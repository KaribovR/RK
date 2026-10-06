# ПРОБА: каналы по углам база-линии (только геометрия). y — log(mid) своего ТФ.
import numpy as np
def dp(y,tol):
  """Упрощение линии: оставляет углы, отклонение которых больше tol. Возвращает [(индекс,'H'|'L')]."""
  n=len(y);keep=np.zeros(n,bool);keep[0]=keep[-1]=True;st=[(0,n-1)]
  while st:
    a,b=st.pop()
    if b<=a+1:continue
    x=np.arange(a+1,b);yl=y[a]+(y[b]-y[a])*(x-a)/(b-a);d=np.abs(y[a+1:b]-yl);m=int(np.argmax(d))
    if d[m]>tol:keep[a+1+m]=True;st+=[(a,a+1+m),(a+1+m,b)]
  idx=np.where(keep)[0];out=[]
  for k,i in enumerate(idx):
    if 0<k<len(idx)-1:
      if y[i]>y[idx[k-1]] and y[i]>y[idx[k+1]]:out.append((i,'H'))
      elif y[i]<y[idx[k-1]] and y[i]<y[idx[k+1]]:out.append((i,'L'))
  return out
def fit(y,c,s,e,P):
  """Параллельный канал на отрезке s..e: самый узкий по парам углов; нужно 2+ касания сверху и снизу."""
  H=[i for i,k in c if s<=i<=e and k=='H'];L=[i for i,k in c if s<=i<=e and k=='L']
  if len(H)<2 or len(L)<2:return None
  x=np.arange(s,e+1);ys=y[s:e+1];best=None
  for G in (H,L):
    for a in G:
      for b in G:
        if b<=a:continue
        k=(y[b]-y[a])/(b-a);r=ys-k*x;top,bot=r.max(),r.min();W=top-bot
        if best is None or W<best[1]:best=(k,W,top,bot)
  k,W,top,bot=best
  if W>P['maxW']:return None
  tz=P['touch']*W
  th=[i for i in H if y[i]-k*i>=top-tz];tl=[i for i in L if y[i]-k*i<=bot+tz]
  if len(th)<2 or len(tl)<2:return None
  return dict(k=k,W=W,top=top,bot=bot,th=th,tl=tl)
