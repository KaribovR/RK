'use strict';
const http = require('http');
const fs = require('fs');
const BASE = 'https://fapi.binance.com';
const CFG = { rank:168, brk:24, holdMs:8*3600*1000, q:0.20, fee:0.0009,
  sessThr:0.45, weekendThr:0.30, topN:150, minVol:5e6,
  pollSec:30, rankMin:60, klimit:200, conc:8, port:8080 };
const STATE_FILE = '/root/rk_state.json';
let S = { started:Date.now(), uni:[], data:{}, armed:{}, leaders:[], laggers:[],
  open:[], trades:[], bal:0, lastRank:0, lastErr:null, price:{}, updated:0, stocks:0 };
try { if (fs.existsSync(STATE_FILE)) { S = Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))); console.log('state restored'); } } catch(e){ console.log('no state:', e.message); }
let saveTimer=null;
function save(){ if(saveTimer)return; saveTimer=setTimeout(()=>{ saveTimer=null;
  try{ if(S.trades.length>2000)S.trades=S.trades.slice(-2000); fs.writeFileSync(STATE_FILE, JSON.stringify(S)); }catch(e){console.log('save err',e.message);} },500); }
async function jget(url){ const r=await fetch(url,{headers:{accept:'application/json'}}); const t=await r.text();
  if(t[0]==='<') throw new Error('HTML (geo-block?)'); return JSON.parse(t); }
async function pool(items, worker, conc){ let i=0; const out=new Array(items.length);
  async function run(){ while(i<items.length){ const k=i++; try{out[k]=await worker(items[k]);}catch(e){out[k]=null;} } }
  await Promise.all(Array.from({length:conc},run)); return out; }
