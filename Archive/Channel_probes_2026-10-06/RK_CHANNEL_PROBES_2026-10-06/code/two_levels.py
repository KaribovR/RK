# Крупные (жёлтые: углы dp 0.5*допуск, ширина <= 2*допуск) и мелкие (синие: 0.15 / 0.6) каналы на одном ТФ
import json,math,numpy as np,datetime as dt,matplotlib;matplotlib.use('Agg')
import matplotlib.pyplot as plt,matplotlib.dates as md,matplotlib.ticker as mt
from task_draw import build,MS
def lines(ax,x,y,a,T,col,lw,ms):
  n=len(y);tx=lambda i:T[0]+dt.timedelta(milliseconds=ms*i);end=x['brk'] if x['brk'] is not None else n-1
  for b in (x['top'],x['bot']):
    i0=max(x['s'],a)
    if x['e']>=a: ax.plot([tx(i0),tx(x['e'])],[math.exp(x['k']*i0+b),math.exp(x['k']*x['e']+b)],color=col,lw=lw)
    j0=max(x['e'],a);ax.plot([tx(j0),tx(end)],[math.exp(x['k']*j0+b),math.exp(x['k']*end+b)],color=col,lw=lw*.7,ls='--')
  if x['brk'] is not None and x['brk']>=a: ax.plot(tx(x['brk']),math.exp(y[x['brk']]),'x',color=col,ms=11,mew=2.2)
fig,axs=plt.subplots(3,1,figsize=(18,16),facecolor='#131722')
for ax,(coin,tf,days) in zip(axs,[('SOLUSDT','4h',30),('SOLUSDT','1h',10),('XRPUSDT','1h',10)]):
  G=json.load(open(f'geo_{coin}.json'))[tf];ms=MS[tf];y=np.log(np.array(G['mid']));n=len(y)
  T=[dt.datetime.utcfromtimestamp((t+ms/2)/1000) for t in G['t']];a=n-int(days*86400000/ms)
  ax.plot(T[a:],np.exp(y[a:]),color='#26c6a0',lw=1.3)
  for P,col,lw in [(dict(fine=0.5*G['tol'],maxW=2.0*G['tol'],touch=0.2,minLen=6,maxLen=400),'#ffe14d',2.0),(dict(fine=0.15*G['tol'],maxW=0.6*G['tol'],touch=0.2,minLen=6,maxLen=200),'#8fb3ff',1.1)]:
    for x in build(y,P,max(0,a-600)):
      if (x['brk'] or n)>=a: lines(ax,x,y,a,T,col,lw,ms)
  ax.set_yscale('log');ax.yaxis.set_major_formatter(mt.FormatStrFormatter('%.4g'));ax.set_facecolor('#131722');ax.tick_params(colors='#aab',labelsize=8)
  ax.grid(color='#222a38');ax.xaxis.set_major_formatter(md.DateFormatter('%d.%m'));ax.set_xlim(T[a],T[-1])
  ax.set_title(f'{coin} {tf.upper()} · жёлтые — крупные, синие — мелкие · ✕ пробой',color='#dde',fontsize=10,loc='left')
plt.tight_layout();plt.savefig('SOL_XRP_два_уровня_каналов.png',dpi=72,facecolor='#131722')
