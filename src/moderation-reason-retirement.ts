import {createHash} from 'node:crypto';
import type {BotState,ModerationOperation} from './store.js';

export const REASON_RETIREMENT='moderation:reason-retired:';
export const retirementOperationDigest=(o:ModerationOperation):string=>createHash('sha256').update(JSON.stringify([
 o.id,o.chatId,o.memberId,o.actorId,o.kind,o.reasonFingerprint,o.policyVersion,o.createdAt,
 o.untilDate??null,o.baselineMode??null,o.reverses??null,o.action??null,o.caseReference??null,o.attemptGateway??null
])).digest('hex');
type Entry=['MANUAL'|'SUBSCRIPTION',string,'BAN'|'MUTE',{expiresAt:number}?];
function entries(raw:string):Entry[]|null{
 try{
  const rows:unknown=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>1000)return null;
  const valid=rows.every((r:unknown)=>Array.isArray(r)&&(r.length===3||r.length===4)&&
   ['MANUAL','SUBSCRIPTION'].includes(r[0])&&typeof r[1]==='string'&&r[1].length>0&&r[1].length<=80&&['BAN','MUTE'].includes(r[2])&&
   (r.length===3||r[3]&&typeof r[3]==='object'&&!Array.isArray(r[3])&&Object.keys(r[3]).join(',')==='expiresAt'&&Number.isSafeInteger(r[3].expiresAt)&&r[3].expiresAt>=0&&r[3].expiresAt<=8640000000000000));
  if(!valid)return null;const typed=rows as Entry[];
  return JSON.stringify([...typed].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))===raw&&new Set(typed.map(r=>JSON.stringify(r))).size===typed.length?typed:null;
 }catch{return null;}
}
function effect(rows:Entry[]):{kind:'BAN'|'MUTE'|'NONE';untilDate:number|null}{
 const kind=rows.some(r=>r[2]==='BAN')?'BAN':rows.some(r=>r[2]==='MUTE')?'MUTE':'NONE',same=rows.filter(r=>r[2]===kind);
 return {kind,untilDate:same.length>0&&same.every(r=>r[3]!==undefined)?Math.ceil(Math.max(...same.map(r=>r[3]!.expiresAt))/1000):null};
}
/** This attests a local subtraction only. No operation or remote confirmation
 * is fabricated: every edge must preserve the original restriction exactly. */
export function validReasonRetirement(before:string,after:string,o:ModerationOperation):boolean{
 const a=entries(before),b=entries(after);if(!a||!b||a.length!==b.length+1||b.length===0)return false;
 if(!a.some((r,i)=>r[0]==='MANUAL'&&JSON.stringify(a.filter((_,j)=>j!==i))===after))return false;
 const expected={kind:o.kind,untilDate:o.untilDate??null};return JSON.stringify(effect(a))===JSON.stringify(expected)&&JSON.stringify(effect(b))===JSON.stringify(expected);
}
export function moderationEvidenceMatches(s:BotState,o:ModerationOperation,current:string,owner:string,now:number):boolean{
 const edges:{before:string;after:string;at:number}[]=[];
 for(const a of s.audit){
  if(!a.updateKey.startsWith(REASON_RETIREMENT))continue;
  let v:unknown;try{v=JSON.parse(a.reason);}catch{return false;}
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const row=v as {operationId:string;digest:string;before:string;after:string};
  if(row.operationId!==o.id)continue;
  if(Object.keys(row).sort().join(',')!=='after,before,digest,operationId'||a.actorId!==owner||a.decision!=='ALLOW'||a.policyVersion!==o.policyVersion||
   !Number.isSafeInteger(a.at)||a.at<o.createdAt||a.at>now||!/^moderation:reason-retired:[0-9a-f-]{36}$/u.test(a.updateKey)||
   s.audit.filter(x=>x.updateKey===a.updateKey).length!==1||row.digest!==retirementOperationDigest(o)||typeof row.before!=='string'||typeof row.after!=='string'||!validReasonRetirement(row.before,row.after,o))return false;
  edges.push({before:row.before,after:row.after,at:a.at});
 }
 if(edges.length>1000)return false;
 let cursor=o.reasonFingerprint,at=o.createdAt;const unused=new Set(edges);
 while(unused.size){const next=[...unused].filter(e=>e.before===cursor);if(next.length!==1||next[0]!.at<at)return false;const edge=next[0]!;cursor=edge.after;at=edge.at;unused.delete(edge);}
 return cursor===current;
}
