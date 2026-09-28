/* Kelly Stock Lab: deterministic, long-only, single-stock daily-bar research engine.
   No orders, credentials, price fabrication or future-data-dependent sizing. */
(function(root){'use strict';
 const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
 const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
 function validate(rows){
  if(!Array.isArray(rows)||rows.length<120||rows.length>10000)throw Error('일봉 120~10,000개가 필요합니다.');
  const seen=new Set();const out=rows.map((r,k)=>{
   const d=String(r[0]).trim().replace(/[./]/g,'-').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
   const m=d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);if(!m)throw Error((k+2)+'행: 날짜 형식을 확인하세요.');
   const day=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');const dt=new Date(day+'T00:00:00Z');
   if(!Number.isFinite(dt.getTime())||dt.toISOString().slice(0,10)!==day||seen.has(day))throw Error('유효하지 않거나 중복된 날짜: '+day);
   seen.add(day);const nums=r.slice(1,6).map(x=>String(x??'').trim()).map(x=>x===''?NaN:Number(x.replace(/,/g,'')));
   const [o,h,l,c,v]=nums;if(nums.some(x=>!Number.isFinite(x))||Math.min(o,h,l,c)<=0||v<0||l>Math.min(o,c)||h<Math.max(o,c)||h<l)throw Error(day+': 시가·고가·저가·종가·거래량 오류. 누락/거래정지 행은 별도 정리하세요.');
   return [day,o,h,l,c,v];
  });out.sort((a,b)=>a[0].localeCompare(b[0]));return out;
 }
 function csv(text){
  const delim=text.split(/\r?\n/)[0].includes('\t')?'\t':',';let rows=[],row=[],field='',q=false;
  text=text.replace(/^\uFEFF/,'');for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(q&&text[i+1]==='"'){field+='"';i++;}else q=!q;}
   else if(c===delim&&!q){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}else field+=c;
  }if(q)throw Error('CSV 따옴표가 닫히지 않았습니다.');if(field||row.length){row.push(field);rows.push(row);}
  if(rows.length<2)throw Error('CSV 내용을 찾지 못했습니다.');const head=rows.shift().map(x=>x.trim().toLowerCase().replace(/[\s_]/g,''));
  const aliases=[['date','날짜','일자','날짜(일)'],['open','시가'],['high','고가'],['low','저가'],['close','종가','현재가'],['volume','거래량']];
  const idx=aliases.map(a=>head.findIndex(x=>a.includes(x)));if(idx.some(i=>i<0))throw Error('필수 열: 날짜, 시가, 고가, 저가, 종가, 거래량. 영문 Date/Open/High/Low/Close/Volume도 지원합니다.');
  return validate(rows.map(r=>idx.map(i=>r[i])));
 }
 function indicators(b){const s=[0];b.forEach(x=>s.push(s[s.length-1]+x[4]));return b.map((r,i)=>({ma20:i>=19?(s[i+1]-s[i-19])/20:NaN,ma60:i>=59?(s[i+1]-s[i-59])/60:NaN,high20:i>=20?Math.max(...b.slice(i-20,i).map(x=>x[2])):NaN}));}
 function signal(b,ind,i,type){if(i<59||b[i][5]<=0)return false;const c=b[i][4],x=ind[i];if(type==='breakout')return c>x.high20;if(type==='pullback')return c<x.ma20*.95;return c>x.ma20&&x.ma20>x.ma60;}
 function exitAt(bar,entry,age,c,sameDay=false){
  const stop=entry*(1-c.sl),target=entry*(1+c.tp),o=bar[1],h=bar[2],l=bar[3];
  if(bar[5]<=0)return null;
  if(!sameDay&&o<=stop)return {px:o*(1-c.slip),why:'시가 갭·손절',ambiguous:false};
  if(!sameDay&&o>=target)return {px:o*(1-c.slip),why:'시가 갭·익절',ambiguous:false};
  if(l<=stop)return {px:stop*(1-c.slip),why:h>=target?'동시 접촉·손절 우선':'손절',ambiguous:h>=target};
  if(h>=target)return {px:target*(1-c.slip),why:'익절',ambiguous:false};
  if(age>=c.hold)return {px:bar[4]*(1-c.slip),why:'보유기간 만료',ambiguous:false};return null;
 }
 function trades(b,ind,start,end,c){let out=[];for(let i=Math.max(start,60);i<=end;i++){
  if(!signal(b,ind,i-1,c.rule)||b[i][5]<=0)continue;const entry=b[i][1]*(1+c.slip);let e=null,j=i;
  for(;j<=end;j++){e=exitAt(b[j],entry,j-i+1,c,j===i);if(e)break;}
  const terminal=!e;if(terminal){j=end;e={px:b[end][4]*(1-c.slip),why:'구간 종료·강제청산',ambiguous:false};}
  const ret=e.px*(1-c.fee-c.tax)/(entry*(1+c.fee))-1;
  out.push({entry:i,exit:j,in:entry,out:e.px,r:ret,why:e.why,ambiguous:e.ambiguous,terminal});i=j;
 }return out;}
 function kelly(a){if(!a.length||a.some(x=>!Number.isFinite(x)||x< -1))return 0;
  const d=f=>mean(a.map(r=>r/(1+f*r)));if(d(0)<=0)return 0;if(d(1-1e-12)>=0)return 1;let lo=0,hi=1;for(let j=0;j<64;j++){let m=(lo+hi)/2;if(d(m)>0)lo=m;else hi=m;}return (lo+hi)/2;}
 function summary(rs){const w=rs.filter(r=>r>1e-12),l=rs.filter(r=>r< -1e-12);return {n:rs.length,w:w.length,l:l.length,p:rs.length?w.length/rs.length:null,avg:mean(rs),win:mean(w),loss:-mean(l),pf:l.length?w.reduce((a,x)=>a+x,0)/(-l.reduce((a,x)=>a+x,0)):null};}
 function simulate(b,ts,start,c,kind){let cash=c.capital,pos=null,ledger=[],curve=[c.capital],peak=c.capital,dd=0,ptr=0;
  for(let i=start;i<b.length;i++){
   const t=ts[ptr];if(t&&t.entry===i){let f=kind==='fixed10'?.1:kind==='fixed20'?.2:kind==='buyhold'?1:t.k===null?0:Math.min(c.cap,t.k*(kind==='quarter'?.25:kind==='half'?.5:1));
    const before=cash,q=Math.floor(Math.max(0,cash*f)/(t.in*(1+c.fee)));const debit=q*t.in*(1+c.fee);cash-=debit;pos={t,q,debit,before,f};}
   if(pos&&pos.t.exit===i){const p=pos,credit=p.q*p.t.out*(1-c.fee-c.tax);cash+=credit;ledger.push({...p.t,q:p.q,f:p.f,pnl:credit-p.debit,before:p.before,after:cash,skipped:p.q===0});pos=null;ptr++;}
   const equity=cash+(pos?pos.q*b[i][4]:0);curve.push(equity);peak=Math.max(peak,equity);dd=Math.max(dd,1-equity/peak);
  }
  return {kind,curve,ledger,final:curve[curve.length-1],ret:curve[curve.length-1]/c.capital-1,dd,count:ledger.filter(x=>!x.skipped).length};
 }
 function run(input,c){const b=validate(input).filter(x=>(!c.from||x[0]>=c.from)&&(!c.to||x[0]<=c.to));if(b.length<240)throw Error('선택 기간에 최소 240개 일봉이 필요합니다. 기간을 늘려 주세요.');
  const ind=indicators(b),split=clamp(Math.floor(b.length*c.split),100,b.length-60);
  const training=trades(b,ind,60,split-1,c).filter(t=>!t.terminal);const hist=training.map(t=>t.r),initialFit=summary(hist),initialKelly=hist.length>=c.min?kelly(hist):null;
  const testing=trades(b,ind,split,b.length-1,c);for(const t of testing){t.n=hist.length;t.k=hist.length>=c.min?kelly(hist):null;t.fitEnd=t.entry>0?b[t.entry-1][0]:null;if(!t.terminal)hist.push(t.r);}
  const variants=['fixed10','fixed20','quarter','half','full'].map(k=>simulate(b,testing,split,c,k));const hold=[{entry:split,exit:b.length-1,in:b[split][1]*(1+c.slip),out:b[b.length-1][4]*(1-c.slip),k:1,n:0,why:'동일 검증기간 보유',terminal:true}];variants.push(simulate(b,hold,split,c,'buyhold'));
  return {b,ind,split,c,training,testing,initialFit,initialKelly,latestFit:summary(hist),latestKelly:hist.length>=c.min?kelly(hist):null,variants};
 }
 const api={validate,csv,indicators,signal,exitAt,trades,kelly,summary,simulate,run};root.KSEngine=Object.freeze(api);if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
