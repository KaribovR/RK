'use strict';
// ============================================================================
// lib/log.js — единое логирование с тегом модуля.
// Правило проекта: при ошибке видно МОДУЛЬ и ПРИЧИНУ, а не голое "Error".
// Пример:  log.err('Funding', `сорвалась догрузка ${sym}`, e);
// ============================================================================
const chalk = require('chalk');

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  info(mod, msg)  { console.log(`${chalk.gray(stamp())} ${chalk.cyan('[' + mod + ']')} ${msg}`); },
  ok(mod, msg)    { console.log(`${chalk.gray(stamp())} ${chalk.green('[' + mod + ']')} ${msg}`); },
  warn(mod, msg)  { console.warn(`${chalk.gray(stamp())} ${chalk.yellow('[' + mod + ']')} ⚠ ${msg}`); },
  // err печатает причину из error.message — не проглатывает её
  err(mod, msg, error) {
    const reason = error ? (error.message || String(error)) : '';
    console.error(`${chalk.gray(stamp())} ${chalk.red('[' + mod + ']')} ✗ ${msg}${reason ? ': ' + reason : ''}`);
  },
  // progress без перевода строки (для длинных прогонов по монетам)
  step(mod, msg)  { process.stdout.write(`\r${chalk.gray(stamp())} ${chalk.cyan('[' + mod + ']')} ${msg}   `); },
  nl() { process.stdout.write('\n'); },
  chalk,
};
