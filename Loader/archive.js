'use strict';
// ============================================================================
// lib/archive.js — весь доступ к диску RK_DATA_v3 в одном месте.
// Это тот самый "сменный модуль-источник": сейчас читает/пишет локальный диск,
// позже на сервере за тем же интерфейсом может встать база/API — остальной код
// не меняется.
// ============================================================================
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const cfg = require('../config');
const rkb = require('./rkb');
const log = require('./log');

// --- Утилиты путей ---
function monthKey(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function coinDir(symbol)      { return path.join(cfg.DIR.klines5m, symbol); }
function monthFile(symbol, k) { return path.join(coinDir(symbol), `${k}.bin`); }
function fundingFile(symbol)  { return path.join(cfg.DIR.funding, `${symbol}.json`); }
function ratiosFile(symbol)   { return path.join(cfg.DIR.ratios, `${symbol}.json`); }
function oiFile(symbol)       { return path.join(cfg.DIR.oi, `${symbol}.json`); }

async function ensureDirs() {
  for (const d of [cfg.DATA_DIR, cfg.DIR.klines5m, cfg.DIR.funding, cfg.DIR.ratios, cfg.DIR.oi]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

// --- Список монет, уже присутствующих в архиве (по любой из трёх папок) ---
async function symbolsInArchive() {
  const set = new Set();
  const scan = async (dir, isDir) => {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (isDir && e.isDirectory()) set.add(e.name);
      else if (!isDir && e.isFile() && e.name.endsWith('.json')) set.add(e.name.replace(/\.json$/, ''));
    }
  };
  await scan(cfg.DIR.klines5m, true);
  await scan(cfg.DIR.funding, false);
  await scan(cfg.DIR.ratios, false);
  await scan(cfg.DIR.oi, false);
  return [...set];
}

// --- Свечи: помесячные .bin ---

// Список месячных ключей монеты (отсортированы по возрастанию), напр. ['2026-07','2026-08']
async function candleMonths(symbol) {
  let entries = [];
  try { entries = await fsp.readdir(coinDir(symbol)); } catch (_) { return []; }
  return entries.filter((f) => /^\d{4}-\d{2}\.bin$/.test(f))
    .map((f) => f.replace(/\.bin$/, '')).sort();
}

// Прочитать бары одного месяца
async function readMonth(symbol, key) {
  const buf = await fsp.readFile(monthFile(symbol, key));
  return rkb.decode(buf).bars;
}

// openTime последнего сохранённого бара монеты (или null, если свечей нет)
async function lastCandleTime(symbol) {
  const months = await candleMonths(symbol);
  if (!months.length) return null;
  const bars = await readMonth(symbol, months[months.length - 1]);
  return bars.length ? bars[bars.length - 1][0] : null;
}

// Дописать новые бары в помесячные файлы. Бары уже валидированы (без дыр/дублей).
// Возвращает {written, monthsTouched}.
async function appendCandles(symbol, newBars) {
  if (!newBars.length) return { written: 0, monthsTouched: [] };
  await fsp.mkdir(coinDir(symbol), { recursive: true });

  // Группируем новые бары по месяцу
  const byMonth = new Map();
  for (const b of newBars) {
    const k = monthKey(b[0]);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(b);
  }

  let written = 0;
  const touched = [];
  for (const [k, bars] of [...byMonth.entries()].sort()) {
    let existing = [];
    try { existing = await readMonth(symbol, k); } catch (_) { existing = []; }
    // dedup по openTime (на случай нахлёста)
    const seen = new Set(existing.map((b) => b[0]));
    const add = bars.filter((b) => !seen.has(b[0]));
    if (!add.length) continue;
    const merged = existing.concat(add).sort((a, b) => a[0] - b[0]);
    await fsp.writeFile(monthFile(symbol, k), rkb.encode(merged));
    written += add.length;
    touched.push(k);
  }
  return { written, monthsTouched: touched };
}

// --- JSON-серии (funding / ratios): дозапись в существующий формат ---

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (_) { return null; }
}
async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj), 'utf8');
}

// --- Манифест ---
async function readManifest() {
  return (await readJson(cfg.MANIFEST)) || {
    format: cfg.FORMAT_VERSION,
    rkbVersion: cfg.RKB.VERSION,
    ncols: cfg.RKB.NCOLS,
    columns: cfg.RKB.COLUMNS,
    updated: 0,
    coins: {},   // coins[SYMBOL] = { candles:{first,last,bars,gaps}, funding:{last,n}, ratios:{...}, oi:{last}, status }
  };
}
async function writeManifest(m) {
  m.updated = Date.now();
  await writeJson(cfg.MANIFEST, m);
}

// --- Универсум-снимок (кто и с каким оборотом попал в загрузку) ---
async function readUniverse() { return readJson(cfg.UNIVERSE); }
async function writeUniverse(u) { await writeJson(cfg.UNIVERSE, u); }

module.exports = {
  monthKey, coinDir, monthFile, fundingFile, ratiosFile, oiFile,
  ensureDirs, symbolsInArchive,
  candleMonths, readMonth, lastCandleTime, appendCandles,
  readJson, writeJson, readManifest, writeManifest, readUniverse, writeUniverse,
  exists: (p) => fs.existsSync(p),
  TF_MS: cfg.TF_MS,
};
