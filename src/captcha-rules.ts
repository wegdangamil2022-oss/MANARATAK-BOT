import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {MembershipPort} from './education-interactions.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {CaptchaService,captchaSource} from './captcha.js';
import {currentGroupRuleVersion,versions,type Version} from './group-rules-model.js';
import {subscriptionVerificationEpoch} from './subscription-verification-access.js';

const ROOT='captcha:rules-policy:',ACCEPTED='captcha:rules-accepted:',CALLBACK='captcha-rules:',TTL=120000;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const person=(v:string)=>/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const group=(v:string)=>/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const escape=(v:string)=>v.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
export const validCaptchaRulesRoute=(data:string)=>/^cr:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
type RuleConfig={state:'OFF'|'ON';revision:number}|{state:'INVALID';revision:number};
type RuleAction={chat:string;epoch:string;version:number;reference:string;proof:string};

/** Acceptance is scoped to a published rules version and a completed CAPTCHA.
 * It records only the member's own explicit decision; it does not release a sanction. */
export class CaptchaRuleGate{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly captcha:CaptchaService,private readonly membership:MembershipPort,private readonly clock:()=>number){}
 private stamp(s:BotState,chat:string):string{return hash([this.policy.ownerId,chat,s.chats.filter(c=>c.id===chat),this.captcha.settings(s,chat),s.privateFeatures['owner.dashboard'],s.privateSettingsRevision??null]);}
 epoch(s:BotState,chat:string):string{return hash([chat,captchaSource(s),s.audit.filter(a=>a.updateKey===ROOT+chat),versions(s,chat),s.audit.filter(a=>a.updateKey.startsWith('moderation:rules:published:'+chat+':'))]);}
 private config(s:BotState,chat:string):RuleConfig{
  const rows=s.audit.filter(a=>a.updateKey===ROOT+chat),a=rows[0],now=this.clock();if(!rows.length)return {state:'OFF',revision:0};
  if(rows.length!==1||!a||a.actorId!==this.policy.ownerId||a.decision!=='ALLOW'||a.policyVersion!==this.policy.chatRevision(s,chat)||!time(now)||!time(a.at)||a.at>now)return {state:'INVALID',revision:0};
  try{const v=JSON.parse(a.reason) as {enabled:boolean;revision:number;stamp:string};if(Object.keys(v).sort().join(',')!=='enabled,revision,stamp'||typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.revision)||v.revision<1||v.stamp!==this.stamp(s,chat))return {state:'INVALID',revision:0};return {state:v.enabled?'ON':'OFF',revision:v.revision};}catch{return {state:'INVALID',revision:0};}
 }
 private currentRule(s:BotState,chat:string):Version|null{const version=currentGroupRuleVersion(s,chat),rows=versions(s,chat).filter(v=>v.version===version);return version!==null&&rows.length===1?rows[0]!:null;}
 mode(s:BotState,chat:string):'OFF'|'ON'|'INVALID'{return this.config(s,chat).state;}
 hasRules(s:BotState,chat:string):boolean{return this.currentRule(s,chat)!==null;}
 private receipt(s:BotState,chat:string,actor:string):{key:string;reason:string;scope:number}|null{
  const config=this.config(s,chat),rule=this.currentRule(s,chat),challenge=this.captcha.challenge(s,chat,actor);if(config.state!=='ON'||!rule||!challenge)return null;
  const payload=[chat,actor,config.revision,rule.version,rule.scope,hash(rule),challenge.reference];return {key:ACCEPTED+hash(payload),reason:'CAPTCHA_RULES_ACCEPTED:'+hash(payload),scope:rule.scope};
 }
 status(s:BotState,chat:string,actor:string):'NOT_REQUIRED'|'PENDING'|'ACCEPTED'|'UNAVAILABLE'{
  if(!group(chat)||!person(actor)||!this.policy.canUseChat(s,chat,'moderation'))return 'UNAVAILABLE';const config=this.config(s,chat);if(config.state==='INVALID')return 'UNAVAILABLE';if(config.state==='OFF')return 'NOT_REQUIRED';
  const receipt=this.receipt(s,chat,actor),captcha=this.captcha.status(s,chat,actor);if(!receipt||captcha==='UNAVAILABLE')return 'UNAVAILABLE';if(captcha!=='PASSED')return 'PENDING';
  const rows=s.audit.filter(a=>a.updateKey===receipt.key),a=rows[0],now=this.clock();if(!rows.length)return 'PENDING';return rows.length===1&&a?.actorId===actor&&a.decision==='ALLOW'&&a.policyVersion===receipt.scope&&a.reason===receipt.reason&&time(a.at)&&time(now)&&a.at<=now?'ACCEPTED':'UNAVAILABLE';
 }
 pendingGroups(s:BotState,actor:string):string[]{
  if(!person(actor))return [];const groups=new Set<string>(),configured=new Set(s.audit.filter(a=>a.updateKey.startsWith(ROOT)).map(a=>a.updateKey.slice(ROOT.length)));for(const w of s.wizards){if(w.userId!==actor||typeof w.flow!=='string'||!w.flow.startsWith('captcha-member:'))continue;try{const v=JSON.parse(w.flow.slice('captcha-member:'.length));if(typeof v?.group==='string'&&group(v.group)&&configured.has(v.group)&&this.captcha.status(s,v.group,actor)==='PASSED'&&this.status(s,v.group,actor)==='PENDING')groups.add(v.group);}catch{/* malformed sessions are not surfaced */}}
  return [...groups].sort();
 }
 async pendingBatch(actor:string):Promise<string[]>{
  if(!person(actor)||!time(this.clock()))return [];const initial=this.pendingGroups(await this.store.snapshot(),actor);if(initial.length<=8)return initial;return this.store.transaction(s=>{const due=this.pendingGroups(s,actor),now=this.clock();if(!time(now)||due.length>1000)return [];if(due.length<=8)return due;
   const key='captcha:rules-cursor:'+actor,rows=s.audit.filter(a=>a.updateKey===key),old=rows[0];if(rows.length>1)return [];let cursor=0;
   if(old){if(old.actorId!==actor||old.decision!=='NOOP'||old.policyVersion!==0||!time(old.at)||old.at>now||!/^(0|[1-9][0-9]{0,2})$/u.test(old.reason))return [];cursor=Number(old.reason);}
   const index=cursor%due.length,batch=[...due.slice(index),...due.slice(0,index)].slice(0,8),record={actorId:actor,updateKey:key,decision:'NOOP' as const,reason:String((index+batch.length)%due.length),policyVersion:0,at:now};if(old)Object.assign(old,record);else s.audit.push(record);return batch;
  });
 }
 async cancel(actor:string):Promise<void>{
  if(!person(actor))return;const before=await this.store.snapshot();if(!before.callbacks.some(c=>c.ref.startsWith(CALLBACK)&&c.actorId===actor&&!c.used&&!c.revoked))return;
  await this.store.transaction(s=>{for(const c of s.callbacks)if(c.ref.startsWith(CALLBACK)&&c.actorId===actor&&!c.used)c.revoked=true;});
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef:string):Promise<boolean>{
  if(!group(chat)||typeof enabled!=='boolean'||!this.policy.isOwner(actor)||!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef))return false;
  return this.store.transaction(s=>{const now=this.clock(),callbacks=s.callbacks.filter(c=>c.ref===confirmationRef),c=callbacks[0];if(!time(now)||this.epoch(s,chat)!==expected||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.policy.canUseChat(s,chat,'moderation')||!this.captcha.settings(s,chat)?.enabled||enabled&&(!this.currentRule(s,chat)||!this.policy.canUseChat(s,chat,'navigation')||!this.policy.canUseChat(s,chat,'verification'))||callbacks.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||!c.used||c.revoked||!time(c.expiresAt)||now>=c.expiresAt||c.expiresAt>now+TTL)return false;
   try{const a=JSON.parse(c.action);if(!Array.isArray(a)||a.length!==3||a[1]!==captchaSource(s)||a[2]!==expected||a[0]?.group!==chat||a[0]?.kind!==(enabled?'rules-on-confirm':'rules-off-confirm'))return false;}catch{return false;}
   const rows=s.audit.filter(a=>a.updateKey===ROOT+chat),old=rows[0];if(rows.length>1)return false;let revision=0;if(old){try{const v=JSON.parse(old.reason);revision=v.revision;}catch{return false;}if(old.actorId!==actor||old.decision!=='ALLOW'||!time(old.at)||old.at>now||!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)return false;}
   const record={actorId:actor,updateKey:ROOT+chat,decision:'ALLOW' as const,reason:JSON.stringify({enabled,revision:revision+1,stamp:this.stamp(s,chat)}),policyVersion:this.policy.chatRevision(s,chat),at:now};if(old)Object.assign(old,record);else s.audit.push(record);s.audit.push({...record,updateKey:'captcha:rules-policy-change:'+randomBytes(18).toString('base64url'),reason:'CAPTCHA_RULES_POLICY:'+hash(record)});return true;
  });
 }
 async open(actor:string,chat:string):Promise<(OwnerInlineScreen&{verificationAccess:{actorId:string;scope:string;epoch:string;expiresAt:number}})|null>{
  const started=this.clock();if(!person(actor)||!group(chat)||!time(started))return null;const before=await this.store.snapshot(),epoch=this.epoch(before,chat);if(this.status(before,chat,actor)!=='PENDING'||this.captcha.status(before,chat,actor)!=='PASSED')return null;
  try{if(await this.membership(chat,actor)!=='VERIFIED')return null;}catch{return null;}
  return this.store.transaction(s=>{const now=this.clock(),rule=this.currentRule(s,chat),receipt=this.receipt(s,chat,actor),challenge=this.captcha.challenge(s,chat,actor);if(!time(now)||now<started||now>=started+TTL||this.epoch(s,chat)!==epoch||this.status(s,chat,actor)!=='PENDING'||this.captcha.status(s,chat,actor)!=='PASSED'||!rule||!receipt||!challenge||!subscriptionVerificationEpoch(s,this.policy,actor,chat,now))return null;
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(CALLBACK)||c.expiresAt>now);if(s.callbacks.filter(c=>c.ref.startsWith(CALLBACK)&&!c.used&&!c.revoked).length>=1000)return null;for(const c of s.callbacks)if(c.ref.startsWith(CALLBACK)&&c.actorId===actor&&!c.used)c.revoked=true;
   const nonce=randomBytes(18).toString('base64url'),action:RuleAction={chat,epoch,version:rule.version,reference:challenge.reference,proof:receipt.reason};s.callbacks.push({ref:CALLBACK+nonce,actorId:actor,chatId:'private',policyVersion:rule.scope,oneShot:true,used:false,revoked:false,expiresAt:now+TTL,action:JSON.stringify(action)});
   const active=rule.lines.map((line,i)=>rule.disabled?.includes(i+1)?null:(i+1)+'. '+escape(line)).filter((line):line is string=>line!==null);
   const access=subscriptionVerificationEpoch(s,this.policy,actor,chat,now);if(!access)return null;
   return {text:'<b>قوانين المجموعة — الإصدار '+rule.version+'</b>\n'+(active.length?active.join('\n'):'لا توجد فقرات فعالة حاليًا.')+'\nاقرأ القوانين ثم اختر الموافقة لإكمال هذه الخطوة.',keyboard:{inline_keyboard:[[{text:'✅ أوافق على القوانين',callback_data:'cr:1:'+nonce}],[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]},verificationAccess:{actorId:actor,scope:chat,epoch:access,expiresAt:now+TTL}};
  });
 }
 async accept(actor:string,data:string):Promise<boolean>{
  const started=this.clock();if(!person(actor)||!validCaptchaRulesRoute(data)||!time(started))return false;const before=await this.store.snapshot(),rows=before.callbacks.filter(c=>c.ref===CALLBACK+data.slice(5)),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||!c.oneShot||c.used||c.revoked||!time(c.expiresAt)||started>=c.expiresAt||c.expiresAt>started+TTL)return false;
  let action:RuleAction;try{action=JSON.parse(c.action);if(!action||typeof action!=='object'||Array.isArray(action)||Object.keys(action).sort().join(',')!=='chat,epoch,proof,reference,version'||typeof action.chat!=='string'||!group(action.chat)||typeof action.epoch!=='string'||typeof action.proof!=='string'||typeof action.reference!=='string'||!Number.isSafeInteger(action.version))return false;}catch{return false;}
  const rule=this.currentRule(before,action.chat),receipt=this.receipt(before,action.chat,actor),challenge=this.captcha.challenge(before,action.chat,actor);if(this.epoch(before,action.chat)!==action.epoch||!rule||rule.version!==action.version||c.policyVersion!==rule.scope||!receipt||receipt.reason!==action.proof||!challenge||challenge.reference!==action.reference||this.captcha.status(before,action.chat,actor)!=='PASSED'||this.status(before,action.chat,actor)!=='PENDING')return false;
  try{if(await this.membership(action.chat,actor)!=='VERIFIED')return false;}catch{return false;}
  return this.store.transaction(s=>{const now=this.clock(),matches=s.callbacks.filter(x=>x.ref===c.ref),current=matches[0],rule=this.currentRule(s,action.chat),receipt=this.receipt(s,action.chat,actor),challenge=this.captcha.challenge(s,action.chat,actor);if(!time(now)||now<started||now>=started+TTL||matches.length!==1||!current||current.actorId!==actor||current.chatId!=='private'||!current.oneShot||current.used||current.revoked||current.action!==c.action||current.expiresAt!==c.expiresAt||!time(current.expiresAt)||now>=current.expiresAt||current.expiresAt>now+TTL||this.epoch(s,action.chat)!==action.epoch||!rule||rule.version!==action.version||current.policyVersion!==rule.scope||!receipt||receipt.reason!==action.proof||!challenge||challenge.reference!==action.reference||this.captcha.status(s,action.chat,actor)!=='PASSED'||this.status(s,action.chat,actor)!=='PENDING'||s.audit.some(a=>a.updateKey===receipt.key))return false;
   current.used=true;s.audit.push({actorId:actor,updateKey:receipt.key,decision:'ALLOW',reason:receipt.reason,policyVersion:receipt.scope,at:now});return true;
  });
 }
}
