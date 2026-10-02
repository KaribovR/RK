'use strict';
// ============================================================================
// core/forecast.js — ЭТАП 3 (сборка: прогноз) + ЭТАП 4 (сторож исходов).
// Только ГЕОМЕТРИЯ, без индикаторов.
//
// v0.4 — ядро «пробой зоны» (старый повод «вершина + отход» и подсчёт
// подтверждений N/6 убраны; стоп A и пометка D убраны):
//   • повод: свеча 1H/4H закрылась за живой зоной своего или старшего ТФ
//     (прошлая — не дальше края, текущая — за краем); тень — не пробой;
//   • направление: куда пробила;
//   • цель: первая зона впереди не слабее пробитой (сила: старшинство ТФ,
//     затем эпохи); слабее — остановки по пути; нет — отказ; за историей — пустота;
//   • срыв: закрытие за ДАЛЬНИМ краем пробитой зоны (ложный пробой);
//   • ориентир: ТФ на ступень старше (1H→4H, 4H→1D) — в какую сторону он
//     последним закрытием пробил зону; точка «по ориентиру» / «против» / «нет»;
//   • вероятность: доля прошлых пробоев монеты на этом ТФ с тем же отношением
//     к ориентиру, которые ДОШЛИ (из закончившихся до момента точки);
//     меньше MIN_HISTORY — «мало истории». Справочно — разрезы по форме,
//     энергии, силе цели, дальности.
// КАЖДЫЙ пробой отслеживается до исхода (для статистики), даже если прогноз
// на этом ТФ уже активен; показывается только тот, что занял свободное место.
// Разогрев (warm): пробои считаются только в статистику, в отчёт не идут.
// ============================================================================

const cfg = require('../config');
const FC = cfg.FORECAST;
const ZONE_TFS = ['15m', '1h', '4h', '1d'];
const TFN = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const pct = (a, b) => (b / a - 1) * 100;
const L = Math.log;

