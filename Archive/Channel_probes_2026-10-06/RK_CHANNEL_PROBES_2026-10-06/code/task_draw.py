# Каналы по база-линии + пунктир до пробоя (✕) + зоны своего ТФ + живой последний канал до ближайшей зоны (◆)
# Параметры пробы (на глаз): углы dp 0.15*допуск ТФ, ширина <= 0.6*допуск, касание 20% ширины, пробой 15% ширины.
import json,math,numpy as np,datetime as dt,matplotlib;matplotlib.use('Agg')
import matplotlib.pyplot as plt,matplotlib.dates as md,matplotlib.ticker as mt
from chan_geo import dp,fit
MS={'15m':9e5,'1h':36e5,'4h':144e5};DAYS={'4h':30,'1h':10,'15m':1.5};NAME={'4h':'4H','1h':'1H','15m':'15m'}
OUT=0.15
def build(y,P,s0):
  c=[(i,k) for i,k in dp(y,P['fine']) if i>=s0];out=[];si=0;n=len(y)
  while si<len(c):
    s=c[si][0];best=None
    for ej in range(si+3,len(c)):
      e=c[ej][0]
      if e-s>P['maxLen']:break
      f=fit(y,c,s,e,P)
      if f:best=(e,f)
    if best and best[0]-s>=P['minLen']:
      e,f=best;k,W,top,bot=f['k'],f['W'],f['top'],f['bot'];brk=None
      for j in range(e+1,n):
        r=y[j]-k*j
        if r>top+OUT*W or r<bot-OUT*W: brk=j;break
      out.append(dict(s=s,e=e,brk=brk,**f))
      if brk is None:break
      while si<len(c) and c[si][0]<brk: si+=1     # следующий канал — только со стыка, не изнутри
    else: si+=1
  return out
def draw(ax,coin,tf):
  G=json.load(open(f'geo_{coin}.json'))[tf];ms=MS[tf];y=np.log(np.array(G['mid']));n=len(y)
  T=[dt.datetime.utcfromtimestamp((t+ms/2)/1000) for t in G['t']]
  nb=int(DAYS[tf]*86400000/ms);a=n-nb
  P=dict(fine=0.15*G['tol'],maxW=0.6*G['tol'],touch=0.2,minLen=6,maxLen=200)
  ch=build(y,P,max(0,a-3*nb))
  tx=lambda i:T[0]+dt.timedelta(milliseconds=ms*i)
  lo=math.exp(y[a:].min());hi=math.exp(y[a:].max())
  zones=[f for f in G['floors'] if f['hi']>=lo*0.97 and f['lo']<=hi*1.03]
  for f in zones:
    ax.axhspan(f['lo'],f['hi'],color='#ffc85a',alpha=.16);ax.text(T[a],f['lvl'],f" {f['lvl']:.4g}",color='#ffc85a',fontsize=7,va='center')
  ax.plot(T[a:],np.exp(y[a:]),color='#26c6a0',lw=1.3)
  last=None
  for x in ch:
    end=x['brk'] if x['brk'] is not None else n-1
    if end<a: continue
    up=x['k']*(x['e']-x['s']);kind='вверх' if up>x['W']*.5 else 'вниз' if up<-x['W']*.5 else 'плоский'
    col={'вверх':'#5fd38d','вниз':'#ff6b6b'}.get(kind,'#c8d0e0')
    L=lambda j,b:math.exp(x['k']*j+b)
    for b in (x['top'],x['bot']):
      i0=max(x['s'],a)
      if x['e']>=a: ax.plot([tx(i0),tx(x['e'])],[L(i0,b),L(x['e'],b)],color=col,lw=1.8)
      j0=max(x['e'],a);ax.plot([tx(j0),tx(end)],[L(j0,b),L(end,b)],color=col,lw=1.2,ls='--')
    for i in x['th']+x['tl']:
      if i>=a: ax.plot(T[i],math.exp(y[i]),'o',mfc='none',mec=col,ms=6)
    if x['brk'] is not None and x['brk']>=a: ax.plot(T[x['brk']],math.exp(y[x['brk']]),'x',color='#ffd166',ms=10,mew=2)
    last=(x,col)
  note=''
  if last and last[0]['brk'] is not None:
    note=f"; последний канал пробит {tx(last[0]['brk']):%d.%m %H:%M} — живого канала сейчас нет";ax.set_xlim(T[a],T[-1])
  elif last:
    x,col=last;start=n-1;hit=None
    for j in range(start,start+int(3*(x['e']-x['s']))+1):
      for b,nm in ((x['top'],'верх'),(x['bot'],'низ')):
        v=math.exp(x['k']*j+b)
        for f in zones+[f for f in G['floors'] if f not in zones]:
          if f['lo']<=v<=f['hi']: hit=(j,v,nm,f);break
        if hit:break
      if hit:break
    if hit:
      j,v,nm,f=hit
      for b in (x['top'],x['bot']): ax.plot([tx(start),tx(j)],[math.exp(x['k']*start+b),math.exp(x['k']*j+b)],color=col,lw=1,ls=':')
      ax.plot(tx(j),v,'D',color='#ffffff',ms=8)
      ax.annotate(f"{tx(j):%d.%m %H:%M} · {v:.4g}",(tx(j),v),textcoords='offset points',xytext=(6,6),color='#fff',fontsize=8)
      note=f"; последний канал → {nm} граница встречает зону {f['lvl']:.4g} {tx(j):%d.%m %H:%M} UTC"
      ax.set_xlim(T[a],max(T[-1],tx(j))+dt.timedelta(milliseconds=ms*3))
    else:
      note='; последний канал: зоны впереди в пределах 3 длин канала нет';ax.set_xlim(T[a],T[-1])
  ax.set_yscale('log');ax.yaxis.set_major_formatter(mt.FormatStrFormatter('%.4g'));ax.yaxis.set_minor_formatter(mt.FormatStrFormatter('%.4g'))
  ax.tick_params(colors='#aab',labelsize=8);ax.grid(color='#222a38');ax.set_facecolor('#131722')
  ax.xaxis.set_major_formatter(md.DateFormatter('%d.%m' if tf!='15m' else '%d.%m %H:%M'))
  ax.set_title(f"{coin} {NAME[tf]} · последние {DAYS[tf]:g} дн. · зоны только {NAME[tf]}{note}",color='#dde',fontsize=10,loc='left')
if __name__=='__main__':
  for coin in ['SOLUSDT','ENAUSDT','XRPUSDT','STRKUSDT','LTCUSDT']:
    fig,axs=plt.subplots(3,1,figsize=(18,17),facecolor='#131722')
    for ax,tf in zip(axs,['4h','1h','15m']): draw(ax,coin,tf)
    plt.tight_layout();plt.savefig(f'{coin}_каналы_4H_1H_15m.png',dpi=72,facecolor='#131722');plt.close();print(coin,'ok')
