import {createHash} from 'node:crypto';
import type {BotState,BotStore,AuditRecord} from './store.js';
import type {Policy} from './policy.js';
import type {CaptchaService} from './captcha.js';
import type {TelegramTemporaryGroupSender,TemporaryGroupSendResult,TemporaryGroupDeleteResult} from './telegram-temporary-group-sender.js';

const POLICY='captcha:join-notice-policy:',ROOT='captcha:join-notice-job:',PREFIX='CAPTCHA_JOIN_NOTICE:';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const safeTime=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-120000;
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const update=(v:unknown):v is string=>typeof v==='string'&&/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
type Consent={enabled:boolean;revision:number;stamp:string};
type Notice={key:string;chat:string;topicId?:number;at:number;version:number;revision:number;stamp:string;sentAt:number};
type Status='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED';
const outcome=(s:BotState,key:string,suffix:string)=>s.audit.filter(a=>a.updateKey===key+suffix);
const validMarker=(a:AuditRecord|undefined,key:string,actor:string,version:number,reason:string,now:number)=>
 !!a&&a.updateKey===key&&a.actorId===actor&&a.policyVersion===version&&a.decision==='ALLOW'&&
 a.reason===reason&&safeTime(a.at)&&a.at<=now;

/** Explicit owner opt-in. Notice creation/dispatch is disabled by default.
 * Only generic bot links are sent. The receiver and its challenge remain private. */
