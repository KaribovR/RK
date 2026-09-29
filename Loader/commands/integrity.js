'use strict';
// ============================================================================
// commands/integrity.js — КНОПКА 4: проверка целостности.
// НИЧЕГО не качает. Только читает архив и отчитывается: где всё цело (зелёное),
// где проблема (красное). Именно эта кнопка ловит невосстановимые дыры ratios
// ДО того, как ты обнаружишь их на бэктесте.
//
// Остановленные монеты (статус в манифесте не TRADING И свечи не обновлялись
// > 2 дней) показываются отдельно серым: для них "дыры" ratios/OI и устаревшие
// свечи — не потеря, а конец торгов. Битые файлы/дубли у них проверяются как обычно.
// ============================================================================
const cfg = require('../config');
const archive = require('../lib/archive');
const rkb = require('../lib/rkb');
const log = require('../lib/log');
const Table = require('cli-table3');
const chalk = require('chalk');

const DAY = 86400000;

// Проверка непрерывности свечей монеты по всем месяцам.
async function checkCandles(symbol) {
  const months = await archive.candleMonths(symbol);
  if (!months.length) return { present: false };
  let bars = [];
  const errors = [];
  for (const m of months) {
    try {
      const b = await archive.readMonth(symbol, m);
      // проверка колонок формата
      // (decode уже проверил magic/длину; тут — актуальность схемы)
      bars = bars.concat(b);
    } catch (e) {
      errors.push(`${m}: ${e.message}`);
    }
  }
  bars.sort((a, b) => a[0] - b[0]);
  let gaps = 0, dups = 0, misalign = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i][0] - bars[i - 1][0];
    if (d === 0) dups++;
    else if (d === cfg.TF_MS) { /* ok */ }
    else if (d > cfg.TF_MS) gaps += Math.round(d / cfg.TF_MS) - 1;
    else misalign++;
  }
  const first = bars.length ? bars[0][0] : null;
  const last = bars.length ? bars[bars.length - 1][0] : null;
  return { present: true, bars: bars.length, first, last, gaps, dups, misalign, errors };
}

async function checkFunding(symbol) {
  const j = await archive.readJson(archive.fundingFile(symbol));
  if (!j || !Array.isArray(j.rows) || !j.rows.length) return { present: false };
  return { present: true, n: j.rows.length, last: j.rows[j.rows.length - 1][0] };
}

async function checkRatios(symbol, now) {
  const j = await archive.readJson(archive.ratiosFile(symbol));
  if (!j) return { present: false };
  const keys = ['topAcc', 'topPos', 'global', 'taker'];
  let minLast = Infinity, anyPresent = false, missingSeries = [];
  for (const k of keys) {
    const rows = j[k];
    if (Array.isArray(rows) && rows.length) { anyPresent = true; minLast = Math.min(minLast, rows[rows.length - 1][0]); }
    else missingSeries.push(k);
  }
  if (!anyPresent) return { present: false };
  const daysLeft = cfg.RATIOS_WINDOW_DAYS - (now - minLast) / DAY;
  return { present: true, minLast, daysLeft, missingSeries };
}

async function checkOi(symbol, now) {
  const j = await archive.readJson(archive.oiFile(symbol));
  if (!j || !Array.isArray(j.oi) || !j.oi.length) return { present: false };
  const last = j.oi[j.oi.length - 1][0];
  const daysLeft = cfg.RATIOS_WINDOW_DAYS - (now - last) / DAY;
  return { present: true, last, daysLeft };
}

