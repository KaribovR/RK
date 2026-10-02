'use strict';
// ============================================================================
// core/geometry.js — ЭТАП 1: ГЕОМЕТРИЯ (карта графика).
// Перенос проверенного Python-движка (Engine/rk_baseline.py) + то, что решили:
//   • база-линия = среднее ЦЕНТРОВ тел 5m внутри свечи ТФ (§6.1.3);
//   • узлы = изгибы линии (упрощение Дугласа-Пекера по лог-цене), отдельный
//     зигзаг не строим;
//   • этажи = ЗОНЫ, куда садятся узлы в разное время; сила = отдельные визиты;
//     ЭПОХИ = разные периоды, когда цена жила у зоны (§6.1.5);
//   • роль зоны менялась (подходили и сверху, и снизу) — отмечается;
//   • волны (ноги) между вершинами и впадинами; коррекции не выбрасываются;
//   • ВСЕ ТФ сразу и СВЯЗЬ между ними: зона старшего ТФ = скопление узлов и
//     этажей младших; этаж младшего внутри зоны старшего = «спотыкание».
// Все допуски относительные к монете (см. config.GEOMETRY). Черновые.
// Будущего не видит: работает только с тем, что лежит в сериях ТФ.
// ============================================================================

const cfg = require('../config');
const G = cfg.GEOMETRY;
const GEO_TFS = Object.keys(G.TF);            // ['15m','1h','4h','1d'] — 5m только сырьё

