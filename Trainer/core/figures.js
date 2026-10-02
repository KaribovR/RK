'use strict';
// ============================================================================
// core/figures.js — ФИГУРЫ (часть Этапа 1, геометрия).
// Перенос figures() из Engine/rk_steps.py:
//   двойная/тройная вершина и дно, голова-плечи прямая и перевёрнутая.
// Ищутся по чередующимся вершинам/впадинам (узлам) базы-линии ТФ.
// ЗАСЧИТЫВАЕТСЯ ТОЛЬКО ПРОБОЕМ шеи (конституция): линия ушла за шею после
// фигуры, в пределах её ширины и ДО того, как цена обновила её край.
// ДЛИНА фигуры (от края до шеи, в лог-цене) откладывается от шеи в сторону
// пробоя — это ЦЕЛЬ фигуры («на такую же длину»).
// Видит только прошлое: линия берётся из серии ТФ до «сейчас».
// ============================================================================

const cfg = require('../config');
const F = cfg.FIGURES;

// nodes — узлы из geometry.mapTF (с t, p, kind, edge); line — { t[], p[] } база-линия ТФ до «сейчас»
function findFigures(nodes, line, tfMs, tol) {
  // Допуски фигур — доли от допуска ТФ (на STRK 1H: 2% / 5% / 3% при допуске 6%).
  const EQ = F.EQ_OF_TOL * tol, DEPTH = F.DEPTH_OF_TOL * tol, STICK = F.STICK_OF_TOL * tol;
  const hl = nodes.filter(n => (n.kind === 'H' || n.kind === 'L') && !n.edge);
  const res = [];

  // Пробой шеи: после конца фигуры, в пределах её ширины, до обновления края.
  function broke(pts, neck, down) {
    const tEnd = pts[pts.length - 1].t, width = tEnd - pts[0].t;
    const ext = down ? Math.max(...pts.map(p => p.p)) : Math.min(...pts.map(p => p.p));
    for (let i = 0; i < line.t.length; i++) {
      const t = line.t[i];
      if (t <= tEnd) continue;
      if (t > tEnd + width) break;
      const p = line.p[i];
      if ((down && p > ext) || (!down && p < ext)) return null;
      if ((down && p < neck) || (!down && p > neck)) return t;
    }
    return null;
  }
  function make(kind, pts, neck, top, extreme) {
    const tb = broke(pts, neck, top);
    const len = Math.abs(Math.log(extreme / neck));               // длина фигуры
    const target = top ? neck * Math.exp(-len) : neck * Math.exp(len);
    return { kind, dir: top ? 'down' : 'up', pts: pts.map(p => ({ t: p.t, p: p.p, kind: p.kind })),
             neck, extreme, lenPct: len * 100, target, confirmed: tb != null, tBreak: tb };
  }

  // двойные / тройные
  for (let i = 0; i + 2 < hl.length; i++) {
    const a = hl[i], m = hl[i + 1], b = hl[i + 2];
    if (a.kind !== b.kind || a.kind === m.kind) continue;
    const top = a.kind === 'H';
    if (Math.abs(Math.log(a.p / b.p)) > EQ) continue;
    if (Math.abs(Math.log(m.p / a.p)) < DEPTH) continue;
    let kind = top ? 'двойная вершина' : 'двойное дно';
    let pts = [a, m, b];
    if (i + 4 < hl.length) {
      const m2 = hl[i + 3], c = hl[i + 4];
      if (c.kind === a.kind && Math.abs(Math.log(c.p / a.p)) <= EQ) { kind = top ? 'тройная вершина' : 'тройное дно'; pts = [a, m, b, m2, c]; }
    }
    const necks = pts.filter(p => p.kind === m.kind).map(p => p.p);
    const neck = top ? Math.min(...necks) : Math.max(...necks);
    const edges = pts.filter(p => p.kind === a.kind).map(p => p.p);
    const extreme = top ? Math.max(...edges) : Math.min(...edges);
    res.push(make(kind, pts, neck, top, extreme));
  }
  // голова-плечи
  for (let i = 0; i + 4 < hl.length; i++) {
    const [s1, n1, h, n2, s2] = hl.slice(i, i + 5);
    if (!(s1.kind === h.kind && h.kind === s2.kind && n1.kind === n2.kind && n1.kind !== s1.kind)) continue;
    const top = s1.kind === 'H';
    if (Math.abs(Math.log(s1.p / s2.p)) > EQ * 1.5) continue;
    const stick = top ? Math.log(h.p / Math.max(s1.p, s2.p)) : Math.log(Math.min(s1.p, s2.p) / h.p);
    if (stick < STICK) continue;
    const neck = (n1.p + n2.p) / 2;
    res.push(make(top ? 'голова-плечи' : 'перевёрнутая голова-плечи', [s1, n1, h, n2, s2], neck, top, h.p));
  }
  // мин. ширина; вложенные дубли — оставляем крупную
  const minW = F.MIN_WIDTH_BARS * tfMs;
  const wide = res.filter(r => r.pts[r.pts.length - 1].t - r.pts[0].t >= minW)
    .sort((x, y) => (y.pts[y.pts.length - 1].t - y.pts[0].t) - (x.pts[x.pts.length - 1].t - x.pts[0].t));
  const keep = [];
  for (const r of wide) {
    const a0 = r.pts[0].t, a1 = r.pts[r.pts.length - 1].t;
    if (keep.some(k => k.pts[0].t <= a0 && a1 <= k.pts[k.pts.length - 1].t)) continue;
    keep.push(r);
  }
  return keep.sort((x, y) => x.pts[0].t - y.pts[0].t);
}

// База-линия ТФ до «сейчас» (закрытые + незавершённая) — для проверки пробоя.
function lineOf(se) {
  const t = se.t.slice(), p = se.mid.slice();
  const part = se.partial();
  if (part) { t.push(part.t); p.push(part.mid); }
  return { t, p };
}

module.exports = { findFigures, lineOf };