function classify(k){
  let inW=0,tot=0,wend=0,wcnt=0,wday=0,dcnt=0;
  for(const b of k){ const q=+b[7]; const d=new Date(+b[0]); const h=d.getUTCHours(); const dow=d.getUTCDay();
    tot+=q; if(h>=14&&h<20)inW+=q;
    if(dow===0||dow===6){ wend+=q; wcnt++; } else { wday+=q; dcnt++; } }
  const sessShare = tot>0? inW/tot : 1;
  const wendAvg = wcnt>0? wend/wcnt : 0, wdayAvg = dcnt>0? wday/dcnt : 1;
  const weekendRatio = wdayAvg>0? wendAvg/wdayAvg : 1;
  return (sessShare>=CFG.sessThr) || (weekendRatio<CFG.weekendThr);
}
async function refreshRank(){
  const tk = await jget(BASE+'/fapi/v1/ticker/24hr');
  const uni = tk.filter(t=>t.symbol.endsWith('USDT') && +t.quoteVolume>CFG.minVol)
    .sort((a,b)=>+b.quoteVolume-+a.quoteVolume).slice(0,CFG.topN).map(t=>t.symbol);
  const need = CFG.rank+CFG.brk+5; let stocks=0;
  await pool(uni, async sym=>{
    const k = await jget(`${BASE}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=${CFG.klimit}`);
    if(!Array.isArray(k)||k.length<need) return;
    if(classify(k)){ stocks++; delete S.data[sym]; return; }
    const n=k.length, c=+k[n-1][4]; let hh=-Infinity, ll=Infinity;
    for(let i=n-1-CFG.brk;i<n-1;i++){ const H=+k[i][2],L=+k[i][3]; if(H>hh)hh=H; if(L<ll)ll=L; }
    S.data[sym] = { mom: c/(+k[n-1-CFG.rank][4])-1, hh, ll, ts:Date.now() };
  }, CFG.conc);
  const rows = Object.entries(S.data).filter(([s,d])=>Date.now()-d.ts<3*3600*1000);
  rows.sort((a,b)=>a[1].mom-b[1].mom);
  const kk=Math.max(1,Math.floor(rows.length*CFG.q));
  S.laggers = rows.slice(0,kk).map(r=>r[0]);
  S.leaders = rows.slice(-kk).map(r=>r[0]);
  S.uni = uni; S.lastRank=Date.now(); S.stocks=stocks;
  console.log(`rank: crypto ${rows.length}, stocks ${stocks}, leaders ${S.leaders.length}`); save();
}
async function poll(){
  try{
    const pr = await jget(BASE+'/fapi/v1/ticker/price');
    const price={}; for(const t of pr) if(t.symbol.endsWith('USDT')) price[t.symbol]=+t.price;
    S.price=price; S.updated=Date.now(); S.lastErr=null;
    const now=Date.now(); const inTr = new Set(S.open.map(t=>t.sym));
    for(const sym of S.leaders){ const d=S.data[sym], p=price[sym]; if(!d||p==null||inTr.has(sym))continue;
      if(S.armed[sym] && p>d.hh){ S.open.push({sym,dir:'LONG',entry:d.hh,ts:now,mom:d.mom}); inTr.add(sym); S.armed[sym]=false; } }
    for(const sym of S.laggers){ const d=S.data[sym], p=price[sym]; if(!d||p==null||inTr.has(sym))continue;
      if(S.armed[sym] && p<d.ll){ S.open.push({sym,dir:'SHORT',entry:d.ll,ts:now,mom:d.mom}); inTr.add(sym); S.armed[sym]=false; } }
    for(const sym of [...S.leaders,...S.laggers]){ const d=S.data[sym], p=price[sym]; if(d&&p!=null&&p>d.ll&&p<d.hh) S.armed[sym]=true; }
    S.open = S.open.filter(t=>{ const p=price[t.sym]; if(p==null)return true;
      if(now-t.ts < CFG.holdMs) return true;
      const net=(t.dir==='LONG'?(p-t.entry):(t.entry-p))/t.entry - CFG.fee;
      S.bal+=net; S.trades.push({...t,exit:p,net,closed:now}); return false; });
    save();
  }catch(e){ S.lastErr='poll: '+e.message; console.log(S.lastErr); }
}
http.createServer((req,res)=>{
  if(req.url.startsWith('/log.csv')){
    let c='sym,dir,entry,exit,net%,mom7d%,opened,closed\n';
    for(const t of S.trades) c+=`${t.sym},${t.dir},${t.entry},${t.exit},${(t.net*100).toFixed(3)},${(t.mom*100).toFixed(1)},${new Date(t.ts).toISOString()},${new Date(t.closed).toISOString()}\n`;
    res.writeHead(200,{'content-type':'text/csv','access-control-allow-origin':'*'}); res.end(c); return; }
  const wins=S.trades.filter(t=>t.net>0).length;
  const view={ uptimeMin:Math.round((Date.now()-S.started)/60000),
    updatedSecAgo:S.updated?Math.round((Date.now()-S.updated)/1000):null,
    universe:S.uni.length, stocksFiltered:S.stocks, leaders:S.leaders.length, laggers:S.laggers.length,
    openCount:S.open.length, trades:S.trades.length,
    winrate:S.trades.length?Math.round(wins/S.trades.length*100)+'%':'—',
    sumPct:(S.bal*100).toFixed(2)+'%',
    avgPct:S.trades.length?(S.trades.reduce((a,t)=>a+t.net,0)/S.trades.length*100).toFixed(3)+'%':'—',
    lastErr:S.lastErr,
    open:S.open.map(t=>({sym:t.sym,dir:t.dir,entry:t.entry,minsOpen:Math.round((Date.now()-t.ts)/60000)})),
    lastTrades:S.trades.slice(-20).reverse().map(t=>({sym:t.sym,dir:t.dir,net:(t.net*100).toFixed(2)+'%'})) };
  res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'});
  res.end(JSON.stringify(view,null,2));
}).listen(CFG.port, ()=>console.log('status http on :'+CFG.port));
async function main(){
  try{ await refreshRank(); }catch(e){ S.lastErr='rank: '+e.message; console.log(S.lastErr); }
  setInterval(()=>{ if(Date.now()-S.lastRank > CFG.rankMin*60*1000) refreshRank().catch(e=>{S.lastErr='rank: '+e.message;}); }, 60*1000);
  poll(); setInterval(poll, CFG.pollSec*1000);
}
main();
