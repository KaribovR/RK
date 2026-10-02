'use strict';
// ============================================================================
// core/report.js — ОТЧЁТ прогона (читает человек).
// По каждой точке прогноза — запись «мышления» сканера по шагам (v0.4):
//   1) пробой и ориентир  2) цель и срыв  3) вероятность  4) справочно
//   5) чем кончилось
// Вверху — итоги: сколько точек, какие исходы, по ТФ, вероятности и ориентиру.
// Один и тот же текст идёт в файл report.md и в окно «Отчёт» плеера.
// ============================================================================

const cfg = require('../config');
const { TFN } = require('./forecast');
const FC = cfg.FORECAST;

const pad = n => String(n).padStart(2, '0');
const tstr = t => { const d = new Date(t); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const P = p => (+p).toPrecision(5);
const S = x => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
const dirRu = d => d === 'up' ? 'вверх' : 'вниз';
const shareStr = x => x.n >= FC.MIN_HISTORY ? `дошли ${x.reached} из ${x.n} (${Math.round(x.share * 100)}%)` : `мало истории (${x.n} из нужных ${FC.MIN_HISTORY})`;
const relRu = { 'по': 'по ориентиру', 'против': 'ПРОТИВ ориентира', 'нет': 'ориентира нет' };

function headLine(f) {
  const pr = f.few ? 'мало истории' : `вероятность ${Math.round(f.conf * 100)}%`;
  return `Точка ${f.id} · ${TFN[f.tf]} · ${dirRu(f.dir)} · ${relRu[f.rel]} · ${pr} — ${f.level}`;
}

// Строки мышления (без исхода)
function thinking(f) {
  const out = [];
  const st = f.stats;
  out.push(`Построена ${tstr(f.createdT)} UTC на закрытии ${TFN[f.tf]}, цена ${P(f.price)}.`);
  out.push('1. Пробой');
  out.push(`   Повод: ${f.trigger.text}.`);
  if (f.brokenAll.length > 1) out.push(`   Пройденные зоны: ${f.brokenAll.map(z => `${TFN[z.tf]} ${P(z.lvl)} (эпох ${z.epochs})`).join('; ')}.`);
  if (f.orient) out.push(`   Ориентир ${TFN[f.orient.tf]}: последним пробил зону ${P(f.orient.lvl)} ${dirRu(f.orient.dir)} (${tstr(f.orient.t)}) → ${relRu[f.rel]}.`);
  else out.push(`   Ориентир: старший ТФ ещё не пробивал зону → ориентира нет.`);
  out.push('2. Цель');
  out.push(`   Цель: зона ${TFN[f.target.tf]} ${P(f.target.p)} (эпох ${f.target.epochs}), зона начинается с ${P(f.target.edge)} (${S(f.target.edgePct)}). Почему она: первая впереди не слабее пробитой (${TFN[f.broken.tf]}, эпох ${f.broken.epochs}).`);
  out.push(f.path.length ? `   Остановки по пути (зоны слабее): ${f.path.map(s => `${TFN[s.tf]} ${P(s.p)} (${S(s.pct)}, эпох ${s.epochs})`).join('; ')}.` : '   Остановок по пути нет.');
  out.push(`   Срыв (ложный пробой): закрытие ${f.dir === 'up' ? 'ниже' : 'выше'} ${P(f.behind.invalid)} — дальний край пробитой зоны (${S(f.behind.pct)}).`);
  out.push(`   До зоны цели / до срыва: ${Math.abs(f.target.edgePct).toFixed(1)}% / ${Math.abs(f.behind.pct).toFixed(1)}% = ${f.ratio.toFixed(1)}.`);
  out.push(`3. Вероятность — прошлые пробои монеты на ${TFN[f.tf]} (исход известен до этой точки)`);
  out.push(`   Основная — «${relRu[f.rel]}»: ${shareStr(st.rel)}.`);
  out.push(`   Справочно: «${st.form.val}» — ${shareStr(st.form)}; «${st.energy.val}» — ${shareStr(st.energy)};`);
  out.push(`              «${st.strength.val}» — ${shareStr(st.strength)}; «${st.reach.val}» — ${shareStr(st.reach)}.`);
  out.push('4. Справочно');
  if (f.rhythm) out.push(`   Значимые ноги ${dirRu(f.dir)} на ${TFN[f.tf]}: ${f.rhythm.legsPct.map(S).join(', ')} → обычная ${S(f.rhythm.medPct)}; до цели ${Math.abs(f.target.edgePct).toFixed(1)}% → ${f.factors.reach}.`);
  else out.push(`   Ритм не считается: меньше ${FC.RHYTHM_MIN} значимых ног ${dirRu(f.dir)} на ${TFN[f.tf]}.`);
  out.push('   Пустота: нет (цель внутри истории монеты).');
  out.push(`   Обычный ход монеты за ${f.horizonH} ч: ~${f.typMovePct.toFixed(1)}% → цель ${f.far ? 'ДАЛЕКО (дальше 1,5 обычного хода)' : 'в пределах обычного хода'}.`);
  return out;
}

function outcomeLines(f) {
  if (!f.outcome) return ['5. Чем кончилось: ещё активна (архив закончился).'];
  const o = f.outcome;
  const what = { 'дошла': 'ДОШЛА до зоны цели', 'сорвалась': 'СОРВАЛАСЬ (закрытие за пробитой зоной — ложный пробой)', 'истекла': 'ИСТЕКЛА' }[o.type];
  const lines = [`5. Чем кончилось: ${what} через ${o.hours.toFixed(1)} ч.`];
  lines.push(`   В сторону прогноза прошла ${f.mfePct.toFixed(1)}% (${Math.round(o.progressPct)}% пути до зоны цели), против — ${f.maePct.toFixed(1)}%.`);
  if (f.path.length) lines.push(`   Остановки по пути задеты: ${f.touched.length ? f.touched.map(P).join(', ') : 'ни одной'}.`);
  return lines;
}

// Итоговые таблицы
function summary(all, refusals, figs) {
  const L = [];
  const bucket = f => f.few ? 'мало истории' : f.conf >= FC.BRIGHT_FROM ? '70–100%' : f.conf >= FC.DRAW_FROM ? '50–70%' : '<50%';
  const row = arr => {
    const n = arr.length, c = t => arr.filter(f => f.outcome && f.outcome.type === t).length;
    const a = arr.filter(f => !f.outcome).length;
    return `| ${n} | ${c('дошла')} | ${c('сорвалась')} | ${c('истекла')} | ${a} | ${n - a ? Math.round(c('дошла') / (n - a) * 100) + '%' : '—'} |`;
  };
  L.push('| срез | точек | дошла | сорвалась | истекла | активна | доля «дошла» |', '|---|---|---|---|---|---|---|');
  L.push(`| все ${row(all)}`);
  for (const tf of Object.keys(FC.TF)) for (const b of ['70–100%', '50–70%', '<50%', 'мало истории']) {
    const arr = all.filter(f => f.tf === tf && bucket(f) === b);
    if (arr.length) L.push(`| ${TFN[tf]} ${b} ${row(arr)}`);
  }
  for (const d of ['up', 'down']) { const arr = all.filter(f => f.dir === d); if (arr.length) L.push(`| ${dirRu(d)} ${row(arr)}`); }
  for (const r of ['по', 'против', 'нет']) { const arr = all.filter(f => f.rel === r); if (arr.length) L.push(`| ${relRu[r]} ${row(arr)}`); }
  L.push('');
  const rs = {}; for (const r of refusals) { const k = r.reason.split(':')[0]; rs[k] = (rs[k] || 0) + 1; }
  L.push(`Отказов построить точку: ${refusals.length}${refusals.length ? ' — ' + Object.entries(rs).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}.`);
  L.push('');
  if (figs.length) {
    const reached = figs.filter(g => g.outcome && g.outcome.type === 'цель достигнута').length;
    const onZone = figs.filter(g => g.zonesAtTarget.length).length;
    L.push(`Фигур подтверждено пробоем: ${figs.length}; цель (такая же длина) достигнута в срок: ${reached}; цель попала на живую зону: ${onZone}.`);
  } else L.push('Фигур, подтверждённых пробоем, не было.');
  return L;
}

function figureLines(g) {
  const o = g.outcome;
  return [`Фигура Ф${g.id} · ${TFN[g.tf]} · ${g.kind} · пробой ${tstr(g.tBreak)} · длина ${g.lenPct.toFixed(1)}% · цель ${P(g.target)}`,
    `   Цель на зонах: ${g.zonesAtTarget.length ? g.zonesAtTarget.map(z => TFN[z]).join(', ') : 'нет'}. Итог: ${o ? o.type + (o.type === 'цель достигнута' ? ` через ${o.hours.toFixed(1)} ч` : `, прошла ${Math.round(o.progressPct)}% длины`) : 'ещё в пути'}.`];
}

function markdown(meta, fc) {
  const L = [];
  L.push(`# Отчёт тренажёра — ${meta.coin}`, '');
  L.push(`Логика **${cfg.LOGIC_VERSION}** (только геометрия, без индикаторов). Прошлое до ${meta.historyEnd}, прогон до ${meta.end} (UTC).`);
  L.push(`Повод — пробой зоны своего или старшего ТФ; цель — следующая зона не слабее пробитой; срыв — закрытие за пробитой зоной. Ориентир — ТФ на ступень старше. Вероятность — доля дошедших у прошлых пробоев монеты (разогрев ${FC.WARMUP_DAYS} дней до начала теста; меньше ${FC.MIN_HISTORY} — «мало истории»). На графике — от ${FC.DRAW_FROM * 100}%, ярко — от ${FC.BRIGHT_FROM * 100}%.`, '');
  L.push('## Итоги', '', ...summary(fc.all, fc.refusals, fc.figs), '');
  L.push('## Точки прогноза', '');
  for (const f of fc.all) { L.push(`### ${headLine(f)}`, '', '```', ...thinking(f), ...outcomeLines(f), '```', ''); }
  if (fc.figs.length) { L.push('## Фигуры', ''); for (const g of fc.figs) L.push('```', ...figureLines(g), '```'); L.push(''); }
  if (fc.refusals.length) {
    L.push('## Отказы (почему точка не построена)', '');
    for (const r of fc.refusals) L.push(`- ${tstr(r.createdT)} ${TFN[r.tf]} ${dirRu(r.dir)}: ${r.reason} (повод: ${r.trigger.text})`);
  }
  return L.join('\n');
}

module.exports = { markdown, thinking, outcomeLines, headLine, summary, figureLines };
