'use strict';
// ============================================================================
// commands/trimdead.js — разовая уборка "мусорного хвоста" свечей.
// Мусорный хвост = бары с объёмом 0 в самом конце архива монеты, длиннее суток
// (контракт остановлен, а Binance продолжал отдавать пустые бары).
//
//   node index.js trim-dead            — ТОЛЬКО ПОКАЗАТЬ, что будет обрезано
//   node index.js trim-dead --apply    — бэкап затронутых файлов, потом обрезка
//
// Трогает ТОЛЬКО klines_5m/ (и запись candles в манифесте).
// Пустые бары ВНУТРИ истории не трогает. Монету без единого живого бара не трогает.
// Бэкап: <архив>/_backup/trim_<дата-время>/<SYMBOL>/<YYYY-MM>.bin
// ============================================================================
const fsp = require('fs/promises');
const path = require('path');
const cfg = require('../config');
const rkb = require('../lib/rkb');
const archive = require('../lib/archive');
const log = require('../lib/log');

const COL_BASE_VOL = 5;                  // индекс baseVol (cfg.RKB.COLUMNS)
const DAY_BARS = 86400000 / cfg.TF_MS;   // 288
const d = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// Ищем последний бар с объёмом > 0, идя от последнего месяца назад.
// Возвращает { lastLive, liveMonth, liveIndex, tailBars, laterMonths, totalBars } или null.
async function findDeadTail(symbol) {
  const months = await archive.candleMonths(symbol);
  if (!months.length) return null;
  let tailBars = 0;
  for (let mi = months.length - 1; mi >= 0; mi--) {
    const bars = await archive.readMonth(symbol, months[mi]);
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i][COL_BASE_VOL] !== 0) {
        return {
          lastLive: bars[i][0],
          liveMonth: months[mi],
          liveIndex: i,
          tailBars,
          laterMonths: months.slice(mi + 1),
        };
      }
      tailBars++;
    }
  }
  return { lastLive: null, tailBars }; // ни одного живого бара
}

async function trimOne(symbol, t, backupRoot) {
  const bdir = path.join(backupRoot, symbol);
  await fsp.mkdir(bdir, { recursive: true });

  // 1) Бэкап ВСЕХ затронутых файлов до любых изменений
  const affected = [t.liveMonth, ...t.laterMonths];
  for (const k of affected) {
    await fsp.copyFile(archive.monthFile(symbol, k), path.join(bdir, `${k}.bin`));
  }

  // 2) Месяц с последним живым баром — обрезаем после него
  const bars = await archive.readMonth(symbol, t.liveMonth);
  const kept = bars.slice(0, t.liveIndex + 1);
  await fsp.writeFile(archive.monthFile(symbol, t.liveMonth), rkb.encode(kept));

  // 3) Более поздние месяцы — целиком пустые, удаляем (копия в бэкапе)
  for (const k of t.laterMonths) {
    await fsp.unlink(archive.monthFile(symbol, k));
  }
}

async function run(symbols, apply) {
  const list = symbols && symbols.length ? symbols : (await archive.symbolsInArchive()).sort();
  log.info('TrimDead', `${apply ? 'РЕЖИМ ОБРЕЗКИ (--apply)' : 'ТОЛЬКО ПРОСМОТР (ничего не меняю)'}. Монет: ${list.length}`);

  const found = [];
  for (const sym of list) {
    try {
      const t = await findDeadTail(sym);
      if (!t) continue;
      if (t.lastLive === null) {
        log.warn('TrimDead', `${sym}: нет ни одного бара с объёмом — не трогаю, разберёмся отдельно.`);
        continue;
      }
      if (t.tailBars >= DAY_BARS) found.push({ sym, t });
    } catch (e) {
      log.err('TrimDead', `не удалось прочитать свечи ${sym}`, e);
    }
  }

  if (!found.length) { log.ok('TrimDead', 'мусорных хвостов нет — обрезать нечего.'); return; }

  for (const { sym, t } of found) {
    const del = t.laterMonths.length ? `, удалить месяцы: ${t.laterMonths.join(', ')}` : '';
    log.info('TrimDead', `${sym}: последний живой бар ${d(t.lastLive)}, пустой хвост ${t.tailBars} баров (~${(t.tailBars / DAY_BARS).toFixed(1)} дн). Обрезать ${t.liveMonth}${del}.`);
  }

  if (!apply) {
    log.warn('TrimDead', 'Это был просмотр. Чтобы обрезать: node index.js trim-dead --apply');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backupRoot = path.join(cfg.DATA_DIR, '_backup', `trim_${stamp}`);
  const manifest = await archive.readManifest();
  let ok = 0;

  for (const { sym, t } of found) {
    try {
      await trimOne(sym, t, backupRoot);
      const c = manifest.coins[sym] && manifest.coins[sym].candles;
      if (c) {
        c.last = t.lastLive;
        if (typeof c.bars === 'number') c.bars -= t.tailBars;
      }
      ok++;
      log.ok('TrimDead', `${sym}: обрезано ${t.tailBars} пустых баров.`);
    } catch (e) {
      log.err('TrimDead', `не удалось обрезать ${sym} (копии уже в бэкапе, если успели)`, e);
    }
  }
  await archive.writeManifest(manifest);
  log.ok('TrimDead', `готово: обрезано монет ${ok} из ${found.length}. Бэкап: ${backupRoot}`);
}

module.exports = { run };
