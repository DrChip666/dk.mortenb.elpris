const assert=require('assert');
const calc=require('../lib/calc');
const ag=require('../lib/agreements');
const json=require('./fixture');
const data=calc.normalizeTimepris(json, Date.now());

// 1. continuity: every quarter's end equals next start (as instants), across midnight and DST
const all=calc.allQuarters(data.days);
for(let i=1;i<all.length;i++) assert.strictEqual(all[i-1].to, all[i].from, 'gap at '+i);
assert.strictEqual(all.length,196);
console.log('continuity ok, DST day quarters', data.days[1].quarters.length);

// 2. findQuarter at the doubled 02:30 (second occurrence, +01:00)
const t2=Date.parse('2026-10-25T02:30:00+01:00');
const f=calc.findQuarter(data.days,t2);
assert.strictEqual(f.quarter.start,'2026-10-25T02:30:00+01:00');
assert.strictEqual(f.hasLaterDay,false);
console.log('findQuarter DST ok');

// 3. add-surcharge keeps file ranks; price adds
const surAdd={kind:'add',ore:5};
const effA=calc.effectiveData(data,surAdd);
assert.strictEqual(effA[0].quarters[0].price, calc.round2(data.days[0].quarters[0].ore+5));
assert.strictEqual(effA[0].quarters[0].rank, data.days[0].quarters[0].rank);
// 4. fixed: recomputed, percentile matches midrank of effective prices
const effF=calc.effectiveData(data,{kind:'fixed',ore:80});
const pr=effF[0].quarters.map(q=>q.price);
const q0=effF[0].quarters[70];
assert.strictEqual(q0.price, calc.round2(data.days[0].quarters[70].ore-data.days[0].quarters[70].spot+80));
assert.strictEqual(q0.percentile, calc.midrankPercentile(pr,q0.price));
// grid peak should be expensive under fixed (spot removed, grid dominates)
assert.strictEqual(effF[0].quarters.find(q=>q.hour===18).level,'expensive');
assert.strictEqual(effF[1].hours.length,24, 'DST day hours merge doubled 02');
console.log('surcharge ok');

// 5. percentileAhead null when <16 ahead
const late=Date.parse('2026-10-25T21:05:00+01:00');
assert.strictEqual(calc.percentileAhead(effA,late),null);
const mid=Date.parse('2026-10-24T20:20:00+02:00');
const pa=calc.percentileAhead(effA,mid); assert(pa>=0&&pa<=100); console.log('percentileAhead', pa);

// 6. plan
const now=Date.parse('2026-10-24T20:20:00+02:00');
let p=calc.plan(effA,now,3,'07:00');
assert(p.complete&&p.fits); 
// brute-force check block
const lst=calc.allQuarters(effA); const i0=lst.findIndex(q=>q.from<=now&&now<q.to);
const dl=lst.findIndex((q,j)=>j>i0&&q.clock==='07:00'); const win=lst.slice(i0,dl);
let best=null; for(let s=0;s+12<=win.length;s++){const sum=win.slice(s,s+12).reduce((a,q)=>a+q.price,0); if(!best||sum<best.sum-1e-9)best={s,sum};}
assert.strictEqual(p.block.start, win[best.s].from);
console.log('plan block', new Date(p.block.start).toISOString(), 'runNow', p.runNowBlock, 'flex count', p.flexibleStarts.length);
// deadline beyond known
p=calc.plan(effA,now,3,'07:00'); 
const p2=calc.plan(effA,Date.parse('2026-10-25T20:00:00+01:00'),2,'07:00'); assert.strictEqual(p2.complete,false);
// no time: 3h before 21:00 at 20:20
const p3=calc.plan(effA,now,3,'21:00'); assert.strictEqual(p3.fits,false);
// deadline at end of known data 00:00
const p4=calc.plan(effA,Date.parse('2026-10-25T20:00:00+01:00'),1,'00:00'); assert(p4.complete&&p4.fits);
// DST deadline 02:00 → first occurrence (+02:00)
const p5=calc.plan(effA,Date.parse('2026-10-24T23:10:00+02:00'),1,'02:00'); assert.strictEqual(p5.block.end<=Date.parse('2026-10-25T02:00:00+02:00'),true);
console.log('plan edge cases ok');
assert.strictEqual(calc.validPlanArgs(1.5,'07:00'),null);
assert.strictEqual(calc.validPlanArgs(1.3,'07:00'),'hours');
assert.strictEqual(calc.validPlanArgs(2,'07:10'),'deadline');

// 7. cheapest hours
const fc=calc.findQuarter(effA,Date.parse('2026-10-24T04:50:00+02:00'));
console.log('hour 4 rank', fc.day.hours.find(h=>h.hour===4).rank, calc.inCheapestHours(fc,4));

// 8. agreements
const store=ag.normalizeAgreements({dataAsOf:'x',areas:[
  {gridCompany:'N1 A/S',rows:[{supplier:'Jysk Energi',supplierSlug:'jysk-energi',product:'Spot',productSlug:'jysk-spot',type:'variable',spotBased:true,energyOreInclVat:4.5},{supplier:'Andel',product:'Fast',productSlug:'andel-fast',spotBased:false,energyOreInclVat:95}]},
  {gridCompany:'Radius Elnet A/S',rows:[{supplier:'Jysk Energi',product:'Spot',productSlug:'jysk-spot',spotBased:true,energyOreInclVat:4.6}]}]},1);
assert.strictEqual(ag.findAgreement(store,'jysk-spot','DK2').energyOre,4.6);
assert.strictEqual(ag.findAgreement(store,'jysk-spot','DK1').energyOre,4.5);
assert.strictEqual(ag.findAgreement(store,'andel-fast','DK2').spotBased,false);
assert.strictEqual(ag.listForRegion(store,'DK2').length,2);
console.log('agreements ok');
console.log('ALL TESTS PASSED');