function median(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

class Forecaster {
  constructor(sym) {
    this.sym = sym;
    this.all = [];            // показанные прогнозы (с исходами)
    this.active = {};         // active[tf] = показанный прогноз
    this.tracked = [];        // ВСЕ пробои (с исходами) — для вероятности
    this.open = [];           // пробои без исхода
    this.refusals = [];       // отказы: пустота, нет станций
    this.figs = [];           // журнал подтверждённых фигур и их исходов
    this.figSeen = new Set();
    this.nextId = 1;
    this.nextFig = 1;
    this.warm = false;        // разогрев: только статистика
    this.orient = {};         // orient[старший ТФ] = { dir, t, lvl, ztf }
    this.orientLog = {};      // orientLog[ТФ] = [{ t, dir }] — смены ориентира (для плеера)
  }

  // ---------------- фигуры: новые подтверждённые → журнал ----------------
  noteFigures(tf, figures, maps, now) {
    const out = [];
    for (const f of figures) {
      if (!f.confirmed || f.tBreak > now) continue;
      const key = tf + ':' + f.kind + ':' + f.pts[0].t;
      if (this.figSeen.has(key)) continue;
      this.figSeen.add(key);
      if (this.warm) continue;
      const mt = FC.MATCH_OF_TOL * maps[tf].tol;
      const zonesAtTarget = ZONE_TFS.filter(z => maps[z] && maps[z].ready && maps[z].floors.some(g => g.status === 'жив' && overlapBand(f.target, mt, g)));
      const rec = { id: this.nextFig++, tf, kind: f.kind, dir: f.dir, pts: f.pts, neck: f.neck, extreme: f.extreme,
        lenPct: f.lenPct, target: f.target, tBreak: f.tBreak, noted: now, zonesAtTarget,
        horizonH: FC.TF[tf].horizonH, outcome: null, mfePct: 0 };
      this.figs.push(rec); out.push(rec);
    }
    return out;
  }

  // ---------------- пробои на закрытии ТФ ----------------
  // Какие живые зоны (своего и старших ТФ) пробило последнее закрытие ТФ.
  _breaks(tf, maps, seTf) {
    const n = seTf.length;
    if (n < 2) return null;
    const cPrev = seTf.c[n - 2], cNow = seTf.c[n - 1];
    const up = [], down = [];
    for (const z of FC.BREAK_TFS[tf]) {
      const mz = maps[z];
      if (!mz || !mz.ready) continue;
      for (const f of mz.floors) {
        if (f.status !== 'жив') continue;
        if (cPrev <= f.hi && cNow > f.hi) up.push({ z, f });
        else if (cPrev >= f.lo && cNow < f.lo) down.push({ z, f });
      }
    }
    if (!up.length && !down.length) return null;
    // обе стороны сразу не бывает при одном закрытии (зоны не пересекаются с обеих сторон цены)
    const dir = up.length ? 'up' : 'down';
    const list = up.length ? up : down;
    // «пробитая» — последняя пройденная (ближайшая к цене)
    list.sort((a, b) => dir === 'up' ? b.f.hi - a.f.hi : a.f.lo - b.f.lo);
    return { dir, list, cPrev, cNow, bar: { h: seTf.h[n - 1], l: seTf.l[n - 1], o: seTf.o[n - 1], c: cNow, t: seTf.t[n - 1] } };
  }

  // Ориентир: старший ТФ (4H, 1D) — сторона последнего пробоя зоны. Вызывать на его закрытии.
  updateOrient(tf, maps, seTf, now) {
    if (!FC.BREAK_TFS[tf]) return;
    const br = this._breaks(tf, maps, seTf);
    if (!br) return;
    const b = br.list[0];
    const prev = this.orient[tf];
    this.orient[tf] = { dir: br.dir, t: now, lvl: b.f.lvl, ztf: b.z };
    if (!prev || prev.dir !== br.dir) (this.orientLog[tf] || (this.orientLog[tf] = [])).push({ t: now, dir: br.dir });
  }

  // ---------------- попытка построить прогноз на закрытии ТФ ----------------
  // maps — карты всех ТФ; se1d — серия 1D (для пустоты); seTf — серия ТФ; price — цена «сейчас»
  tryBuild(tf, maps, figures, se1d, seTf, price, now) {
    const m = maps[tf];
    if (!m || !m.ready) return null;
    const br = this._breaks(tf, maps, seTf);
    if (!br) return null;
    const dir = br.dir, sgn = dir === 'up' ? 1 : -1;
    const tol = m.tol, mt = FC.MATCH_OF_TOL * tol, tfMs = cfg.TFS.find(x => x.name === tf).ms;
    const broken = br.list[0];
    const rank = z => FC.BREAK_TFS['1h'].indexOf(z);          // 1h=0, 4h=1, 1d=2
    const stronger = (a, b) => rank(a.z) > rank(b.z) || (rank(a.z) === rank(b.z) && a.f.epochs >= b.f.epochs);

    const trigger = { type: 'пробой', text: `закрытие ${fmt(br.cNow)} ${dir === 'up' ? 'выше' : 'ниже'} зоны ${TFN[broken.z]} ${fmt(broken.f.lvl)} (${fmt(broken.f.lo)}–${fmt(broken.f.hi)}, эпох ${broken.f.epochs})`
      + (br.list.length > 1 ? `; за одну свечу пройдено зон: ${br.list.length}` : '') };
    const start = { t: br.bar.t, p: dir === 'up' ? broken.f.hi : broken.f.lo };

    // --- ориентир (ТФ на ступень старше) ---
    const sTf = FC.ORIENT_OF[tf];
    const o = sTf ? this.orient[sTf] : null;
    const rel = !o ? 'нет' : o.dir === dir ? 'по' : 'против';

    // --- ритм (только справочно: обычная нога и предел поиска) ---
    const legs = m.legs.filter(l => l.big && l.dir === dir).slice(-FC.RHYTHM_LEGS);
    let rhythm = null;
    if (legs.length >= FC.RHYTHM_MIN) {
      const med = median(legs.map(l => Math.abs(L(l.p1 / l.p0))));
      rhythm = { legsPct: legs.map(l => l.pct), medPct: (Math.exp(sgn * med) - 1) * 100, logLen: med };
    }

    // --- зоны впереди: цель = первая не слабее пробитой ---
    const maxLog = rhythm ? FC.SEARCH_OF_RHYTHM * rhythm.logLen : FC.SEARCH_OF_TOL * tol;
    const aheadZ = [];
    for (const z of FC.BREAK_TFS[tf]) {
      const mz = maps[z]; if (!mz || !mz.ready) continue;
      for (const f of mz.floors) {
        if (f.status !== 'жив') continue;
        const near = dir === 'up' ? f.lo : f.hi;
        const d = sgn * L(near / price);
        if (d > 0 && d <= maxLog) aheadZ.push({ z, f, d, near });
      }
    }
    aheadZ.sort((a, b) => a.d - b.d);
    const tgt = aheadZ.find(x => stronger(x, broken));
    const base = { tf, dir, createdT: now, price, start, trigger, rhythm, tol, mt, orient: o ? { tf: sTf, dir: o.dir, lvl: o.lvl, t: o.t } : null, rel,
      broken: { tf: broken.z, lvl: broken.f.lvl, lo: broken.f.lo, hi: broken.f.hi, epochs: broken.f.epochs },
      brokenAll: br.list.map(x => ({ tf: x.z, lvl: x.f.lvl, epochs: x.f.epochs })) };
    const canShow = !this.warm && !this.active[tf];
    if (!tgt) { if (canShow) this.refusals.push({ ...base, reason: 'нет станций впереди в пределах поиска' }); return null; }

    // пустота
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < se1d.length; i++) { if (se1d.h[i] > hi) hi = se1d.h[i]; if (se1d.l[i] < lo) lo = se1d.l[i]; }
    const p1 = se1d.partial(); if (p1) { hi = Math.max(hi, p1.h); lo = Math.min(lo, p1.l); }
    if (tgt.f.lvl > hi || tgt.f.lvl < lo) { if (canShow) this.refusals.push({ ...base, reason: `пустота: цель ${fmt(tgt.f.lvl)} за пределами истории (${fmt(lo)}–${fmt(hi)})` }); return null; }

    const path = aheadZ.filter(x => x.d < tgt.d).map(x => ({ p: x.f.lvl, pct: pct(price, x.f.lvl), tf: x.z, epochs: x.f.epochs, src: [`зона ${TFN[x.z]}`] }));

    // обычный ход монеты за срок прогноза (справочно: «далеко»)
    const k = Math.max(1, Math.round(FC.TF[tf].horizonH * 3600000 / tfMs));
    const moves = [];
    for (let i = Math.max(0, seTf.length - 1000 - k); i + k < seTf.length; i++) moves.push(Math.abs(L(seTf.c[i + k] / seTf.c[i])));
    const typ = moves.length ? median(moves) : NaN;
    const far = isFinite(typ) && Math.abs(L(tgt.near / price)) > FC.REACH_X * typ;

    // срыв: закрытие за дальним краем пробитой зоны
    const invalid = dir === 'up' ? broken.f.lo : broken.f.hi;
    const behind = { kind: 'пробитая зона', tf: broken.z, lvl: broken.f.lvl, invalid, epochs: broken.f.epochs, pct: pct(price, invalid) };

    // --- справочные признаки пробоя ---
    const zw = broken.f.hi - broken.f.lo;
    const beyond = dir === 'up' ? br.cNow - broken.f.hi : broken.f.lo - br.cNow;
    const rangeLog = L(br.bar.h / br.bar.l);
    const reachLog = Math.abs(L(tgt.near / price));
    const factors = {
      rel,
      form: beyond >= FC.FORM_FAR_OF_ZONE * zw ? 'далеко за зоной' : 'едва за зоной',
      energy: rangeLog >= FC.ENERGY_X * m.medRange ? 'длинная свеча' : 'обычная свеча',
      strength: (rank(tgt.z) > rank(broken.z) || tgt.f.epochs > broken.f.epochs) ? 'цель сильнее' : 'цель равна',
      reach: !rhythm ? 'ритма нет' : reachLog <= rhythm.logLen ? 'в пределах ноги' : 'дальше ноги',
    };
    const stats = {};
    for (const key of Object.keys(factors)) stats[key] = this._share(tf, key, factors[key], now);
    const prob = stats.rel;   // основная цифра — по ориентиру
    const conf = prob.n >= FC.MIN_HISTORY ? prob.share : 0;
    const few = prob.n < FC.MIN_HISTORY;
    const level = few ? 'мало истории' : conf >= FC.BRIGHT_FROM ? 'яркая' : conf >= FC.DRAW_FROM ? 'прозрачная' : 'не рисуется';

    const rec = {
      ...base,
      target: { p: tgt.f.lvl, pct: pct(price, tgt.f.lvl), tf: tgt.z, epochs: tgt.f.epochs, lo: tgt.f.lo, hi: tgt.f.hi,
                src: [`зона ${TFN[tgt.z]}`], edge: tgt.near, edgePct: pct(price, tgt.near) },
      path, behind, ratio: Math.abs(pct(price, tgt.near)) / Math.max(1e-9, Math.abs(behind.pct)),
      horizonH: FC.TF[tf].horizonH, typMovePct: (Math.exp(typ) - 1) * 100, far,
      factors, stats, conf, few, level,
      outcome: null, mfePct: 0, maePct: 0, touched: [], warm: this.warm,
    };
    this.tracked.push(rec); this.open.push(rec);
    if (!canShow) return null;
    rec.id = this.nextId++;
    this.all.push(rec); this.active[tf] = rec;
    return rec;
  }

  // Доля «дошла» среди прошлых пробоев ТФ с тем же значением признака (исход известен до now).
  _share(tf, key, val, now) {
    let n = 0, w = 0;
    for (const r of this.tracked) {
      if (r.tf !== tf || !r.outcome || r.outcome.t > now || r.factors[key] !== val) continue;
      n++; if (r.outcome.type === 'дошла') w++;
    }
    return { val, n, reached: w, share: n ? w / n : 0 };
  }

  // Конец разогрева: дальше пробои показываются и идут в отчёт.
  startTest() { this.warm = false; this.active = {}; this.orientLog = Object.fromEntries(Object.entries(this.orient).map(([tf, o]) => [tf, [{ t: o.t, dir: o.dir }]])); }

  // ---------------- сторож: каждая закрытая 5m ----------------
  watch(bar, now) {
    const done = [];
    const still = [];
    for (const f of this.open) {
      const up = f.dir === 'up';
      f.mfePct = Math.max(f.mfePct, (up ? bar.h / f.price - 1 : 1 - bar.l / f.price) * 100);
      f.maePct = Math.max(f.maePct, (up ? 1 - bar.l / f.price : bar.h / f.price - 1) * 100);
      for (const s of f.path) if (!f.touched.includes(s.p) && bar.l <= s.p && bar.h >= s.p) f.touched.push(s.p);
      const reached = up ? bar.h >= f.target.edge : bar.l <= f.target.edge;   // вошла в зону цели
      const failed = up ? bar.c < f.behind.invalid : bar.c > f.behind.invalid;
      let type = null;
      if (reached && !failed) type = 'дошла';
      else if (failed) type = 'сорвалась';
      else if (now - f.createdT >= f.horizonH * 3600000) type = 'истекла';
      if (!type) { still.push(f); continue; }
      const toTarget = Math.abs(f.target.edgePct);
      f.outcome = { type, t: now, hours: (now - f.createdT) / 3600000, progressPct: Math.min(100, f.mfePct / Math.max(1e-9, toTarget) * 100) };
      if (this.active[f.tf] === f) { this.active[f.tf] = null; done.push(f); }
    }
    this.open = still;
    // фигуры: дошла ли цена до цели фигуры за срок ТФ
    for (const g of this.figs) {
      if (g.outcome) continue;
      const up = g.dir === 'up';
      g.mfePct = Math.max(g.mfePct, (up ? bar.h / g.neck - 1 : 1 - bar.l / g.neck) * 100);
      if (up ? bar.h >= g.target : bar.l <= g.target) g.outcome = { type: 'цель достигнута', t: now, hours: (now - g.tBreak) / 3600000 };
      else if (now - g.tBreak >= g.horizonH * 3600000) g.outcome = { type: 'не дошла за срок', t: now, hours: g.horizonH, progressPct: g.mfePct / g.lenPct * 100 };
    }
    return done;
  }
}

function overlapBand(p, mt, f) { const lo = p * Math.exp(-mt), hi = p * Math.exp(mt); return f.lo <= hi && lo <= f.hi; }
function fmt(p) { return (+p).toPrecision(5); }

module.exports = { Forecaster, TFN };