// ---------------------------------------------------------------------------
// Вспомогательное
// ---------------------------------------------------------------------------
function median(arr) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Дуглас-Пекер по лог-цене, вертикальное отклонение, допуск абсолютный (доля).
// Точная копия simplify() из rk_baseline.py. Возвращает индексы узлов.
function simplifyIdx(y, tol) {
  const n = y.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    if (b <= a + 1) continue;
    let dmax = 0, im = a;
    const dx = (b - a) || 1e-9, ya = y[a], slope = (y[b] - ya) / dx;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(y[i] - (ya + slope * (i - a)));
      if (d > dmax) { dmax = d; im = i; }
    }
    if (dmax > tol) { keep[im] = 1; st.push([a, im], [im, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Карта одного ТФ
// ---------------------------------------------------------------------------
// se — TFSeries; withEdge — добавить незавершённую свечу как «живой край».
function mapTF(se, tfName, opts = {}) {
  const P = G.TF[tfName];
  const total = se.length;
  const win = opts.window != null ? opts.window : P.window;
  const from = win ? Math.max(0, total - win) : 0;

  // Окно: закрытые свечи + (по желанию) незавершённая как последняя точка линии.
  const t = se.t.slice(from), mid = se.mid.slice(from);
  let o = se.o.slice(from), h = se.h.slice(from), l = se.l.slice(from), c = se.c.slice(from);
  const part = opts.withEdge === false ? null : se.partial();
  if (part) { t.push(part.t); mid.push(part.mid); o.push(part.o); h.push(part.h); l.push(part.l); c.push(part.c); }
  const n = t.length;
  if (n < 10) return { tf: tfName, ready: false, reason: `мало свечей (${n})` };

  // Размах свечей монеты на этом ТФ (по закрытым) → относительный допуск.
  const ranges = [];
  for (let i = 0; i < n - (part ? 1 : 0); i++) if (l[i] > 0) ranges.push(Math.log(h[i] / l[i]));
  const medRange = median(ranges);
  const tol = opts.absTol != null ? opts.absTol : P.K * medRange;
  const floorTol = G.FLOOR_TOL_OF_TOL * tol;

  // Аномальные свечи-проколы: тени ужать к телу (только для визитов этажей).
  let cleaned = 0;
  if (G.ANOMALY_X) {
    h = h.slice(); l = l.slice();
    for (let i = 0; i < n; i++) {
      const r = Math.log(h[i] / l[i]);
      if (r > medRange * G.ANOMALY_X) {
        const bh = Math.max(o[i], c[i]), bl = Math.min(o[i], c[i]);
        const span = Math.abs(c[i] - o[i]) || bh * 0.001;
        h[i] = Math.min(h[i], bh + span * 1.5); l[i] = Math.max(l[i], bl - span * 1.5);
        cleaned++;
      }
    }
  }

  // --- Узлы (изгибы линии) ---
  const y = mid.map(Math.log);
  const idx = simplifyIdx(y, tol);
  const nodes = idx.map((i, k) => {
    let kind = '-';
    if (k > 0 && k < idx.length - 1) {
      const p = mid[i], pp = mid[idx[k - 1]], pn = mid[idx[k + 1]];
      if (p > pp && p > pn) kind = 'H'; else if (p < pp && p < pn) kind = 'L';
    }
    return { i, t: t[i], p: mid[i], kind };
  });
  // Последний узел — «живой край»: ещё может сдвинуться, не подтверждён.
  if (nodes.length) nodes[nodes.length - 1].edge = true;

  // --- Этажи-зоны: кластер цен узлов (как в движке), затем визиты/эпохи ---
  const prices = nodes.map(nd => nd.p).sort((a, b) => a - b);
  const clusters = [];
  for (const pr of prices) {
    const last = clusters[clusters.length - 1];
    if (last && (pr - last[last.length - 1]) / last[last.length - 1] <= floorTol) last.push(pr);
    else clusters.push([pr]);
  }
  const floors = [];
  for (const cl of clusters) {
    const lvl = cl.reduce((a, b) => a + b, 0) / cl.length;
    const lo = lvl * (1 - floorTol), hi = lvl * (1 + floorTol);
    const visits = [];
    let prevIn = false;
    for (let i = 0; i < n; i++) {
      const inb = l[i] <= hi && h[i] >= lo;
      if (inb && !prevIn) {
        // откуда пришла цена: сверху или снизу (для «роль менялась»)
        const from = i > 0 ? (c[i - 1] > hi ? 'above' : c[i - 1] < lo ? 'below' : 'in') : 'in';
        let react = false;
        if (i + G.REACT_BARS < n) {
          for (let j = i + 1; j <= i + G.REACT_BARS; j++) if (Math.abs(Math.log(c[j] / lvl)) >= G.REACT_OF_TOL * tol) { react = true; break; }
        }
        visits.push({ i, t: t[i], from, react });
      }
      prevIn = inb;
    }
    if (visits.length < G.MIN_VISITS) continue;
    // эпохи: разрыв между визитами больше EPOCH_GAP свечей → новая эпоха
    let epochs = 1;
    for (let k = 1; k < visits.length; k++) if (visits[k].i - visits[k - 1].i > G.EPOCH_GAP) epochs++;
    const lastAgeBars = (n - 1) - visits[visits.length - 1].i;
    const status = lastAgeBars < G.ALIVE_BARS ? 'жив' : lastAgeBars < G.AGING_BARS ? 'стареет' : 'мёртв';
    const fromAbove = visits.some(v => v.from === 'above'), fromBelow = visits.some(v => v.from === 'below');
    const lv = visits[visits.length - 1], pv = visits[visits.length - 2];
    floors.push({
      lvl, lo, hi, nodes: cl.length, visits: visits.length,
      reacts: visits.filter(v => v.react).length, epochs,
      firstT: visits[0].t, lastT: lv.t, lastAgeBars, status,
      roleChanged: fromAbove && fromBelow,
      lastFrom: lv.from, prevFrom: pv ? pv.from : null,
      lastGapBars: pv ? lv.i - pv.i : null,   // сколько свечей цена отсутствовала до последнего визита
    });
  }
  floors.sort((a, b) => b.lvl - a.lvl);

  // --- Волны (ноги) между чередующимися H/L; коррекции не выбрасываем ---
  const hl = nodes.filter(nd => nd.kind === 'H' || nd.kind === 'L');
  const legs = [];
  for (let k = 1; k < hl.length; k++) {
    const a = hl[k - 1], b = hl[k];
    if (a.kind === b.kind) continue;
    const pct = (b.p - a.p) / a.p * 100;
    legs.push({ t0: a.t, p0: a.p, t1: b.t, p1: b.p, dir: pct < 0 ? 'down' : 'up', pct,
                big: Math.abs(pct) >= G.WAVE_OF_TOL * tol * 100 });   // как в движке: длина ноги в %
  }

  const last = mid[n - 1];
  return {
    tf: tfName, ready: true, bars: n, from: t[0], to: t[n - 1], hasEdge: !!part,
    medRange, tol, floorTol, cleaned, price: last,
    nodes: nodes.map(({ t, p, kind, edge }) => ({ t, p, kind, edge: !!edge })),
    floors, legs,
  };
}

// ---------------------------------------------------------------------------
// Связь ТФ: зона старшего = скопление младших; этаж младшего внутри старшего
// ---------------------------------------------------------------------------
function linkTFs(maps) {
  const order = GEO_TFS.filter(tf => maps[tf] && maps[tf].ready);
  const overlap = (a, b) => a.lo <= b.hi && b.lo <= a.hi;
  for (let x = 0; x < order.length; x++) {
    const low = maps[order[x]];
    for (const f of low.floors) {
      f.insideOf = [];                       // зоны старших ТФ, внутри которых этот этаж
      for (let y = x + 1; y < order.length; y++) {
        for (const g of maps[order[y]].floors) if (overlap(f, g)) f.insideOf.push({ tf: order[y], lvl: g.lvl });
      }
    }
  }
  for (let y = 0; y < order.length; y++) {
    const high = maps[order[y]];
    for (const g of high.floors) {
      g.childFloors = {}; g.childNodes = {};  // скопление младших внутри зоны старшего
      for (let x = 0; x < y; x++) {
        const low = maps[order[x]];
        g.childFloors[order[x]] = low.floors.filter(f => overlap(f, g)).length;
        g.childNodes[order[x]] = low.nodes.filter(nd => nd.p >= g.lo && nd.p <= g.hi).length;
      }
    }
  }
  return maps;
}

// ---------------------------------------------------------------------------
// Карта монеты целиком (все ТФ) и разница между двумя картами (для журнала)
// ---------------------------------------------------------------------------
function mapCoin(seriesByTf, opts = {}) {
  const maps = {};
  for (const tf of GEO_TFS) {
    try { maps[tf] = mapTF(seriesByTf[tf], tf, opts); }
    catch (e) { maps[tf] = { tf, ready: false, reason: `[Geometry] Failed to map ${tf}: ${e.message}` }; }
  }
  return linkTFs(maps);
}

// Что изменилось в этажах одного ТФ между прошлой и новой картой.
// Только НАСТОЯЩИЕ события, а не перерасчётное мигание:
//  • визит — цена вошла в зону ПОСЛЕ прошлой карты;
//  • новая_эпоха — цена вернулась к зоне после долгого отсутствия (> EPOCH_GAP свечей);
//  • роль_сменилась — последний визит пришёл с другой стороны, чем предыдущий;
//  • этаж_родился / этаж_исчез / статус_этажа — сопоставление по БЛИЖАЙШЕМУ уровню.
function diffFloors(prev, next) {
  const ev = [];
  if (!prev || !prev.ready || !next || !next.ready) return ev;
  const nearest = (f, list) => {
    let best = null, bd = Infinity;
    for (const g of list) {
      if (!(f.lo <= g.hi && g.lo <= f.hi)) continue;
      const d = Math.abs(Math.log(f.lvl / g.lvl));
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  };
  const since = prev.to;   // время последней свечи прошлой карты
  for (const f of next.floors) {
    const old = nearest(f, prev.floors);
    if (!old) { ev.push({ type: 'этаж_родился', tf: next.tf, lvl: f.lvl, visits: f.visits, epochs: f.epochs }); continue; }
    if (f.status !== old.status) ev.push({ type: 'статус_этажа', tf: next.tf, lvl: f.lvl, from: old.status, to: f.status });
    if (f.lastT > since) {
      ev.push({ type: 'визит', tf: next.tf, lvl: f.lvl, from: f.lastFrom, visits: f.visits });
      if (f.lastGapBars != null && f.lastGapBars > G.EPOCH_GAP) ev.push({ type: 'новая_эпоха', tf: next.tf, lvl: f.lvl, epochs: f.epochs, absentBars: f.lastGapBars });
      const sides = ['above', 'below'];
      if (sides.includes(f.lastFrom) && sides.includes(f.prevFrom) && f.lastFrom !== f.prevFrom) {
        ev.push({ type: 'роль_сменилась', tf: next.tf, lvl: f.lvl, from: f.prevFrom, now: f.lastFrom });
      }
    }
  }
  for (const f of prev.floors) if (!nearest(f, next.floors)) ev.push({ type: 'этаж_исчез', tf: next.tf, lvl: f.lvl });
  // новая завершённая нога
  const lp = prev.legs[prev.legs.length - 1], ln = next.legs[next.legs.length - 1];
  if (ln && (!lp || ln.t1 !== lp.t1)) ev.push({ type: 'нога', tf: next.tf, dir: ln.dir, pct: ln.pct, big: ln.big });
  return ev;
}

module.exports = { mapTF, mapCoin, linkTFs, diffFloors, simplifyIdx, GEO_TFS };
