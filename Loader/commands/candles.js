'use strict';
// ============================================================================
// commands/candles.js — КНОПКА 1: свечи 5m.
// Первичная закачка (нет истории) ИЛИ догрузка хвоста (есть история).
// Трогает ТОЛЬКО klines_5m/ — funding/ratios не касается физически.
//
// Гарантии:
//  - формирующаяся свеча не сохраняется (отсекаем по времени сервера);
//  - стык проверяется: дыра (остановка биржи) → предупреждение + счётчик в манифест,
//    нахлёст → дедуп; тихой склейки кривых данных нет;
//  - пустой хвост (бары с объёмом 0 в самом конце) НЕ записывается: Binance
//    отдаёт такие бары по остановленному контракту. Пустые бары ВНУТРИ истории
//    (техработы биржи) не трогаются. Отрезанный хвост перекачается в следующий
//    заход и запишется, если к тому времени появится живой бар после него.
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const rkb = require('../lib/rkb');
const archive = require('../lib/archive');
const log = require('../lib/log');

const COL_BASE_VOL = 5;        // индекс baseVol в баре (см. cfg.RKB.COLUMNS)
const DAY_BARS = 86400000 / cfg.TF_MS; // 288 баров в сутках

// Тянем свечи вперёд от startTime до "закрытого сейчас". Пагинация по 1000.
async function fetchForward(symbol, startTime, closedNow) {
  const out = [];
  let cursor = startTime;
  // защита от вечного цикла
  let guard = 0;
  while (cursor <= closedNow && guard < 10000) {
    guard++;
    let raw;
    try {
      raw = await binance.klines(symbol, { startTime: cursor, limit: cfg.KLINES_PAGE_LIMIT });
    } catch (e) {
      log.err('Candles', `догрузка ${symbol} прервана на ${new Date(cursor).toISOString()}`, e);
      break; // сохраним то, что успели; хвост доберётся в следующий заход
    }
    if (!raw || !raw.length) break;

    for (const k of raw) {
      const openTime = +k[0];
      // отсекаем формирующуюся/незакрытую свечу
      if (openTime + cfg.TF_MS > closedNow + 1) continue;
      out.push(rkb.fromKline(k));
    }
    const lastOpen = +raw[raw.length - 1][0];
    if (lastOpen < cursor) break;        // не двигаемся — стоп
    cursor = lastOpen + cfg.TF_MS;       // следующая страница
    if (raw.length < cfg.KLINES_PAGE_LIMIT) break; // дошли до конца доступного
  }
  return out;
}

// Отрезает хвост из баров с нулевым объёмом. Возвращает число отрезанных.
function trimDeadTail(bars) {
  let cut = 0;
  while (bars.length && bars[bars.length - 1][COL_BASE_VOL] === 0) {
    bars.pop();
    cut++;
  }
  return cut;
}

// Обработка одной монеты. Возвращает запись для манифеста.
async function processSymbol(symbol, meta, closedNow) {
  const last = await archive.lastCandleTime(symbol);
  const isFresh = last == null;
  const startTime = isFresh
    ? closedNow - cfg.CANDLE_BACKFILL_DAYS * 86400000
    : last + cfg.TF_MS;

  // Если монета не торгуется и хвоста нет — не долбим API впустую.
  if (!isFresh && startTime > closedNow) {
    return { skipped: true };
  }

  const bars = await fetchForward(symbol, startTime, closedNow);

  // Пустой хвост не пишем (остановленный контракт).
  const cut = trimDeadTail(bars);
  if (cut >= DAY_BARS) {
    log.warn('Candles', `${symbol}: пустой хвост ${cut} баров (~${(cut / DAY_BARS).toFixed(1)} дн, объём 0) не записан — торги стоят?`);
  }

  let gapDetected = false;
  if (!isFresh && bars.length) {
    const firstNew = bars[0][0];
    const expected = last + cfg.TF_MS;
    if (firstNew > expected) {
      const missing = Math.round((firstNew - expected) / cfg.TF_MS);
      gapDetected = true;
      log.warn('Candles', `${symbol}: разрыв ~${missing} баров (остановка биржи?) между ${new Date(expected).toISOString()} и ${new Date(firstNew).toISOString()} — записан в манифест.`);
    }
  }

  let written = 0, monthsTouched = [];
  if (bars.length) {
    ({ written, monthsTouched } = await archive.appendCandles(symbol, bars));
  }

  // сводка по монете для манифеста
  const months = await archive.candleMonths(symbol);
  let first = null, lastT = null, total = 0;
  if (months.length) {
    const fb = await archive.readMonth(symbol, months[0]);
    const lb = await archive.readMonth(symbol, months[months.length - 1]);
    first = fb.length ? fb[0][0] : null;
    lastT = lb.length ? lb[lb.length - 1][0] : null;
    for (const m of months) total += (await archive.readMonth(symbol, m)).length;
  }

  return {
    written, monthsTouched, gapDetected,
    candles: { first, last: lastT, bars: total },
    status: meta && meta.status ? meta.status : 'UNKNOWN',
  };
}

// Главная точка кнопки 1
async function run(symbols, meta) {
  await archive.ensureDirs();
  const manifest = await archive.readManifest();

  let serverNow;
  try { serverNow = await binance.serverTime(); }
  catch (e) { log.err('Candles', 'нет времени сервера, использую локальное', e); serverNow = Date.now(); }
  // «Закрытое сейчас» = последняя граница 5м, полностью прошедшая.
  const closedNow = Math.floor(serverNow / cfg.TF_MS) * cfg.TF_MS - 1;

  let totalWritten = 0, gaps = 0, done = 0;
  for (const sym of symbols) {
    try {
      const r = await processSymbol(sym, meta[sym], closedNow);
      if (r.skipped) { done++; continue; }
      totalWritten += r.written;
      if (r.gapDetected) gaps++;

      manifest.coins[sym] = manifest.coins[sym] || {};
      manifest.coins[sym].candles = r.candles;
      manifest.coins[sym].status = r.status;
      if (r.gapDetected) {
        manifest.coins[sym].candles.gaps = (manifest.coins[sym].candles.gaps || 0) + 1;
      }
    } catch (e) {
      log.err('Candles', `монета ${sym} пропущена целиком`, e);
    }
    done++;
    log.step('Candles', `${done}/${symbols.length}  (+${totalWritten} баров, разрывов: ${gaps})  ${sym}`);
  }
  log.nl();
  await archive.writeManifest(manifest);
  log.ok('Candles', `готово: ${done} монет, дописано ${totalWritten} баров, разрывов замечено: ${gaps}.`);
}

module.exports = { run };
