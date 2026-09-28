'use strict';
// ============================================================================
// commands/funding.js — КНОПКА 2: дозагрузка funding.
// Формат файла (существующий, НЕ меняем):
//   { symbol, updated, n, rows: [[ts, rate], ...] }
// Особенности:
//  - funding отдаётся ВГЛУБЬ → пропущенное можно закрыть задним числом;
//  - шаг непостоянен между монетами (4ч/8ч) → идём "от последней точки вперёд",
//    без предположений об интервале;
//  - трогаем ТОЛЬКО папку funding/.
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const archive = require('../lib/archive');
const log = require('../lib/log');

async function processSymbol(symbol, serverNow) {
  const file = archive.fundingFile(symbol);
  const existing = await archive.readJson(file) || { symbol, updated: 0, n: 0, rows: [] };
  const rows = Array.isArray(existing.rows) ? existing.rows : [];
  const lastTs = rows.length ? rows[rows.length - 1][0] : null;

  const startTime = lastTs != null
    ? lastTs + 1
    : serverNow - cfg.CANDLE_BACKFILL_DAYS * 86400000; // свежая монета — тянем вглубь

  const seen = new Set(rows.map((r) => r[0]));
  const added = [];
  let cursor = startTime, guard = 0;

  while (cursor <= serverNow && guard < 5000) {
    guard++;
    let raw;
    try {
      raw = await binance.fundingRate(symbol, { startTime: cursor, limit: cfg.FUNDING_PAGE_LIMIT });
    } catch (e) {
      log.err('Funding', `догрузка ${symbol} прервана`, e);
      break;
    }
    if (!raw || !raw.length) break;
    for (const f of raw) {
      const ts = +f.fundingTime;
      if (seen.has(ts)) continue;
      seen.add(ts);
      added.push([ts, +f.fundingRate]);
    }
    const lastOpen = +raw[raw.length - 1].fundingTime;
    if (lastOpen < cursor) break;
    cursor = lastOpen + 1;
    if (raw.length < cfg.FUNDING_PAGE_LIMIT) break;
  }

  if (!added.length) return { added: 0, last: lastTs, n: rows.length };

  const merged = rows.concat(added).sort((a, b) => a[0] - b[0]);
  const obj = { symbol, updated: Date.now(), n: merged.length, rows: merged };
  await archive.writeJson(file, obj);
  return { added: added.length, last: merged[merged.length - 1][0], n: merged.length };
}

async function run(symbols) {
  await archive.ensureDirs();
  const manifest = await archive.readManifest();
  let serverNow;
  try { serverNow = await binance.serverTime(); } catch (_) { serverNow = Date.now(); }

  let totalAdded = 0, done = 0;
  for (const sym of symbols) {
    try {
      const r = await processSymbol(sym, serverNow);
      totalAdded += r.added;
      manifest.coins[sym] = manifest.coins[sym] || {};
      manifest.coins[sym].funding = { last: r.last, n: r.n };
    } catch (e) {
      log.err('Funding', `монета ${sym} пропущена`, e);
    }
    done++;
    log.step('Funding', `${done}/${symbols.length}  (+${totalAdded} точек)  ${sym}`);
  }
  log.nl();
  await archive.writeManifest(manifest);
  log.ok('Funding', `готово: ${done} монет, дописано ${totalAdded} точек фандинга.`);
}

module.exports = { run };
