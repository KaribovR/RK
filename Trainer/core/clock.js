'use strict';
// ============================================================================
// core/clock.js — Часы тренажёра.
// Держат весь архив монет, но ОТДАЮТ его сканеру только по одной закрытой
// 5m-свече за шаг — как живой рынок. Всё, что дальше «сейчас», сканеру не видно:
// в серии ТФ попадает только поданное.
//
//   warmup()      — подать первые HISTORY_MONTHS месяцев разом (это «прошлое»,
//                   которое сканер видит сразу).
//   step()        — подать следующую 5m по всем монетам. Событие 'bar'.
//   runUntil(ts)  — шагать до времени ts (кнопка «+ месяц»).
//
// Событие 'bar' несёт, какие ТФ у каждой монеты ЗАКРЫЛИСЬ на этом шаге —
// по ним следующие этапы решают, что пересчитывать (тяжёлое — по закрытию
// старших свечей, лёгкое — на каждом шаге).
// ============================================================================

const { EventEmitter } = require('events');
const cfg = require('../config');
const { TFSeries } = require('./data');

const DAY = 24 * 60 * 60 * 1000;

function addMonthsUTC(ts, months) {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}
function floorDayUTC(ts) { return Math.floor(ts / DAY) * DAY; }

class Clock extends EventEmitter {
  // coins: массив результатов data.loadCoin()
  constructor(coins) {
    super();
    if (!coins.length) throw new Error('[Clock] No coins given');
    this.coins = new Map();
    let minT = Infinity, maxT = -Infinity;
    for (const d of coins) {
      const series = {};
      for (const tf of cfg.TFS) series[tf.name] = new TFSeries(tf.name, tf.ms);
      this.coins.set(d.sym, { data: d, idx: 0, series });
      if (d.t[0] < minT) minT = d.t[0];
      if (d.t[d.n - 1] > maxT) maxT = d.t[d.n - 1];
    }
    this.startT = minT;                               // первый бар архива
    this.lastT = maxT;                                // последний бар архива
    // Граница «прошлого»: начало архива + N месяцев, по началу суток UTC.
    this.historyEnd = floorDayUTC(addMonthsUTC(minT, cfg.HISTORY_MONTHS));
    this.cursor = minT;                               // openTime следующего к подаче 5m
    this.now = minT;                                  // «сейчас» = время закрытия последней поданной 5m
  }

  // Подать один 5m-слот (openTime = this.cursor) всем монетам, у которых он есть.
  _feedSlot(emit) {
    const T = this.cursor;
    const closed = emit ? {} : null;
    for (const [sym, st] of this.coins) {
      const d = st.data;
      // Пропускаем, если у монеты этого бара нет (разрыв или монета моложе).
      while (st.idx < d.n && d.t[st.idx] < T) st.idx++;
      if (st.idx >= d.n || d.t[st.idx] !== T) continue;
      const i = st.idx++;
      const list = emit ? [] : null;
      for (const tf of cfg.TFS) {
        const done = st.series[tf.name].push(
          d.t[i], d.o[i], d.h[i], d.l[i], d.c[i], d.v[i], d.qv[i], d.trades[i], d.tbb[i], d.tbq[i]);
        if (done && emit) list.push(tf.name);
      }
      if (emit) closed[sym] = list;
    }
    this.cursor = T + cfg.BASE_MS;
    this.now = this.cursor;           // бар [T, T+5m) закрыт → «сейчас» = T+5m
    return closed;
  }

  // Прошлое: подать всё до historyEnd разом, без покадровых событий.
  warmup() {
    let bars = 0;
    while (this.cursor + cfg.BASE_MS <= this.historyEnd) { this._feedSlot(false); bars++; }
    this.emit('history', { until: this.now, slots: bars });
    return this.now;
  }

  // Один шаг вперёд. Возвращает null, если архив кончился.
  step() {
    if (this.cursor > this.lastT) return null;
    const closed = this._feedSlot(true);
    const ev = { now: this.now, closed };
    this.emit('bar', ev);
    return ev;
  }

  // Шагать до времени ts (включительно по закрытию). Возвращает число шагов.
  runUntil(ts) {
    let n = 0;
    while (this.now < ts && this.cursor <= this.lastT) { this.step(); n++; }
    return n;
  }

  // Граница «+ N месяцев» от текущего «сейчас».
  nextStepEnd(months = cfg.STEP_MONTHS) { return Math.min(addMonthsUTC(this.now, months), this.lastT + cfg.BASE_MS); }

  series(sym, tf) {
    const st = this.coins.get(sym);
    if (!st) throw new Error(`[Clock] Unknown coin ${sym}`);
    return st.series[tf];
  }

  get finished() { return this.cursor > this.lastT; }
}

module.exports = { Clock, addMonthsUTC, floorDayUTC };
