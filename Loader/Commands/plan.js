'use strict';
// ============================================================================
// commands/plan.js — оценка ДО запуска: сколько баров/запросов/времени/места
// потребует закачка свечей. Ничего не качает (кроме списка монет и времени).
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const archive = require('../lib/archive');
const log = require('../lib/log');

function fmtN(n) { return Math.round(n).toLocaleString('ru-RU'); }
function fmtDur(sec) {
  if (sec < 60) return `${Math.round(sec)}с`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${(sec / 3600).toFixed(1)} ч`;
}

async function run(symbols) {
  let serverNow;
  try { serverNow = await binance.serverTime(); } catch (_) { serverNow = Date.now(); }
  const closedNow = Math.floor(serverNow / cfg.TF_MS) * cfg.TF_MS - 1;

  let totalBars = 0, fresh = 0, topup = 0;
  for (const sym of symbols) {
    const last = await archive.lastCandleTime(sym);
    let bars;
    if (last == null) { bars = cfg.CANDLE_BACKFILL_DAYS * 288; fresh++; }
    else { bars = Math.max(0, Math.floor((closedNow - last) / cfg.TF_MS)); if (bars > 0) topup++; }
    totalBars += bars;
  }

  const reqs = Math.ceil(totalBars / cfg.KLINES_PAGE_LIMIT) + symbols.length;
  // Оценка времени: по латентности (~0.4с/запрос) и по весу (10/запрос при лимите ~2000/мин)
  const byLatency = reqs * 0.4;
  const byWeight = reqs * 10 / (cfg.WEIGHT_SOFT_STOP) * 60;
  const eta = Math.max(byLatency, byWeight);
  const sizeMB = totalBars * cfg.RKB.NCOLS * 8 / 1048576;

  log.info('Plan', `монет: ${symbols.length}  (первичных: ${fresh}, догрузка: ${topup})`);
  log.info('Plan', `к загрузке ~${fmtN(totalBars)} баров · ~${fmtN(reqs)} запросов · ~${sizeMB.toFixed(0)} МБ · ~${fmtDur(eta)}`);
  if (fresh > 20) log.warn('Plan', 'много первичных монет — это долгий заход, оставь комп включённым.');
}

module.exports = { run };
