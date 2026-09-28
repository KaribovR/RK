#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rk_steps.py — ЭКСПЕРИМЕНТ (Этап 1). Не трогает rk_baseline / rk_render.
1) Ступени ВНУТРИ ног: грубые ноги (tol_coarse) -> внутри каждой тонкое
   упрощение (tol_fine) -> передышки (встречные зубцы) -> ступени между ними.
   Передышка отмечается «на этаже», если её зона задевает этаж.
2) Кандидаты фигур по узлам + этажам (двойная/тройная вершина/дно,
   перевёрнутая/прямая голова-плечи). Засчитывается только ПРОБОЕМ.
Все допуски черновые, «по глазу».
"""
import numpy as np, pandas as pd
import rk_baseline as B

def _pct(a, b): return (b - a) / a * 100.0

# ---------- НОГИ (грубо) ----------
def legs(nodes, min_pct=6.0):
    seq = [(t, p) for t, p, k in nodes]
    out = []
    for i in range(1, len(seq)):
        (t0, p0), (t1, p1) = seq[i-1], seq[i]
        pc = _pct(p0, p1)
        if abs(pc) >= min_pct:
            out.append(dict(t0=t0, p0=p0, t1=t1, p1=p1, pct=pc, dir='up' if pc > 0 else 'down'))
    return out

# ---------- СТУПЕНИ ВНУТРИ НОГИ ----------
def steps_in_leg(line, leg, tol_fine=0.015, floors_list=(), floor_tol=0.012,
                 slow=0.35, max_counter=0.5, min_step=0.03):
    """Передышка = кусок ноги, где цена шла ПРОТИВ ноги ИЛИ почти стояла
       (скорость в сторону ноги < slow * средней скорости ноги), >=2 бара.
       Ступень = импульсный кусок между передышками."""
    seg = line[(line.index >= leg['t0']) & (line.index <= leg['t1'])]
    if len(seg) < 4: return dict(pauses=[], steps=[])
    fn = [(t, p) for t, p, _ in B.simplify(seg, tol_fine)]
    sgn = 1 if leg['dir'] == 'up' else -1
    total = abs(np.log(leg['p1'] / leg['p0']))
    hrs = lambda a, b: max((b - a).total_seconds() / 3600, 1e-9)
    vleg = total / hrs(leg['t0'], leg['t1'])
    kinds = []
    for (ta, pa), (tb, pb) in zip(fn[:-1], fn[1:]):
        d = sgn * np.log(pb / pa)
        v = d / hrs(ta, tb)
        is_p = (d < 0) or (v < slow * vleg and hrs(ta, tb) >= 2)
        kinds.append(['P' if is_p else 'I', ta, pa, tb, pb])
    # склеить соседние одинаковые
    m = []
    for k in kinds:
        if m and m[-1][0] == k[0]: m[-1][3], m[-1][4] = k[3], k[4]
        else: m.append(k)
    # крайние передышки не считаем (начало/конец ноги)
    while m and m[0][0] == 'P': m.pop(0)
    while m and m[-1][0] == 'P': m.pop()
    # импульс меньше min_step -> растворить в соседних передышках
    changed = True
    while changed:
        changed = False
        for i in range(1, len(m) - 1):
            if m[i][0] == 'I' and abs(np.log(m[i][4] / m[i][2])) < min_step:
                m[i-1][3], m[i-1][4] = m[i+1][3], m[i+1][4]; del m[i:i+2]; changed = True; break
    pauses, steps = [], []
    for k, ta, pa, tb, pb in m:
        if k == 'P':
            sub = seg[(seg.index >= ta) & (seg.index <= tb)]
            lo, hi = float(sub.min()), float(sub.max())
            onf = [f['lvl'] for f in floors_list
                   if f['lvl'] * (1 - floor_tol) <= hi and f['lvl'] * (1 + floor_tol) >= lo]
            pauses.append(dict(ta=ta, tb=tb, lo=lo, hi=hi, pa=pa, pb=pb, on_floor=bool(onf)))
        else:
            steps.append(dict(t0=ta, p0=pa, t1=tb, p1=pb, pct=_pct(pa, pb)))
    if steps:
        med = np.median([abs(s['pct']) for s in steps])
        for s in steps: s['even'] = len(steps) > 1 and abs(abs(s['pct']) / med - 1) <= 0.15
    return dict(pauses=pauses, steps=steps)

# ---------- КАНДИДАТЫ ФИГУР ----------
def figures(nodes, line, eq_tol=0.02, min_depth=0.05, min_width_h=24):
    """Двойная/тройная вершина/дно и голова-плечи по чередующимся H/L.
       Пробой: цена базы-линии ушла за шею (впадину/вершину между) ПОСЛЕ фигуры."""
    hl = [(t, p, k) for t, p, k in nodes if k in ('H', 'L')]
    res = []
    def broke(pts, level, down):
        """Пробой шеи в пределах ширины фигуры и ДО того, как цена обновила её крайнюю точку."""
        t_end = pts[-1][0]; width = t_end - pts[0][0]
        ext = max(p for _, p, _ in pts) if down else min(p for _, p, _ in pts)
        after = line[(line.index > t_end) & (line.index <= t_end + width)]
        for t, p in after.items():
            if (down and p > ext) or (not down and p < ext): return None
            if (down and p < level) or (not down and p > level): return t
        return None
    for i in range(len(hl) - 2):
        a, m, b = hl[i], hl[i+1], hl[i+2]
        if a[2] != b[2] or a[2] == m[2]: continue
        top = a[2] == 'H'
        if abs(np.log(a[1] / b[1])) > eq_tol: continue
        depth = abs(np.log(m[1] / a[1]))
        if depth < min_depth: continue
        # тройная?
        kind = 'двойная вершина' if top else 'двойное дно'
        pts = [a, m, b]
        if i + 4 < len(hl):
            m2, c = hl[i+3], hl[i+4]
            if c[2] == a[2] and abs(np.log(c[1] / a[1])) <= eq_tol:
                kind = 'тройная вершина' if top else 'тройное дно'; pts = [a, m, b, m2, c]
        neck = min(p for _, p, k in pts if k == m[2]) if top else max(p for _, p, k in pts if k == m[2])
        tb = broke(pts, neck, down=top)
        res.append(dict(kind=kind, pts=pts, neck=neck, confirmed=tb is not None, t_break=tb,
                        target=neck * (neck / a[1]) if tb is not None else None))
    # голова-плечи: плечо, голова (выступает), плечо ≈ плечо
    for i in range(len(hl) - 4):
        s1, n1, h, n2, s2 = hl[i:i+5]
        if not (s1[2] == h[2] == s2[2] and n1[2] == n2[2] != s1[2]): continue
        top = s1[2] == 'H'
        if abs(np.log(s1[1] / s2[1])) > eq_tol * 1.5: continue
        stick = np.log(h[1] / max(s1[1], s2[1])) if top else np.log(min(s1[1], s2[1]) / h[1])
        if stick < 0.03: continue
        neck = (n1[1] + n2[1]) / 2
        tb = broke([s1, n1, h, n2, s2], neck, down=top)
        res.append(dict(kind='голова-плечи' if top else 'перевёрнутая голова-плечи',
                        pts=[s1, n1, h, n2, s2], neck=neck, confirmed=tb is not None, t_break=tb,
                        target=neck * (neck / h[1]) if tb is not None else None))
    # мин. ширина и снятие вложенных дублей (оставляем крупную)
    res = [r for r in res if (r['pts'][-1][0] - r['pts'][0][0]) >= pd.Timedelta(hours=min_width_h)]
    res.sort(key=lambda r: -(r['pts'][-1][0] - r['pts'][0][0]))
    keep = []
    for r in res:
        a0, a1 = r['pts'][0][0], r['pts'][-1][0]
        if any(k['pts'][0][0] <= a0 and a1 <= k['pts'][-1][0] for k in keep): continue
        keep.append(r)
    return sorted(keep, key=lambda r: r['pts'][0][0])
