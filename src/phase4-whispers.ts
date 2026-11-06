import {randomBytes} from 'node:crypto';
import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyWhisperState,type WhisperKind,type WhisperMessage,
 type WhisperState} from './phase4-whisper-model.js';

export type WhisperDraftInput={
 kind:WhisperKind;seats?:number;recipientId?:string;durationMinutes:number;text:string
};
export type WhisperReserveResult={status:'HELD'|'ALREADY_HELD'|'FULL'|
 'CLOSED'|'EXPIRED'|'STALE'|'NOT_RECIPIENT'|'CONSENT_REQUIRED'|
 'VERIFICATION_REQUIRED'|'DENIED'|'NOT_FOUND';reservationId?:string};
type VerifyMember=(chatId:string,memberId:string)=>Promise<
 'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>;
const isUser=(v:string)=>/^[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const isGroup=(v:string)=>/^-[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const validClock=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-3_600_000;
const clone=(s:BotState):WhisperState=>s.phase4Whispers??emptyWhisperState();
const getChat=(s:BotState,chatId:string)=>{
 const list=s.chats.filter(c=>c.id===chatId);
 return list.length===1?list[0]:undefined;
};
const approvedChat=(s:BotState,p:Policy,chatId:string)=>{
 const c=getChat(s,chatId);
 return c&&c.approved&&c.version>=1&&c.scopes.includes('navigation')&&
  p.canUseChat(s,chatId,'navigation')?c:null;
};
const newId=(items:readonly {id:string}[])=>{
 let id='';
 do{id=randomBytes(12).toString('hex');}
 while(items.some(r=>r.id===id));
 return id;
};
/** Private content is never stored in an outbound Telegram job. This service
 * may reserve a seat, but CANNOT post a message, reveal the secret or claim
 * it was delivered or read. Real publishing needs independent review. */
export class Phase4WhisperService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now,
  private readonly verifyMember:VerifyMember=async()=> 'UNKNOWN'){}
 private owner(s:BotState,actor:string):boolean{
  return this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private scope(s:BotState,actor:string,chatId:string):number|null{
  const chat=approvedChat(s,this.policy,chatId);
  return isGroup(chatId)&&chat&&this.owner(s,actor)&&
   this.policy.has(s,actor,'chat.manage',chatId,this.clock())?
   chat.version:null;
 }
 /** Unpublished owner-only draft. No public announcement and no recipient DM. */
 async draft(actor:string,chatId:string,input:WhisperDraftInput):Promise<WhisperMessage>{
  const now=this.clock();
  if(!validClock(now)||!isGroup(chatId)||!input||typeof input.text!=='string'||
   input.text.trim()!==input.text||input.text.length<1||input.text.length>800||
   /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(input.text)||
   !Number.isSafeInteger(input.durationMinutes)||input.durationMinutes<1||
   input.durationMinutes>60||!['FIRST_N','DIRECT'].includes(input.kind)||
   input.kind==='FIRST_N'&&(!Number.isSafeInteger(input.seats)||
    input.seats===undefined||input.seats<1||input.seats>20||
    input.recipientId!==undefined)||
   input.kind==='DIRECT'&&(input.seats!==undefined&&input.seats!==1||
    !isUser(input.recipientId??'')||input.recipientId===actor))
   throw Error('WHISPER_INPUT_INVALID');
  return this.store.transaction(s=>{
   const version=this.scope(s,actor,chatId);
   if(version===null)throw Error('WHISPER_DENIED');
   const data=clone(s);
   if(data.messages.length>=200)throw Error('WHISPER_CAPACITY');
   const record:WhisperMessage={
    id:newId(data.messages),chatId,chatVersion:version,creatorId:actor,
    kind:input.kind,seats:input.kind==='DIRECT'?1:input.seats!,
    ...(input.kind==='DIRECT'?{recipientId:input.recipientId!}:{}),
    text:input.text,status:'DRAFT',revision:1,
    createdAt:now,expiresAt:now+input.durationMinutes*60_000
   };
   data.messages.push(record);
   s.phase4Whispers=data;
   return structuredClone(record);
  });
 }
 async approve(actor:string,id:string):Promise<WhisperMessage>{
  const now=this.clock();if(!validClock(now))throw Error('WHISPER_CLOCK_INVALID');
  return this.store.transaction(s=>{
   const data=clone(s),items=data.messages.filter(x=>x.id===id),row=items[0];
   if(items.length!==1||!row||row.status!=='DRAFT')
    throw Error('WHISPER_DRAFT_NOT_FOUND');
   if(this.scope(s,actor,row.chatId)!==row.chatVersion||
    row.creatorId!==actor)throw Error('WHISPER_DENIED');
   if(now<row.createdAt||now>=row.expiresAt)throw Error('WHISPER_DRAFT_EXPIRED');
   row.status='OPEN';row.revision=2;row.approvedAt=now;
   s.phase4Whispers=data;
   return structuredClone(row);
  });
 }
 /** Immediate close scrubs content even if there were reservations. A held
  * reservation is not a delivery and cannot be reused as a resend ticket. */
 async close(actor:string,id:string,expectedRevision?:number):Promise<boolean>{
  const now=this.clock();if(!validClock(now))throw Error('WHISPER_CLOCK_INVALID');
  return this.store.transaction(s=>{
   const data=clone(s),matches=data.messages.filter(x=>x.id===id),row=matches[0];
   if(matches.length!==1||!row||row.status==='CLOSED'||
    expectedRevision!==undefined&&row.revision!==expectedRevision)return false;
   if(this.scope(s,actor,row.chatId)!==row.chatVersion||
    row.creatorId!==actor)throw Error('WHISPER_DENIED');
   row.closedAt=Math.max(row.createdAt,now);
   row.revision=row.status==='DRAFT'?2:3;
   row.status='CLOSED';delete row.text;
   s.phase4Whispers=data;
   return true;
  });
 }
 /** Optional private opt-in by a verified member; NOT a Telegram bot-rights
  * grant. Every future reservation must verify membership again. */
 async consent(memberId:string,chatId:string,enabled:boolean):Promise<boolean>{
  const now=this.clock();
  if(!isUser(memberId)||!isGroup(chatId)||typeof enabled!=='boolean'||!validClock(now))
   return false;
  const before=await this.store.snapshot();
  if(!approvedChat(before,this.policy,chatId))return false;
  try{if(await this.verifyMember(chatId,memberId)!=='VERIFIED')return false;}
  catch{return false;}
  return this.store.transaction(s=>{
   const chat=approvedChat(s,this.policy,chatId);
   if(!chat||chat.version!==getChat(before,chatId)?.version)return false;
   const data=clone(s),existing=data.consents.filter(c=>
    c.chatId===chatId&&c.memberId===memberId);
   if(existing.length>1||!existing.length&&data.consents.length>=2000)return false;
   if(existing.length){
    const row=existing[0]!;
    if(now<row.updatedAt)return false;
    row.enabled=enabled;row.updatedAt=now;row.chatVersion=chat.version;
   }else data.consents.push({
    chatId,chatVersion:chat.version,memberId,enabled,updatedAt:now
   });
   s.phase4Whispers=data;
   return true;
  });
 }
 /** Atomic per-user private-seat reservation; deliberately returns no text.
  * Provider membership must be VERIFIED twice: first outside the transaction,
  * then the current local authorization/consent is rechecked under lock.
  * Callbacks may never grant membership merely because a seat is available. */
 async reserve(memberId:string,id:string):Promise<WhisperReserveResult>{
  const now=this.clock(),deny=(status:WhisperReserveResult['status']):WhisperReserveResult=>({status});
  if(!isUser(memberId)||!validClock(now))return deny('DENIED');
  const before=await this.store.snapshot();
  const match=clone(before).messages.filter(m=>m.id===id),whisper=match[0];
  if(match.length!==1||!whisper)return deny('NOT_FOUND');
  if(whisper.status==='CLOSED')return deny('CLOSED');
  if(whisper.status!=='OPEN')return deny('DENIED');
  if(now<whisper.createdAt||now>=whisper.expiresAt)return deny('EXPIRED');
  const chat=approvedChat(before,this.policy,whisper.chatId);
  if(!chat||chat.version!==whisper.chatVersion)return deny('STALE');
  if(whisper.kind==='DIRECT'&&whisper.recipientId!==memberId)return deny('NOT_RECIPIENT');
  const initial=clone(before).consents.filter(c=>
   c.chatId===whisper.chatId&&c.memberId===memberId);
  if(initial.length!==1||initial[0]!.chatVersion!==chat.version||
   !initial[0]!.enabled)return deny('CONSENT_REQUIRED');
  let verified=false;
  try{verified=await this.verifyMember(whisper.chatId,memberId)==='VERIFIED';}
  catch{return deny('VERIFICATION_REQUIRED');}
  if(!verified)return deny('VERIFICATION_REQUIRED');
  return this.store.transaction(s=>{
   const data=clone(s),fresh=data.messages.filter(m=>m.id===id),row=fresh[0];
   if(fresh.length!==1||!row)return deny('NOT_FOUND');
   if(row.status==='CLOSED')return deny('CLOSED');
   if(row.status!=='OPEN')return deny('DENIED');
   if(row.chatVersion!==whisper.chatVersion||row.revision!==whisper.revision||
    row.expiresAt!==whisper.expiresAt)return deny('STALE');
   if(now>=row.expiresAt)return deny('EXPIRED');
   const current=approvedChat(s,this.policy,row.chatId);
   if(!current||current.version!==row.chatVersion)return deny('STALE');
   if(row.kind==='DIRECT'&&row.recipientId!==memberId)return deny('NOT_RECIPIENT');
   const consent=data.consents.filter(c=>c.chatId===row.chatId&&c.memberId===memberId);
   if(consent.length!==1||!consent[0]!.enabled||
    consent[0]!.chatVersion!==current.version||consent[0]!.updatedAt>now)
    return deny('CONSENT_REQUIRED');
   const duplicates=data.reservations.filter(x=>x.messageId===id&&x.memberId===memberId);
   if(duplicates.length!==0)return deny('ALREADY_HELD');
   if(data.reservations.filter(x=>x.messageId===id).length>=row.seats||
    data.reservations.length>=2000)return deny('FULL');
   const reserved={id:newId(data.reservations),messageId:id,
    memberId,at:now,status:'HELD' as const};
   data.reservations.push(reserved);
   s.phase4Whispers=data;
   return {status:'HELD',reservationId:reserved.id};
  });
 }
 async expire():Promise<number>{
  const now=this.clock();if(!validClock(now))return 0;
  return this.store.transaction(s=>{
   const data=clone(s);let total=0;
   for(const row of data.messages){
    if(row.status==='CLOSED'||now<row.expiresAt)continue;
    row.revision=row.status==='DRAFT'?2:3;
    row.status='CLOSED';row.closedAt=now;delete row.text;total++;
   }
   if(total)s.phase4Whispers=data;
   return total;
  });
 }
 /** Owner-only private preview. Never expose a stored text in public UI. */
 async ownerView(actor:string,id:string):Promise<WhisperMessage|null>{
  const s=await this.store.snapshot(),rows=clone(s).messages.filter(x=>x.id===id),row=rows[0];
  if(rows.length!==1||!row||this.scope(s,actor,row.chatId)!==row.chatVersion||
   row.creatorId!==actor)return null;
  return structuredClone(row);
 }
 /** Public metadata never reveals secret, recipient ID, or who reserved a seat.
  * This does not imply that a public Telegram post exists. */
 async publicSummary(actor:string,id:string):Promise<string>{
  const s=await this.store.snapshot(),rows=clone(s).messages.filter(m=>m.id===id),row=rows[0];
  if(rows.length!==1||!row||this.scope(s,actor,row.chatId)!==row.chatVersion)
   throw Error('WHISPER_DENIED');
  const used=clone(s).reservations.filter(c=>c.messageId===id).length;
  return '💌 همسة '+row.kind+' · '+row.status+' · المقاعد: '+
   Math.max(0,row.seats-used)+'/'+row.seats+' · لا يوجد نشر Telegram';
 }
 async list(actor:string,chatId?:string):Promise<WhisperMessage[]>{
  const s=await this.store.snapshot();
  if(!this.owner(s,actor))throw Error('WHISPER_DENIED');
  return clone(s).messages.filter(m=>(chatId===undefined||m.chatId===chatId)&&
   this.scope(s,actor,m.chatId)===m.chatVersion)
   .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))
   .slice(0,50).map(m=>structuredClone(m));
 }
}
