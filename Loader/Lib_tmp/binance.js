'use strict';
// ============================================================================
// lib/binance.js — тонкий REST-клиент к Binance USDT-M Futures.
// Отвечает за: соблюдение rate-limit, ретраи с backoff, обёртки эндпоинтов.
// Каждый сетевой запрос обёрнут в try/catch с логом [Binance] причина.
// WS здесь НЕТ — загрузчик работает только по REST (WS будет в живом сканере).
// ============================================================================
const cfg = require('../config');
const log = require('./log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Отслеживаем вес, о котором сообщает сам Binance (заголовок X-MBX-USED-WEIGHT-1M),
// плюс держим минимальный зазор между запросами.
let _lastReqAt = 0;

async function spacing() {
  const dt = Date.now() - _lastReqAt;
  if (dt < cfg.REQ_SPACING_MS) await sleep(cfg.REQ_SPACING_MS - dt);
  _lastReqAt = Date.now();
}

// Собирает URL с query. symbol проходит через encodeURIComponent — критично для
// юникод-монет (龙虾USDT, 牛来USDT), иначе запрос отвалится.
function buildUrl(endpoint, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return cfg.BASE + endpoint + (qs ? '?' + qs : '');
}

/**
 * Основной запрос с ретраями и уважением к rate-limit.
 * @returns распарсенный JSON, либо бросает ошибку после исчерпания ретраев.
 */
async function request(endpoint, params = {}, { retries = 4, tag = 'Binance' } = {}) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    try {
      await spacing();
      const url = buildUrl(endpoint, params);
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

      // --- Обработка rate-limit по кодам Binance ---
      if (res.status === 429 || res.status === 418) {
        // 429 = превышение лимита, 418 = IP временно забанен.
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 2000 * 2 ** attempt);
        log.warn(tag, `HTTP ${res.status} (rate-limit). Пауза ${Math.round(waitMs / 1000)}с и повтор.`);
        await sleep(waitMs);
        attempt++;
        continue;
      }

      if (!res.ok) {
        // Прочие ошибки (напр. -1121 неизвестный символ у делистнутой монеты).
        let body = '';
        try { body = await res.text(); } catch (_) {}
        throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      }

      // Мягкий тормоз по сообщённому весу — не приближаемся к жёсткому потолку.
      const used = Number(res.headers.get('x-mbx-used-weight-1m')) || 0;
      if (used >= cfg.WEIGHT_SOFT_STOP) {
        log.warn(tag, `Вес ${used}/${cfg.WEIGHT_LIMIT_1M} близко к потолку — пауза 10с.`);
        await sleep(10000);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      // Сетевой сбой/таймаут — backoff и повтор.
      const waitMs = Math.min(30000, 1000 * 2 ** attempt);
      if (attempt < retries) {
        log.warn(tag, `запрос ${endpoint} не удался (попытка ${attempt + 1}/${retries + 1}), повтор через ${Math.round(waitMs / 1000)}с — ${e.message}`);
        await sleep(waitMs);
      }
      attempt++;
    }
  }
  throw new Error(`${endpoint} — исчерпаны ретраи: ${lastErr ? lastErr.message : 'неизвестно'}`);
}

// --- Обёртки конкретных эндпоинтов (проверены по документации) ---

async function serverTime() {
  const d = await request(cfg.ENDPOINTS.time, {}, { tag: 'Binance' });
  return d.serverTime;
}

// exchangeInfo → массив символов с полями status, contractType, onboardDate, quoteAsset
async function exchangeInfo() {
  return request(cfg.ENDPOINTS.exchangeInfo, {}, { tag: 'Binance' });
}

// ticker/24hr без symbol → массив по всем парам (для отбора топ по обороту)
async function ticker24hAll() {
  return request(cfg.ENDPOINTS.ticker24h, {}, { tag: 'Binance' });
}

// klines: [ [openTime,o,h,l,c,vol,closeTime,quoteVol,trades,takerBuyBase,takerBuyQuote,ignore], ... ]
async function klines(symbol, { startTime, endTime, limit } = {}) {
  return request(cfg.ENDPOINTS.klines, {
    symbol, interval: cfg.TF, startTime, endTime,
    limit: limit || cfg.KLINES_PAGE_LIMIT,
  }, { tag: 'Candles' });
}

// fundingRate: [ {symbol, fundingRate, fundingTime, markPrice}, ... ]
async function fundingRate(symbol, { startTime, endTime, limit } = {}) {
  return request(cfg.ENDPOINTS.fundingRate, {
    symbol, startTime, endTime,
    limit: limit || cfg.FUNDING_PAGE_LIMIT,
  }, { tag: 'Funding' });
}

// ratios: одна из 4 серий. field — имя числового поля в ответе:
//   longShortRatio для topAcc/topPos/global, buySellRatio для taker.
async function ratioSeries(kind, symbol, { startTime, endTime, limit } = {}) {
  const endpoint = cfg.ENDPOINTS[kind];
  if (!endpoint) throw new Error(`неизвестная серия ratios: ${kind}`);
  return request(endpoint, {
    symbol, period: cfg.RATIOS_PERIOD, startTime, endTime,
    limit: limit || cfg.RATIOS_PAGE_LIMIT,
  }, { tag: 'Ratios' });
}

/**
 * Оконная загрузка НАЗАД по endTime (как в проверенном старом загрузчике).
 * Годится для любого futures/data-эндпоинта с окном 30 дней (oi + 4 ratios).
 * @param endpointKey ключ из cfg.ENDPOINTS (oi/topAcc/topPos/global/taker)
 * @param mapFn (x) => [ts, ...values]  преобразование строки ответа
 * @returns Map<ts, row>  (ts → строка), уже без дублей
 */
async function fetchWindowBackward(endpointKey, symbol, mapFn, serverNow, { tag = 'Data' } = {}) {
  const endpoint = cfg.ENDPOINTS[endpointKey];
  if (!endpoint) throw new Error(`неизвестный эндпоинт: ${endpointKey}`);
  const windowStart = serverNow - cfg.RATIOS_WINDOW_DAYS * 86400000;
  const map = new Map();
  let end = serverNow;
  for (let page = 0; page < 12; page++) {
    let d;
    try {
      d = await request(endpoint, {
        symbol, period: cfg.RATIOS_PERIOD, limit: cfg.RATIOS_PAGE_LIMIT, endTime: end,
      }, { tag });
    } catch (e) {
      log.err(tag, `${symbol}/${endpointKey} страница прервана`, e);
      break;
    }
    if (!Array.isArray(d) || !d.length) break;
    for (const x of d) { const r = mapFn(x); map.set(r[0], r); }
    const first = +d[0].timestamp;
    if (first <= windowStart) break;   // дошли до края 30-дневного окна
    if (first >= end - 1000) break;    // курсор не двигается — стоп
    end = first - 1;
    if (d.length < cfg.RATIOS_PAGE_LIMIT) break;
  }
  return map;
}

module.exports = {
  sleep, request,
  serverTime, exchangeInfo, ticker24hAll,
  klines, fundingRate, ratioSeries, fetchWindowBackward,
};
