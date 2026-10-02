'use strict';
// ============================================================================
// replay.js — главный запуск тренажёра.
// Прогоняет монету вперёд по времени (первые HISTORY_MONTHS месяцев — прошлое,
// дальше свеча за свечой), на каждом закрытии ТФ пересчитывает карту Этапа 1
// и ЗАПИСЫВАЕТ КАЖДОЕ СОСТОЯНИЕ карты. Результат — один HTML-файл-плеер:
// открываешь двойным кликом и перематываешь процесс по шагам: где линия
// появилась, где исчезла, когда цена пришла к зоне и т.д.
//
// Запуск:  node replay.js МОНЕТА [МОНЕТА ...] [--months N]
//   по умолчанию — до конца архива (до сегодняшнего дня);
//   --months N  — только N месяцев после прошлого (для быстрых проверок)
// Результат: runs/<дата>_<версия>/replay_<МОНЕТА>.html + events.jsonl + summary.md
// ============================================================================

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { loadCoin } = require('./core/data');
const { Clock } = require('./core/clock');
const G = require('./core/geometry');
const { createRun } = require('./core/journal');
const { findFigures, lineOf } = require('./core/figures');
const { Forecaster } = require('./core/forecast');
const REP = require('./core/report');

// ---------- аргументы ----------
const args = process.argv.slice(2);
let months = 0;   // 0 = до конца архива
const mi = args.indexOf('--months');
if (mi >= 0) { months = Math.max(1, parseInt(args[mi + 1], 10) || 1); args.splice(mi, 2); }
const COINS = args.length ? args.map(x => x.toUpperCase()) : [cfg.COINS[0]];

const iso = x => new Date(x).toISOString().slice(0, 16).replace('T', ' ');
// Время в плеере хранится в МИНУТАХ от начала прогона (короче в файле). Плеер восстанавливает.
let BASE_T = 0;
const tm = t => Math.round((t - BASE_T) / 60000);
// Снимки хранятся «разницей» к прошлому (что убрали / что добавили) + полный кадр каждые KEY шагов.
const KEY_EVERY = 48;
const r6 = x => (x == null || !isFinite(x)) ? null : +x.toPrecision(6);
const STATUS = { 'жив': 0, 'стареет': 1, 'мёртв': 2 };

// Компактный снимок карты одного ТФ для плеера.
function snap(t, m) {
  if (!m.ready) return { t: tm(t), ready: 0, reason: m.reason };
  // Мёртвые этажи младших ТФ в плеер не кладём (шум и объём); в журнале они есть.
  const floors = (m.tf === '15m' || m.tf === '1h') ? m.floors.filter(x => x.status !== 'мёртв') : m.floors;
  return {
    t: tm(t), ready: 1, tol: +m.tol.toFixed(5),
    // узел: [время, цена, тип H/L/-, живой край 0/1]
    n: m.nodes.map(x => [tm(x.t), r6(x.p), x.kind, x.edge ? 1 : 0]),
    // этаж: [уровень, низ, верх, визитов, реакций, эпох, статус, роль менялась, первый визит, последний визит,
    //        внутри зон старших "4h:0.041|1d:0.04", скопление младших "15m:2/9|1h:1/3" (этажей/узлов)]
    f: floors.map(x => [r6(x.lvl), r6(x.lo), r6(x.hi), x.visits, x.reacts, x.epochs, STATUS[x.status], x.roleChanged ? 1 : 0,
      tm(x.firstT), tm(x.lastT),
      (x.insideOf || []).map(p => `${p.tf}:${r6(p.lvl)}`).join('|'),
      Object.keys(x.childFloors || {}).map(k => `${k}:${x.childFloors[k]}/${x.childNodes[k]}`).join('|')]),
    // значимые ноги: [t0, p0, t1, p1]
    g: m.tf === '15m' ? [] : m.legs.filter(l => l.big).map(l => [tm(l.t0), r6(l.p0), tm(l.t1), r6(l.p1)]),
  };
}

