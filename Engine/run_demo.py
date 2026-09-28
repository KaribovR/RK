#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_demo.py — демонстрация Этапа 1 на одной монете.
Запуск:  python3 run_demo.py <папка_с_bin> <ТФ> <допуск_упрощения>
Пример:  python3 run_demo.py /путь/к/STRKUSDT 1h 0.06

Делает: читает 5m -> база-линия по центрам -> сужение до ТФ -> узлы (упрощение)
-> этажи (визиты, живучесть) -> волны -> карта PNG + числовая сводка.
Только для проверки глазом. Боевой сканер не рисует.
"""
import sys
import rk_io, rk_baseline, rk_render

def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "/tmp/strk"
    rule   = sys.argv[2] if len(sys.argv) > 2 else "1h"
    tol    = float(sys.argv[3]) if len(sys.argv) > 3 else 0.06

    df5 = rk_io.load(folder)
    df5, nbad = rk_io.clean_anomalies(df5)
    dfx = rk_io.resample(df5, rule)                 # свечи ТФ (для визитов этажей)
    line = rk_baseline.baseline(df5, rule)          # база-линия

    nodes = rk_baseline.simplify(line, tol)
    fl = rk_baseline.floors(nodes, dfx, rel_tol=0.012, min_visits=3)
    wv = rk_baseline.waves(nodes, min_pct=8.0)

    print(f"=== КАРТА {folder.split('/')[-1]} {rule} (допуск {tol*100:.0f}%) ===")
    print(f"аномальных свечей срезано: {nbad}")
    print(f"узлов линии всего: {len(nodes)}")
    print(f"этажей: {len(fl)}  (живых {sum(f['status']=='жив' for f in fl)}, "
          f"стареют {sum(f['status']=='стареет' for f in fl)}, мёртвых {sum(f['status']=='мёртв' for f in fl)})")
    downs = [w['pct'] for w in wv if w['dir'] == 'down']
    ups   = [w['pct'] for w in wv if w['dir'] == 'up']
    print(f"волны вниз (%): {[round(d) for d in downs]}")
    print(f"волны вверх (%): {[round(u) for u in ups]}")
    cur = line.values[-1]
    print(f"текущая цена: {cur:.5f}")
    print("живые этажи:")
    for f in fl:
        if f['status'] == 'жив':
            print(f"  {f['lvl']:.5f} | визитов {f['visits']:2d} реакций {f['react']:2d} | "
                  f"{(f['lvl']-cur)/cur*100:+.1f}% от цены")

    out = rk_render.render_map(line, nodes, fl, wv, weeks=10,
                               path="/tmp/rk_map.png",
                               title=f"{folder.split('/')[-1]} {rule} — карта на базе-линии (допуск {tol*100:.0f}%)")
    print("картинка:", out)

if __name__ == "__main__":
    main()
