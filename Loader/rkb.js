'use strict';
// ============================================================================
// lib/rkb.js — бинарный формат RKB1 (расширенный, v2, 10 колонок).
// Самоописан: число колонок и версия лежат в заголовке, поэтому читатель
// НЕ путается между старым (7 кол.) и новым (10 кол.) форматом — это и есть
// защита от бага "поехавших версий".
//
// Раскладка (little-endian):
//   Заголовок 32 байта:
//     0  char[4] "RKB1"
//     4  uint32  версия формата
//     8  uint32  число колонок
//     12 uint32  число баров N
//     16 float64 openTime первого бара
//     24 float64 openTime последнего бара
//   Далее N × NCOLS float64 подряд.
//
// Бар в памяти = обычный массив из NCOLS чисел в порядке cfg.RKB.COLUMNS.
// ============================================================================
const cfg = require('../config');
const { MAGIC, VERSION, NCOLS, HEADER_BYTES } = cfg.RKB;

// bars: массив баров (каждый — массив из NCOLS чисел) → Buffer
function encode(bars) {
  const n = bars.length;
  const buf = Buffer.alloc(HEADER_BYTES + n * NCOLS * 8);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt32LE(VERSION, 4);
  buf.writeUInt32LE(NCOLS, 8);
  buf.writeUInt32LE(n, 12);
  buf.writeDoubleLE(n ? bars[0][0] : 0, 16);
  buf.writeDoubleLE(n ? bars[n - 1][0] : 0, 24);
  let off = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const row = bars[i];
    for (let c = 0; c < NCOLS; c++) {
      buf.writeDoubleLE(row[c], off);
      off += 8;
    }
  }
  return buf;
}

// Buffer → { header, bars }. Бросает ошибку на чужой magic / несовпадении длины.
function decode(buf) {
  if (buf.length < HEADER_BYTES) throw new Error('файл короче заголовка RKB1');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`чужой формат (magic="${magic}", ждали "${MAGIC}")`);
  const version = buf.readUInt32LE(4);
  const ncols = buf.readUInt32LE(8);
  const n = buf.readUInt32LE(12);
  const expected = HEADER_BYTES + n * ncols * 8;
  if (buf.length !== expected) {
    throw new Error(`битая длина: файл ${buf.length} байт, по заголовку ждали ${expected} (n=${n}, ncols=${ncols})`);
  }
  const bars = new Array(n);
  let off = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const row = new Array(ncols);
    for (let c = 0; c < ncols; c++) { row[c] = buf.readDoubleLE(off); off += 8; }
    bars[i] = row;
  }
  return {
    header: {
      version, ncols, n,
      firstOpenTime: buf.readDoubleLE(16),
      lastOpenTime: buf.readDoubleLE(24),
    },
    bars,
  };
}

// Маппинг сырого kline Binance → бар нашего формата (10 колонок).
// Индексы Binance: 0 openTime,1 o,2 h,3 l,4 c,5 vol,7 quoteVol,8 trades,9 takerBuyBase,10 takerBuyQuote
function fromKline(k) {
  return [
    +k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7], +k[8], +k[9], +k[10],
  ];
}

module.exports = { encode, decode, fromKline, NCOLS, VERSION };