// Разница двух списков по ключу: { r: ключи убранных, a: добавленные/изменённые элементы }
function listDiff(prev, next, keyOf) {
  const pk = new Map(prev.map(x => [keyOf(x), JSON.stringify(x)]));
  const nk = new Set(next.map(keyOf));
  const r = []; for (const k of pk.keys()) if (!nk.has(k)) r.push(k);
  const a = [];
  for (const x of next) { const k = keyOf(x); const old = pk.get(k); if (old === undefined) a.push(x); else if (old !== JSON.stringify(x)) { r.push(k); a.push(x); } }
  return { r, a };
}
function encodeSnaps(list) {
  const out = []; let prev = null;
  list.forEach((s, i) => {
    if (!s.ready || !prev || !prev.ready || i % KEY_EVERY === 0) { out.push({ ...s, K: 1 }); }
    else out.push({ t: s.t, ready: 1, tol: s.tol,
      n: listDiff(prev.n, s.n, x => x[0] + ':' + x[2] + ':' + x[3]),
      f: listDiff(prev.f, s.f, x => String(x[0])),
      g: listDiff(prev.g, s.g, x => x[0] + ':' + x[2]) });
    prev = s;
  });
  return out;
}

function candlesOf(se, fromT) {
  const out = { t: [], o: [], h: [], l: [], c: [], m: [] };
  for (let i = 0; i < se.length; i++) {
    if (se.t[i] < fromT) continue;
    out.t.push(tm(se.t[i])); out.o.push(r6(se.o[i])); out.h.push(r6(se.h[i]));
    out.l.push(r6(se.l[i])); out.c.push(r6(se.c[i])); out.m.push(r6(se.mid[i]));
  }
  return out;
}

