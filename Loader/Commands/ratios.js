'use strict';
// ============================================================================
// commands/ratios.js — КНОПКА 3: дозагрузка ratios.
// Формат файла (существующий, НЕ меняем):
//   { symbol, updated, topAcc:[[ts,v]], topPos:[[ts,v]], global:[[ts,v]], taker:[[ts,v]] }
//
// Загрузка НАЗАД по endTime (как в проверенном старом загрузчике): каждую из
// 4 серий тянем независимо (у taker поле buySellRatio, метки сдвинуты на -1ч),
// сливаем в существующие данные по ts. Окно Binance = 30 дней.
//
// КРИТИЧНО: пропущенное за пределами окна НЕ закрыть -> ГРОМКОЕ предупреждение.
// Трогаем ТОЛЬКО папку ratios/.
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const archive = require('../lib/archive');
const log = require('../lib/log');

const SERIES = [
  { key: 'topAcc', field: 'longShortRatio' },
  { key: 'topPos', field: 'longShortRatio' },
  { key: 'global', field: 'longShortRatio' },
  { key: 'taker',  field: 'buySellRatio'  }, // <- другое поле!
];

async function processSymbol(symbol, serverNow) {
  const file = archive.ratiosFile(symbol);
  const existing = await archive.readJson(file) || { symbol, updated: 0 };
  const windowStart = serverNow - cfg.RATIOS_WINDOW_DAYS * 86400000;

  const report = { added: 0, gapWarnings: [] };
  let changed = false;

  for (const { key, field } of SERIES) {
    const rows = Array.isArray(existing[key]) ? existing[key] : [];
    const lastTs = rows.length ? rows[rows.length - 1][0] : null;

    // Предупреждение о непокрываемом разрыве: последняя точка старше начала окна.
    if (lastTs != null && lastTs < windowStart) {
      const lostDays = ((windowStart - lastTs) / 86400000).toFixed(1);
      report.gapWarnings.push(`${key}: дыра ~${lostDays} дн НЕВОССТАНОВИМА (последняя ${new Date(lastTs).toISOString().slice(0, 10)}, окно с ${new Date(windowStart).toISOString().slice(0, 10)})`);
    }

    // Тянем последние 30 дней назад по endTime, поле -> число.
    let fresh;
    try {
      fresh = await binance.fetchWindowBackward(key, symbol, (x) => [+x.timestamp, +x[field]], serverNow, { tag: 'Ratios' });
    } catch (e) {
      log.err('Ratios', `${symbol}/${key} пропущена`, e);
      continue;
    }
    if (!fresh.size) continue;

    // Слияние в Map по ts
    const map = new Map(rows.map((r) => [r[0], r]));
    const before = map.size;
    for (const [ts, r] of fresh) {
      if (r[1] == null || Number.isNaN(r[1])) continue;
      map.set(ts, r);
    }
    if (map.size === before) continue;
    existing[key] = [...map.values()].sort((a, b) => a[0] - b[0]);
    report.added += map.size - before;
    changed = true;
  }

  if (changed) {
    existing.symbol = symbol;
    existing.updated = Date.now();
    await archive.writeJson(file, existing);
  }

  const lasts = {};
  for (const { key } of SERIES) {
    const rows = existing[key];
    lasts[key] = Array.isArray(rows) && rows.length ? rows[rows.length - 1][0] : null;
  }
  report.lasts = lasts;
  return report;
}

async function run(symbols) {
  await archive.ensureDirs();
  const manifest = await archive.readManifest();
  let serverNow;
  try { serverNow = await binance.serverTime(); } catch (_) { serverNow = Date.now(); }

  let totalAdded = 0, done = 0, warned = 0;
  for (const sym of symbols) {
    try {
      const r = await processSymbol(sym, serverNow);
      totalAdded += r.added;
      if (r.gapWarnings.length) {
        warned++;
        for (const w of r.gapWarnings) log.warn('Ratios', `${sym} - ${w}`);
      }
      manifest.coins[sym] = manifest.coins[sym] || {};
      manifest.coins[sym].ratios = r.lasts;
    } catch (e) {
      log.err('Ratios', `монета ${sym} пропущена`, e);
    }
    done++;
    log.step('Ratios', `${done}/${symbols.length}  (+${totalAdded} точек, дыр: ${warned})  ${sym}`);
  }
  log.nl();
  await archive.writeManifest(manifest);
  log.ok('Ratios', `готово: ${done} монет, дописано ${totalAdded} точек. Монет с невосстановимыми дырами: ${warned}.`);
  if (warned) log.warn('Ratios', 'Дыры выше уже не закрыть. Чтобы не копить новые - дополняй не позже чем раз в 25 дней.');
}

module.exports = { run };
