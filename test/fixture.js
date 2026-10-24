// Builds a timepris.json-shaped object for 2026-10-24 (+02:00, 96 q) and 2026-10-25 (DST, 100 q).
function pad(n){return String(n).padStart(2,'0');}
function mk(dayStr, segments){ // segments: [{offset, startHour, count}]
  const quarters=[];
  for(const seg of segments){
    let h=seg.h, m=0;
    for(let k=0;k<seg.count;k++){
      const start=`${dayStr}T${pad(h)}:${pad(m)}:00${seg.off}`;
      let eh=h, em=m+15; if(em===60){em=0;eh=h+1;}
      let endDay=dayStr, eoff=seg.off;
      if(eh===24){eh=0; endDay=seg.next;}
      if(seg.switchAt && eh===seg.switchAt.h && em===0 && k===seg.count-1){eh=seg.switchAt.toH; eoff=seg.switchAt.off;}
      const end=`${endDay}T${pad(eh)}:${pad(em)}:00${eoff}`;
      const grid = h>=17&&h<21?119.45:(h<6?13.27:39.82);
      const spot = 50+40*Math.sin((h*4+m/15)/96*2*Math.PI*2) + (h===4&&m===45? -60:0);
      quarters.push({start,end,hour:h,minute:m,oreInclVat:+(spot+grid+15.38).toFixed(2),spotOreInclVat:+spot.toFixed(2),gridOreInclVat:grid,chargesOreInclVat:15.38,level:'mid',percentile:50,rank:1});
      m+=15; if(m===60){m=0;h++;}
    }
  }
  // set level/percentile/rank like the file
  const prices=quarters.map(q=>q.oreInclVat);
  const n=prices.length;
  quarters.forEach(q=>{const lower=prices.filter(p=>p<q.oreInclVat).length, eq=prices.filter(p=>p===q.oreInclVat).length;
    q.percentile=Math.round(100*(lower+(eq-1)/2)/(n-1)); q.rank=lower+1; q.level=q.percentile<=33?'cheap':q.percentile>=67?'expensive':'mid';});
  const byHour=new Map(); quarters.forEach(q=>{if(!byHour.has(q.hour))byHour.set(q.hour,[]);byHour.get(q.hour).push(q.oreInclVat);});
  const avgs=[...byHour].map(([h,l])=>({hour:h,avg:l.reduce((a,b)=>a+b)/l.length}));
  const hours=avgs.map(a=>({hour:a.hour,rank:1+avgs.filter(b=>b.avg<a.avg).length}));
  return {day:dayStr,quarters,hours,cheapestHour:{hour:4,krPerKwhInclVat:0.3}};
}
const today=mk('2026-10-24',[{off:'+02:00',h:0,count:96,next:'2026-10-25'}]);
// DST day: 00:00-03:00 +02:00 (12 q), then 02:00-24:00 +01:00 (88 q)
const tomorrow=mk('2026-10-25',[{off:'+02:00',h:0,count:12,next:'2026-10-25',switchAt:{h:3,toH:2,off:'+01:00'}},{off:'+01:00',h:2,count:88,next:'2026-10-26'}]);
module.exports={place:{gridArea:'791',gridCompany:'Radius Elnet A/S',region:'DK2',regionLabel:'Østdanmark',ambiguous:false,candidates:['791']},today,tomorrow};
if(require.main===module){console.log(tomorrow.quarters.length, tomorrow.quarters[11], tomorrow.quarters[12], tomorrow.quarters[99]);}
