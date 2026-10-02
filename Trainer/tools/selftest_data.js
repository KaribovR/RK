'use strict';
// Самопроверка модуля 1: чтение архива, сборка ТФ, часы, граница видимого.
// Запуск:  node tools/selftest_data.js [МОНЕТА ...] [--dump файл.json]
//   без монет — берётся список COINS из config.js
const fs = require('fs');
const cfg = require('../config');
const { loadCoin } = require('../core/data');
const { Clock } = require('../core/clock');

const args = process.argv.slice(2);
const di = args.indexOf('--dump');
const dumpFile = di >= 0 ? args[di + 1] : null;
const list = (di >= 0 ? args.slice(0, di) : args).map(x => x.toUpperCase());
const COINS = list.length ? list : cfg.COINS;
const sym = COINS[0];
console.log(`[Selftest] Папка монет: ${cfg.KLINES_DIR}`);
const t0 = Date.now();
let coins;
try { coins = COINS.map(s => loadCoin(s)); }
catch (e) { console.error(e.message); console.error('[Selftest] Проверь путь в RK_KLINES_DIR и имя монеты.'); process.exit(1); }
console.log(`[Selftest] Загружено ${coins.length} монет за ${Date.now() - t0} мс`);
for (const d of coins) console.log(`  ${d.sym}: ${d.n} баров, разрывов ${d.gaps.length}`);

const clock = new Clock(coins);
const iso = x => new Date(x).toISOString().slice(0, 16).replace('T', ' ');
console.log(`[Selftest] Архив ${iso(clock.startT)} → ${iso(clock.lastT)}; граница прошлого ${iso(clock.historyEnd)}`);

const t1 = Date.now();
clock.warmup();
console.log(`[Selftest] Прошлое подано за ${Date.now() - t1} мс, «сейчас» = ${iso(clock.now)}`);

// Анти-подглядывание: ни одна серия не содержит свечей, открытых после «сейчас».
let leak = 0;
for (const s of COINS) for (const tf of cfg.TFS) {
  const se = clock.series(s, tf.name);
  if (se.length && se.t[se.length - 1] + tf.ms > clock.now) leak++;
}
console.log(`[Selftest] Утечек будущего: ${leak}`);

// Незавершённые свечи на границе
for (const tf of cfg.TFS) {
  const p = clock.series(sym, tf.name).partial();
  console.log(`  ${sym} ${tf.name}: закрытых ${clock.series(sym, tf.name).length}, незавершённая: ${p ? iso(p.t) + ' (' + p.n5 + ' из ' + tf.ms / cfg.BASE_MS + ' 5m)' : 'нет'}`);
}

// Шаги: один месяц вперёд, считаем закрытия ТФ
const t2 = Date.now();
const counts = {};
clock.on('bar', ev => { for (const tfs of Object.values(ev.closed)) for (const tf of tfs) counts[tf] = (counts[tf] || 0) + 1; });
const n = clock.runUntil(clock.nextStepEnd());
console.log(`[Selftest] +1 месяц: ${n} шагов за ${Date.now() - t2} мс, «сейчас» = ${iso(clock.now)}; закрытий ТФ (все монеты):`, counts);

// До конца архива и дамп серий для сверки с независимым расчётом
clock.runUntil(Infinity);
const out = {};
for (const tf of cfg.TFS) {
  const se = clock.series(sym, tf.name);
  out[tf.name] = { t: se.t, o: se.o, h: se.h, l: se.l, c: se.c, v: se.v, tbb: se.tbb, incomplete: se.incomplete || [], partial: se.partial() };
}
if (dumpFile) { fs.writeFileSync(dumpFile, JSON.stringify(out)); console.log(`[Selftest] Дамп → ${dumpFile}`); }
console.log('[Selftest] Готово.');
