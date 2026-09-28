'use strict';
// ============================================================================
// commands/oi.js — КНОПКА 5: дозагрузка Open Interest.
// Формат файла (существующий, НЕ меняем):
//   { symbol, updated, oi: [[ts, объём_монет, объём_$], ...] }
// Механика идентична ratios: окно Binance 30 дней, загрузка назад по endTime,
// невосстановимые дыры → предупреждение. Трогаем ТОЛЬКО папку oi/.
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const archive = require('../lib/archive');
const log = require('../lib/log');

async function processSymbol(symbol, serverNow) {
  const file = archive.oiFile(symbol);
  const existing = await archive.readJson(file) || { symbol, updated: 0, oi: [] };
  const rows = Array.isArray(existing.oi) ? existing.oi : [];
  const windowStart = serverNow - cfg.RATIOS_WINDOW_DAYS * 86400000;
  const lastTs = rows.length ? rows[rows.length - 1][0] : null;

  const report = { added: 0, gap: null };
  if (lastTs != null && lastTs < windowStart) {
    const lostDays = ((windowStart - lastTs) / 86400000).toFixed(1);
    report.gap = `дыра ~${lostDays} дн НЕВОССТАНОВИМА (последняя ${new Date(lastTs).toISOString().slice(0, 10)}, окно с ${new Date(windowStart).toISOString().slice(0, 10)})`;
  }

  // строка OI: [ts, sumOpenInterest (монеты), sumOpenInterestValue ($)]
  let fresh;
  try {
    fresh = await binance.fetchWindowBackward('oi', symbol,
      (x) => [+x.timestamp, +x.sumOpenInterest, +x.sumOpenInterestValue], serverNow, { tag: 'OI' });
  } catch (e) {
    log.err('OI', `${symbol} пропущена`, e);
    return report;
  }
  if (fresh.size) {
    const map = new Map(rows.map((r) => [r[0], r]));
    const before = map.size;
    for (const [ts, r] of fresh) {
      if (r[1] == null || Number.isNaN(r[1])) continue;
      map.set(ts, r);
    }
    if (map.size !== before) {
      existing.oi = [...map.values()].sort((a, b) => a[0] - b[0]);
      existing.symbol = symbol;
      existing.updated = Date.now();
      await archive.writeJson(file, existing);
      report.added = map.size - before;
    }
  }

  report.last = existing.oi.length ? existing.oi[existing.oi.length - 1][0] : null;
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
      if (r.gap) { warned++; log.warn('OI', `${sym} — ${r.gap}`); }
      manifest.coins[sym] = manifest.coins[sym] || {};
      manifest.coins[sym].oi = { last: r.last };
    } catch (e) {
      log.err('OI', `монета ${sym} пропущена`, e);
    }
    done++;
    log.step('OI', `${done}/${symbols.length}  (+${totalAdded} точек, дыр: ${warned})  ${sym}`);
  }
  log.nl();
  await archive.writeManifest(manifest);
  log.ok('OI', `готово: ${done} монет, дописано ${totalAdded} точек. Монет с невосстановимыми дырами: ${warned}.`);
  if (warned) log.warn('OI', 'Дыры выше уже не закрыть. Дополняй не позже чем раз в 25 дней.');
}

module.exports = { run };
