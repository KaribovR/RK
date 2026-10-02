'use strict';
// ============================================================================
// core/journal.js — Журнал прогона (отчётность и анализ).
// Каждый прогон — своя папка runs/<дата_время>_<версия логики>/:
//   events.jsonl  — каждое событие отдельной строкой (время, монета, ТФ, что, детали)
//   summary.md    — итог: сколько каких событий по монетам и ТФ, параметры прогона
// Версия логики пишется в каждый файл, чтобы не путать, какая логика что насчитала.
// ============================================================================

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const iso = x => new Date(x).toISOString().slice(0, 16).replace('T', ' ');

function createRun(meta = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const dir = path.join(cfg.RUNS_DIR, `${stamp}_${cfg.LOGIC_VERSION}`);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { throw new Error(`[Journal] Failed to create run folder ${dir}: ${e.message}`); }

  const evPath = path.join(dir, 'events.jsonl');
  const fd = fs.openSync(evPath, 'w');
  const counts = {};        // counts[coin][tf][type]
  let total = 0;

  function write(ev) {
    // ev: { t, coin, tf, type, ...детали }
    const line = JSON.stringify({ time: iso(ev.t), logic: cfg.LOGIC_VERSION, ...ev });
    try { fs.writeSync(fd, line + '\n'); }
    catch (e) { console.error(`[Journal] Failed to write event: ${e.message}`); }
    const c = (counts[ev.coin] ||= {}); const t = (c[ev.tf || '-'] ||= {});
    t[ev.type] = (t[ev.type] || 0) + 1; total++;
  }

  function close(extra = {}) {
    try { fs.closeSync(fd); } catch (e) { console.error(`[Journal] Failed to close events file: ${e.message}`); }
    const lines = [];
    lines.push(`# Прогон тренажёра — ${stamp}`, '');
    lines.push(`- Версия логики: **${cfg.LOGIC_VERSION}**`);
    for (const [k, v] of Object.entries({ ...meta, ...extra })) lines.push(`- ${k}: ${v}`);
    lines.push(`- Событий всего: ${total}`, '');
    for (const [coin, byTf] of Object.entries(counts)) {
      lines.push(`## ${coin}`, '', '| ТФ | событие | сколько |', '|---|---|---|');
      for (const [tf, byType] of Object.entries(byTf)) for (const [type, n] of Object.entries(byType)) lines.push(`| ${tf} | ${type} | ${n} |`);
      lines.push('');
    }
    try { fs.writeFileSync(path.join(dir, 'summary.md'), lines.join('\n')); }
    catch (e) { console.error(`[Journal] Failed to write summary: ${e.message}`); }
  }

  return { dir, write, close, get total() { return total; } };
}

module.exports = { createRun };
