import {createHash} from 'node:crypto';
import type {BotState,BotStore,AuditRecord} from './store.js';
import type {Policy} from './policy.js';
import {studioId,studioURL,validStudioContent,type StudioContent} from './button-studio-model.js';
import type {TemporaryGroupSendResult,TemporaryGroupDeleteResult} from './telegram-temporary-group-sender.js';

export type GreetingKind='WELCOME'|'FAREWELL'|'GUIDE'|'RULES';
export type GroupGreetingPayload={chatId:string;text:string;buttons:{text:string;url:string}[][];topicId?:number};
export interface GroupGreetingSender{
 send(payload:GroupGreetingPayload,verify:()=>Promise<boolean>):Promise<TemporaryGroupSendResult>;
 delete(chatId:string,messageId:number,verify:()=>Promise<boolean>):Promise<TemporaryGroupDeleteResult>;
}
export type GreetingPolicy={enabled:boolean;revision:number;stamp:string;templateId:string;templateRevision:number;templateDigest:string};
const POLICY='greeting:policy:',JOB='greeting:job:',PREFIX='GROUP_GREETING_V1:';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const isTime=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-600000;
const message=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const webhook=(v:unknown):v is string=>typeof v==='string'&&/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(v);
const topic=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const kind=(v:unknown):v is GreetingKind=>v==='WELCOME'||v==='FAREWELL'||v==='GUIDE'||v==='RULES';
const rows=(s:BotState,key:string)=>s.audit.filter(a=>a.updateKey===key);
type Job={key:string;chat:string;kind:GreetingKind;messageId:number;updateKey:string;sentAt:number;issued:number;version:number;revision:number;stamp:string;templateId:string;templateRevision:number;templateDigest:string;topicId?:number};
const format=(content:StudioContent,kind:GreetingKind,issued:number):string|null=>{
 if(!validStudioContent(content)||!isTime(issued))return null;
 const lang=content.text.replace(/\{[^{}]+\}/gu,'');
 const english=/[a-zA-Z]/u.test(lang)&&!/[\u0600-\u06ff]/u.test(lang);
 let date='',clock='';
 try{
  date=new Intl.DateTimeFormat(english?'en-GB':'ar',{timeZone:content.timezone,calendar:content.calendar,year:'numeric',month:'numeric',day:'numeric'}).format(issued);
  clock=new Intl.DateTimeFormat(english?'en-GB':'ar',{timeZone:content.timezone,hour:'2-digit',minute:'2-digit',hour12:content.hour12}).format(issued);
 }catch{return null;}
 const replacements:Record<string,string>={
  '{العضو}':kind==='WELCOME'?(english?'a new member':'عضو جديد'):kind==='FAREWELL'?(english?'one of our members':'أحد الأعضاء'):(english?'a student':'طالب'),
  '{اسم_المجموعة}':english?'Manaratak learning group':'مجموعة منارتك',
  '{التاريخ}':date,'{الوقت}':clock,
  '{رابط_القوانين}':english?'Ask an admin for the group rules':'اطلب قوانين المجموعة من المشرف'
 };
 const output=content.text.replace(/\{[^{}]+\}/gu,m=>replacements[m]??'');
 return output.length>0&&Array.from(output).length<=2000&&!/[\u0000-\u001f\u007f]/u.test(output.replace(/\n/gu,''))?output:null;
};
const links=(content:StudioContent):{text:string;url:string}[][]|null=>{
 if(!validStudioContent(content)||content.buttons.length>4)return null;
 const buttons:{text:string;url:string}[][]=[];
 let offset=0;
 for(const size of content.layout){
  const row:{text:string;url:string}[]=[];
  for(const b of content.buttons.slice(offset,offset+size)){
   if(b.action.kind!=='URL'||b.condition.role!=='ANY'||b.condition.opensAt!==0||
      b.condition.closesAt!==0||b.condition.seats!==0)return null;
   const url=studioURL(b.action.target);if(!url)return null;
   row.push({text:b.title,url});
  }
  buttons.push(row);offset+=size;
 }
 return buttons;
};
export function savedGreetingVersion(s:BotState,id:string,revision:number):{content:StudioContent;digest:string}|null{
 if(!studioId(id)||!Number.isSafeInteger(revision)||revision<1)return null;
 const ts=s.buttonStudio?.templates.filter(t=>t.id===id)??[],t=ts[0];
 if(ts.length!==1||!t||t.revision<revision)return null;
 const versions=t.versions.filter(v=>v.revision===revision),v=versions[0];
 if(versions.length!==1||!v||!links(v.content)||!validStudioContent(v.content))return null;
 return {content:v.content,digest:digest([id,revision,v.content])};
}
export class GroupWelcomeFarewell{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,
  private readonly sender:GroupGreetingSender,private readonly clock:()=>number,
  private readonly safety:()=>Promise<boolean>,
  private readonly deleteRights:(chat:string)=>Promise<'GRANTED'|'DENIED'|'UNKNOWN'>){}
 private stamp(s:BotState,chat:string):string{
  return digest(['GROUP_GREETING_CONSENT_V1',chat,this.policyAccess.ownerId,
   s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),
   s.privateFeatures,s.privateSettingsRevision??null]);
 }
 preview(s:BotState,chat:string,type:GreetingKind,id:string,revision:number):GroupGreetingPayload|null{
  if(!group(chat)||!kind(type)||!this.policyAccess.canUseChat(s,chat,'moderation'))return null;
  const v=savedGreetingVersion(s,id,revision),text=v?format(v.content,type,this.clock()):null,buttons=v?links(v.content):null;
  return text&&buttons?{chatId:chat,text,buttons}:null;
 }
 epoch(s:BotState,chat:string,type:GreetingKind):string{
  return digest([this.stamp(s,chat),rows(s,POLICY+chat+':'+type)]);
 }
 policy(s:BotState,chat:string,type:GreetingKind):GreetingPolicy|null{
  const now=this.clock();
  if(!group(chat)||!kind(type)||!isTime(now)||s.chats.filter(c=>c.id===chat).length!==1||
      !this.policyAccess.canUseChat(s,chat,'moderation'))return null;
  const stamp=this.stamp(s,chat),config=rows(s,POLICY+chat+':'+type),a=config[0];
  if(config.length===0)return {enabled:false,revision:0,stamp,templateId:'',templateRevision:0,templateDigest:''};
  if(config.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
     !isTime(a.at)||a.at>now||a.policyVersion!==this.policyAccess.chatRevision(s,chat))return null;
  try{
   const value:unknown=JSON.parse(a.reason);
   if(!value||typeof value!=='object'||Array.isArray(value))return null;
   const v=value as Record<string,unknown>;
   if(Object.keys(v).sort().join(',')!=='enabled,revision,stamp,templateDigest,templateId,templateRevision'||
      typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||
      typeof v.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(v.stamp)||
      typeof v.templateId!=='string'||!Number.isSafeInteger(v.templateRevision)||
      typeof v.templateDigest!=='string')return null;
   const selection=v.enabled? savedGreetingVersion(s,v.templateId,Number(v.templateRevision)):null;
   return {enabled:v.enabled&&v.stamp===stamp&&!!selection&&selection.digest===v.templateDigest,
    revision:Number(v.revision),stamp,templateId:v.templateId,templateRevision:Number(v.templateRevision),templateDigest:v.templateDigest};
  }catch{return null;}
 }
 async configure(actor:string,chat:string,type:GreetingKind,enabled:boolean,id:string,revision:number,expected:string,ref?:string):Promise<boolean>{
  if(!group(chat)||!kind(type)||typeof enabled!=='boolean'||typeof id!=='string'||!Number.isSafeInteger(revision)||
      typeof expected!=='string'||!/^[a-f0-9]{64}$/u.test(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),prior=this.policy(s,chat,type);
   if(!isTime(now)||!prior||prior.revision>=Number.MAX_SAFE_INTEGER||!this.policyAccess.isOwner(actor)||
      !this.policyAccess.privateFeature(s,'owner.dashboard',actor)||this.epoch(s,chat,type)!==expected)return false;
   const version=enabled?savedGreetingVersion(s,id,revision):null;
   if(enabled&&!version||!enabled&&(id!==''||revision!==0))return false;
   if(ref!==undefined){
    const callbacks=s.callbacks.filter(c=>c.ref===ref),c=callbacks[0];
    if(!/^welcome-owner:[A-Za-z0-9_-]{24}$/u.test(ref)||callbacks.length!==1||!c||
       c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||!c.used||c.revoked||
       !isTime(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return false;
   }
   const next={enabled,revision:prior.revision+1,stamp:prior.stamp,templateId:enabled?id:'',templateRevision:enabled?revision:0,templateDigest:version?.digest??''},
    auditKey=POLICY+chat+':'+type,record={actorId:actor,updateKey:auditKey,decision:'ALLOW' as const,
     reason:JSON.stringify(next),policyVersion:this.policyAccess.chatRevision(s,chat),at:now};
   const changed='greeting:policy-change:'+digest([chat,type,next,now]);
   if(s.audit.some(a=>a.updateKey===changed))return false;
   const existing=s.audit.find(a=>a.updateKey===auditKey);
   if(existing)Object.assign(existing,record);else s.audit.push(record);
   s.audit.push({actorId:actor,updateKey:changed,decision:'ALLOW',
    reason:'GROUP_GREETING_POLICY_CHANGED:'+digest(record),policyVersion:record.policyVersion,at:now});
   return true;
  });
 }
 /** GUIDE is a requested /guide command, never unsolicited. The transport must
  * authenticate an unedited non-forwarded group text update before invoking this
  * path; the shared queue reuses the same one-minute burst budget and receipts. */
 async observeGuide(chat:string,messageId:number,updateKey:string,sentAt:number,topicId?:number):Promise<number>{
  return this.observe(chat,'GUIDE',messageId,updateKey,sentAt,topicId);
 }
 /** A read-only, member-requested summary. Never changes the actual moderation
  * rules and never proactively posts rules to a joining member. */
 async observeRules(chat:string,messageId:number,updateKey:string,sentAt:number,topicId?:number):Promise<number>{
  return this.observe(chat,'RULES',messageId,updateKey,sentAt,topicId);
 }
 /** Called only after Telegram webhook decoding of an authentic service event
  * or, for GUIDE, an explicit human /guide command. */
 async observe(chat:string,type:GreetingKind,messageId:number,updateKey:string,sentAt:number,topicId?:number):Promise<number>{
  if(!group(chat)||!kind(type)||!message(messageId)||!webhook(updateKey)||!isTime(sentAt)||
      topicId!==undefined&&!topic(topicId))return 0;
  return this.store.transaction(s=>{
   const now=this.clock(),config=this.policy(s,chat,type);
   if(!isTime(now)||sentAt>now||now-sentAt>30000||!config?.enabled)return 0;
   const existing=this.jobs(s,now);
   if(existing.some(j=>j.chat===chat&&j.updateKey===updateKey))return 0;
   if(existing.some(j=>j.chat===chat&&j.kind===type&&now-j.issued>=0&&now-j.issued<60000))return 0;
   if(existing.filter(j=>j.chat===chat&&now-j.issued>=0&&now-j.issued<86400000).length>=250)return 0;
   const base={chat,kind:type,messageId,updateKey,sentAt,issued:now,
    version:this.policyAccess.chatRevision(s,chat),revision:config.revision,stamp:config.stamp,
    templateId:config.templateId,templateRevision:config.templateRevision,templateDigest:config.templateDigest,
    topicId:topicId??null};
   const key=JOB+digest(base);
   if(rows(s,key).length)return 0;
   s.audit.push({actorId:this.policyAccess.ownerId,updateKey:key,decision:'ALLOW',
    reason:PREFIX+JSON.stringify(base),policyVersion:base.version,at:now});
   return 1;
  });
 }
 private jobs(s:BotState,now:number):Job[]{
  if(!isTime(now))return [];
  const counts=new Map<string,number>(),result:Job[]=[];
  for(const a of s.audit)if(/^greeting:job:[a-f0-9]{64}$/u.test(a.updateKey))counts.set(a.updateKey,(counts.get(a.updateKey)??0)+1);
  for(const a of s.audit){
   if(!/^greeting:job:[a-f0-9]{64}$/u.test(a.updateKey)||counts.get(a.updateKey)!==1||
      a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||!a.reason.startsWith(PREFIX)||
      !isTime(a.at)||a.at>now||now-a.at>86400000)continue;
   try{
    const raw:unknown=JSON.parse(a.reason.slice(PREFIX.length));
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='chat,issued,kind,messageId,revision,sentAt,stamp,templateDigest,templateId,templateRevision,topicId,updateKey,version'||
       !group(v.chat)||!kind(v.kind)||!message(v.messageId)||!webhook(v.updateKey)||
       !isTime(v.issued)||!isTime(v.sentAt)||v.issued!==a.at||v.sentAt>v.issued||Number(v.issued)-Number(v.sentAt)>30000||
       !Number.isSafeInteger(v.revision)||Number(v.revision)<1||
       !Number.isSafeInteger(v.version)||Number(v.version)<1||v.version!==a.policyVersion||
       !studioId(v.templateId)||!Number.isSafeInteger(v.templateRevision)||Number(v.templateRevision)<1||
       typeof v.stamp!=='string'||!/^[a-f0-9]{64}$/u.test(v.stamp)||
       typeof v.templateDigest!=='string'||!/^[a-f0-9]{64}$/u.test(v.templateDigest)||
       v.topicId!==null&&!topic(v.topicId)||digest(v)!==a.updateKey.slice(JOB.length))continue;
    result.push({key:a.updateKey,chat:v.chat,kind:v.kind,messageId:v.messageId,updateKey:v.updateKey,
     issued:v.issued,sentAt:v.sentAt,version:v.version,revision:v.revision,stamp:v.stamp,
     templateId:v.templateId,templateRevision:v.templateRevision,templateDigest:v.templateDigest,
     ...(v.topicId===null?{}:{topicId:v.topicId})} as Job);
   }catch{/* malformed audit rows never authorize sending */}
  }
  return result.sort((a,b)=>a.issued-b.issued||a.chat.localeCompare(b.chat)||a.messageId-b.messageId);
 }
 private eligible(s:BotState,j:Job,now:number):boolean{
  if(!isTime(now)||now<j.issued||now>=j.issued+30000||this.policyAccess.chatRevision(s,j.chat)!==j.version)return false;
  const c=this.policy(s,j.chat,j.kind);
  return !!c?.enabled&&c.stamp===j.stamp&&c.revision===j.revision&&c.templateId===j.templateId&&
   c.templateRevision===j.templateRevision&&c.templateDigest===j.templateDigest;
 }
 private mark(s:BotState,j:Job,tail:':outcome'|':delete-outcome',status:string,at:number):void{
  if(rows(s,j.key+tail).length)return;
  s.audit.push({actorId:this.policyAccess.ownerId,updateKey:j.key+tail,decision:'NOOP',
   reason:status,policyVersion:j.version,at:isTime(at)?at:j.issued});
 }
 private begun(s:BotState,j:Job,now:number,tail:':started'|':delete-started',reason:string):boolean{
  const found=rows(s,j.key+tail),a=found[0];
  return found.length===1&&!!a&&a.actorId===this.policyAccess.ownerId&&a.decision==='ALLOW'&&
   a.reason===reason&&a.policyVersion===j.version&&isTime(a.at)&&a.at>=j.issued&&a.at<=now&&
   now<a.at+30000;
 }
 async drain(limit=5):Promise<{sent:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('GREETING_SEND_LIMIT_INVALID');
  let sent=0,unresolved=0;
  for(let i=0;i<limit;i++){
   try{if(!await this.safety())break;}catch{break;}
   const claimed=await this.store.transaction(s=>{
    const now=this.clock(),next=this.jobs(s,now).find(j=>!rows(s,j.key+':outcome').length);
    if(!next)return null;
    if(rows(s,next.key+':started').length){
     this.mark(s,next,':outcome','GROUP_GREETING_SEND_UNKNOWN_OUTCOME',now);return 'SKIP' as const;
    }
    if(!this.eligible(s,next,now)){
     this.mark(s,next,':outcome','GROUP_GREETING_SEND_CANCELLED',now);return 'SKIP' as const;
    }
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:next.key+':started',decision:'ALLOW',
     reason:'GROUP_GREETING_SEND_STARTED',policyVersion:next.version,at:now});
    return next;
   });
   if(!claimed)break;if(claimed==='SKIP')continue;
   let result:TemporaryGroupSendResult={status:'UNKNOWN_OUTCOME'};
   try{
    const s=await this.store.snapshot(),v=savedGreetingVersion(s,claimed.templateId,claimed.templateRevision);
    const text=v&&v.digest===claimed.templateDigest?format(v.content,claimed.kind,claimed.issued):null,
     buttons=v?links(v.content):null;
    if(text&&buttons){
     result=await this.sender.send({chatId:claimed.chat,text,buttons,
      ...(claimed.topicId?{topicId:claimed.topicId}:{})},async()=>{
       try{
        if(!await this.safety())return false;
        const state=await this.store.snapshot(),now=this.clock();
        return this.eligible(state,claimed,now)&&
         this.begun(state,claimed,now,':started','GROUP_GREETING_SEND_STARTED')&&
         !rows(state,claimed.key+':outcome').length&&await this.safety();
       }catch{return false;}
      });
    }else result={status:'NOT_SENT'};
   }catch{/* Unknown whether Telegram observed a request. */}
   const outcome=await this.store.transaction(s=>{
    const now=this.clock(),safe=this.eligible(s,claimed,now)&&
     this.begun(s,claimed,now,':started','GROUP_GREETING_SEND_STARTED');
    const confirmedId=result.status==='CONFIRMED'&&message(result.messageId)?result.messageId:null;
    if(safe&&confirmedId!==null&&!s.audit.some(a=>a.reason.startsWith('GROUP_GREETING_RECEIPT:'+claimed.chat+':'+confirmedId+':'))){
     const reason='GROUP_GREETING_RECEIPT:'+claimed.chat+':'+confirmedId+':'+digest([claimed,confirmedId]);
     s.audit.push({actorId:this.policyAccess.ownerId,updateKey:claimed.key+':receipt',decision:'ALLOW',
      reason,policyVersion:claimed.version,at:now});
     this.mark(s,claimed,':outcome','GROUP_GREETING_SEND_CONFIRMED',now);
     return 'CONFIRMED' as const;
    }
    const status=safe&&(result.status==='FAILED_CONFIRMED'||result.status==='NOT_SENT')?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
    this.mark(s,claimed,':outcome','GROUP_GREETING_SEND_'+status,now);
    return status;
   });
   if(outcome==='CONFIRMED')sent++;else if(outcome==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {sent,unresolved};
 }
 private receipt(s:BotState,j:Job,now:number):number|null{
  const starts=rows(s,j.key+':started'),outcomes=rows(s,j.key+':outcome'),receipts=rows(s,j.key+':receipt');
  if(starts.length!==1||outcomes.length!==1||receipts.length!==1||
     !this.begun(s,j,starts[0]!.at,':started','GROUP_GREETING_SEND_STARTED'))return null;
  const [o,a]=[outcomes[0]!,receipts[0]!];
  if(o.actorId!==this.policyAccess.ownerId||o.decision!=='NOOP'||o.reason!=='GROUP_GREETING_SEND_CONFIRMED'||
     o.policyVersion!==j.version||!isTime(o.at)||o.at<starts[0]!.at||o.at>now||
     a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||a.policyVersion!==j.version||
     !isTime(a.at)||a.at!==o.at)return null;
  const m=/^GROUP_GREETING_RECEIPT:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,15}):([a-f0-9]{64})$/u.exec(a.reason);
  if(!m||m[1]!==j.chat||!message(Number(m[2]))||m[3]!==digest([j,Number(m[2])])||
     s.audit.filter(row=>row.reason.startsWith('GROUP_GREETING_RECEIPT:'+j.chat+':'+m[2]+':')).length!==1)return null;
  return Number(m[2]);
 }
 private mayDelete(s:BotState,j:Job,msgId:number,now:number):boolean{
  if(!isTime(now)||now<j.issued+300000||now>=j.issued+86400000||!this.policyAccess.canUseChat(s,j.chat,'moderation')||
     this.policyAccess.chatRevision(s,j.chat)!==j.version)return false;
  return this.receipt(s,j,now)===msgId;
 }
 async cleanup(limit=5):Promise<{deleted:number;unresolved:number}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('GREETING_DELETE_LIMIT_INVALID');
  let deleted=0,unresolved=0;
  for(let i=0;i<limit;i++){
   try{if(!await this.safety())break;}catch{break;}
   const state=await this.store.snapshot(),now=this.clock();
   if(!isTime(now))break;
   const item=this.jobs(state,now).find(j=>!rows(state,j.key+':delete-outcome').length&&
     (rows(state,j.key+':delete-started').length>0||this.receipt(state,j,now)!==null&&now>=j.issued+300000));
   if(!item)break;
   if(rows(state,item.key+':delete-started').length){
    await this.store.transaction(s=>this.mark(s,item,':delete-outcome','GROUP_GREETING_DELETE_UNKNOWN_OUTCOME',this.clock()));
    unresolved++;continue;
   }
   const msgId=this.receipt(state,item,now);
   if(msgId===null)break;
   let right:'GRANTED'|'DENIED'|'UNKNOWN'='UNKNOWN';
   try{right=await this.deleteRights(item.chat);}catch{/* fail closed */}
   if(right!=='GRANTED')break;
   const claimed=await this.store.transaction(s=>{
    const at=this.clock();
    if(!this.mayDelete(s,item,msgId,at)||rows(s,item.key+':delete-outcome').length||
       rows(s,item.key+':delete-started').length)return false;
    s.audit.push({actorId:this.policyAccess.ownerId,updateKey:item.key+':delete-started',decision:'ALLOW',
     reason:'GROUP_GREETING_DELETE_STARTED',policyVersion:item.version,at});
    return true;
   });
   if(!claimed)continue;
   let response:TemporaryGroupDeleteResult='UNKNOWN_OUTCOME';
   try{
    response=await this.sender.delete(item.chat,msgId,async()=>{
     try{
      if(!await this.safety())return false;
      const s=await this.store.snapshot(),at=this.clock();
      return this.mayDelete(s,item,msgId,at)&&
       this.begun(s,item,at,':delete-started','GROUP_GREETING_DELETE_STARTED')&&
       await this.deleteRights(item.chat)==='GRANTED'&&await this.safety();
     }catch{return false;}
    });
   }catch{/* unknown outcome is terminal */}
   const status=await this.store.transaction(s=>{
    const at=this.clock(),safe=this.mayDelete(s,item,msgId,at)&&
     this.begun(s,item,at,':delete-started','GROUP_GREETING_DELETE_STARTED');
    const outcome=safe?response:'UNKNOWN_OUTCOME';
    this.mark(s,item,':delete-outcome','GROUP_GREETING_DELETE_'+outcome,at);
    return outcome;
   });
   if(status==='ACKNOWLEDGED')deleted++;else if(status==='UNKNOWN_OUTCOME')unresolved++;
  }
  return {deleted,unresolved};
 }
}
