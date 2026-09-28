#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rk_io.py — ВВОД ДАННЫХ для движка карты (offline, для проверки глазом Рагима).
Читает архив свечей RKB1 (v1=7 колонок ИЛИ v2=10 колонок — ncols берётся из
заголовка!), ресемплит из 5m в любой ТФ, отсекает аномальные свечи-проколы.

Формат RKB1: заголовок 32 байта [magic "RKB1", uint32 version, uint32 ncols,
uint32 nrows, float64 firstOpenTime, float64 lastOpenTime], далее N×ncols float64.
Колонки v1: openTime,O,H,L,C,baseVol,quoteVol
Колонки v2: openTime,O,H,L,C,baseVol,quoteVol,trades,takerBuyBase,takerBuyQuote
"""
import struct, glob, os
import numpy as np, pandas as pd

HEADER = 32

def read_bin(path):
    """Один .bin -> ndarray [n, ncols]. ncols читается из заголовка."""
    b = open(path, "rb").read()
    if b[0:4] != b"RKB1":
        raise ValueError(f"чужой формат: {b[0:4]!r} в {path}")
    ver, ncols, n = struct.unpack("<III", b[4:16])
    arr = np.frombuffer(b, dtype="<f8", count=n * ncols, offset=HEADER).reshape(n, ncols)
    return arr

def load(folder):
    """Все .bin монеты (папка с помесячными файлами) -> DataFrame 5m по времени.
       Берём только первые 7 колонок (O..quoteVol) — общее у v1 и v2."""
    files = sorted(glob.glob(os.path.join(folder, "*.bin")))
    if not files:
        raise FileNotFoundError(f"нет .bin в {folder}")
    rows = [read_bin(f)[:, :7] for f in files]
    a = np.vstack(rows)
    df = pd.DataFrame({
        "time": pd.to_datetime(a[:, 0], unit="ms", utc=True),
        "Open": a[:, 1], "High": a[:, 2], "Low": a[:, 3], "Close": a[:, 4],
        "Volume": a[:, 5],
    }).drop_duplicates("time").sort_values("time").set_index("time")
    return df

def resample(df, rule):
    """5m -> любой ТФ. Open=first, High=max, Low=min, Close=last, Volume=sum."""
    o = df["Open"].resample(rule).first()
    h = df["High"].resample(rule).max()
    l = df["Low"].resample(rule).min()
    c = df["Close"].resample(rule).last()
    v = df["Volume"].resample(rule).sum()
    return pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": c, "Volume": v}).dropna()

def clean_anomalies(df, factor=8.0):
    """Отсечь флеш-вики: свеча с диапазоном > factor*медианы -> тени ужать к телу.
       Найдено на STRK: свеча 334% за 4ч (10 окт 2025) искажала скелет."""
    df = df.copy()
    rng = (df["High"] - df["Low"]) / df["Low"]
    med = rng.median()
    bad = rng > med * factor
    for i in np.where(bad.values)[0]:
        o, c = df["Open"].iloc[i], df["Close"].iloc[i]
        body_hi, body_lo = max(o, c), min(o, c)
        span = abs(c - o) if abs(c - o) > 0 else body_hi * 0.001
        df.iat[i, df.columns.get_loc("High")] = min(df["High"].iloc[i], body_hi + span * 1.5)
        df.iat[i, df.columns.get_loc("Low")]  = max(df["Low"].iloc[i],  body_lo - span * 1.5)
    return df, int(bad.sum())
