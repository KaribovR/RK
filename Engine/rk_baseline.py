#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rk_baseline.py — ТЕКУЩИЙ подход (Этап 1, карта графика).
БАЗА = одна линия по ЦЕНТРАМ тел 5m свечей, суженная до нужного ТФ.
Свечи не рисуем. Изгибы линии = вершины/впадины. По 5m НЕ работаем (только сырьё).

Все допуски «по глазу» — ЧЕРНОВЫЕ, подлежат настройке на результате с Рагимом.
Параметры см. RK_VISION.md §14.
"""
import numpy as np, pandas as pd

# ---------- БАЗА-ЛИНИЯ ----------
def baseline(df5, rule="1h"):
    """Линия по центрам тел 5m -> сужение до ТФ (среднее центров внутри бара)."""
    center5 = (df5["Open"] + df5["Close"]) / 2.0
    line = center5.resample(rule).mean().dropna()
    return line   # pandas Series (index=время, value=цена)

# ---------- УПРОЩЕНИЕ ЛИНИИ (узлы = вершины/впадины) ----------
def simplify(line, tol):
    """Дуглас-Пекер по ЛОГ-цене, вертикальное отклонение, допуск АБСОЛЮТНЫЙ (доля).
       НЕ привязан к диапазону истории (иначе стирает свежую зону).
       Рекомендация: 1H tol=0.05..0.06 (~46 узлов/10нед); 4H грубее (~0.08+)."""
    y = np.log(line.values); x = np.arange(len(y), dtype=float)
    keep = np.zeros(len(y), bool); keep[0] = keep[-1] = True
    st = [(0, len(y) - 1)]
    while st:
        a, b = st.pop()
        if b <= a + 1: continue
        dmax = 0.0; im = a
        for i in range(a + 1, b):
            yl = y[a] + (y[b] - y[a]) * (x[i] - x[a]) / ((x[b] - x[a]) or 1e-9)
            d = abs(y[i] - yl)
            if d > dmax: dmax = d; im = i
        if dmax > tol:
            keep[im] = True; st += [(a, im), (im, b)]
    idx = np.where(keep)[0]
    nodes = [(line.index[i], float(line.values[i])) for i in idx]
    # разметка H/L по чередованию (изгиб вверх=H, вниз=L)
    out = []
    for i, (t, p) in enumerate(nodes):
        if 0 < i < len(nodes) - 1:
            if p > nodes[i-1][1] and p > nodes[i+1][1]: k = 'H'
            elif p < nodes[i-1][1] and p < nodes[i+1][1]: k = 'L'
            else: k = '-'
        else: k = '-'
        out.append((t, p, k))
    return out

# ---------- ЭТАЖИ (сила = число ОТДЕЛЬНЫХ ВИЗИТОВ) ----------
def _distinct_visits(lvl, dfx, tol):
    """Визит = цена вошла в зону этажа, придя ИЗ-ЗА пределов (а не каждый бар).
       Реакция визита = уход от уровня >=3% за 6 баров."""
    H = dfx["High"].values; L = dfx["Low"].values; C = dfx["Close"].values
    idx = dfx.index; n = len(dfx)
    inband = (L <= lvl * (1 + tol)) & (H >= lvl * (1 - tol))
    visits = react = 0; last_i = None; prev = False
    for i in range(n):
        if inband[i] and not prev:
            visits += 1; last_i = i
            if i + 6 < n and np.max(np.abs(C[i+1:i+7] / lvl - 1)) >= 0.03: react += 1
        prev = inband[i]
    last_age = (idx[-1] - idx[last_i]).days if last_i is not None else 999
    return visits, react, last_age

def floors(nodes, dfx, rel_tol=0.012, min_visits=3):
    """Этажи из узлов линии: кластеризуем по цене (rel_tol), сила=визиты, живучесть."""
    prices = sorted(p for _, p, _ in nodes)
    if not prices: return []
    clusters = [[prices[0]]]
    for pr in prices[1:]:
        if (pr - clusters[-1][-1]) / clusters[-1][-1] <= rel_tol: clusters[-1].append(pr)
        else: clusters.append([pr])
    out = []
    for c in clusters:
        lvl = float(np.mean(c))
        visits, react, last_age = _distinct_visits(lvl, dfx, rel_tol)
        if visits < min_visits: continue
        status = "жив" if last_age < 45 else ("стареет" if last_age < 90 else "мёртв")
        out.append({"lvl": round(lvl, 6), "visits": visits, "react": react,
                    "last_age": last_age, "status": status})
    return sorted(out, key=lambda x: -x["lvl"])

# ---------- ВОЛНЫ (ритм: вершина->дно и обратно) ----------
def waves(nodes, min_pct=8.0):
    """Волна = узел H -> следующий L (падение) или L -> H (рост).
       Коррекции между волнами в замере НЕ отдельная сущность — это сами волны
       противоположного знака. Возвращаем список ног с длиной в %."""
    seq = [(t, p, k) for t, p, k in nodes if k in ('H', 'L')]
    out = []
    for i in range(1, len(seq)):
        t0, p0, k0 = seq[i-1]; t1, p1, k1 = seq[i]
        if k0 == k1: continue
        pct = (p1 - p0) / p0 * 100.0
        if abs(pct) >= min_pct:
            out.append({"t0": t0, "p0": p0, "t1": t1, "p1": p1,
                        "dir": "down" if pct < 0 else "up", "pct": round(pct, 1)})
    return out
