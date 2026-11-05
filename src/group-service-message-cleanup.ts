import {createHash} from 'node:crypto';
import type {BotState,BotStore,AuditRecord} from './store.js';
import type {Policy} from './policy.js';
import type {TemporaryGroupDeleteResult,TelegramTemporaryGroupSender} from './telegram-temporary-group-sender.js';
import {ancillaryServiceScope,type AncillaryServiceKind,type AncillaryServiceScope} from './telegram-ancillary-service-notices.js';

const P='group:service-cleanup-policy:',P_PIN='group:pin-cleanup-policy:',P_GROUP='group:group-change-cleanup-policy:',P_FORUM='group:forum-cleanup-policy:',ROOT='group:service-message-job:',PREFIX='GROUP_SERVICE_MESSAGE_V1:';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-120000;
const message=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const update=(v:unknown):v is string=>typeof v==='string'&&/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(v);
type Consent={enabled:boolean;revision:number;stamp:string};
type Kind='JOIN'|'LEAVE'|'PIN'|AncillaryServiceKind;
type Scope='JOIN'|'PIN'|AncillaryServiceScope;
const ancillaryKinds:readonly AncillaryServiceKind[]=['GROUP_TITLE','GROUP_PHOTO','GROUP_PHOTO_REMOVED',
 'TOPIC_CREATED','TOPIC_EDITED','TOPIC_CLOSED','TOPIC_REOPENED','TOPIC_HIDDEN','TOPIC_UNHIDDEN'];
const isKind=(v:unknown):v is Kind=>typeof v==='string'&&
 (v==='JOIN'||v==='LEAVE'||v==='PIN'||ancillaryKinds.includes(v as AncillaryServiceKind));
const scopeFor=(kind:Kind):Scope=>kind==='JOIN'||kind==='LEAVE'?'JOIN':
 kind==='PIN'?'PIN':ancillaryServiceScope(kind);
type Job={key:string;chat:string;kind:Kind;messageId:number;issued:number;sentAt:number;updateKey:string;version:number;revision:number;stamp:string};
type DeleteGateway=Pick<TelegramTemporaryGroupSender,'delete'>;
const suffix=(s:BotState,k:string,name:string)=>s.audit.filter(a=>a.updateKey===k+name);

/** Original Telegram service messages, not the bot's own notices.
 * Never guesses a message ID: must be bound to a validated webhook service event.
 * PIN notifications are separately owner-approved; the referenced pinned
 * message is NEVER a cleanup target. No user IDs, names, or service content
 * is persisted in the cleanup job. */
