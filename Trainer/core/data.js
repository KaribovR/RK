'use strict';
// ============================================================================
// core/data.js — Данные.
// 1) loadCoin(sym): читает весь архив 5m монеты в колонки (Float64Array).
// 2) TFSeries: серия одного ТФ, которая РАСТЁТ по одной закрытой 5m-свече.
//    Старшая свеча собирается только из закрытых 5m (конституция §4):
//    пока ТФ-свеча не достроена, она «незавершённая» (partial), но каждый её
//    кирпич — закрытая 5m. Одинаково для истории и для живого режима.
// Будущего серия не знает: в неё попадает только то, что подал clock.
// ============================================================================

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const COLS = ['t', 'o', 'h', 'l', 'c', 'v', 'qv', 'trades', 'tbb', 'tbq'];

// ---------------------------------------------------------------------------
// Чтение архива монеты
// ---------------------------------------------------------------------------
function readRkbFile(file) {
  const buf = fs.readFileSync(file);
  const { MAGIC, HEADER_BYTES } = cfg.RKB;
  if (buf.length < HEADER_BYTES) throw new Error('файл короче заголовка');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`чужой формат (magic="${magic}")`);
  const version = buf.readUInt32LE(4);
  const ncols = buf.readUInt32LE(8);
  const n = buf.readUInt32LE(12);
  if (ncols !== cfg.RKB.NCOLS) throw new Error(`ждали ${cfg.RKB.NCOLS} колонок, в файле ${ncols} (версия ${version})`);
  const expected = HEADER_BYTES + n * ncols * 8;
  if (buf.length !== expected) throw new Error(`битая длина: ${buf.length} байт, ждали ${expected}`);
  // Копия в выровненный буфер (смещение исходного Buffer может быть не кратно 8).
  const ab = buf.buffer.slice(buf.byteOffset + HEADER_BYTES, buf.byteOffset + expected);
  return { n, ncols, data: new Float64Array(ab) };
}

// Возвращает { sym, n, t, o, h, l, c, v, qv, trades, tbb, tbq, gaps[] }
function loadCoin(sym) {
  const dir = path.join(cfg.KLINES_DIR, sym);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.bin$/.test(f)).sort();
  } catch (e) {
    throw new Error(`[Data] Failed to read folder ${sym}: ${e.message}`);
  }
  if (!files.length) throw new Error(`[Data] No month files for ${sym} in ${dir}`);

  const parts = [];
  let total = 0;
  for (const f of files) {
    try {
      const p = readRkbFile(path.join(dir, f));
      parts.push(p);
      total += p.n;
    } catch (e) {
      throw new Error(`[Data] Failed to read ${sym}/${f}: ${e.message}`);
    }
  }

  const out = { sym, n: total };
  for (const k of COLS) out[k] = new Float64Array(total);
  let row = 0;
  for (const p of parts) {
    const d = p.data, nc = p.ncols;
    for (let i = 0; i < p.n; i++, row++) {
      const b = i * nc;
      for (let k = 0; k < COLS.length; k++) out[COLS[k]][row] = d[b + k];
    }
  }

  // Проверка непрерывности (разрывы/дубли/обратный ход) — только отчёт, не правка.
  const gaps = [];
  const step = cfg.BASE_MS;
  for (let i = 1; i < total; i++) {
    const dt = out.t[i] - out.t[i - 1];
    if (dt !== step) gaps.push({ at: out.t[i - 1], next: out.t[i], missingBars: dt / step - 1 });
  }
  out.gaps = gaps;
  return out;
}

// ---------------------------------------------------------------------------
// TFSeries — растущая серия одного ТФ
// ---------------------------------------------------------------------------
class TFSeries {
  constructor(name, ms) {
    this.name = name;
    this.ms = ms;
    this.perBar = ms / cfg.BASE_MS;   // сколько 5m внутри одной свечи ТФ
    // Завершённые свечи ТФ (обычные массивы — растут по одной).
    this.t = []; this.o = []; this.h = []; this.l = []; this.c = [];
    this.v = []; this.qv = []; this.trades = []; this.tbb = []; this.tbq = [];
    // mid — база-линия: среднее ЦЕНТРОВ тел 5m внутри свечи ТФ (конституция §6.1.3)
    this.mid = [];
    this.cur = null;        // незавершённая (partial) свеча ТФ или null
  }

  // Подать одну ЗАКРЫТУЮ 5m. Возвращает true, если свеча ТФ этим баром закрылась.
  push(t, o, h, l, c, v, qv, tr, tbb, tbq) {
    const bucket = Math.floor(t / this.ms) * this.ms;   // UTC-выравнивание
    if (this.cur && this.cur.t !== bucket) {
      // Пришёл бар нового окна, а старое не добралось до полной длины —
      // значит внутри был разрыв архива. Закрываем как есть, помечаем.
      this._commit(true);
    }
    if (!this.cur) {
      this.cur = { t: bucket, o, h, l, c, v, qv, trades: tr, tbb, tbq, n5: 1, cs: (o + c) / 2 };
    } else {
      const k = this.cur;
      if (h > k.h) k.h = h;
      if (l < k.l) k.l = l;
      k.c = c; k.v += v; k.qv += qv; k.trades += tr; k.tbb += tbb; k.tbq += tbq; k.n5 += 1; k.cs += (o + c) / 2;
    }
    // Свеча ТФ закрыта, когда подан её последний 5m (по времени, не по счёту).
    if (t + cfg.BASE_MS >= bucket + this.ms) { this._commit(false); return true; }
    return false;
  }

  _commit(incomplete) {
    const k = this.cur;
    this.t.push(k.t); this.o.push(k.o); this.h.push(k.h); this.l.push(k.l); this.c.push(k.c);
    this.v.push(k.v); this.qv.push(k.qv); this.trades.push(k.trades); this.tbb.push(k.tbb); this.tbq.push(k.tbq);
    this.mid.push(k.cs / k.n5);
    if (incomplete || k.n5 !== this.perBar) {
      (this.incomplete || (this.incomplete = [])).push({ t: k.t, n5: k.n5, need: this.perBar });
    }
    this.cur = null;
  }

  get length() { return this.t.length; }

  // Незавершённая свеча (собрана из уже закрытых 5m) — для «живого» взгляда
  // на старших ТФ. null, если последняя свеча ТФ только что закрылась.
  partial() { return this.cur ? { ...this.cur, mid: this.cur.cs / this.cur.n5 } : null; }
}

module.exports = { loadCoin, TFSeries, COLS };
