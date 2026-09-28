#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rk_render.py — отрисовка карты на БАЗЕ-ЛИНИИ (только для человека; боевой сканер
не рисует). Лог-шкала. Линия графика + этажи-зоны (цвет=живучесть) + узлы
(вершины красн/впадины голуб) + волны вниз (оранж стрелки с длиной %).
"""
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter, NullFormatter

def render_map(line, nodes, floors_list, waves_list, weeks=10, path="/tmp/rk_map.png",
               title="RK карта на базе-линии"):
    win = line[line.index >= line.index.max() - pd.Timedelta(weeks=weeks)]
    fig, ax = plt.subplots(figsize=(26, 13))
    ax.set_facecolor("#0b0b0b"); fig.patch.set_facecolor("#0b0b0b")
    ax.plot(win.index, win.values, color="#e8e8e8", lw=1.3, zorder=3)
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(ScalarFormatter()); ax.yaxis.set_minor_formatter(NullFormatter())
    ax.tick_params(colors="#aaa"); [s.set_color("#333") for s in ax.spines.values()]
    ax.grid(True, color="#181818", lw=0.5)
    lo, hi = win.values.min() * 0.95, win.values.max() * 1.05

    # этажи-зоны
    for f in floors_list:
        if not (lo <= f["lvl"] <= hi): continue
        c = {"жив": "#2ecc40", "стареет": "#ff9500", "мёртв": "#8a8a8a"}[f["status"]]
        al = 0.10 if f["status"] != "мёртв" else 0.05
        ax.axhspan(f["lvl"] * 0.994, f["lvl"] * 1.006, color=c, alpha=al, zorder=1)
        ax.axhline(f["lvl"], color=c, lw=0.8, alpha=0.5, zorder=2)
        ax.text(win.index[0], f["lvl"], f" {f['lvl']:.4f} ({f['visits']}в)", color=c, fontsize=8, va="center")

    # узлы линии
    for t, p, k in nodes:
        if t < win.index.min() or not (lo <= p <= hi): continue
        if k == 'H': ax.scatter([t], [p], s=40, color="#ff5555", zorder=5)
        elif k == 'L': ax.scatter([t], [p], s=40, color="#55aaff", zorder=5)

    # волны вниз
    for w in waves_list:
        if w["dir"] != "down" or w["t0"] < win.index.min(): continue
        ax.annotate("", xy=(w["t1"], w["p1"]), xytext=(w["t0"], w["p0"]),
                    arrowprops=dict(arrowstyle="->", color="#ff9500", lw=2), zorder=6)
        tm = w["t0"] + (w["t1"] - w["t0"]) / 2; pm = (w["p0"] * w["p1"]) ** 0.5
        ax.text(tm, pm, f" {w['pct']:.0f}%", color="#ff9500", fontsize=10, zorder=7)

    cur = win.values[-1]
    ax.axhline(cur, color="#00d0ff", lw=1.0, ls=":")
    ax.text(win.index[-1], cur, f" ТЕК {cur:.4f}", color="#00d0ff", fontsize=9, va="bottom", ha="right")
    ax.set_title(title, color="#eee", fontsize=13)
    fig.savefig(path, dpi=105, bbox_inches="tight", facecolor="#0b0b0b")
    plt.close(fig)
    return path