export class GroupServiceMessageCleanup{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,
  private readonly sender:DeleteGateway,private readonly clock:()=>number,
  private readonly safety:()=>Promise<boolean>,
  private readonly deleteRights:(chat:string)=>Promise<'GRANTED'|'DENIED'|'UNKNOWN'>){}
 private stamp(s:BotState,chat:string,scope:Scope='JOIN'):string{
  return digest([scope==='JOIN'?'SERVICE_CLEANUP_V1':
   scope==='PIN'?'PIN_SERVICE_CLEANUP_V1':
   scope==='GROUP'?'GROUP_CHANGES_SERVICE_CLEANUP_V1':'FORUM_SERVICE_CLEANUP_V1',this.policyAccess.ownerId,chat,
   s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),
   s.privateFeatures,s.privateSettingsRevision??null]);
 }
 private policyKey(scope:Scope):string{return scope==='JOIN'?P:scope==='PIN'?P_PIN:scope==='GROUP'?P_GROUP:P_FORUM;}
 private epochFor(s:BotState,chat:string,scope:Scope):string{
  return digest([this.stamp(s,chat,scope),s.audit.filter(a=>a.updateKey===this.policyKey(scope)+chat)]);
 }
 epoch(s:BotState,chat:string):string{return this.epochFor(s,chat,'JOIN');}
 epochPin(s:BotState,chat:string):string{return this.epochFor(s,chat,'PIN');}
 epochGroupChanges(s:BotState,chat:string):string{return this.epochFor(s,chat,'GROUP');}
 epochForum(s:BotState,chat:string):string{return this.epochFor(s,chat,'FORUM');}
 policy(s:BotState,chat:string):Consent|null{return this.policyFor(s,chat,'JOIN');}
 policyPin(s:BotState,chat:string):Consent|null{return this.policyFor(s,chat,'PIN');}
 policyGroupChanges(s:BotState,chat:string):Consent|null{return this.policyFor(s,chat,'GROUP');}
 policyForum(s:BotState,chat:string):Consent|null{return this.policyFor(s,chat,'FORUM');}
 private policyFor(s:BotState,chat:string,scope:Scope):Consent|null{
  if(!group(chat)||!time(this.clock())||!this.policyAccess.canUseChat(s,chat,'moderation')||
     s.chats.filter(c=>c.id===chat).length!==1)return null;
  const stamp=this.stamp(s,chat,scope),rows=s.audit.filter(a=>a.updateKey===this.policyKey(scope)+chat),a=rows[0];
  if(rows.length===0)return {enabled:false,revision:0,stamp};
  if(rows.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
     a.policyVersion!==this.policyAccess.chatRevision(s,chat)||!time(a.at)||a.at>this.clock())return null;
  try{
   const v:unknown=JSON.parse(a.reason);
   if(!v||typeof v!=='object'||Array.isArray(v))return null;
   const rec=v as Record<string,unknown>;
   if(Object.keys(rec).sort().join(',')!=='enabled,revision,stamp'||typeof rec.enabled!=='boolean'||
      !Number.isSafeInteger(rec.revision)||Number(rec.revision)<1||typeof rec.stamp!=='string'||
      !/^[a-f0-9]{64}$/u.test(rec.stamp))return null;
   return {enabled:rec.enabled===true&&rec.stamp===stamp,revision:Number(rec.revision),stamp};
  }catch{return null;}
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  return this.configureFor(actor,chat,enabled,expected,'JOIN',confirmationRef);
 }
 async configurePin(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  return this.configureFor(actor,chat,enabled,expected,'PIN',confirmationRef);
 }
 async configureGroupChanges(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  return this.configureFor(actor,chat,enabled,expected,'GROUP',confirmationRef);
 }
 async configureForum(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  return this.configureFor(actor,chat,enabled,expected,'FORUM',confirmationRef);
 }
 private async configureFor(actor:string,chat:string,enabled:boolean,expected:string,scope:Scope,confirmationRef?:string):Promise<boolean>{
  if(!group(chat)||typeof enabled!=='boolean'||typeof expected!=='string'||!/^[a-f0-9]{64}$/u.test(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),old=this.policyFor(s,chat,scope),policyKey=this.policyKey(scope);
   if(!time(now)||!this.policyAccess.isOwner(actor)||!this.policyAccess.privateFeature(s,'owner.dashboard',actor)||
      !old||old.revision>=Number.MAX_SAFE_INTEGER||this.epochFor(s,chat,scope)!==expected)return false;
   if(confirmationRef!==undefined){
    const rows=s.callbacks.filter(c=>c.ref===confirmationRef),c=rows[0];
    if(!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef)||rows.length!==1||!c||
       c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||!c.used||
       c.revoked||!time(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return false;
   }
   const version=this.policyAccess.chatRevision(s,chat),revision=old.revision+1,
    record={actorId:actor,updateKey:policyKey+chat,decision:'ALLOW' as const,
     reason:JSON.stringify({enabled,revision,stamp:old.stamp}),policyVersion:version,at:now};
   const updateKey=(scope==='JOIN'?'group:service-cleanup-change:':
    scope==='PIN'?'group:pin-cleanup-change:':
    scope==='GROUP'?'group:group-change-cleanup-change:':'group:forum-cleanup-change:')+digest([chat,now,revision,old.stamp]);
   if(s.audit.some(a=>a.updateKey===updateKey))return false;
   const existing=s.audit.find(a=>a.updateKey===policyKey+chat);
   if(existing)Object.assign(existing,record);else s.audit.push(record);
   s.audit.push({actorId:actor,updateKey,decision:'ALLOW',reason:(scope==='JOIN'?'SERVICE_CLEANUP_POLICY_UPDATE:':
    scope==='PIN'?'PIN_SERVICE_CLEANUP_POLICY_UPDATE:':
    scope==='GROUP'?'GROUP_CHANGES_SERVICE_CLEANUP_POLICY_UPDATE:':'FORUM_SERVICE_CLEANUP_POLICY_UPDATE:')+digest(record),policyVersion:version,at:now});
   return true;
  });
 }
 /** Invoked only by trusted Telegram service-event handling. PIN is the
  * service notification's own message ID, NEVER pinned_message.message_id. */
 async observeService(chat:string,kind:Kind,messageId:number,updateKey:string,sentAt:number):Promise<number>{
  if(!group(chat)||!isKind(kind)||!message(messageId)||!update(updateKey)||!time(sentAt))return 0;
  return this.store.transaction(s=>{
   const now=this.clock(),consent=this.policyFor(s,chat,scopeFor(kind));
   if(!time(now)||sentAt>now||now-sentAt>30000||!consent?.enabled)return 0;
   const existing=this.jobs(s,now);
   // One Telegram update identifies one service message. A replay with a
   // different kind or message ID cannot enqueue a second deletion.
   if(existing.some(j=>j.chat===chat&&(j.messageId===messageId||j.updateKey===updateKey)))return 0;
   // Bound storage and deletion pressure even when many service events arrive.
   if(existing.filter(j=>j.chat===chat&&now>=j.issued&&now-j.issued<60000).length>=40)return 0;
   const version=this.policyAccess.chatRevision(s,chat),data={
    chat,kind,messageId,updateKey,sentAt,issued:now,revision:consent.revision,stamp:consent.stamp,version
   };
   const key=ROOT+digest(data);
   if(s.audit.some(a=>a.updateKey===key))return 0;
   s.audit.push({actorId:this.policyAccess.ownerId,updateKey:key,decision:'ALLOW',
    reason:PREFIX+JSON.stringify(data),policyVersion:version,at:now});
   return 1;
  });
 }
 private jobs(s:BotState,now:number):Job[]{
  if(!time(now))return [];
  const result:Job[]=[],counts=new Map<string,number>();
  // A single pass detects duplicate restored audit keys. Scanning all historical
  // records for each job was quadratic and could delay the live safety loop.
  for(const a of s.audit)if(/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey))
   counts.set(a.updateKey,(counts.get(a.updateKey)??0)+1);
  for(const a of s.audit){
   if(!/^group:service-message-job:[a-f0-9]{64}$/u.test(a.updateKey)||
      !a.reason.startsWith(PREFIX)||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
      !time(a.at)||a.at>now||now-a.at>86400000||counts.get(a.updateKey)!==1)continue;
   try{
    const raw:unknown=JSON.parse(a.reason.slice(PREFIX.length));
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const d=raw as Record<string,unknown>;
    if(Object.keys(d).sort().join(',')!=='chat,issued,kind,messageId,revision,sentAt,stamp,updateKey,version'||
       !group(d.chat)||!isKind(d.kind)||!message(d.messageId)||
       !update(d.updateKey)||!time(d.sentAt)||!time(d.issued)||
       d.issued!==a.at||Number(d.issued)<Number(d.sentAt)||Number(d.issued)-Number(d.sentAt)>30000||
       !Number.isSafeInteger(d.revision)||Number(d.revision)<1||
       !Number.isSafeInteger(d.version)||Number(d.version)<1||d.version!==a.policyVersion||
       typeof d.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(d.stamp)||digest(d)!==a.updateKey.slice(ROOT.length))continue;
    result.push({key:a.updateKey,chat:d.chat,kind:d.kind as Kind,messageId:d.messageId,
     updateKey:d.updateKey,sentAt:d.sentAt,issued:d.issued,revision:Number(d.revision),
     stamp:d.stamp,version:Number(d.version)});
   }catch{/* restored/corrupted rows are not deletion evidence */}
  }
  return result.sort((a,b)=>a.issued-b.issued||a.chat.localeCompare(b.chat)||a.messageId-b.messageId||a.key.localeCompare(b.key));
 }
 private eligible(s:BotState,job:Job,now:number):boolean{
  if(!time(now)||now<job.issued+60000||now>=job.issued+86400000)return false;
  const c=this.policyFor(s,job.chat,scopeFor(job.kind));
  if(!c?.enabled||c.stamp!==job.stamp||c.revision!==job.revision||
     this.policyAccess.chatRevision(s,job.chat)!==job.version)return false;
  const matches=this.jobs(s,now).filter(n=>n.chat===job.chat&&n.messageId===job.messageId);
  return matches.length===1&&matches[0]!.key===job.key;
 }
 private marker(s:BotState,j:Job,mark:':started'|':outcome'):AuditRecord[]{
  return suffix(s,j.key,mark);
 }
 private started(s:BotState,j:Job,now:number):boolean{
  const rows=this.marker(s,j,':started'),start=rows[0];
  return rows.length===1&&!!start&&start.actorId===this.policyAccess.ownerId&&
   start.decision==='ALLOW'&&start.reason==='GROUP_SERVICE_DELETE_STARTED'&&
   start.policyVersion===j.version&&time(start.at)&&start.at>=j.issued+60000&&start.at<=now&&
   now<start.at+30000&&!this.marker(s,j,':outcome').length;
 }
 private done(s:BotState,j:Job,reason:string,now:number):void{
  if(this.marker(s,j,':outcome').length)return;
  s.audit.push({actorId:this.policyAccess.ownerId,updateKey:j.key+':outcome',decision:'NOOP',
   reason:'GROUP_SERVICE_DELETE_'+reason,policyVersion:j.version,at:time(now)?now:j.issued});
 }
 async cleanup(limit=5):Promise<{deleted:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('SERVICE_CLEANUP_LIMIT_INVALID');
  let deleted=0,unresolved=0;
  for(let i=0;i<limit;i++){
   try{if(await this.safety()!==true)break;}catch{break;}
   const snapshot=await this.store.snapshot(),now=this.clock();
   if(!time(now))break;
   const next=this.jobs(snapshot,now).find(j=>!this.marker(snapshot,j,':outcome').length&&
    (this.marker(snapshot,j,':started').length>0||this.eligible(snapshot,j,now)));
   if(!next)break;
   if(this.marker(snapshot,next,':started').length){
    await this.store.transaction(s=>{this.done(s,next,'UNKNOWN_OUTCOME',this.clock());});
    unresolved++;continue;
   }
   let rights:'GRANTED'|'DENIED'|'UNKNOWN'='UNKNOWN';
   try{rights=await this.deleteRights(next.chat);}catch{/* preserve safety */}
   if(rights!=='GRANTED')break;
   const claim=await this.store.transaction(s=>{
    const at=this.clock();
    if(!this.eligible(s,next,at)||this.marker(s,next,':started').length||
       this.marker(s,next,':outcome').length)return false;
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:next.key+':started',decision:'ALLOW',
     reason:'GROUP_SERVICE_DELETE_STARTED',policyVersion:next.version,at});
    return true;
   });
   if(!claim)continue;
   let result:TemporaryGroupDeleteResult='UNKNOWN_OUTCOME';
   try{
    result=await this.sender.delete(next.chat,next.messageId,async()=>{
     try{
      if(!await this.safety())return false;
      const s=await this.store.snapshot(),at=this.clock();
      return this.eligible(s,next,at)&&this.started(s,next,at)&&
       await this.deleteRights(next.chat)==='GRANTED'&&await this.safety();
     }catch{return false;}
    });
   }catch{/* external result uncertain */}
   const saved=await this.store.transaction(s=>{
    const at=this.clock(),fresh=this.eligible(s,next,at)&&this.started(s,next,at);
    const status=fresh?result:'UNKNOWN_OUTCOME';
    this.done(s,next,status,at);return status;
   });
   if(saved==='ACKNOWLEDGED')deleted++;else if(saved==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {deleted,unresolved};
 }
}
