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
 'VERIFICATION_REQUIRED'|'CONSENT_CHANGED'|'DENIED'|'NOT_FOUND';reservationId?:string};
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
   // Owner-only publishing is not a bulk messaging loophole. Including
   // closed tombstones makes rapid create/close cycles count toward abuse limits.
   if(data.messages.filter(x=>x.chatId===chatId&&x.creatorId===actor&&
      x.createdAt<=now&&now-x.createdAt<3600000).length>=5)
    throw Error('WHISPER_GROUP_HOURLY_LIMIT');
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
 /** A SECOND owner action after local approval. A posted teaser never
  * contains the whisper body, names, recipient ID or a usable authorization.
  * Group posts are sent by the separate RUN-gated at-most-once worker.
  */
 async queueAnnouncement(actor:string,id:string):Promise<string>{
  const now=this.clock();
  if(!validClock(now)||!/^[a-f0-9]{24}$/u.test(id))
   throw Error('WHISPER_ANNOUNCE_INVALID');
  return this.store.transaction(s=>{
   const data=clone(s),items=data.messages.filter(m=>m.id===id),row=items[0];
   if(items.length!==1||!row||row.status!=='OPEN'||!row.text||
      !row.approvedAt||now<row.approvedAt||now>=row.expiresAt)
    throw Error('WHISPER_ANNOUNCE_NOT_READY');
   if(row.creatorId!==actor||this.scope(s,actor,row.chatId)!==row.chatVersion)
    throw Error('WHISPER_ANNOUNCE_DENIED');
   if((data.announcements??[]).some(a=>a.messageId===id))
    throw Error('WHISPER_ANNOUNCEMENT_EXISTS');
   if((data.announcements?.length??0)>=200)
    throw Error('WHISPER_ANNOUNCEMENT_CAPACITY');
   data.announcements??=[];
   const announcementId=newId(data.announcements);
   data.announcements.push({id:announcementId,messageId:id,chatId:row.chatId,
    chatVersion:row.chatVersion,ownerId:actor,createdAt:now,status:'QUEUED'});
   s.phase4Whispers=data;
   return announcementId;
  });
 }
 /** Privately read an announcement receipt's current status. It never
  * represents the recipient's message delivery or whether anyone read it.
  */
 async announcementStatus(actor:string,id:string):Promise<
  'NOT_POSTED'|'QUEUED'|'SENDING'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'SKIPPED'>{
  const s=await this.store.snapshot(),m=clone(s).messages.filter(x=>x.id===id);
  if(m.length!==1||m[0]!.creatorId!==actor||
     this.scope(s,actor,m[0]!.chatId)!==m[0]!.chatVersion)
   throw Error('WHISPER_DENIED');
  const rows=clone(s).announcements?.filter(a=>a.messageId===id)??[];
  return rows.length===1?rows[0]!.status:'NOT_POSTED';
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
  const earlierConsents=clone(before).consents.filter(c=>
   c.chatId===chatId&&c.memberId===memberId);
  if(earlierConsents.length>1)return false;
  // A member must remain free to WITHDRAW permission after leaving or
  // losing group authorization. Opt-out is self-service and never requires
  // a potentially unavailable external membership lookup.
  if(enabled){
   if(!approvedChat(before,this.policy,chatId))return false;
   try{if(await this.verifyMember(chatId,memberId)!=='VERIFIED')return false;}
   catch{return false;}
  }
  return this.store.transaction(s=>{
   const data=clone(s),existing=data.consents.filter(c=>
    c.chatId===chatId&&c.memberId===memberId);
   if(existing.length>1||!existing.length&&data.consents.length>=2000)return false;
   if(!enabled){
    if(existing.length!==1)return false;
    const row=existing[0]!;
    if(this.clock()<row.updatedAt||row.revision>=9_999_999_999)return false;
    row.enabled=false;row.updatedAt=this.clock();row.revision++;
    // A withdrawal also releases every LOCAL (never delivered) HELD seat
    // associated with this member in the specified group. Do not affect
    // other groups or other members. The incremented consent revision
    // fences stale membership verification that was already in flight.
    const groupMessageIds=new Set(data.messages.filter(m=>m.chatId===chatId)
     .map(m=>m.id));
    data.reservations=data.reservations.filter(r=>
     r.memberId!==memberId||!groupMessageIds.has(r.messageId));
    // Preserve the old chat version: revocation must not reactivate an old
    // consent if the same group later regains approval.
    s.phase4Whispers=data;
    return true;
   }
   const chat=approvedChat(s,this.policy,chatId);
   if(!chat||chat.version!==getChat(before,chatId)?.version)return false;
   // An earlier opt-in verification can finish AFTER the member presses
   // opt-out. Its old provider result must never reactivate permission.
   // Compare monotonically increasing revisions, not just enabled flags:
   // off -> on -> off with equal clock timestamps remains detectable.
   if(earlierConsents.length!==existing.length||
    (existing.length===1&&(
      existing[0]!.revision!==earlierConsents[0]!.revision||
      existing[0]!.enabled!==earlierConsents[0]!.enabled||
      existing[0]!.chatVersion!==earlierConsents[0]!.chatVersion)))
    return false;
   if(existing.length){
    const row=existing[0]!;
    if(this.clock()<row.updatedAt||row.revision>=9_999_999_999)return false;
    row.enabled=true;row.updatedAt=this.clock();row.chatVersion=chat.version;
    row.revision++;
   }else data.consents.push({
    chatId,chatVersion:chat.version,memberId,enabled:true,revision:1,
    updatedAt:this.clock()
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
  if(whisper.creatorId===memberId)return deny('DENIED');
  if(whisper.kind==='DIRECT'&&whisper.recipientId!==memberId)return deny('NOT_RECIPIENT');
  const initialBlocks=clone(before).blocks?.filter(b=>
   b.chatId===whisper.chatId&&b.memberId===memberId&&
   b.senderId===whisper.creatorId)??[];
  if(initialBlocks.length>1||initialBlocks.some(b=>b.enabled))return deny('DENIED');
  const blockRevision=initialBlocks[0]?.revision??0;
  const initial=clone(before).consents.filter(c=>
   c.chatId===whisper.chatId&&c.memberId===memberId);
  if(initial.length!==1||initial[0]!.chatVersion!==chat.version||
   !initial[0]!.enabled)return deny('CONSENT_REQUIRED');
  const consentRevision=initial[0]!.revision;
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
   // The remote Telegram membership read may have waited past expiry.
   // Never use the pre-I/O timestamp as a valid reservation timestamp.
   const commitTime=this.clock();
   if(!validClock(commitTime)||commitTime<now)return deny('STALE');
   if(commitTime>=row.expiresAt)return deny('EXPIRED');
   const current=approvedChat(s,this.policy,row.chatId);
   if(!current||current.version!==row.chatVersion)return deny('STALE');
   if(row.creatorId===memberId)return deny('DENIED');
   if(row.kind==='DIRECT'&&row.recipientId!==memberId)return deny('NOT_RECIPIENT');
   const latestBlock=(data.blocks??[]).filter(b=>
     b.chatId===row.chatId&&b.memberId===memberId&&b.senderId===row.creatorId);
   if(latestBlock.length>1||latestBlock.some(b=>b.enabled)||
      (latestBlock[0]?.revision??0)!==blockRevision)return deny('CONSENT_CHANGED');
   const consent=data.consents.filter(c=>c.chatId===row.chatId&&c.memberId===memberId);
   if(consent.length!==1||!consent[0]!.enabled||
    consent[0]!.chatVersion!==current.version||consent[0]!.updatedAt>now)
    return deny('CONSENT_REQUIRED');
   // A rapid opt-out and opt-in can share the same timestamp. Its monotonic
   // revision must still invalidate any verification already in flight.
   if(consent[0]!.revision!==consentRevision)return deny('CONSENT_CHANGED');
   const duplicates=data.reservations.filter(x=>x.messageId===id&&x.memberId===memberId);
   if(duplicates.length!==0)return deny('ALREADY_HELD');
   if(data.reservations.filter(x=>x.messageId===id).length>=row.seats||
    data.reservations.length>=2000)return deny('FULL');
   const reserved={id:newId(data.reservations),messageId:id,
    memberId,at:commitTime,status:'HELD' as const};
   data.reservations.push(reserved);
   s.phase4Whispers=data;
   return {status:'HELD',reservationId:reserved.id};
  });
 }
 /** Member-owned sender block. No provider membership check is required to
  * protect the member: opt-out and block must remain available after leaving.
  * A new block releases unsent seat holds before future reservations.
  */
 async block(memberId:string,chatId:string,senderId:string,enabled:boolean):Promise<boolean>{
  const now=this.clock();
  if(!isUser(memberId)||!isGroup(chatId)||!isUser(senderId)||
    senderId===memberId||typeof enabled!=='boolean'||!validClock(now))
   return false;
  return this.store.transaction(s=>{
   const data=clone(s),rows=(data.blocks??[]).filter(x=>
    x.chatId===chatId&&x.memberId===memberId&&x.senderId===senderId);
   if(rows.length>1||!rows.length&&(data.blocks?.length??0)>=2000)return false;
   const row=rows[0];
   if(row){
    if(now<row.updatedAt||row.revision>=9_999_999_999)return false;
    row.revision++;row.updatedAt=now;row.enabled=enabled;
   }else{
    const chat=getChat(s,chatId);
    if(!chat||chat.version<1)return false;
    data.blocks??=[];
    data.blocks.push({chatId,chatVersion:chat.version,memberId,
     senderId,enabled,revision:1,updatedAt:now});
   }
   if(enabled){
    const whispers=new Set(data.messages.filter(m=>
      m.chatId===chatId&&m.creatorId===senderId).map(m=>m.id));
    data.reservations=data.reservations.filter(r=>
      r.memberId!==memberId||!whispers.has(r.messageId));
   }
   s.phase4Whispers=data;return true;
  });
 }
 /** Block the author of a particular reserved whisper without disclosing
  * that author's Telegram ID to the member. No matching seat means deny.
  */
 async blockWhisper(memberId:string,id:string):Promise<boolean>{
  if(!isUser(memberId)||!/^[a-f0-9]{24}$/u.test(id))return false;
  const state=await this.store.snapshot(),data=clone(state);
  const messages=data.messages.filter(m=>m.id===id);
  if(messages.length!==1||
     !data.reservations.some(r=>r.memberId===memberId&&r.messageId===id))
   return false;
  const row=messages[0]!;
  return this.block(memberId,row.chatId,row.creatorId,true);
 }
 /** Abuse evidence is bounded to an opaque reason code, not a copied secret.
  * Only a member with an actual reserved seat may report this message.
  */
 async report(memberId:string,id:string,reason:'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER'):
 Promise<boolean>{
  const now=this.clock();
  if(!isUser(memberId)||!validClock(now)||
     !/^[a-f0-9]{24}$/u.test(id)||
     !['SPAM','HARASSMENT','PERSONAL_DATA','OTHER'].includes(reason))
   return false;
  return this.store.transaction(s=>{
   const data=clone(s),rows=data.messages.filter(m=>m.id===id);
   if(rows.length!==1||rows[0]!.creatorId===memberId||
      !data.reservations.some(r=>r.memberId===memberId&&r.messageId===id)||
      (data.reports??[]).some(r=>r.messageId===id&&r.reporterId===memberId)||
      (data.reports?.length??0)>=500)return false;
   data.reports??=[];
   data.reports.push({id:newId(data.reports),messageId:id,reporterId:memberId,
    reportedAt:now,reason,status:'OPEN'});
   s.phase4Whispers=data;return true;
  });
 }
 async reports(actor:string,chatId:string):Promise<Array<
  {id:string;messageId:string;reportedAt:number;reason:string;status:string}>>{
  const s=await this.store.snapshot();
  if(this.scope(s,actor,chatId)===null)return [];
  const ids=new Set(clone(s).messages.filter(m=>m.chatId===chatId).map(m=>m.id));
  return (clone(s).reports??[]).filter(r=>ids.has(r.messageId))
   .sort((a,b)=>b.reportedAt-a.reportedAt).slice(0,30).map(r=>({
    id:r.id,messageId:r.messageId,reportedAt:r.reportedAt,
    reason:r.reason,status:r.status
   }));
 }
 async reviewReport(actor:string,id:string):Promise<boolean>{
  const now=this.clock();
  if(!validClock(now)||!/^[a-f0-9]{24}$/u.test(id))return false;
  return this.store.transaction(s=>{
   const data=clone(s),reports=(data.reports??[]).filter(r=>r.id===id);
   if(reports.length!==1||reports[0]!.status!=='OPEN')return false;
   const rows=data.messages.filter(m=>m.id===reports[0]!.messageId);
   if(rows.length!==1||this.scope(s,actor,rows[0]!.chatId)!==rows[0]!.chatVersion)
    return false;
   const item=reports[0]!;
   if(now<item.reportedAt)return false;
   item.status='REVIEWED';item.reviewedAt=now;item.reviewedBy=actor;
   s.phase4Whispers=data;
   return true;
  });
 }
 /** Only a recipient-initiated PRIVATE request can call this method. A
  * public deep-link carries an ID (NOT a capability); current Telegram group
  * membership, subscription, consent, block list and atomic seat ownership
  * are mandatory before even returning plaintext to the trusted transport.
  * The existing Telegram reply ledger independently rechecks this witness
  * at the irrevocable outbound-send boundary.
  */
 async open(memberId:string,id:string):Promise<
  {status:'READY';text:string;scope:string;reservationId:string;
   messageRevision:number;consentRevision:number;chatVersion:number;expiresAt:number}|
  {status:WhisperReserveResult['status']|'NOT_ANNOUNCED'}>{
  const now=this.clock();
  if(!validClock(now)||!isUser(memberId)||!/^[a-f0-9]{24}$/u.test(id))
   return {status:'DENIED'};
  const first=await this.store.snapshot(),rows=clone(first).messages.filter(m=>m.id===id);
  if(rows.length!==1||rows[0]!.status!=='OPEN'||!rows[0]!.text)
   return {status:'NOT_FOUND'};
  if(!(clone(first).announcements??[]).some(a=>
     a.messageId===id&&a.status==='CONFIRMED'))return {status:'NOT_ANNOUNCED'};
  const result=await this.reserve(memberId,id);
  if(result.status!=='HELD'&&result.status!=='ALREADY_HELD')
   return {status:result.status};
  const after=await this.store.snapshot(),d=clone(after),found=d.messages.filter(m=>m.id===id),
   item=found[0],current=this.clock();
  if(found.length!==1||!item||item.status!=='OPEN'||!item.text||
     !validClock(current)||current<now||current>=item.expiresAt)
   return {status:'EXPIRED'};
  const chat=approvedChat(after,this.policy,item.chatId);
  if(!chat||chat.version!==item.chatVersion)return {status:'STALE'};
  if(!(d.announcements??[]).some(a=>a.messageId===id&&a.status==='CONFIRMED'))
   return {status:'NOT_ANNOUNCED'};
  const consent=d.consents.filter(c=>
    c.chatId===item.chatId&&c.memberId===memberId&&c.enabled&&
    c.chatVersion===chat.version);
  const seats=d.reservations.filter(r=>r.messageId===id&&r.memberId===memberId);
  if(consent.length!==1||seats.length!==1)return {status:'CONSENT_REQUIRED'};
  if((d.blocks??[]).some(b=>b.chatId===item.chatId&&
     b.memberId===memberId&&b.senderId===item.creatorId&&b.enabled))
   return {status:'DENIED'};
  return {status:'READY',text:item.text,scope:item.chatId,
   reservationId:seats[0]!.id,messageRevision:item.revision,
   consentRevision:consent[0]!.revision,chatVersion:chat.version,
   expiresAt:Math.min(item.expiresAt,current+30000)};
 }
 async expire():Promise<number>{
  const now=this.clock();if(!validClock(now))return 0;
  return this.store.transaction(s=>{
   const data=clone(s);let total=0,redacted=0;
   // A private whisper's plaintext must never remain queued after its
   // short witness expires, even if Telegram safety STOP prevents sending.
   // Do not mark attempted SENDING jobs retryable or redact unrelated DMs.
   for(const job of s.telegramReplyJobs??[]){
    if(job.status!=='QUEUED'||!job.whisperAccess)continue;
    const w=job.whisperAccess,source=data.messages.find(m=>m.id===w.whisperId);
    const member=job.plan?.chatId,scope=job.privateGroupAccess?.scope;
    const consent=data.consents.find(c=>c.chatId===scope&&c.memberId===member);
    const blocked=!!(data.blocks??[]).find(b=>b.chatId===scope&&
      b.memberId===member&&b.senderId===source?.creatorId&&b.enabled);
    if(now<w.expiresAt&&source?.status==='OPEN'&&source.expiresAt>now&&
      consent?.enabled&&consent.revision===w.consentRevision&&!blocked)continue;
    job.status='FAILED_CONFIRMED';delete job.plan;delete job.whisperAccess;
    delete job.privateGroupAccess;delete job.privateReplyKind;
    job.redactedAt=now;redacted++;
   }
   for(const row of data.messages){
    if(row.status==='CLOSED'||now<row.expiresAt)continue;
    row.revision=row.status==='DRAFT'?2:3;
    row.status='CLOSED';row.closedAt=now;delete row.text;total++;
   }
   // Redacted tombstones are retained for only 24 hours. There is no
   // provider receipt to retry; deleting old HELD seats cannot authorize
   // delivery or reconstruct private content.
   const before=data.messages.length;
   data.messages=data.messages.filter(row=>row.status!=='CLOSED'||
    row.closedAt===undefined||now-row.closedAt<=86_400_000);
   const kept=new Set(data.messages.map(row=>row.id));
   data.reservations=data.reservations.filter(row=>kept.has(row.messageId));
   data.announcements=(data.announcements??[]).filter(a=>kept.has(a.messageId));
   // Privacy: report references cannot retain old secret/message identity
   // longer than its redacted tombstone; no unbounded evidence archive.
   data.reports=(data.reports??[]).filter(r=>
    kept.has(r.messageId)&&r.reportedAt<=now&&
    now-r.reportedAt<=86_400_000);
   // Disabled blocks and old reviewed reports are pruned regularly.
   data.blocks=(data.blocks??[]).filter(b=>
    b.updatedAt<=now&&(b.enabled||now-b.updatedAt<86400000));
   if(total||redacted||data.messages.length!==before||
      (data.reports?.length??0)!==(s.phase4Whispers?.reports?.length??0)||
      (data.blocks?.length??0)!==(s.phase4Whispers?.blocks?.length??0)||
      (data.announcements?.length??0)!==(s.phase4Whispers?.announcements?.length??0))
    s.phase4Whispers=data;
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
   Math.max(0,row.seats-used)+'/'+row.seats+' · الإعلان: '+
   ((clone(s).announcements??[]).find(x=>x.messageId===id)?.status??'NOT_POSTED');
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
