import {createHash} from 'node:crypto';
import type {BotState,BotStore,AuditRecord} from './store.js';
import type {Policy} from './policy.js';
import type {TelegramTemporaryGroupSender,TemporaryGroupDeleteResult} from './telegram-temporary-group-sender.js';

const P='group:admin-command-policy:',ROOT='group:admin-command-job:',PREFIX='GROUP_ADMIN_COMMAND_V1:';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const actorId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const at=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-120000;
const msgId=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const update=(v:unknown):v is string=>typeof v==='string'&&/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(v);
type Kind='MODERATION'|'LOCK';
type Consent={enabled:boolean;revision:number;stamp:string};
type Job={key:string;chat:string;actor:string;kind:Kind;reason:string;messageId:number;
 updateKey:string;sentAt:number;issued:number;version:number;revision:number;stamp:string};
const suffix=(s:BotState,k:string,x:string)=>s.audit.filter(a=>a.updateKey===k+x);
const known=(kind:Kind,reason:string):boolean=>
 kind==='MODERATION'&&reason==='MODERATION_PREVIEW_ONLY'||kind==='LOCK'&&reason==='GROUP_PERMISSIONS_VIEW';
/** Cleans up only original commands whose authorized moderation/permission
 * previews were durably dispatched to the same actor privately. The preview
 * is required to be SENT before deletion, not merely queued or attempted. */
