// Дамп базы-линии и узлов Этапа 1 (тренажёр v0.4 без изменений) для пробы каналов.
// Запуск: set RK_KLINES_DIR=...  node geo_dump.js SOLUSDT   (TRAINER — путь к папке тренажёра v0.4)
const T=process.env.TRAINER||'../RK_TRAINER';const cfg=require(T+'/config');const {loadCoin,TFSeries}=require(T+'/core/data');const G=require(T+'/core/geometry');
const fs=require('fs');const coin=process.argv[2];
const d=loadCoin(coin);const ser={};for(const tf of cfg.TFS)ser[tf.name]=new TFSeries(tf.name,tf.ms);
for(let j=0;j<d.n;j++){const r=[d.t[j],d.o[j],d.h[j],d.l[j],d.c[j],d.v[j],d.qv[j],d.trades[j],d.tbb[j],d.tbq[j]];for(const k in ser)ser[k].push(...r);}
const out={coin};
for(const tf of ['15m','1h','4h']){const se=ser[tf];const m=G.mapTF(se,tf,{withEdge:false});
  out[tf]={t:se.t,o:se.o,h:se.h,l:se.l,c:se.c,mid:se.mid,tol:m.tol,win:cfg.GEOMETRY.TF[tf].window,nodes:m.nodes,floors:m.floors.map(f=>({lvl:f.lvl,lo:f.lo,hi:f.hi,visits:f.visits,epochs:f.epochs,status:f.status,firstT:f.firstT,lastT:f.lastT}))};
  console.log(coin,tf,'свечей',se.length,'допуск',(m.tol*100).toFixed(2)+'%','узлов',m.nodes.length,'этажей',m.floors.length);}
fs.writeFileSync(`geo_${coin}.json`,JSON.stringify(out));
