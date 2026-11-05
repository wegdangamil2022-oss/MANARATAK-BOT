import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {GroupServiceMessageCleanup} from './group-service-message-cleanup.js';
import type {GroupAdminCommandCleanup} from './group-admin-command-cleanup.js';
import {adminRoomNotificationTarget} from './admin-room-links.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

const POLICY='group:cleanup-audit-policy:',BATCH='group:cleanup-audit-batch:',TTL=180000;
const digest=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const stampTime=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-180000;
const validDigest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const validNumber=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=1000;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export type CleanupAuditCounts={ACKNOWLEDGED:number;FAILED_CONFIRMED:number;UNKNOWN_OUTCOME:number;NOT_SENT:number};
type Consent={enabled:boolean;revision:number;stamp:string;at:number};
type Target={id:string;room:string;setting:string};
export type CleanupAuditBatch={key:string;chat:string;room:string;link:string;setting:string;slot:number;version:number;
 revision:number;stamp:string;sourceHash:string;service:CleanupAuditCounts;command:CleanupAuditCounts};
type SendResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT';
const zero=():CleanupAuditCounts=>({ACKNOWLEDGED:0,FAILED_CONFIRMED:0,UNKNOWN_OUTCOME:0,NOT_SENT:0});
/** Fixed-message sender: the only outbound content is group ID and bounded
 * aggregate counts. No member ID, command text, message ID or source payload. */
export class TelegramGroupCleanupAuditSender{
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
 }
 async send(batch:CleanupAuditBatch,verify:()=>Promise<boolean>):Promise<SendResult>{
  if(!group(batch?.chat)||!group(batch?.room)||batch.chat===batch.room||!validDigest(batch.sourceHash)||
     ![batch.service,batch.command].every(x=>obj(x)&&Object.keys(x).sort().join(',')==='ACKNOWLEDGED,FAILED_CONFIRMED,NOT_SENT,UNKNOWN_OUTCOME'&&
      Object.values(x).every(v=>validNumber(v)))||typeof verify!=='function')return 'NOT_SENT';
  try{if(!await verify())return 'NOT_SENT';}catch{return 'NOT_SENT';}
  const summary=(title:string,x:CleanupAuditCounts)=>title+': ناجح '+x.ACKNOWLEDGED+
   '، مرفوض '+x.FAILED_CONFIRMED+'، غير محسوم '+x.UNKNOWN_OUTCOME+'، لم يُرسل '+x.NOT_SENT;
  const text='⚙️ تدقيق تنظيف الرسائل\nالمجموعة: '+batch.chat+'\n'+
   summary('إشعارات الخدمة',batch.service)+'\n'+summary('أوامر المشرفين',batch.command)+
   '\nمرجع تقرير غير كاشف: '+batch.sourceHash.slice(0,12)+'\nالنتيجة تخص محاولة الحذف فقط، وليست إثباتًا لقراءة الرسالة.';
  try{
   const response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:batch.room,text,link_preview_options:{is_disabled:true}}),
    redirect:'error',signal:AbortSignal.timeout(8000)});
   const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';
   const data:unknown=JSON.parse(raw);if(!obj(data))return 'UNKNOWN_OUTCOME';
   if(response.ok&&response.status===200&&data.ok===true&&obj(data.result)){
    const m=data.result;
    return obj(m.chat)&&m.chat.id===Number(batch.room)&&obj(m.from)&&
     m.from.id===Number(this.token.split(':')[0])&&m.from.is_bot===true&&
     typeof m.message_id==='number'&&Number.isSafeInteger(m.message_id)&&m.message_id>0?
     'CONFIRMED':'UNKNOWN_OUTCOME';
   }
   return response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?
    'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
}
/** Every audit report is separately owner-approved and tied to an already
 * double-approved NOTIFICATIONS room. The worker verifies the room is not
 * publicly addressable immediately before sending. No channel is inferred.
 *
 * One immutable aggregate per group per completed minute; a claimed window
 * never resends after a crash or ambiguous Telegram response. */
