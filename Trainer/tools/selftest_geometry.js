'use strict';
// Самопроверка модуля 2 (геометрия): прогон месяца вперёд с пересчётом карты
// по закрытию каждого ТФ, скорость, сводка карты и связь ТФ.
// Запуск:  node tools/selftest_geometry.js [МОНЕТА ...]
const cfg = require('../config');
const { loadCoin } = require('../core/data');
const { Clock } = require('../core/clock');
const G = require('../core/geometry');

const list = process.argv.slice(2).map(x => x.toUpperCase());
const COINS = list.length ? list : cfg.COINS;
const iso = x => new Date(x).toISOString().slice(0, 16).replace('T', ' ');
const f5 = x => x.toPrecision(5);

let coins;
try { coins = COINS.map(s => loadCoin(s)); }
catch (e) { console.error(e.message); process.exit(1); }
const clock = new Clock(coins);
clock.warmup();

// Карта на момент конца прошлого
const maps = {}, events = {};
let t0 = Date.now();
for (const s of COINS) {
  const ser = {}; for (const tf of G.GEO_TFS) ser[tf] = clock.series(s, tf);
  maps[s] = G.mapCoin(ser); events[s] = [];
}
console.log(`[Geometry] Карты на ${iso(clock.now)} построены за ${Date.now() - t0} мс (${COINS.length} монет × ${G.GEO_TFS.length} ТФ)`);

// Прогон месяца: пересчёт ТФ при закрытии его свечи
let recomputes = 0; t0 = Date.now();
clock.on('bar', ev => {
  for (const [s, closedTfs] of Object.entries(ev.closed)) {
    for (const tf of closedTfs) {
      if (!G.GEO_TFS.includes(tf)) continue;
      const prev = maps[s][tf];
      const next = G.mapTF(clock.series(s, tf), tf);
      maps[s][tf] = next; recomputes++;
      for (const e of G.diffFloors(prev, next)) events[s].push({ at: ev.now, ...e });
    }
    if (closedTfs.some(tf => G.GEO_TFS.includes(tf))) G.linkTFs(maps[s]);
  }
});
clock.runUntil(clock.nextStepEnd());
console.log(`[Geometry] +1 месяц до ${iso(clock.now)}: ${recomputes} пересчётов ТФ за ${((Date.now() - t0) / 1000).toFixed(1)} с`);

for (const s of COINS) {
  console.log(`\n=== ${s} на ${iso(clock.now)} ===`);
  for (const tf of G.GEO_TFS) {
    const m = maps[s][tf];
    if (!m.ready) { console.log(`  ${tf}: не готова (${m.reason})`); continue; }
    const alive = m.floors.filter(f => f.status === 'жив');
    const big = m.legs.filter(l => l.big);
    console.log(`  ${tf.padEnd(3)} допуск ${(m.tol * 100).toFixed(1)}% (размах ${(m.medRange * 100).toFixed(2)}%) | узлов ${m.nodes.length} | этажей ${m.floors.length} (живых ${alive.length}) | ног ${m.legs.length}, значимых ${big.length}`);
  }
  // Живые зоны 4H и что под ними на младших
  const m4 = maps[s]['4h'], price = maps[s]['1h'].price;
  const near = m4.floors.filter(f => f.status === 'жив').sort((a, b) => Math.abs(a.lvl - price) - Math.abs(b.lvl - price)).slice(0, 4);
  console.log(`  цена ${f5(price)}; ближайшие живые зоны 4H:`);
  for (const f of near) {
    console.log(`    ${f5(f.lvl)} (${((f.lvl / price - 1) * 100).toFixed(1)}%) визитов ${f.visits}, эпох ${f.epochs}${f.roleChanged ? ', роль менялась' : ''}; внутри: этажей 1H ${f.childFloors['1h']}, 15m ${f.childFloors['15m']}; узлов 1H ${f.childNodes['1h']}, 15m ${f.childNodes['15m']}`);
  }
  const byType = {}; for (const e of events[s]) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(`  события за месяц:`, byType);
}