async function run() {
  const now = Date.now();

  // Сверка версии формата
  const manifest = await archive.readManifest();
  if (manifest.format !== cfg.FORMAT_VERSION) {
    log.warn('Integrity', `формат манифеста "${manifest.format}" ≠ ожидаемому "${cfg.FORMAT_VERSION}" — возможен чужой/старый архив.`);
  }
  if (manifest.ncols && manifest.ncols !== cfg.RKB.NCOLS) {
    log.warn('Integrity', `в манифесте ncols=${manifest.ncols}, а формат ждёт ${cfg.RKB.NCOLS}.`);
  }

  const symbols = await archive.symbolsInArchive();
  if (!symbols.length) { log.warn('Integrity', 'архив пуст.'); return; }
  symbols.sort();

  const problems = [];
  const stopped = [];
  let okCount = 0;

  for (const sym of symbols) {
    let issue = [];
    const c = await checkCandles(sym);
    const f = await checkFunding(sym);
    const r = await checkRatios(sym, now);
    const o = await checkOi(sym, now);

    // Остановлена = биржа говорит "не TRADING" И свечи давно не обновлялись.
    // (Второе условие страхует от статуса UNKNOWN после запуска с --symbols.)
    const status = manifest.coins && manifest.coins[sym] ? manifest.coins[sym].status : undefined;
    const staleDays = c.present && c.last ? (now - c.last) / DAY : null;
    const isStopped = c.present && status !== 'TRADING' && staleDays !== null && staleDays > 2;

    if (!c.present) issue.push('нет свечей');
    else {
      if (c.errors && c.errors.length) issue.push(`битые .bin (${c.errors.length})`);
      if (c.dups) issue.push(`дубли ${c.dups}`);
      if (c.misalign) issue.push(`несоосность ${c.misalign}`);
      if (!isStopped && staleDays > 2) issue.push(`свечи устарели ${staleDays.toFixed(1)}д`);
    }

    if (isStopped) {
      // Для остановленной монеты окна ratios/OI и свежесть funding не проверяем:
      // новых данных по ней не бывает, это не потеря.
      stopped.push({ sym, c, status: status || 'нет статуса' });
      if (issue.length) problems.push({ sym, c, f, r, o, issue });
      continue;
    }

    if (!f.present) issue.push('нет funding');
    if (!r.present) issue.push('нет ratios');
    else if (r.daysLeft < 3) {
      issue.push(r.daysLeft < 0
        ? chalk.red(`ratios ДЫРА (${Math.abs(r.daysLeft).toFixed(1)}д потеряно)`)
        : chalk.yellow(`ratios: ${r.daysLeft.toFixed(1)}д до потери`));
    }
    if (!o.present) issue.push('нет OI');
    else if (o.daysLeft < 3) {
      issue.push(o.daysLeft < 0
        ? chalk.red(`OI ДЫРА (${Math.abs(o.daysLeft).toFixed(1)}д потеряно)`)
        : chalk.yellow(`OI: ${o.daysLeft.toFixed(1)}д до потери`));
    }

    if (issue.length) {
      problems.push({ sym, c, f, r, o, issue });
    } else {
      okCount++;
    }
  }

  // --- Отчёт ---
  log.nl();
  const d = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '—';
  console.log(chalk.bold(`Архив: ${cfg.DATA_DIR}`));
  console.log(`Монет всего: ${symbols.length}   ${chalk.green('целых: ' + okCount)}   ` +
    `${chalk.gray('остановленных: ' + stopped.length)}   ` +
    `${problems.length ? chalk.red('с проблемами: ' + problems.length) : chalk.green('проблем нет')}`);

  if (stopped.length) {
    for (const s of stopped) {
      console.log(chalk.gray(`  - ${s.sym}: торги остановлены (статус ${s.status}), последний бар ${d(s.c.last)}. Дыры ratios/OI после этой даты — не потеря.`));
    }
  }

  if (problems.length) {
    const t = new Table({
      head: ['Монета', 'Свечи (баров / last)', 'Разрывы', 'Funding', 'Ratios (запас)', 'OI (запас)', 'Проблема'],
      style: { head: ['cyan'] },
      colWidths: [13, 22, 8, 12, 16, 14, 30],
      wordWrap: true,
    });
    for (const p of problems) {
      t.push([
        p.sym,
        p.c.present ? `${p.c.bars} / ${d(p.c.last)}` : '—',
        p.c.present ? String(p.c.gaps) : '—',
        p.f && p.f.present ? d(p.f.last) : chalk.red('нет'),
        p.r && p.r.present ? `${p.r.daysLeft.toFixed(1)}д` : chalk.red('нет'),
        p.o && p.o.present ? `${p.o.daysLeft.toFixed(1)}д` : chalk.red('нет'),
        p.issue.join('; '),
      ]);
    }
    console.log(t.toString());
    log.warn('Integrity', 'Красное по ratios — уже потеряно навсегда. Жёлтое — успей дополнить до потери.');
  }
}

module.exports = { run };