export class CaptchaJoinNotices{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,private readonly captcha:CaptchaService,
  private readonly sender:Pick<TelegramTemporaryGroupSender,'send'|'delete'>,private readonly botUsername:string,
  private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 private stamp(s:BotState,chat:string):string{
  return hash(['CAPTCHA_JOIN_NOTICE_V1',this.policyAccess.ownerId,chat,s.chats.filter(c=>c.id===chat),
   s.grants,s.privateFeatures,s.privateSettingsRevision??null,this.captcha.settings(s,chat)]);
 }
 epoch(s:BotState,chat:string):string{
  return hash([this.stamp(s,chat),s.audit.filter(a=>a.updateKey===POLICY+chat)]);
 }
 policy(s:BotState,chat:string):Consent|null{
  const stamp=this.stamp(s,chat),rows=s.audit.filter(a=>a.updateKey===POLICY+chat),a=rows[0],now=this.clock();
  if(!group(chat)||!safeTime(now)||!this.policyAccess.canUseChat(s,chat,'moderation')||
     !this.policyAccess.canUseChat(s,chat,'verification')||s.chats.filter(c=>c.id===chat).length!==1)return null;
  if(rows.length===0)return {enabled:false,revision:0,stamp};
  if(rows.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
     !safeTime(a.at)||a.at>now||a.policyVersion!==this.policyAccess.chatRevision(s,chat))return null;
  try{
   const parsed:unknown=JSON.parse(a.reason);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
   const v=parsed as Record<string,unknown>;
   if(Object.keys(v).sort().join(',')!=='enabled,revision,stamp'||typeof v.enabled!=='boolean'||
      !Number.isSafeInteger(v.revision)||Number(v.revision)<1||typeof v.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(v.stamp))return null;
   // Historical settings never grant authority after a group or CAPTCHA change.
   return {enabled:v.stamp===stamp&&v.enabled,revision:Number(v.revision),stamp};
  }catch{return null;}
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef?:string):Promise<boolean>{
  if(typeof enabled!=='boolean'||!group(chat)||!/^[a-f0-9]{64}$/u.test(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),consent=this.policy(s,chat);
   if(!safeTime(now)||!this.policyAccess.isOwner(actor)||!this.policyAccess.privateFeature(s,'owner.dashboard',actor)||
      !consent||this.epoch(s,chat)!==expected||consent.revision>=Number.MAX_SAFE_INTEGER||
      enabled&&!this.captcha.settings(s,chat)?.enabled)return false;
   if(confirmationRef!==undefined){
    const rows=s.callbacks.filter(c=>c.ref===confirmationRef),callback=rows[0];
    if(!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef)||rows.length!==1||!callback||
      callback.actorId!==actor||callback.chatId!=='private'||callback.policyVersion!==0||
      !callback.oneShot||!callback.used||callback.revoked||!safeTime(callback.expiresAt-1)||
      callback.expiresAt<=now||callback.expiresAt>now+120000)return false;
   }
   const revision=consent.revision+1,record={actorId:actor,updateKey:POLICY+chat,decision:'ALLOW' as const,
    reason:JSON.stringify({enabled,revision,stamp:consent.stamp}),policyVersion:this.policyAccess.chatRevision(s,chat),at:now};
   const prior=s.audit.find(a=>a.updateKey===record.updateKey);
   if(prior)Object.assign(prior,record);else s.audit.push(record);
   s.audit.push({actorId:actor,updateKey:'captcha:join-notice-change:'+hash([chat,now,revision,consent.stamp]).slice(0,40),
    decision:'ALLOW',reason:'JOIN_NOTICE_POLICY_CHANGE:'+hash(record),policyVersion:record.policyVersion,at:now});
   return true;
  });
 }
 /** May only observe the CURRENT authenticated Telegram join, after CaptchaService.observe.
  * No member identifier, username or join message ID is written to this public notice queue. */
 async observe(chat:string,members:string[],updateKey:string,sentAt:number,topicId?:number):Promise<number>{
  if(!group(chat)||!update(updateKey)||!safeTime(sentAt)||!Array.isArray(members)||
     members.length<1||members.length>100||new Set(members).size!==members.length||!members.every(person)||
     topicId!==undefined&&(!Number.isSafeInteger(topicId)||topicId<1||topicId>2147483647))return 0;
  return this.store.transaction(s=>{
   const now=this.clock(),consent=this.policy(s,chat),settings=this.captcha.settings(s,chat);
   if(!safeTime(now)||sentAt>now||now-sentAt>30000||!consent?.enabled||!settings?.enabled)return 0;
   const eligible=members.some(member=>{
    if(this.policyAccess.isOwner(member)||this.policyAccess.has(s,member,'chat.manage',chat,now))return false;
    const challenge=this.captcha.challenge(s,chat,member),receipts=challenge?s.audit.filter(a=>a.updateKey==='captcha:join-issued:'+challenge.nonce):[];
    return !!challenge&&challenge.issued>=sentAt&&challenge.issued<=now&&
     this.captcha.status(s,chat,member)==='PENDING'&&receipts.length===1&&
     receipts[0]?.actorId===member&&receipts[0].decision==='ALLOW'&&
     receipts[0].at===challenge.issued&&receipts[0].policyVersion===this.policyAccess.chatRevision(s,chat);
   });
   if(!eligible)return 0;
   const key=ROOT+hash([chat,updateKey,sentAt]),rows=s.audit.filter(a=>a.updateKey===key);
   if(rows.length)return 0;
   const at=now,version=this.policyAccess.chatRevision(s,chat);
   s.audit.push({actorId:this.policyAccess.ownerId,updateKey:key,decision:'ALLOW',reason:PREFIX+
    JSON.stringify({chat,topicId:topicId??null,at,sentAt,revision:consent.revision,stamp:consent.stamp}),policyVersion:version,at});
   return 1;
  });
 }
 private jobs(s:BotState,now:number):Notice[]{
  if(!safeTime(now))return [];
  const jobs:Notice[]=[];
  for(const a of s.audit){
   if(!/^captcha:join-notice-job:[a-f0-9]{64}$/u.test(a.updateKey)||!a.reason.startsWith(PREFIX)||
      a.decision!=='ALLOW'||a.actorId!==this.policyAccess.ownerId||!safeTime(a.at)||
      a.at>now||s.audit.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
   try{
    const data:unknown=JSON.parse(a.reason.slice(PREFIX.length));
    if(!data||typeof data!=='object'||Array.isArray(data))continue;
    const d=data as Record<string,unknown>;
    if(Object.keys(d).sort().join(',')!=='at,chat,revision,sentAt,stamp,topicId'||
       !group(d.chat)||!safeTime(d.at)||d.at!==a.at||
       !safeTime(d.sentAt)||Number(d.sentAt)>a.at||a.at-Number(d.sentAt)>30000||
       !Number.isSafeInteger(d.revision)||Number(d.revision)<1||
       typeof d.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(d.stamp)||
       d.topicId!==null&&(typeof d.topicId!=='number'||!Number.isSafeInteger(d.topicId)||d.topicId<1||d.topicId>2147483647)||
       !Number.isSafeInteger(a.policyVersion)||a.policyVersion<1)continue;
    jobs.push({key:a.updateKey,chat:d.chat,at:a.at,version:a.policyVersion,revision:Number(d.revision),
     stamp:d.stamp,sentAt:Number(d.sentAt),...(d.topicId===null?{}:{topicId:d.topicId as number})});
   }catch{/* Corrupted audit evidence never authorizes Telegram calls. */}
  }
  return jobs.sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key));
 }
 private eligible(s:BotState,n:Notice,now:number):boolean{
  const consent=this.policy(s,n.chat);
  return safeTime(now)&&now>=n.at&&now<n.at+30000&&!!consent?.enabled&&
   consent.revision===n.revision&&consent.stamp===n.stamp&&
   this.policyAccess.chatRevision(s,n.chat)===n.version&&
   this.captcha.settings(s,n.chat)?.enabled===true;
 }
 private started(s:BotState,n:Notice,now:number):boolean{
  const rows=outcome(s,n.key,':started');
  return rows.length===1&&validMarker(rows[0],n.key+':started',this.policyAccess.ownerId,n.version,'CAPTCHA_JOIN_NOTICE_STARTED',now)&&
   rows[0]!.at>=n.at&&now<rows[0]!.at+30000&&!outcome(s,n.key,':outcome').length;
 }
 private mark(s:BotState,n:Notice,suffix:string,status:string,now:number):void{
  if(outcome(s,n.key,suffix).length)return;
  s.audit.push({actorId:this.policyAccess.ownerId,updateKey:n.key+suffix,decision:'NOOP',
   reason:status,policyVersion:n.version,at:safeTime(now)&&now>=n.at?now:n.at});
 }
 private delivery(s:BotState,n:Notice,now:number):Status|'PENDING'{
  const rows=outcome(s,n.key,':outcome'),a=rows[0];
  if(!rows.length)return 'PENDING';
  if(rows.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='NOOP'||
     a.policyVersion!==n.version||!safeTime(a.at)||a.at<n.at||a.at>now||
     !/^CAPTCHA_JOIN_NOTICE_(CONFIRMED|FAILED_CONFIRMED|UNKNOWN_OUTCOME|CANCELLED)$/u.test(a.reason))return 'UNKNOWN_OUTCOME';
  return a.reason.slice('CAPTCHA_JOIN_NOTICE_'.length) as Status;
 }
 async drain(limit=5):Promise<{sent:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('CAPTCHA_JOIN_NOTICE_LIMIT_INVALID');
  let sent=0,unresolved=0;
  for(let i=0;i<limit;i++){
   if(!await this.safety())break;
   const claim=await this.store.transaction(s=>{
    const now=this.clock();if(!safeTime(now))return null;
    const n=this.jobs(s,now).find(n=>this.delivery(s,n,now)==='PENDING');
    if(!n)return null;
    if(outcome(s,n.key,':started').length){this.mark(s,n,':outcome','CAPTCHA_JOIN_NOTICE_UNKNOWN_OUTCOME',now);return 'SKIP' as const;}
    if(!this.eligible(s,n,now)){this.mark(s,n,':outcome','CAPTCHA_JOIN_NOTICE_CANCELLED',now);return 'SKIP' as const;}
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:n.key+':started',decision:'ALLOW',
     reason:'CAPTCHA_JOIN_NOTICE_STARTED',policyVersion:n.version,at:now});return n;
   });
   if(!claim)break;
   if(claim==='SKIP')continue;
   let result:TemporaryGroupSendResult={status:'NOT_SENT'};
   try{
    result=await this.sender.send({chatId:claim.chat,botUsername:this.botUsername,
     ...(claim.topicId===undefined?{}:{topicId:claim.topicId}),kind:'CAPTCHA'},async()=>{
      if(!await this.safety())return false;
      const s=await this.store.snapshot(),now=this.clock();
      return this.eligible(s,claim,now)&&this.started(s,claim,now)&&await this.safety();
    });
   }catch{result={status:'UNKNOWN_OUTCOME'};}
   const status=await this.store.transaction(s=>{
    const now=this.clock(),safe=this.eligible(s,claim,now)&&this.started(s,claim,now);
    if(result.status==='CONFIRMED'&&safe&&Number.isSafeInteger(result.messageId)&&result.messageId>0){
     const collision=s.audit.some(a=>a.reason.startsWith('CAPTCHA_JOIN_NOTICE_RECEIPT:')&&a.reason.startsWith('CAPTCHA_JOIN_NOTICE_RECEIPT:'+claim.chat+':'+result.messageId+':'));
     if(!collision){
      s.audit.push({actorId:this.policyAccess.ownerId,updateKey:claim.key+':receipt',decision:'ALLOW',
       reason:'CAPTCHA_JOIN_NOTICE_RECEIPT:'+claim.chat+':'+result.messageId+':'+hash([claim, result.messageId]),
       policyVersion:claim.version,at:now});
      this.mark(s,claim,':outcome','CAPTCHA_JOIN_NOTICE_CONFIRMED',now);return 'CONFIRMED' as const;
     }
    }
    const settled=safe&&(result.status==='FAILED_CONFIRMED'||result.status==='NOT_SENT')?
     result.status==='FAILED_CONFIRMED'?'FAILED_CONFIRMED':'CANCELLED':'UNKNOWN_OUTCOME';
    this.mark(s,claim,':outcome','CAPTCHA_JOIN_NOTICE_'+settled,now);
    return settled;
   });
   if(status==='CONFIRMED')sent++;else if(status==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {sent,unresolved};
 }
 private receipt(s:BotState,n:Notice,now:number):number|null{
  if(this.delivery(s,n,now)!=='CONFIRMED')return null;
  const outcomes=outcome(s,n.key,':outcome'),receipts=outcome(s,n.key,':receipt'),
   starts=outcome(s,n.key,':started'),a=receipts[0],
   match=/^CAPTCHA_JOIN_NOTICE_RECEIPT:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,15}):([a-f0-9]{64})$/u.exec(a?.reason??'');
  if(outcomes.length!==1||receipts.length!==1||starts.length!==1||!a||!match||
   match[1]!==n.chat||!Number.isSafeInteger(Number(match[2]))||
   !validMarker(a,n.key+':receipt',this.policyAccess.ownerId,n.version,a.reason,now)||
   a.at!==outcomes[0]?.at||a.at<starts[0]!.at||
   match[3]!==hash([n,Number(match[2])]))return null;
  const claims=s.audit.filter(row=>row.reason.startsWith('CAPTCHA_JOIN_NOTICE_RECEIPT:'+n.chat+':'+match[2]+':'));
  return claims.length===1?Number(match[2]):null;
 }
 private cleanupEligible(s:BotState,n:Notice,messageId:number,now:number):boolean{
  if(!safeTime(now)||now<n.at+60000||now>=n.at+86400000||
    !this.policyAccess.canUseChat(s,n.chat,'moderation')||
    this.policyAccess.chatRevision(s,n.chat)!==n.version)return false;
  return this.receipt(s,n,now)===messageId;
 }
 async cleanup(limit=5):Promise<{deleted:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('CAPTCHA_JOIN_CLEANUP_LIMIT_INVALID');
  let deleted=0,unresolved=0;
  for(let i=0;i<limit;i++){
   if(!await this.safety())break;
   const claim=await this.store.transaction(s=>{
    const now=this.clock();if(!safeTime(now))return null;
    const n=this.jobs(s,now).find(n=>{
     const messageId=this.receipt(s,n,now);
     return messageId!==null&&now>=n.at+60000&&!outcome(s,n.key,':delete-outcome').length;
    });
    if(!n)return null;
    const messageId=this.receipt(s,n,now)!;
    if(outcome(s,n.key,':delete-started').length){
     this.mark(s,n,':delete-outcome','CAPTCHA_JOIN_DELETE_UNKNOWN_OUTCOME',now);return 'SKIP' as const;
    }
    if(!this.cleanupEligible(s,n,messageId,now)){
     this.mark(s,n,':delete-outcome','CAPTCHA_JOIN_DELETE_CANCELLED',now);return 'SKIP' as const;
    }
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:n.key+':delete-started',decision:'ALLOW',
     reason:'CAPTCHA_JOIN_DELETE_STARTED',policyVersion:n.version,at:now});
    return {n,messageId,at:now};
   });
   if(!claim)break;if(claim==='SKIP')continue;
   let response:TemporaryGroupDeleteResult='NOT_SENT';
   try{
    response=await this.sender.delete(claim.n.chat,claim.messageId,async()=>{
     if(!await this.safety())return false;
     const s=await this.store.snapshot(),now=this.clock(),started=outcome(s,claim.n.key,':delete-started');
     return this.cleanupEligible(s,claim.n,claim.messageId,now)&&started.length===1&&
      validMarker(started[0],claim.n.key+':delete-started',this.policyAccess.ownerId,claim.n.version,
       'CAPTCHA_JOIN_DELETE_STARTED',now)&&
      now>=claim.at&&now<claim.at+30000&&!outcome(s,claim.n.key,':delete-outcome').length&&await this.safety();
    });
   }catch{response='UNKNOWN_OUTCOME';}
   const status=await this.store.transaction(s=>{
    const now=this.clock(),started=outcome(s,claim.n.key,':delete-started'),safe=this.cleanupEligible(s,claim.n,claim.messageId,now)&&
     started.length===1&&validMarker(started[0],claim.n.key+':delete-started',this.policyAccess.ownerId,claim.n.version,
      'CAPTCHA_JOIN_DELETE_STARTED',now)&&now>=claim.at&&now<claim.at+30000;
    const status=safe?response:'UNKNOWN_OUTCOME';
    this.mark(s,claim.n,':delete-outcome','CAPTCHA_JOIN_DELETE_'+status,now);
    return status;
   });
   if(status==='ACKNOWLEDGED')deleted++;else if(status==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {deleted,unresolved};
 }
}
