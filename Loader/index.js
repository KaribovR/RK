#!/usr/bin/env node
'use strict';
// ============================================================================
// RK_LOADER - index.js
// Диспетчер команд ("кнопок"). Каждая команда = отдельный модуль.
//
//   node index.js candles     - свечи 5m (закачка/догрузка, только klines_5m/)
//   node index.js funding     - дозагрузка funding (глубокая)
//   node index.js ratios      - дозагрузка ratios (окно 30д, предупреждает о дырах)
//   node index.js oi          - дозагрузка Open Interest (окно 30д, предупреждает о дырах)
//   node index.js check       - проверка целостности (только чтение)
//   node index.js plan        - оценка объёма/времени закачки свечей (ничего не качает)
//   node index.js all         - весь цикл: ratios -> oi -> funding -> candles -> check
//   node index.js help
//
// Флаги (для candles/funding/ratios/oi/plan/all):
//   --symbols=BTCUSDT,ETHUSDT   работать по списку, а не по универсуму
//   --archive-only              работать только по монетам из архива (без топ-150)
// ============================================================================
const cfg = require('./config');
const log = require('./lib/log');
const archive = require('./lib/archive');
const universe = require('./commands/universe');
const candles = require('./commands/candles');
const funding = require('./commands/funding');
const ratios = require('./commands/ratios');
const oi = require('./commands/oi');
const integrity = require('./commands/integrity');
const plan = require('./commands/plan');

function parseFlags(argv) {
  const f = { symbols: null, archiveOnly: false };
  for (const a of argv) {
    if (a.startsWith('--symbols=')) f.symbols = a.slice('--symbols='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--archive-only') f.archiveOnly = true;
  }
  return f;
}

async function resolveSymbols(flags) {
  if (flags.symbols) {
    log.info('Universe', `явный список: ${flags.symbols.length} монет.`);
    return { symbols: flags.symbols, meta: {} };
  }
  if (flags.archiveOnly) {
    const inArch = await archive.symbolsInArchive();
    log.info('Universe', `только архив: ${inArch.length} монет.`);
    return { symbols: inArch, meta: {} };
  }
  const u = await universe.build();
  return { symbols: u.working, meta: u.meta };
}

function help() {
  console.log(`
RK_LOADER - история Binance USDT-M Futures -> ${cfg.FORMAT_VERSION}
Папка архива: ${cfg.DATA_DIR}   (переопределяется переменной RK_DATA_DIR)

Команды:
  candles    Свечи 5m: первичная закачка или догрузка хвоста. Ресемплинг в
             15m/1h/4h/1d делает сканер - здесь храним только 5m (10 колонок).
  funding    Дозагрузка ставки финансирования (глубокая история).
  ratios     Дозагрузка long/short + taker (окно 30 дней! предупреждает о дырах).
  oi         Дозагрузка Open Interest (окно 30 дней! предупреждает о дырах).
  check      Проверка целостности архива. Ничего не качает.
  plan       Оценка объёма/времени закачки свечей до запуска.
  all        Весь цикл сразу: ratios -> oi -> funding -> candles -> check.
  help       Эта справка.

Флаги: --symbols=A,B,C  |  --archive-only

ВАЖНО: funding/ratios/oi невосстановимы за пределами их окон (ratios/oi - 30 дней).
Кнопки не трогают чужие папки: candles работает только с klines_5m/, и наоборот.
Обычный порядок раз в 3-4 недели: ratios, oi, funding, candles, check.
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);

  try {
    switch (cmd) {
      case 'candles': { const { symbols, meta } = await resolveSymbols(flags); await candles.run(symbols, meta); break; }
      case 'funding': { const { symbols } = await resolveSymbols(flags); await funding.run(symbols); break; }
      case 'ratios':  { const { symbols } = await resolveSymbols(flags); await ratios.run(symbols); break; }
      case 'oi':      { const { symbols } = await resolveSymbols(flags); await oi.run(symbols); break; }
      case 'plan':    { const { symbols } = await resolveSymbols(flags); await plan.run(symbols); break; }
      case 'check':   await integrity.run(); break;
      case 'all': {
        const { symbols, meta } = await resolveSymbols(flags);
        await ratios.run(symbols);   // сначала невосстановимое (окно 30д)
        await oi.run(symbols);
        await funding.run(symbols);
        await candles.run(symbols, meta);
        await integrity.run();
        break;
      }
      case 'help':
      case undefined:
        help(); break;
      default:
        log.err('Main', `неизвестная команда "${cmd}". Запусти: node index.js help`);
        process.exitCode = 1;
    }
  } catch (e) {
    log.err('Main', 'фатальная ошибка выполнения', e);
    process.exitCode = 1;
  }
}

main();
