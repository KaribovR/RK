#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""run_steps.py <папка> <ТФ> <tol_coarse> <tol_fine> <out.png>  — ступени внутри ног + фигуры."""
import sys, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter, NullFormatter
import rk_io, rk_baseline as B, rk_steps as S

folder, rule = sys.argv[1], sys.argv[2]
tc, tf = float(sys.argv[3]), float(sys.argv[4]); out = sys.argv[5]
WEEKS = 10
name = folder.rstrip('/').split('/')[-1]

df5 = rk_io.load(folder); df5, _ = rk_io.clean_anomalies(df5)
dfx = rk_io.resample(df5, rule); line = B.baseline(df5, rule)
nodes_all = B.simplify(line, tc)
fl = B.floors(nodes_all, dfx, rel_tol=0.012, min_visits=3)
t_win = line.index.max() - pd.Timedelta(weeks=WEEKS)
win = line[line.index >= t_win]
nodes = [n for n in nodes_all if n[0] >= t_win]
lg = [dict(t0=w['t0'],p0=w['p0'],t1=w['t1'],p1=w['p1'],pct=w['pct'],dir=w['dir']) for w in B.waves(nodes, min_pct=8.0)]
st = [S.steps_in_leg(line, L, tol_fine=tf, floors_list=fl) for L in lg]
figs = [f for f in S.figures(B.simplify(win, tc * 0.67), line) if f['pts'][0][0] >= t_win and f['confirmed']] if False else [f for f in S.figures(B.simplify(win, tc * 0.67), line) if f['pts'][0][0] >= t_win]

# ---- сводка ----
print(f"=== {name} {rule}: ноги {len(lg)}, грубо {tc}, тонко {tf} ===")
npa = sum(len(s['pauses']) for s in st); nof = sum(p['on_floor'] for s in st for p in s['pauses'])
print(f"передышек {npa}, из них на этаже {nof}")
for L, s in zip(lg, st):
    stp = [round(x['pct']) for x in s['steps']]
    ev = sum(x.get('even', False) for x in s['steps'])
    print(f"{L['t0']:%m-%d %H} {L['dir']:4s} {L['pct']:+5.0f}% | ступеней {len(stp)} {stp} | ровных {ev}/{len(stp)} | "
          f"передышек на этаже {sum(p['on_floor'] for p in s['pauses'])}/{len(s['pauses'])}")
print("фигуры:")
for f in figs:
    print(f"  {f['kind']:26s} {f['pts'][0][0]:%m-%d} → {f['pts'][-1][0]:%m-%d} шея {f['neck']:.5f} "
          f"{'ПРОБОЙ '+f['t_break'].strftime('%m-%d %H') if f['confirmed'] else 'не подтверждена'}"
          f"{'  цель %.5f' % f['target'] if f['target'] else ''}")

# ---- рисунок ----
fig, ax = plt.subplots(figsize=(26, 13))
ax.set_facecolor("#0b0b0b"); fig.patch.set_facecolor("#0b0b0b")
ax.set_yscale("log"); ax.yaxis.set_major_formatter(ScalarFormatter()); ax.yaxis.set_minor_formatter(NullFormatter())
ax.tick_params(colors="#aaa"); [s_.set_color("#333") for s_ in ax.spines.values()]
ax.grid(True, color="#181818", lw=0.5)
lo, hi = win.min() * 0.96, win.max() * 1.04
for f in fl:
    if lo <= f['lvl'] <= hi:
        c = {"жив": "#2ecc40", "стареет": "#ff9500", "мёртв": "#8a8a8a"}[f['status']]
        ax.axhspan(f['lvl'] * 0.994, f['lvl'] * 1.006, color=c, alpha=0.08, zorder=1)
        ax.text(win.index[0], f['lvl'], f" {f['lvl']:.4f} ({f['visits']}в)", color=c, fontsize=8, va="center", alpha=0.8)
ax.plot(win.index, win.values, color="#d8d8d8", lw=1.1, zorder=3)
for L, s in zip(lg, st):
    col = "#ff9500" if L['dir'] == 'down' else "#3ddc97"
    ax.plot([L['t0'], L['t1']], [L['p0'], L['p1']], color=col, lw=0.9, alpha=0.3, ls="--", zorder=2)
    ax.text(L['t1'], L['p1'], f" {abs(L['pct']):.0f}%", color=col, fontsize=9, alpha=0.6)
    for x in s['steps']:                       # ступени
        ax.annotate("", xy=(x['t1'], x['p1']), xytext=(x['t0'], x['p0']),
                    arrowprops=dict(arrowstyle="->", color=col, lw=1.6, alpha=0.95 if x.get('even') else 0.55), zorder=6)
        tm = x['t0'] + (x['t1'] - x['t0']) / 2; pm = (x['p0'] * x['p1']) ** 0.5
        ax.text(tm, pm, f"{abs(x['pct']):.0f}", color=col, fontsize=8, zorder=7,
                fontweight='bold' if x.get('even') else 'normal')
    for p in s['pauses']:                      # передышки = прямоугольник зоны застоя
        ax.fill_between([p['ta'], p['tb']], p['lo'], p['hi'], color="#ffe14d" if p['on_floor'] else "#9a8a3a",
                        alpha=0.55 if p['on_floor'] else 0.35, zorder=5, lw=0)
for f in figs:
    c = "#ff4fd8" if f['confirmed'] else "#7a4a70"
    xs = [q[0] for q in f['pts']]; ys = [q[1] for q in f['pts']]
    ax.plot(xs, ys, color=c, lw=1.2, ls=":", zorder=4)
    ax.hlines(f['neck'], xs[0], (f['t_break'] or xs[-1]), color=c, lw=1.0, zorder=4)
    ax.text(xs[len(xs)//2], max(ys) * 1.012 if f['kind'].startswith(('двойная в', 'тройная в', 'голова')) else min(ys) * 0.985,
            f['kind'] + (" ✓" if f['confirmed'] else " ?"), color=c, fontsize=9, ha="center", zorder=8)
cur = win.values[-1]; ax.axhline(cur, color="#00d0ff", lw=0.8, ls=":")
ax.set_ylim(lo, hi)
ax.set_title(f"{name} {rule} — ступени внутри ног (жёлтые блоки = передышки, ярко = на этаже; жирная цифра = ровная ступень ±15%), фигуры розовым",
             color="#eee", fontsize=12)
fig.savefig(out, dpi=100, bbox_inches="tight", facecolor="#0b0b0b"); plt.close(fig)
print("картинка:", out)
