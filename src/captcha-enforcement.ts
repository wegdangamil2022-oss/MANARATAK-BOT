import {subscriptionRequirementMode} from './subscription-integrity.js';
import {retirementOperationDigest} from './moderation-reason-retirement.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {CaptchaService,captchaSource} from './captcha.js';
import {CaptchaRuleGate} from './captcha-rules.js';
import type {ModerationService,ModerationResult} from './moderation.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';
const ROOT='captcha:enforcement:';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-120000;
const denied=(reason:string):ModerationResult=>({status:'DENIED',reason});
export class CaptchaEnforcement{
 private readonly rules:CaptchaRuleGate;
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly captcha:CaptchaService,
  private readonly moderation:ModerationService|undefined,private readonly probe:{gateway:TelegramBotApiModerationGateway;safety:()=>Promise<boolean>}|undefined,private readonly clock:()=>number){this.rules=new CaptchaRuleGate(store,policy,captcha,async()=> 'UNKNOWN',clock);}
 available():boolean{return !!this.moderation?.supportsSubscriptionEnforcement()&&!!this.probe&&TelegramBotApiModerationGateway.usesOfficialRightsRead(this.probe.gateway)&&TelegramBotApiModerationGateway.usesOfficialTrialGroupRead(this.probe.gateway);}
 standalone(s:BotState,chat:string):boolean{const mode=subscriptionRequirementMode(s,chat);return mode==='NONE'||mode==='PAUSED';}
 #stamp(s:BotState,chat:string):string{return hash([this.policy.ownerId,chat,s.chats.filter(c=>c.id===chat),this.captcha.settings(s,chat),s.subscriptionRequirements.filter(r=>r?.chatId===chat),s.privateFeatures['owner.dashboard'],s.privateSettingsRevision??null]);}
 epoch(s:BotState,chat:string):string{return hash([chat,captchaSource(s),s.subscriptionRequirements.filter(r=>r?.chatId===chat),s.audit.filter(a=>a.updateKey===ROOT+chat)]);}
 consent(s:BotState,chat:string):{enabled:boolean;at:number;version:number}|null{
  if(!this.standalone(s,chat)||!/^-[1-9][0-9]{0,15}$/u.test(chat)||!Number.isSafeInteger(Number(chat))||!this.policy.privateFeature(s,'owner.dashboard',this.policy.ownerId)||!this.policy.canUseChat(s,chat,'moderation')||!this.captcha.settings(s,chat)?.enabled)return null;
  const rows=s.audit.filter(a=>a.updateKey===ROOT+chat),a=rows[0],now=this.clock();if(rows.length!==1||!a||a.actorId!==this.policy.ownerId||a.decision!=='ALLOW'||a.policyVersion!==this.policy.chatRevision(s,chat)||!validTime(now)||!validTime(a.at)||a.at>now)return null;
  try{const v=JSON.parse(a.reason) as {enabled:boolean;stamp:string;version:number};return Object.keys(v).sort().join(',')==='enabled,stamp,version'&&typeof v.enabled==='boolean'&&v.stamp===this.#stamp(s,chat)&&Number.isSafeInteger(v.version)&&v.version>0?{enabled:v.enabled,at:a.at,version:v.version}:null;}catch{return null;}
 }
 async configure(actor:string,chat:string,enabled:boolean,expected:string,confirmationRef:string):Promise<boolean>{
  const started=this.clock();if(typeof enabled!=='boolean'||!validTime(started)||!this.available()||!this.policy.isOwner(actor))return false;
  const current=(s:BotState)=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===confirmationRef),c=rows[0];if(!validTime(now)||now<started||now>=started+120000||this.epoch(s,chat)!==expected||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.policy.canUseChat(s,chat,'moderation')||!this.captcha.settings(s,chat)?.enabled||enabled&&!this.standalone(s,chat)||rows.length!==1||!c||!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(c.ref)||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||!c.used||c.revoked||!Number.isSafeInteger(c.expiresAt)||now>=c.expiresAt||c.expiresAt>now+120000)return false;
   try{const a=JSON.parse(c.action);return Array.isArray(a)&&a.length===3&&a[1]===captchaSource(s)&&a[2]===expected&&a[0]?.group===chat&&a[0]?.kind===(enabled?'enforce-on-confirm':'enforce-off-confirm');}catch{return false;}
  };
  if(!current(await this.store.snapshot()))return false;
  try{if(enabled){if(!await this.probe!.safety()||!current(await this.store.snapshot())||await this.probe!.gateway.inspectTrialGroupKind(chat)!=='SUPERGROUP'||!await this.probe!.safety()||!current(await this.store.snapshot())||await this.probe!.gateway.inspectBotModerationRights(chat)!=='GRANTED'||!await this.probe!.safety())return false;}}catch{return false;}
  return this.store.transaction(s=>{if(!current(s))return false;const rows=s.audit.filter(a=>a.updateKey===ROOT+chat),old=rows[0];if(rows.length>1)return false;let version=0;if(old){try{version=JSON.parse(old.reason).version;}catch{return false;}if(old.actorId!==actor||old.decision!=='ALLOW'||!validTime(old.at)||old.at>this.clock()||!Number.isSafeInteger(version)||version<1||version>=Number.MAX_SAFE_INTEGER)return false;}
   const record={actorId:actor,updateKey:ROOT+chat,decision:'ALLOW' as const,reason:JSON.stringify({enabled,stamp:this.#stamp(s,chat),version:version+1}),policyVersion:this.policy.chatRevision(s,chat),at:this.clock()};if(old)Object.assign(old,record);else s.audit.push(record);
   s.audit.push({...record,updateKey:'captcha:enforcement-change:'+randomBytes(18).toString('base64url'),reason:'CAPTCHA_ENFORCEMENT_CONSENT:'+hash(record)});return true;
  });
 }
 #source(s:BotState,chat:string,member:string){const consent=this.consent(s,chat),challenge=this.captcha.challenge(s,chat,member);if(!consent?.enabled||!challenge)return null;const ownership=s.audit.filter(a=>a.updateKey==='captcha:enforced:'+challenge.reference);let operationId:string|undefined;try{operationId=JSON.parse(ownership[0]?.reason??'null')?.operationId;}catch{}return {consent,challenge,epoch:this.epoch(s,chat),status:this.captcha.status(s,chat,member),rulesStatus:this.rules.status(s,chat,member),rulesEpoch:this.rules.epoch(s,chat),ownership,attempts:s.moderationOperations.filter(o=>o.id===operationId)};}
 async admit(chat:string,member:string,updateKey:string,sentAt:number):Promise<ModerationResult>{
  const now=this.clock();if(!this.available()||!validTime(now)||!validTime(sentAt)||now<sentAt||now-sentAt>30000)return denied('CAPTCHA_ENFORCEMENT_UNAVAILABLE');
  const before=await this.store.snapshot(),source=this.#source(before,chat,member);if(!source||source.status!=='PENDING'||source.rulesStatus==='UNAVAILABLE'||source.challenge.issued<source.consent.at||sentAt<source.consent.at||!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(updateKey))return denied('CAPTCHA_ENFORCEMENT_NOT_APPROVED');
  const observed=before.audit.filter(a=>a.updateKey==='captcha:join-issued:'+source.challenge.nonce),proof=observed[0];
  if(observed.length!==1||!proof||proof.actorId!==member||proof.decision!=='ALLOW'||proof.at!==source.challenge.issued||proof.policyVersion!==this.policy.chatRevision(before,chat)||proof.reason!=='CAPTCHA_JOIN_OBSERVED:'+hash([chat,member,source.challenge.nonce,updateKey,sentAt,before.audit.filter(a=>a.updateKey===ROOT+chat)]))return denied('CAPTCHA_JOIN_SOURCE_UNAVAILABLE');
  // Do not overwrite an existing independent or unresolved restriction.
  if(before.moderationReasons.some(r=>r.chatId===chat&&r.memberId===member&&(r.active||r.reference===source.challenge.reference)))return denied('CAPTCHA_EXISTING_REASON_REQUIRES_REVIEW');
  const current=(s:BotState)=>{const at=this.clock();return validTime(at)&&at>=now&&at<now+5000&&JSON.stringify(this.#source(s,chat,member))===JSON.stringify(source)&&s.moderationReasons.filter(r=>r.chatId===chat&&r.memberId===member&&r.active).every(r=>r.source==='MANUAL'&&r.reference===source.challenge.reference&&r.kind==='MUTE'&&r.createdBy===this.policy.ownerId&&r.expiresAt===undefined);};
  const result=await this.moderation!.addManualReason(this.policy.ownerId,chat,member,source.challenge.reference,'MUTE',current,undefined,current,now+5000);
  if(result.status==='APPLIED'){const bound=await this.store.transaction(s=>{if(!current(s)||s.audit.some(a=>a.updateKey==='captcha:enforced:'+source.challenge.reference))return false;const ops=s.moderationOperations.filter(o=>o.chatId===chat&&o.memberId===member&&o.actorId===this.policy.ownerId&&o.createdAt>=now&&o.status==='CONFIRMED'&&o.kind==='MUTE'&&o.attemptGateway==='TELEGRAM_API'&&o.baselineMode==='INHERIT_GROUP_DEFAULTS'),op=ops[0];if(ops.length!==1||!op)return false;s.audit.push({actorId:this.policy.ownerId,updateKey:'captcha:enforced:'+source.challenge.reference,decision:'ALLOW',reason:JSON.stringify({operationId:op.id,digest:retirementOperationDigest(op),reference:source.challenge.reference}),policyVersion:op.policyVersion,at:this.clock()});return true;});if(!bound){await this.store.transaction(s=>{const at=this.clock(),ops=s.moderationOperations.filter(o=>o.chatId===chat&&o.memberId===member&&o.actorId===this.policy.ownerId&&o.createdAt>=now&&o.status==='CONFIRMED'&&o.kind==='MUTE'&&o.attemptGateway==='TELEGRAM_API'),op=ops[0];if(!validTime(at)||ops.length!==1||!op||s.audit.some(a=>a.updateKey==='captcha:binding-failure:'+op.id))return;try{const reasons=JSON.parse(op.reasonFingerprint);if(!Array.isArray(reasons)||!reasons.some(r=>Array.isArray(r)&&r[0]==='MANUAL'&&r[1]===source.challenge.reference&&r[2]==='MUTE'))return;}catch{return;}s.audit.push({actorId:this.policy.ownerId,updateKey:'captcha:binding-failure:'+op.id,decision:'DENY',reason:'CAPTCHA_OWNERSHIP_BINDING_UNAVAILABLE:'+hash([chat,member,source.challenge.reference,retirementOperationDigest(op)]),policyVersion:op.policyVersion,at});});return denied('CAPTCHA_OWNERSHIP_BINDING_UNAVAILABLE');}}
  return result;
 }
 async release(chat:string,member:string):Promise<ModerationResult>{
  if(!this.available())return denied('CAPTCHA_ENFORCEMENT_UNAVAILABLE');const now=this.clock(),before=await this.store.snapshot(),source=this.#source(before,chat,member);
  if(!validTime(now)||!source||source.status!=='PASSED')return denied('CAPTCHA_NOT_VERIFIED');
  if(source.rulesStatus!=='NOT_REQUIRED'&&source.rulesStatus!=='ACCEPTED')return denied('CAPTCHA_RULES_NOT_ACCEPTED');
  const receipts=before.audit.filter(a=>a.updateKey==='captcha:enforced:'+source.challenge.reference),receipt=receipts[0];
  if(receipts.length!==1||!receipt||receipt.actorId!==this.policy.ownerId||receipt.decision!=='ALLOW'||receipt.policyVersion!==this.policy.chatRevision(before,chat)||!validTime(receipt.at)||receipt.at>now)return denied('CAPTCHA_ENFORCEMENT_RECEIPT_UNAVAILABLE');
  try{const v=JSON.parse(receipt.reason),ops=before.moderationOperations.filter(o=>o.id===v.operationId),op=ops[0];if(Object.keys(v).sort().join(',')!=='digest,operationId,reference'||v.reference!==source.challenge.reference||ops.length!==1||!op||op.chatId!==chat||op.memberId!==member||op.actorId!==this.policy.ownerId||op.kind!=='MUTE'||op.status!=='CONFIRMED'||op.attemptGateway!=='TELEGRAM_API'||op.baselineMode!=='INHERIT_GROUP_DEFAULTS'||op.policyVersion!==receipt.policyVersion||receipt.at<op.createdAt||v.digest!==retirementOperationDigest(op))return denied('CAPTCHA_ENFORCEMENT_RECEIPT_INVALID');}catch{return denied('CAPTCHA_ENFORCEMENT_RECEIPT_INVALID');}
  const reasons=before.moderationReasons.filter(r=>r.chatId===chat&&r.memberId===member&&r.active),owned=reasons.filter(r=>r.source==='MANUAL'&&r.reference===source.challenge.reference&&r.kind==='MUTE'&&r.createdBy===this.policy.ownerId);
  if(owned.length!==1)return denied('CAPTCHA_OWNED_REASON_UNAVAILABLE');
  const current=(s:BotState)=>{const at=this.clock();return validTime(at)&&at>=now&&at<now+5000&&JSON.stringify(this.#source(s,chat,member))===JSON.stringify(source);};
  return reasons.length>1?this.moderation!.retireManualReasonPreservingRestriction(this.policy.ownerId,chat,member,source.challenge.reference,'MUTE',current,now+5000):this.moderation!.removeManualReason(this.policy.ownerId,chat,member,source.challenge.reference,'MUTE',current,now+5000);
 }
 async releaseMember(member:string):Promise<{attempted:number;pending:number;remaining:number}>{
  if(!/^[1-9][0-9]{0,15}$/u.test(member)||!Number.isSafeInteger(Number(member)))return {attempted:0,pending:0,remaining:0};
  const eligible=(s:BotState)=>[...new Set(s.wizards.filter(w=>w.userId===member).flatMap(w=>{try{if(typeof w.flow!=='string'||!w.flow.startsWith('captcha-member:'))return [];const v=JSON.parse(w.flow.slice('captcha-member:'.length));return typeof v.group==='string'?[v.group]:[];}catch{return [];}}))].filter(chat=>this.captcha.status(s,chat,member)==='PASSED'&&s.moderationReasons.some(r=>r.chatId===chat&&r.memberId===member&&r.active&&r.reference===this.captcha.challenge(s,chat,member)?.reference)).sort();
  const initial=eligible(await this.store.snapshot());let selected=initial.slice(0,8),remaining=Math.max(0,initial.length-8);
  if(initial.length>8){const batch=await this.store.transaction(s=>{const due=eligible(s),now=this.clock(),cursorKey='captcha:settlement-cursor:'+member,rows=s.audit.filter(a=>a.updateKey===cursorKey),row=rows[0];
    if(due.length<=8)return {selected:due,remaining:0};if(due.length>1000||!validTime(now)||rows.length>1)return null;
    let cursor=0;if(row){if(row.actorId!==member||row.decision!=='NOOP'||row.policyVersion!==0||!validTime(row.at)||row.at>now||!/^(0|[1-9][0-9]{0,2})$/u.test(row.reason))return null;cursor=Number(row.reason);}
    const index=cursor%due.length,batch=[...due.slice(index),...due.slice(0,index)].slice(0,8),next=String((index+batch.length)%due.length),record={actorId:member,updateKey:cursorKey,decision:'NOOP' as const,reason:next,policyVersion:0,at:now};if(row)Object.assign(row,record);else s.audit.push(record);return {selected:batch,remaining:due.length-batch.length};});
   if(!batch)return {attempted:0,pending:1,remaining:initial.length};selected=batch.selected;remaining=batch.remaining;
  }
  let attempted=0,pending=0;for(const chat of selected){attempted++;if((await this.release(chat,member)).status!=='APPLIED')pending++;}return {attempted,pending,remaining};
 }
}
