// ==== engine.js — чистая структурная логика штурмана. Без DOM. Тестируется в node. ====
// Роли ТФ: 4ч+1д = сторона (bias) по СТРУКТУРЕ; 1ч = режим исполнения; 5м = триггер (позже).
// Откат существует ТОЛЬКО пока 1ч не сломал HL. 1ч против 4ч = не откат, а конфликт.

const closed = b => ({o:b.o.slice(0,-1),h:b.h.slice(0,-1),l:b.l.slice(0,-1),c:b.c.slice(0,-1)}); // без формирующегося бара
const rma=(a,p)=>{if(a.length<p)return[];let r=[a.slice(0,p).reduce((x,y)=>x+y)/p];for(let i=p;i<a.length;i++)r.push((r[r.length-1]*(p-1)+a[i])/p);return r;};
function ATR(b,p=14){const{h,l,c}=b;let tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const r=rma(tr,p);return r.length?r[r.length-1]:(Math.max(...h)-Math.min(...l))/Math.max(1,c.length);}
function bbWidth(b,p=20){const c=b.c;if(c.length<p)return 99;const w=c.slice(-p);const m=w.reduce((a,x)=>a+x)/p;const sd=Math.sqrt(w.reduce((a,x)=>a+(x-m)**2,0)/p);return (sd*4/m)*100;}
function rsiArr(c,p=14){if(c.length<p+1)return c.map(()=>50);let r=Array(p).fill(50),g=0,l=0;for(let i=1;i<=p;i++){let d=c[i]-c[i-1];d>0?g+=d:l-=d;}let ag=g/p,al=l/p;r.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<c.length;i++){let d=c[i]-c[i-1];ag=(ag*(p-1)+Math.max(0,d))/p;al=(al*(p-1)+Math.max(0,-d))/p;r.push(al===0?100:100-100/(1+ag/al));}return r;}
function stochK(c,rp=14,sp=14,kp=3){if(c.length<rp+sp)return 50;const ra=rsiArr(c,rp);let st=[];for(let i=sp-1;i<ra.length;i++){const sl=ra.slice(i-sp+1,i+1),lo=Math.min(...sl),hi=Math.max(...sl);st.push(hi===lo?50:((ra[i]-lo)/(hi-lo))*100);}let k=[];for(let i=kp-1;i<st.length;i++)k.push(st.slice(i-kp+1,i+1).reduce((a,b)=>a+b)/kp);return k.length?k[k.length-1]:50;}

// ---- Зигзаг по ATR: последовательность подтверждённых свингов H/L ----
function structureOf(b, atrMult){
  const {h,l,c}=b, n=c.length;
  if(n<10) return {dir:'RANGE',swings:[],brokeHL:false,brokeLH:false,lastH:null,lastL:null};
  const thr=Math.max(atrMult*ATR(b,14),1e-9);
  let swings=[], trend=0, extP=c[0], extI=0;
  for(let i=1;i<n;i++){
    if(trend>=0){
      if(h[i]>=extP){extP=h[i];extI=i;}
      else if(extP-l[i]>=thr){swings.push({type:'H',price:extP,i:extI});trend=-1;extP=l[i];extI=i;}
    } else {
      if(l[i]<=extP){extP=l[i];extI=i;}
      else if(h[i]-extP>=thr){swings.push({type:'L',price:extP,i:extI});trend=1;extP=h[i];extI=i;}
    }
  }
  // добавляем текущий незакрытый экстремум как ТЕНТАТИВНЫЙ свинг (борьба с лагом зигзага на свежем пике)
  swings.push({type:trend>=0?'H':'L',price:extP,i:extI,tent:true});
  const H=swings.filter(s=>s.type==='H'), L=swings.filter(s=>s.type==='L');
  const Hc=H.filter(s=>!s.tent), Lc=L.filter(s=>!s.tent); // подтверждённые — для направления
  const lastH=H[H.length-1]||null, lastL=L[L.length-1]||null; // вкл. тентативный — для retrace
  const prevH=Hc[Hc.length-1]||null, prevL=Lc[Lc.length-1]||null; // последние ПОДТВЕРЖДЁННЫЕ
  let dir='RANGE';
  const cH1=Hc[Hc.length-1],cH2=Hc[Hc.length-2],cL1=Lc[Lc.length-1],cL2=Lc[Lc.length-2];
  if(cH1&&cH2&&cL1&&cL2){
    if(cH1.price>cH2.price && cL1.price>cL2.price) dir='UP';
    else if(cH1.price<cH2.price && cL1.price<cL2.price) dir='DOWN';
  }
  const price=c[n-1];
  const brokeHL = cL1? price<cL1.price : false; // ниже последнего ПОДТВЕРЖДЁННОГО HL
  const brokeLH = cH1? price>cH1.price : false;
  return {dir,swings,lastH,lastL,prevH:cH1,prevL:cL1,brokeHL,brokeLH,price};
}

