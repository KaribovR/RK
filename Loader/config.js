'use strict';
// ============================================================================
// RK_LOADER — config.js
// Единственное место с настройками. Меняешь тут — меняется везде.
// ----------------------------------------------------------------------------
// ВАЖНО про стек: этот загрузчик — Node-инструмент, работающий с ЛОКАЛЬНЫМ
// диском (браузер не может писать в папку архива). Он НЕ использует ccxt:
// нужные эндпоинты (klines, fundingRate, 4×ratios) бьются напрямую в fapi,
// как в твоём рабочем сканере — прозрачно и без абстракции, за которой легко
// угадать неверный метод. Зависимости только chalk + cli-table3 (из твоего же
// согласованного набора). Node 18+ (встроенный fetch). Решение по стеку живого
// сканера остаётся открытым — здесь оно ни на что не влияет.
// ============================================================================

const path = require('path');

// --- Корень архива. По умолчанию папка RK_DATA_v3 рядом с загрузчиком. ---
// Можно переопределить переменной окружения:  RK_DATA_DIR=/путь/к/RK_DATA_v3
const DATA_DIR = process.env.RK_DATA_DIR
  ? path.resolve(process.env.RK_DATA_DIR)
  : path.resolve(__dirname, 'RK_DATA_v3');

module.exports = {
  DATA_DIR,

  // Подпапки архива. Каждая кнопка загрузчика трогает ТОЛЬКО свою — это защита
  // от случайного затирания невосстановимых funding/ratios при перекачке свечей.
  DIR: {
    klines5m: path.join(DATA_DIR, 'klines_5m'), // klines_5m/<SYMBOL>/<YYYY-MM>.bin
    funding:  path.join(DATA_DIR, 'funding'),   // funding/<SYMBOL>.json
    ratios:   path.join(DATA_DIR, 'ratios'),    // ratios/<SYMBOL>.json
    oi:       path.join(DATA_DIR, 'oi'),        // oi/<SYMBOL>.json
  },
  MANIFEST: path.join(DATA_DIR, 'manifest.json'),
  UNIVERSE: path.join(DATA_DIR, 'universe.json'),

  // --- Binance USDT-M Futures ---
  BASE: 'https://fapi.binance.com',
  ENDPOINTS: {
    time:        '/fapi/v1/time',
    exchangeInfo:'/fapi/v1/exchangeInfo',
    ticker24h:   '/fapi/v1/ticker/24hr',
    klines:      '/fapi/v1/klines',
    fundingRate: '/fapi/v1/fundingRate',
    // futures/data — окно 30 дней, limit max 500
    oi:     '/futures/data/openInterestHist',           // поля: sumOpenInterest, sumOpenInterestValue
    topAcc: '/futures/data/topLongShortAccountRatio',  // поле ответа: longShortRatio
    topPos: '/futures/data/topLongShortPositionRatio', // поле ответа: longShortRatio
    global: '/futures/data/globalLongShortAccountRatio',// поле ответа: longShortRatio
    taker:  '/futures/data/takerlongshortRatio',        // поле ответа: buySellRatio (!)
  },

  // --- Лимиты запросов (rate limit) ---
  WEIGHT_LIMIT_1M: 2400,   // потолок веса Binance на IP в минуту
  WEIGHT_SOFT_STOP: 2100,  // мягкий тормоз: не даём приблизиться к жёсткому потолку
  REQ_SPACING_MS: 120,     // минимальный зазор между запросами (бережём IP)

  // --- Свечи ---
  TF: '5m',
  TF_MS: 5 * 60 * 1000,          // 300000 — длина 5м-бара
  KLINES_PAGE_LIMIT: 1500,       // max на запрос для futures klines (вес 10) — проверено
  CANDLE_BACKFILL_DAYS: 400,     // глубина первичной закачки, если по монете ещё нет свечей

  // --- Funding: глубокая история, max 1000 на страницу ---
  FUNDING_PAGE_LIMIT: 1000,

  // --- Ratios / OI: окно последних 30 дней, max 500 на запрос ---
  RATIOS_PERIOD: '1h',           // шаг архива ratios = 1 час (как в старом RK_DATA)
  RATIOS_PAGE_LIMIT: 500,
  RATIOS_WINDOW_DAYS: 30,        // жёсткое окно Binance — глубже не отдаёт

  // --- Универсум: топ-N по обороту, объединяемый с архивом (растущее объединение) ---
  TOP_N_BY_VOLUME: 150,
  QUOTE: 'USDT',                 // только *USDT перпы

  // --- Формат RKB1 (расширенный до 10 колонок) ---
  // Заголовок 32 байта, затем N × NCOLS float64 (little-endian).
  RKB: {
    MAGIC: 'RKB1',
    VERSION: 2,   // v1 = старые 7 колонок; v2 = 10 колонок (этот загрузчик)
    NCOLS: 10,
    HEADER_BYTES: 32,
    // Порядок колонок. Индексы Binance kline указаны в скобках.
    COLUMNS: [
      'openTime',       // 0  (k[0])  время открытия, мс
      'open',           // 1  (k[1])
      'high',           // 2  (k[2])
      'low',            // 3  (k[3])
      'close',          // 4  (k[4])
      'baseVol',        // 5  (k[5])  объём в монете
      'quoteVol',       // 6  (k[7])  объём в $
      'trades',         // 7  (k[8])  число сделок  (новое)
      'takerBuyBase',   // 8  (k[9])  taker buy в монете  (для CVD/OrderFlow)
      'takerBuyQuote',  // 9  (k[10]) taker buy в $        (новое, $-CVD)
    ],
  },

  FORMAT_VERSION: 'RK_DATA_v3',  // пишется в manifest; читатель сверяет и отказывается на чужом
};
