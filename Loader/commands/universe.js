'use strict';
// ============================================================================
// commands/universe.js — кто попадает в загрузку.
// Правило (согласовано): растущее ОБЪЕДИНЕНИЕ =
//   топ-150 по обороту 24ч  ∪  все монеты, уже лежащие в архиве.
// Список только растёт: выпавшие из топа и делистнутые НЕ теряются
// (честный survivorship). Делистнутые помечаются, не удаляются.
// ============================================================================
const cfg = require('../config');
const binance = require('../lib/binance');
const archive = require('../lib/archive');
const log = require('./../lib/log');

/**
 * @returns {
 *   working: [SYMBOL...],           // с чем работаем в этом заходе
 *   meta: { [SYMBOL]: { status, contractType, onboardDate, inTop, inArchive } }
 * }
 */
async function build() {
  const meta = {};

  // 1) exchangeInfo — статус, тип контракта, дата листинга. Источник истины по «жив ли символ».
  let info;
  try {
    info = await binance.exchangeInfo();
  } catch (e) {
    log.err('Universe', 'не удалось получить exchangeInfo', e);
    throw e;
  }
  const tradable = new Set();
  for (const s of info.symbols || []) {
    // Берём только бессрочные USDT-перпы
    const isPerp = s.contractType === 'PERPETUAL';
    const isUsdt = s.quoteAsset === cfg.QUOTE;
    if (!isUsdt) continue;
    meta[s.symbol] = {
      status: s.status,                 // TRADING / SETTLING / ...
      contractType: s.contractType,
      onboardDate: s.onboardDate || null,
      inTop: false, inArchive: false,
    };
    if (isPerp && s.status === 'TRADING') tradable.add(s.symbol);
  }

  // 2) Топ-150 по обороту среди торгуемых
  let top = [];
  let volBySym = {};
  try {
    const tickers = await binance.ticker24hAll();
    const ranked = tickers
      .filter((t) => tradable.has(t.symbol))
      .sort((a, b) => (+b.quoteVolume) - (+a.quoteVolume));
    for (const t of ranked) volBySym[t.symbol] = Math.round(+t.quoteVolume);
    top = ranked.slice(0, cfg.TOP_N_BY_VOLUME).map((t) => t.symbol);
  } catch (e) {
    log.err('Universe', 'не удалось получить ticker/24hr — работаем только по архиву', e);
  }
  for (const s of top) { if (meta[s]) meta[s].inTop = true; }

  // 3) Монеты из архива (в т.ч. делистнутые — их может не быть в exchangeInfo)
  const inArch = await archive.symbolsInArchive();
  for (const s of inArch) {
    if (!meta[s]) meta[s] = { status: 'UNKNOWN', contractType: null, onboardDate: null, inTop: false, inArchive: true };
    else meta[s].inArchive = true;
  }

  // 4) Объединение
  const working = [...new Set([...top, ...inArch])];

  const delisted = working.filter((s) => meta[s] && meta[s].status !== 'TRADING' && meta[s].inArchive);
  log.info('Universe', `топ-${cfg.TOP_N_BY_VOLUME}: ${top.length}, в архиве: ${inArch.length}, объединение: ${working.length}` +
    (delisted.length ? `, из них не-TRADING: ${delisted.length}` : ''));

  // 5) Снимок universe.json (кто и с каким оборотом попал в этот заход).
  // Выпавшие из топа помечаем, но НЕ удаляем — данные остаются (survivorship).
  try {
    const prev = await archive.readUniverse();
    const prevSyms = prev && Array.isArray(prev.symbols) ? prev.symbols.map((s) => s.symbol) : [];
    const dropped = prevSyms.filter((s) => !top.includes(s));
    const snapshot = {
      collected: Date.now(),
      topN: cfg.TOP_N_BY_VOLUME,
      symbols: top.map((s, i) => ({ symbol: s, rank: i + 1, vol24h: volBySym[s] || 0 })),
      union: working,
      dropped,
    };
    await archive.writeUniverse(snapshot);
    if (dropped.length) log.info('Universe', `выпали из топа (данные сохранены): ${dropped.length}`);
  } catch (e) {
    log.err('Universe', 'не удалось записать universe.json', e);
  }

  return { working, meta, top, inArchive: inArch };
}

module.exports = { build };
