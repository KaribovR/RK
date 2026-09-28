const {classify}=require('../engine.js');
const fs=require('fs');
function resample(m5,bucket){const out={};for(let i=0;i<m5.t.length;i++){const b=Math.floor(m5.t[i]/bucket)*bucket;
  if(!out[b])out[b]=[b,m5.o[i],m5.h[i],m5.l[i],m5.c[i],m5.v[i]];
  else{const r=out[b];r[2]=Math.max(r[2],m5.h[i]);r[3]=Math.min(r[3],m5.l[i]);r[4]=m5.c[i];r[5]+=m5.v[i];}}
  const ks=Object.keys(out).map(Number).sort((a,b)=>a-b);
  return {t:ks,o:ks.map(k=>out[k][1]),h:ks.map(k=>out[k][2]),l:ks.map(k=>out[k][3]),c:ks.map(k=>out[k][4]),v:ks.map(k=>out[k][5])};}
// ноги переменной длины (bars[i] 5м-баров на ногу i)
function pathVar(anchors,bars,pad){const o=[],h=[],l=[],c=[],t=[];let ts=1599955200000;const step=300000;let prev=anchors[0];
  for(let a=1;a<anchors.length;a++){const f=anchors[a-1],to=anchors[a],nb=bars[a-1];for(let j=1;j<=nb;j++){const cl=f+(to-f)*j/nb;const op=prev;o.push(op);h.push(Math.max(op,cl)+pad);l.push(Math.min(op,cl)-pad);c.push(cl);t.push(ts);ts+=step;prev=cl;}}
  o.push(prev);h.push(prev+pad);l.push(prev-pad);c.push(prev);t.push(ts);return {o,h,l,c,v:c.map(()=>1),t};}
function tfs(m5){return {m5,m15:resample(m5,900000),h1:resample(m5,3600000),h4:resample(m5,14400000),d1:resample(m5,86400000)};}
function pass(n,cond){console.log((cond?'✓ ПРОШЁЛ':'✗ ПРОВАЛ')+' — '+n);return cond;}
let ok=true;

const BR=JSON.parse(fs.readFileSync('tests/fixtures/BRUSDT_2026-09-15.json','utf8'));
const vBR=classify(BR);
console.log('\nBRUSDT:',JSON.stringify({setup:vBR.setup,side:vBR.side,h4:vBR.h4,consec:vBR.consec,retrace:vBR.retrace}),'|',vBR.reasons.join(' | '));
ok&=pass('BR ≠ PULLBACK',vBR.setup!=='PULLBACK'&&!vBR.enter);

// Здоровый откат: 9 длинных ног тренда (по 180 бар) + короткий чоппи-откат (по 12 бар)
const upA=[100,118,110,138,126,160,145,185,170,205, 200,203,197,199,193];
const upB=[180,180,180,180,180,180,180,180,180, 12,12,12,12,12];
const vUP=classify(tfs(pathVar(upA,upB,0.4)));
console.log('\nЗдоровый откат:',JSON.stringify({setup:vUP.setup,side:vUP.side,h4:vUP.h4,h1:vUP.h1,consec:vUP.consec,retrace:vUP.retrace,k4:vUP.k4}),'|',vUP.reasons.join(' | '));
ok&=pass('здоровый откат = PULLBACK',vUP.setup==='PULLBACK'&&vUP.enter);

// Поздний догон вниз: длинные ноги до самого дна
const dnA=[200,170,182,150,162,128,140,105,116,82,81];
const dnB=[180,180,180,180,180,180,180,180,180,20];
const vDN=classify(tfs(pathVar(dnA,dnB,0.4)));
console.log('\nПоздний догон:',JSON.stringify({setup:vDN.setup,side:vDN.side,h4:vDN.h4,consec:vDN.consec,retrace:vDN.retrace,k4:vDN.k4}),'|',vDN.reasons.join(' | '));
ok&=pass('поздний догон = LATE',vDN.setup==='LATE');

console.log('\n==== '+(ok?'ВСЕ ТЕСТЫ ПРОШЛИ ✓':'ЕСТЬ ПРОВАЛЫ ✗')+' ====');
process.exit(ok?0:1);