export class GroupCleanupAudit{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,
  private readonly service:GroupServiceMessageCleanup,private readonly commands:GroupAdminCommandCleanup,
  private readonly gateway:TelegramBotApiModerationGateway,
  private readonly sender:Pick<TelegramGroupCleanupAuditSender,'send'>,
  private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private target(s:BotState,chat:string,now:number):Target|null{
  if(!group(chat)||!stampTime(now))return null;
  return adminRoomNotificationTarget(s,this.policyAccess,chat,now);
 }
 private stamp(s:BotState,chat:string,now:number):string{
  const target=this.target(s,chat,now);
  return digest(['CLEANUP_AUDIT_V1',this.policyAccess.ownerId,chat,
   s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),
   s.privateFeatures,s.privateSettingsRevision??null,target]);
 }
 epoch(s:BotState,chat:string):string{
  const now=this.clock();
  return digest([this.stamp(s,chat,now),s.audit.filter(a=>a.updateKey===POLICY+chat)]);
 }
 policy(s:BotState,chat:string):Consent|null{
  const now=this.clock();
  if(!group(chat)||!stampTime(now)||!this.policyAccess.canUseChat(s,chat,'moderation')||
     s.chats.filter(c=>c.id===chat).length!==1)return null;
  const stamp=this.stamp(s,chat,now),rows=s.audit.filter(a=>a.updateKey===POLICY+chat),row=rows[0];
  if(rows.length===0)return {enabled:false,revision:0,stamp,at:0};
  if(rows.length!==1||!row||row.actorId!==this.policyAccess.ownerId||row.decision!=='ALLOW'||
     row.policyVersion!==this.policyAccess.chatRevision(s,chat)||!stampTime(row.at)||row.at>now)return null;
  try{
   const raw:unknown=JSON.parse(row.reason);
   if(!obj(raw)||Object.keys(raw).sort().join(',')!=='enabled,revision,stamp'||
      typeof raw.enabled!=='boolean'||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1||
      !validDigest(raw.stamp))return null;
   return {enabled:raw.enabled&&raw.stamp===stamp&&!!this.target(s,chat,now),
    revision:Number(raw.revision),stamp,at:row.at};
  }catch{return null;}
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  if(!group(chat)||typeof enabled!=='boolean'||!validDigest(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),consent=this.policy(s,chat);
   if(!stampTime(now)||!this.policyAccess.isOwner(actor)||
      !this.policyAccess.privateFeature(s,'owner.dashboard',actor)||!consent||
      !this.target(s,chat,now)||consent.revision>=999999999||this.epoch(s,chat)!==expected)return false;
   if(confirmationRef!==undefined){
    const rows=s.callbacks.filter(c=>c.ref===confirmationRef),c=rows[0];
    if(!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef)||rows.length!==1||
       !c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
       !c.oneShot||!c.used||c.revoked||!stampTime(c.expiresAt)||
       c.expiresAt<=now||c.expiresAt>now+120000)return false;
   }
   const version=this.policyAccess.chatRevision(s,chat),record={
    actorId:actor,updateKey:POLICY+chat,decision:'ALLOW' as const,
    reason:JSON.stringify({enabled,revision:consent.revision+1,stamp:consent.stamp}),
    policyVersion:version,at:now
   };
   const change='group:cleanup-audit-policy-change:'+digest([chat,now,consent.revision+1,consent.stamp]);
   if(s.audit.some(a=>a.updateKey===change))return false;
   const existing=s.audit.find(a=>a.updateKey===POLICY+chat);
   if(existing)Object.assign(existing,record);else s.audit.push(record);
   s.audit.push({updateKey:change,actorId:actor,decision:'ALLOW',
    reason:'CLEANUP_AUDIT_POLICY_CHANGED:'+digest(record),policyVersion:version,at:now});
   return true;
  });
 }
 private batches(s:BotState,now:number):CleanupAuditBatch[]{
  if(!stampTime(now))return [];
  const events=[...this.service.auditOutcomes(s,now),...this.commands.auditOutcomes(s,now)];
  const grouped=new Map<string,typeof events>();
  for(const event of events){
   const slot=Math.floor(event.at/60000),end=(slot+1)*60000;
   if(now<end||now>=end+TTL||!group(event.chat))continue;
   const consent=this.policy(s,event.chat);
   if(!consent?.enabled||consent.at>event.at||
      this.policyAccess.chatRevision(s,event.chat)!==event.version)continue;
   const key=event.chat+':'+slot,items=grouped.get(key)??[];
   items.push(event);grouped.set(key,items);
  }
  const results:CleanupAuditBatch[]=[];
  for(const [id,events] of grouped){
   const [chat,slotText]=id.split(':'),slot=Number(slotText),target=this.target(s,chat!,now),
    consent=this.policy(s,chat!);
   if(!target||!consent?.enabled||events.length===0)continue;
   const service=zero(),command=zero();
   for(const e of events){(e.kind==='SERVICE'?service:command)[e.status]++;}
   const sourceHash=digest(events.map(e=>[e.key,e.status,e.at,e.kind]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
   const key=BATCH+digest([chat,slot]);
   results.push({key,chat:chat!,room:target.room,link:target.id,setting:target.setting,
    slot,version:this.policyAccess.chatRevision(s,chat!),revision:consent.revision,stamp:consent.stamp,
    sourceHash,service,command});
  }
  return results.sort((a,b)=>a.slot-b.slot||a.chat.localeCompare(b.chat));
 }
 private current(s:BotState,job:CleanupAuditBatch,now:number):boolean{
  const active=this.batches(s,now).find(b=>b.key===job.key);
  const started=s.audit.filter(a=>a.updateKey===job.key+':started'),row=started[0];
  return !!active&&JSON.stringify(active)===JSON.stringify(job)&&
   started.length===1&&!!row&&row.actorId===this.policyAccess.ownerId&&
   row.decision==='ALLOW'&&row.reason==='CLEANUP_AUDIT_SEND_STARTED:'+digest(job)&&
   row.policyVersion===job.version&&stampTime(row.at)&&row.at<=now&&
   !s.audit.some(a=>a.updateKey===job.key+':outcome');
 }
 async drain(limit=5):Promise<{sent:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('CLEANUP_AUDIT_LIMIT_INVALID');
  let sent=0,unresolved=0;
  const safe=async()=>{try{return await this.safety()===true;}catch{return false;}};
  for(let i=0;i<limit;i++){
   if(!await safe())break;
   const job=await this.store.transaction(s=>{
    const now=this.clock(),candidate=this.batches(s,now).find(b=>
     !s.audit.some(a=>a.updateKey===b.key+':started'||a.updateKey===b.key+':outcome'));
    if(!candidate)return null;
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:candidate.key+':started',decision:'ALLOW',
     reason:'CLEANUP_AUDIT_SEND_STARTED:'+digest(candidate),policyVersion:candidate.version,at:now});
    return candidate;
   });
   if(!job)break;
   const current=async()=>{const s=await this.store.snapshot();return this.current(s,job,this.clock());};
   let result:SendResult='NOT_SENT';
   if(TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway)&&await safe()&&await current()){
    let visibility:'NO_PUBLIC_USERNAME'|'PUBLIC_USERNAME'|'NOT_GROUP'|'UNKNOWN'='UNKNOWN';
    try{visibility=await this.gateway.inspectRoomPrivacy(job.room);}catch{/* fail closed */}
    if(visibility==='NO_PUBLIC_USERNAME'&&
       TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway)&&await safe()&&await current())
     result=await this.sender.send(job,async()=>await safe()&&await current()&&
      TelegramBotApiModerationGateway.usesOfficialRoomPrivacyRead(this.gateway)&&await safe()&&await current());
   }
   const final=await this.store.transaction(s=>{
    const now=this.clock(),consistent=this.current(s,job,now);
    const status:SendResult=consistent?result:result==='NOT_SENT'?'NOT_SENT':'UNKNOWN_OUTCOME';
    if(!s.audit.some(a=>a.updateKey===job.key+':outcome'))
     s.audit.push({actorId:this.policyAccess.ownerId,updateKey:job.key+':outcome',decision:'NOOP',
      reason:'CLEANUP_AUDIT_SENT_'+status,policyVersion:job.version,at:stampTime(now)?now:job.slot*60000});
    return status;
   });
   if(final==='CONFIRMED')sent++;
   else if(final==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {sent,unresolved};
 }
}
