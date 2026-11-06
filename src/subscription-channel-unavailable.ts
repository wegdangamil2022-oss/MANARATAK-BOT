import type {BotState} from './store.js';
const BUCKET=300000,WINDOW=288,MAX=1000000000,MAX_TIME=8640000000000000;
type Bucket={slot:number;count:number};
type Source='AUTOMATIC'|'MANUAL';
const slotAt=(now:number):number|null=>Number.isSafeInteger(now)&&now>=0&&now<=MAX_TIME?Math.floor(now/BUCKET):null;
/** Validate independently so corrupt optional analytics never block protection. */
function parse(value:unknown):Bucket[]|null{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>WINDOW+1)return null;
 const out:Bucket[]=[];let last=-1;
 for(const raw of value){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const r=raw as Record<string,unknown>;
  if(Object.keys(r).sort().join(',')!=='count,slot'||!Number.isSafeInteger(r.slot)||Number(r.slot)<0||Number(r.slot)>Math.floor(MAX_TIME/BUCKET)||Number(r.slot)<=last||!Number.isSafeInteger(r.count)||Number(r.count)<1||Number(r.count)>MAX)return null;
  last=Number(r.slot);out.push({slot:last,count:Number(r.count)});
 }
 return out;
}
/** Anonymous counts, in five-minute buckets; call after the safety/epoch guards. */
export function recordChannelUnavailability(s:BotState,now:number,source:Source='AUTOMATIC'):boolean{
 const slot=slotAt(now),previous=parse(source==='MANUAL'?s.subscriptionChannelManualHealth:s.subscriptionChannelHealth);if(slot===null||previous===null||previous.some(x=>x.slot>slot))return false;
 const rows=previous.filter(x=>x.slot>=slot-WINDOW),last=rows.at(-1);
 if(last?.slot===slot)last.count=Math.min(MAX,last.count+1);else rows.push({slot,count:1});
 if(source==='MANUAL')s.subscriptionChannelManualHealth=rows;else s.subscriptionChannelHealth=rows;return true;
}
/** Includes the partially overlapping five-minute bucket, at most five extra minutes. */
export function summarizeChannelUnavailability(s:BotState,now:number,source:Source='AUTOMATIC'):{available:boolean;count:number;saturated:boolean}{
 const slot=slotAt(now),rows=parse(source==='MANUAL'?s.subscriptionChannelManualHealth:s.subscriptionChannelHealth);if(slot===null||rows===null||rows.some(x=>x.slot>slot))return {available:false,count:0,saturated:false};
 const active=rows.filter(x=>x.slot>=slot-WINDOW);return {available:true,count:active.reduce((n,x)=>n+x.count,0),saturated:active.some(x=>x.count===MAX)};
}