// ---- retrace последней ноги по свингам ----
function retraceOf(S, price, bias){
  if(bias==='UP'){ if(!S.lastH) return null; // origin = HL перед последним HH
    const origin = (S.lastL&&S.lastL.i<S.lastH.i)?S.lastL.price:(S.prevL?S.prevL.price:null);
    if(origin==null||S.lastH.price<=origin) return null;
    return (S.lastH.price-price)/(S.lastH.price-origin);
  } else if(bias==='DOWN'){ if(!S.lastL) return null;
    const origin=(S.lastH&&S.lastH.i<S.lastL.i)?S.lastH.price:(S.prevH?S.prevH.price:null);
    if(origin==null||origin<=S.lastL.price) return null;
    return (price-S.lastL.price)/(origin-S.lastL.price);
  } return null;
}
// ---- сколько закрытых баров ПОДРЯД против стороны (страховка от лага зигзага) ----
function consecAgainst(b,side){let cnt=0;for(let i=b.c.length-1;i>=0;i--){const against=side>0?b.c[i]<b.o[i]:b.c[i]>b.o[i];if(against)cnt++;else break;}return cnt;}

// ==== КЛАССИФИКАТОР ====
function classify(tfs){
  const H4=closed(tfs.h4), H1=closed(tfs.h1), D1=closed(tfs.d1);
  const S4=structureOf(H4,1.8), S1=structureOf(H1,2.2), Sd=structureOf(D1,1.5);
  const price=H1.c[H1.c.length-1];
  // сторона (bias) — по 4ч, при RANGE подтверждаем дневным
  let bias = S4.dir!=='RANGE'? S4.dir : Sd.dir;
  const reasons=[];
  // SQUEEZE / RANGE, если стороны нет
  if(bias==='RANGE'){
    const sq = bbWidth(H1)<2.2 || bbWidth(H4)<2.2;
    return {setup: sq?'SQUEEZE':'RANGE', side:'MIXED', enter:false, retrace:null, consec:0,
            h4:S4.dir,h1:S1.dir,d1:Sd.dir, reasons:[sq?'сжатие — ждать расширение':'нет стороны — диапазон']};
  }
  const side = bias==='UP'?1:-1;
  const h1BrokeAgainst = (bias==='UP'&&(S1.brokeHL||S1.dir==='DOWN')) || (bias==='DOWN'&&(S1.brokeLH||S1.dir==='UP'));
  const consec = consecAgainst(H1, side);
  const rt = retraceOf(S4, H4.c[H4.c.length-1], bias); // retrace 4ч считаем по цене 4ч, не 1ч
  const k4 = stochK(H4.c);
  const exhausted = (bias==='UP'&&k4>80)||(bias==='DOWN'&&k4<20);

  let setup;
  if(h1BrokeAgainst){ setup='CONFLICT'; reasons.push('1ч сломал структуру против 4ч'); }
  else if(consec>=3){ setup='CONFLICT'; reasons.push(consec+' закрытых 1ч подряд против стороны'); }
  else if(rt!=null && rt>0.5){ setup='BREAK'; reasons.push('отдано >50% ноги — разворотная зона'); }
  else if(rt!=null && rt<0.15){ setup='LATE'; reasons.push('нет отката — вход у вершины (догон)'); }
  else if(exhausted){ setup='LATE'; reasons.push('старший стох на упоре ('+k4.toFixed(0)+')'); }
  else if(rt!=null && rt>=0.15 && rt<=0.5){ setup='PULLBACK'; reasons.push('откат в живом тренде (retrace '+rt.toFixed(2)+', 1ч держит структуру)'); }
  else { setup='CONTINUE'; reasons.push('в тренде, но не классический откат'); }

  return {setup, side:bias, enter: setup==='PULLBACK', retrace: rt==null?null:+rt.toFixed(3),
          consec, h4:S4.dir, h1:S1.dir, d1:Sd.dir, k4:+k4.toFixed(0), reasons};
}
module.exports={classify,structureOf,retraceOf,consecAgainst,closed,ATR,stochK,bbWidth};