export class GroupAdminCommandCleanup{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,
  private readonly sender:Pick<TelegramTemporaryGroupSender,'delete'>,
  private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>,
  private readonly deleteRights:(chat:string)=>Promise<'GRANTED'|'DENIED'|'UNKNOWN'>){}
 private stamp(s:BotState,chat:string):string{
  return digest(['ADMIN_COMMAND_CLEANUP_V1',chat,this.policyAccess.ownerId,
   s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),
   s.privateFeatures,s.privateSettingsRevision??null]);
 }
 epoch(s:BotState,chat:string):string{return digest([this.stamp(s,chat),s.audit.filter(a=>a.updateKey===P+chat)]);}
 policy(s:BotState,chat:string):Consent|null{
  const now=this.clock();
  if(!group(chat)||!at(now)||s.chats.filter(c=>c.id===chat).length!==1||
     !this.policyAccess.canUseChat(s,chat,'moderation'))return null;
  const stamp=this.stamp(s,chat),records=s.audit.filter(a=>a.updateKey===P+chat),a=records[0];
  if(records.length===0)return {enabled:false,revision:0,stamp};
  if(records.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
     !at(a.at)||a.at>now||a.policyVersion!==this.policyAccess.chatRevision(s,chat))return null;
  try{
   const unknown:unknown=JSON.parse(a.reason);
   if(!unknown||typeof unknown!=='object'||Array.isArray(unknown))return null;
   const rec=unknown as Record<string,unknown>;
   if(Object.keys(rec).sort().join(',')!=='enabled,revision,stamp'||typeof rec.enabled!=='boolean'||
      !Number.isSafeInteger(rec.revision)||Number(rec.revision)<1||
      typeof rec.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(rec.stamp))return null;
   return {enabled:rec.enabled===true&&rec.stamp===stamp,revision:Number(rec.revision),stamp};
  }catch{return null;}
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  if(!group(chat)||typeof enabled!=='boolean'||typeof expected!=='string'||!/^[a-f0-9]{64}$/u.test(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),old=this.policy(s,chat);
   if(!at(now)||!this.policyAccess.isOwner(actor)||!this.policyAccess.privateFeature(s,'owner.dashboard',actor)||
      !old||old.revision>=999999999||this.epoch(s,chat)!==expected)return false;
   if(confirmationRef!==undefined){
    const callbacks=s.callbacks.filter(c=>c.ref===confirmationRef),c=callbacks[0];
    if(!/^admin-cleanup-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef)||
       callbacks.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
       !c.oneShot||!c.used||c.revoked||!at(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return false;
   }
   const version=this.policyAccess.chatRevision(s,chat),
    rec={actorId:actor,updateKey:P+chat,decision:'ALLOW' as const,
     reason:JSON.stringify({enabled,revision:old.revision+1,stamp:old.stamp}),
     policyVersion:version,at:now};
   const history='group:admin-command-policy-history:'+digest([chat,old.revision+1,now,enabled]);
   if(s.audit.some(a=>a.updateKey===history))return false;
   const existing=s.audit.find(a=>a.updateKey===P+chat);
   if(existing)Object.assign(existing,rec);else s.audit.push(rec);
   s.audit.push({updateKey:history,actorId:actor,decision:'ALLOW',
    reason:'ADMIN_COMMAND_CLEANUP_POLICY_CHANGED:'+digest(rec),policyVersion:version,at:now});
   return true;
  });
 }
 private delivery(s:BotState,j:Pick<Job,'actor'|'updateKey'>):boolean{
  const rows=s.telegramReplyJobs?.filter(x=>x.updateKey===j.updateKey)??[],job=rows[0];
  // The dispatcher *must* erase plan and privateReplyKind before its API
  // attempt. Sender identity and ADMIN_SCOPED provenance were verified when
  // this original command job was recorded, while the plan was still queued.
  // Only the same job's later CONFIRMED -> SENT receipt can enable deletion.
  return rows.length===1&&!!job&&job.status==='SENT'&&job.plan===undefined&&
   job.privateReplyKind===undefined&&msgId(job.messageId)&&
   at(job.startedAt)&&at(job.redactedAt)&&typeof job.attemptId==='string';
 }
 /** Called only from post-commit processing of a real, unedited group
  * command with an authorized moderation/lock preview. A stored ALLOW
  * decision and same-user private reply are mandatory independent witnesses. */
 async observeApproved(chat:string,messageId:number,actor:string,updateKey:string,
  kind:Kind,reason:string,sentAt:number):Promise<number>{
  if(!group(chat)||!msgId(messageId)||!actorId(actor)||!update(updateKey)||
     !known(kind,reason)||!at(sentAt))return 0;
  return this.store.transaction(s=>{
   const now=this.clock(),consent=this.policy(s,chat),
    original=s.audit.filter(a=>a.updateKey===updateKey),
    queue=s.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
   if(!at(now)||now<sentAt||now-sentAt>30000||!consent?.enabled||
      !this.policyAccess.has(s,actor,'chat.manage',chat,now)||
      !s.updates.some(u=>u.key===updateKey&&u.status==='DONE')||
      original.length!==1||original[0]!.decision!=='ALLOW'||original[0]!.reason!==reason||
      queue.length!==1||queue[0]!.privateReplyKind!=='ADMIN_SCOPED'||queue[0]!.plan?.chatId!==actor||
      queue[0]!.plan?.editMessageId!==undefined||!['QUEUED','SENDING','SENT','UNKNOWN_OUTCOME','FAILED_CONFIRMED'].includes(queue[0]!.status))return 0;
   const jobs=this.jobs(s,now);
   // A webhook update can only identify a single deletion target, even after
   // state restore, and this feature cannot authorize another operation.
   if(jobs.some(j=>j.chat===chat&&(j.updateKey===updateKey||j.messageId===messageId)))return 0;
   if(jobs.filter(j=>j.chat===chat&&now-j.issued>=0&&now-j.issued<60000).length>=20)return 0;
   const value={chat,actor,kind,reason,messageId,updateKey,sentAt,issued:now,
    version:this.policyAccess.chatRevision(s,chat),revision:consent.revision,stamp:consent.stamp};
   const key=ROOT+digest(value);
   if(s.audit.some(a=>a.updateKey===key))return 0;
   s.audit.push({actorId:actor,updateKey:key,decision:'ALLOW',
    reason:PREFIX+JSON.stringify(value),policyVersion:value.version,at:now});
   return 1;
  });
 }
 private jobs(s:BotState,now:number):Job[]{
  if(!at(now))return [];
  const counts=new Map<string,number>(),result:Job[]=[];
  for(const row of s.audit)if(/^group:admin-command-job:[a-f0-9]{64}$/u.test(row.updateKey))
   counts.set(row.updateKey,(counts.get(row.updateKey)??0)+1);
  for(const a of s.audit){
   if(!/^group:admin-command-job:[a-f0-9]{64}$/u.test(a.updateKey)||counts.get(a.updateKey)!==1||
      a.decision!=='ALLOW'||!a.reason.startsWith(PREFIX)||!at(a.at)||a.at>now||now-a.at>86400000)continue;
   try{
    const value:unknown=JSON.parse(a.reason.slice(PREFIX.length));
    if(!value||typeof value!=='object'||Array.isArray(value))continue;
    const v=value as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='actor,chat,issued,kind,messageId,reason,revision,sentAt,stamp,updateKey,version'||
       !group(v.chat)||!actorId(v.actor)||v.actor!==a.actorId||!msgId(v.messageId)||
       !update(v.updateKey)||!at(v.issued)||v.issued!==a.at||!at(v.sentAt)||
       Number(v.sentAt)>Number(v.issued)||Number(v.issued)-Number(v.sentAt)>30000||
       !known(v.kind as Kind,String(v.reason))||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||
       !Number.isSafeInteger(v.version)||Number(v.version)<1||v.version!==a.policyVersion||
       typeof v.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(v.stamp)||
       digest(v)!==a.updateKey.slice(ROOT.length))continue;
    result.push({...v,key:a.updateKey} as Job);
   }catch{/* Invalid historical evidence cannot authorize deletion. */}
  }
  return result.sort((a,b)=>a.issued-b.issued||a.key.localeCompare(b.key));
 }
 private eligible(s:BotState,j:Job,now:number):boolean{
  const cfg=this.policy(s,j.chat);
  return at(now)&&now>=j.issued+120000&&now<j.issued+86400000&&
   cfg?.enabled===true&&cfg.stamp===j.stamp&&cfg.revision===j.revision&&
   this.policyAccess.chatRevision(s,j.chat)===j.version&&
   this.policyAccess.has(s,j.actor,'chat.manage',j.chat,now)&&
   this.delivery(s,j)&&
   s.audit.filter(a=>a.updateKey===j.updateKey&&a.decision==='ALLOW'&&a.reason===j.reason).length===1&&
   this.jobs(s,now).filter(x=>x.chat===j.chat&&(x.messageId===j.messageId||x.updateKey===j.updateKey)).length===1;
 }
 private begun(s:BotState,j:Job,now:number):boolean{
  const logs=suffix(s,j.key,':started'),a=logs[0];
  return logs.length===1&&!!a&&a.actorId===this.policyAccess.ownerId&&
   a.decision==='ALLOW'&&a.reason==='GROUP_ADMIN_COMMAND_DELETE_STARTED'&&a.policyVersion===j.version&&
   at(a.at)&&a.at>=j.issued+120000&&a.at<=now&&now<a.at+30000&&
   !suffix(s,j.key,':outcome').length;
 }
 private done(s:BotState,j:Job,status:string,now:number):void{
  if(suffix(s,j.key,':outcome').length)return;
  s.audit.push({actorId:this.policyAccess.ownerId,updateKey:j.key+':outcome',decision:'NOOP',
   reason:'GROUP_ADMIN_COMMAND_DELETE_'+status,policyVersion:j.version,at:at(now)?now:j.issued});
 }
 async cleanup(limit=5):Promise<{deleted:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('ADMIN_COMMAND_CLEANUP_LIMIT_INVALID');
  let deleted=0,unresolved=0;
  for(let i=0;i<limit;i++){
   try{if(!await this.safety())break;}catch{break;}
   const snapshot=await this.store.snapshot(),now=this.clock();if(!at(now))break;
   const next=this.jobs(snapshot,now).find(j=>!suffix(snapshot,j.key,':outcome').length&&
    (suffix(snapshot,j.key,':started').length>0||this.eligible(snapshot,j,now)));
   if(!next)break;
   if(suffix(snapshot,next.key,':started').length){
    await this.store.transaction(s=>this.done(s,next,'UNKNOWN_OUTCOME',this.clock()));
    unresolved++;continue;
   }
   let rights:'GRANTED'|'DENIED'|'UNKNOWN'='UNKNOWN';
   try{rights=await this.deleteRights(next.chat);}catch{/* fail closed */}
   if(rights!=='GRANTED')break;
   const claimed=await this.store.transaction(s=>{
    const atNow=this.clock();
    if(!this.eligible(s,next,atNow)||suffix(s,next.key,':started').length||
       suffix(s,next.key,':outcome').length)return false;
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:next.key+':started',decision:'ALLOW',
     reason:'GROUP_ADMIN_COMMAND_DELETE_STARTED',policyVersion:next.version,at:atNow});
    return true;
   });
   if(!claimed)continue;
   let response:TemporaryGroupDeleteResult='UNKNOWN_OUTCOME';
   try{
    response=await this.sender.delete(next.chat,next.messageId,async()=>{
     try{
      if(!await this.safety())return false;
      const s=await this.store.snapshot(),atNow=this.clock();
      return this.eligible(s,next,atNow)&&this.begun(s,next,atNow)&&
       await this.deleteRights(next.chat)==='GRANTED'&&await this.safety();
     }catch{return false;}
    });
   }catch{/* Unknown external effect stays terminal. */}
   const result=await this.store.transaction(s=>{
    const atNow=this.clock(),ok=this.eligible(s,next,atNow)&&this.begun(s,next,atNow);
    const status=ok?response:'UNKNOWN_OUTCOME';
    this.done(s,next,status,atNow);return status;
   });
   if(result==='ACKNOWLEDGED')deleted++;else if(result==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {deleted,unresolved};
 }
}