function main() {
  let coins;
  try { coins = COINS.map(s => loadCoin(s)); }
  catch (e) { console.error(e.message); console.error('[Replay] Проверь RK_KLINES_DIR и имя монеты.'); process.exit(1); }

  const tplPath = path.join(__dirname, 'ui', 'replay_template.html');
  let tpl;
  try { tpl = fs.readFileSync(tplPath, 'utf8'); }
  catch (e) { console.error(`[Replay] Failed to read template ${tplPath}: ${e.message}`); process.exit(1); }

  const run = createRun({ 'Монеты': COINS.join(', '), 'Прогон': months ? `${months} мес.` : 'до конца архива' });
  console.log(`[Replay] Папка прогона: ${run.dir}`);

  for (const d of coins) {
    const sym = d.sym;
    const t0 = Date.now();
    const clock = new Clock([d]);
    // v0.4: разогрев — прошлое подаётся до (начало теста − WARMUP_DAYS), дальше шагаем
    // свеча за свечой до начала теста: пробои идут только в статистику, не в отчёт.
    const testStart = clock.historyEnd;
    clock.historyEnd = testStart - cfg.FORECAST.WARMUP_DAYS * 86400000;
    clock.warmup();
    let warm = true;
    let histEnd = testStart;
    BASE_T = histEnd;

    const ser = {}; for (const tf of G.GEO_TFS) ser[tf] = clock.series(sym, tf);
    const maps = G.mapCoin(ser);
    const snaps = {}; const lastKey = {};
    const events = [];
    const fc = new Forecaster(sym);
    fc.warm = true;
    const figs = {}; for (const tf of cfg.FIGURES.TFS) figs[tf] = [];
    const se5 = clock.series(sym, '5m');
    const tfMs = tf => cfg.TFS.find(x => x.name === tf).ms;

    clock.on('bar', ev => {
      const closedAll = ev.closed[sym];
      if (!closedAll) return;
      // 1) сторож: закрытая 5m проверяет активные точки и фигуры
      const i = se5.length - 1;
      const bar = { h: se5.h[i], l: se5.l[i], c: se5.c[i] };
      for (const f of fc.watch(bar, ev.now)) if (!warm) run.write({ t: ev.now, coin: sym, tf: f.tf, type: 'прогноз_итог', id: f.id, outcome: f.outcome.type, hours: +f.outcome.hours.toFixed(1), mfePct: +f.mfePct.toFixed(2), maePct: +f.maePct.toFixed(2) });

      // 2) пересчёт карт закрывшихся ТФ
      const closed = closedAll.filter(tf => G.GEO_TFS.includes(tf));
      if (!closed.length) return;
      for (const tf of closed) {
        const prev = maps[tf];
        const next = G.mapTF(clock.series(sym, tf), tf);
        maps[tf] = next;
        if (!warm) for (const e of G.diffFloors(prev, next)) {
          run.write({ t: ev.now, coin: sym, ...e });
          events.push([tm(ev.now), e.tf, e.type, r6(e.lvl != null ? e.lvl : e.pct), eventText(e)]);
        }
      }
      G.linkTFs(maps);
      if (!warm) for (const tf of closed) {
        const s = snap(ev.now, maps[tf]);
        const key = JSON.stringify([s.n, s.f]);
        if (key !== lastKey[tf]) { snaps[tf].push(s); lastKey[tf] = key; }
      }
      // 3) ориентир: старшие ТФ (4H, 1D) — сторона последнего пробоя зоны
      for (const tf of closed) if (tf === '4h' || tf === '1d') fc.updateOrient(tf, maps, clock.series(sym, tf), ev.now);
      // 4) фигуры и прогноз на закрытии 1H / 4H
      for (const tf of closed) {
        if (!cfg.FIGURES.TFS.includes(tf) || !maps[tf].ready) continue;
        figs[tf] = findFigures(maps[tf].nodes, lineOf(clock.series(sym, tf)), tfMs(tf), maps[tf].tol);
        for (const g of fc.noteFigures(tf, figs[tf], maps, ev.now)) if (!warm) run.write({ t: ev.now, coin: sym, tf, type: 'фигура', id: 'Ф' + g.id, kind: g.kind, lenPct: +g.lenPct.toFixed(2), target: r6(g.target), zonesAtTarget: g.zonesAtTarget });
        const f = fc.tryBuild(tf, maps, figs[tf], clock.series(sym, '1d'), clock.series(sym, tf), bar.c, ev.now);
        if (f) run.write({ t: ev.now, coin: sym, tf, type: 'прогноз', id: f.id, dir: f.dir, price: r6(f.price), target: r6(f.target.p), conf: +f.conf.toFixed(2), few: f.few, rel: f.rel, broken: r6(f.broken.lvl), behind: r6(f.behind.invalid) });
      }
    });
    clock.runUntil(testStart);          // разогрев
    warm = false;
    histEnd = clock.now;
    BASE_T = histEnd;
    fc.startTest();
    for (const tf of G.GEO_TFS) { const s = snap(histEnd, maps[tf]); snaps[tf] = [s]; lastKey[tf] = JSON.stringify([s.n, s.f]); }
    const warmN = fc.tracked.length;
    const endT = months ? clock.nextStepEnd(months) : clock.lastT + cfg.BASE_MS;
    clock.runUntil(endT);

    // Свечи для показа: 15m — последние 30 дней прошлого + прогон; остальные — всё.
    const candles = {};
    for (const tf of cfg.TFS) {
      if (tf.name === '5m') continue;
      const from = tf.name === '15m' ? histEnd - 30 * 86400000 : 0;
      candles[tf.name] = candlesOf(clock.series(sym, tf.name), from);
    }

    const DATA = {
      coin: sym, logic: cfg.LOGIC_VERSION, created: iso(Date.now()),
      base: histEnd, historyEnd: histEnd, end: clock.now, tfs: G.GEO_TFS,
      tfMs: Object.fromEntries(cfg.TFS.map(x => [x.name, x.ms])),
      // события карты (визиты, эпохи…) в плеер не кладём — это шум для поиска багов; они в events.jsonl
      candles, snaps: Object.fromEntries(Object.entries(snaps).map(([tf, l]) => [tf, encodeSnaps(l)])),
      sources: cfg.FORECAST.SOURCES, drawFrom: cfg.FORECAST.DRAW_FROM, brightFrom: cfg.FORECAST.BRIGHT_FROM,
      forecasts: fc.all.map(f => ({
        id: f.id, tf: f.tf, dir: f.dir, t: tm(f.createdT), price: r6(f.price), start: [tm(f.start.t), r6(f.start.p)],
        target: r6(f.target.p), edge: r6(f.target.edge), conf: +f.conf.toFixed(3), src: f.target.src, level: f.level,
        path: f.path.map(x => r6(x.p)), behind: r6(f.behind.invalid), behindLvl: r6(f.behind.lvl), mt: +f.mt.toFixed(5),
        rel: f.rel, few: f.few ? 1 : 0, zone: [r6(f.broken.lo), r6(f.broken.hi)],
        out: f.outcome ? { type: f.outcome.type, t: tm(f.outcome.t) } : null,
        head: REP.headLine(f), text: [...REP.thinking(f), ...REP.outcomeLines(f)],
      })),
      figures: fc.figs.map(g => ({ id: g.id, tf: g.tf, kind: g.kind, dir: g.dir, pts: g.pts.map(p => [tm(p.t), r6(p.p)]),
        neck: r6(g.neck), target: r6(g.target), tb: tm(g.tBreak), lenPct: +g.lenPct.toFixed(1), zones: g.zonesAtTarget,
        text: REP.figureLines(g) })),
      summary: REP.summary(fc.all, fc.refusals, fc.figs),
      // ориентир (v0.4): смены стороны старшего ТФ — [время, 'up'|'down']
      orient: Object.fromEntries(Object.entries(fc.orientLog).map(([tf, l]) => [tf, l.map(x => [tm(x.t), x.dir])])),
    };
    const md = REP.markdown({ coin: sym, historyEnd: iso(histEnd), end: iso(clock.now) }, fc);
    DATA.reportMd = md;
    try { fs.writeFileSync(path.join(run.dir, `report_${sym}.md`), md); }
    catch (e) { console.error(`[Replay] Failed to write report for ${sym}: ${e.message}`); }
    if (process.env.RK_REPLAY_DEBUG) fs.writeFileSync(path.join(run.dir, `debug_snaps_${sym}.json`), JSON.stringify(snaps));
    const html = tpl.replace('/*__DATA__*/null', JSON.stringify(DATA));
    const out = path.join(run.dir, `replay_${sym}.html`);
    try { fs.writeFileSync(out, html); }
    catch (e) { console.error(`[Replay] Failed to write ${out}: ${e.message}`); continue; }
    const sizeMb = (Buffer.byteLength(html) / 1048576).toFixed(1);
    const nSnaps = Object.values(snaps).reduce((a, s) => a + s.length, 0);
    const dr = fc.all.filter(f => f.conf >= cfg.FORECAST.DRAW_FROM).length;
    console.log(`[Replay] ${sym}: ${iso(histEnd)} → ${iso(clock.now)}, точек прогноза ${fc.all.length} (на графике ${dr}), пробоев всего ${fc.tracked.length} (из них разогрев ${warmN}), фигур ${fc.figs.length}, ${((Date.now() - t0) / 1000).toFixed(1)} с, файл ${sizeMb} МБ`);
    console.log(`         Отчёт: ${path.join(run.dir, `report_${sym}.md`)}`);
    console.log(`         Открой двойным кликом: ${out}`);
  }
  run.close();
  console.log(`[Replay] Журнал: ${path.join(run.dir, 'events.jsonl')}, итог: ${path.join(run.dir, 'summary.md')}`);
}

// Человеческий текст события (для списка в плеере).
function eventText(e) {
  const p = e.lvl != null ? (+e.lvl).toPrecision(5) : '';
  const side = { above: 'сверху', below: 'снизу', in: 'изнутри' };
  switch (e.type) {
    case 'этаж_родился': return `новый этаж ${p} (визитов ${e.visits}, эпох ${e.epochs})`;
    case 'этаж_исчез': return `этаж ${p} исчез`;
    case 'статус_этажа': return `этаж ${p}: ${e.from} → ${e.to}`;
    case 'визит': return `цена пришла к ${p} ${side[e.from] || ''} (визит №${e.visits})`;
    case 'новая_эпоха': return `возврат к ${p} после ${e.absentBars} свечей отсутствия — эпоха ${e.epochs}`;
    case 'роль_сменилась': return `${p}: подход ${side[e.now]}, раньше ${side[e.from]} — роль сменилась`;
    case 'нога': return `завершилась нога ${e.dir === 'up' ? 'вверх' : 'вниз'} ${e.pct.toFixed(1)}%${e.big ? ' (значимая)' : ''}`;
    default: return e.type;
  }
}

main();
