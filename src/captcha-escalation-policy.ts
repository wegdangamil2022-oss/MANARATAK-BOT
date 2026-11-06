import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {CaptchaService} from './captcha.js';

const ROOT='captcha:escalation-policy:';
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const validTime=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=8640000000000000-120000;
export type CaptchaEscalationMode='STANDARD'|'EXTENDED';

/** Separate, owner-approved progressively longer CAPTCHA retry cooldown.
 * NOT an automatic ban: existing group restrictions are owned and settled by
 * CaptchaEnforcement; final failure is for human review. */
export class CaptchaEscalationPolicy{
 constructor(private readonly store:BotStore,private readonly policyAccess:Policy,
  private readonly captcha:CaptchaService,private readonly clock:()=>number){}
 private stamp(s:BotState,chat:string):string{
  return sha(['CAPTCHA_ESCALATION_V1',this.policyAccess.ownerId,chat,
   s.chats.filter(c=>c.id===chat),s.grants.filter(g=>g.chatId===chat),
   s.privateFeatures,s.privateSettingsRevision??null,this.captcha.settings(s,chat)]);
 }
 epoch(s:BotState,chat:string):string{
  return sha([this.stamp(s,chat),s.audit.filter(a=>a.updateKey===ROOT+chat)]);
 }
 state(s:BotState,chat:string):{mode:CaptchaEscalationMode;revision:number;stamp:string}|null{
  const now=this.clock(),stamp=this.stamp(s,chat),rows=s.audit.filter(a=>a.updateKey===ROOT+chat),a=rows[0];
  if(!group(chat)||!validTime(now)||s.chats.filter(c=>c.id===chat).length!==1||
     !this.policyAccess.canUseChat(s,chat,'moderation')||!this.captcha.settings(s,chat))return null;
  if(rows.length===0)return {mode:'STANDARD',revision:0,stamp};
  if(rows.length!==1||!a||a.actorId!==this.policyAccess.ownerId||a.decision!=='ALLOW'||
     a.policyVersion!==this.policyAccess.chatRevision(s,chat)||!validTime(a.at)||a.at>now)return null;
  try{
   const parsed:unknown=JSON.parse(a.reason);
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
   const r=parsed as Record<string,unknown>;
   if(Object.keys(r).sort().join(',')!=='mode,revision,stamp'||!['STANDARD','EXTENDED'].includes(String(r.mode))||
      !Number.isSafeInteger(r.revision)||Number(r.revision)<1||typeof r.stamp!=='string'||
      !/^[a-f0-9]{64}$/u.test(r.stamp))return null;
   return {mode:r.stamp===stamp?r.mode as CaptchaEscalationMode:'STANDARD',revision:Number(r.revision),stamp};
  }catch{return null;}
 }
 mode(s:BotState,chat:string):CaptchaEscalationMode|null{return this.state(s,chat)?.mode??null;}
 /** Values are in milliseconds; STANDARD legacy challenges keep their timers. */
 cooldown(s:BotState,chat:string,round:1|2|3):number|null{
  if(![1,2,3].includes(round))return null;
  const mode=this.mode(s,chat);if(mode===null)return null;
  return mode==='EXTENDED'?({1:180000,2:600000,3:1800000} as const)[round]:round*60000;
 }
 /** Keep existing sessions valid after owner switches the mode.
  * A mode switch never retroactively shortens an existing waiting period. */
 static knownCooldown(round:number,retryMs:number):'STANDARD'|'EXTENDED'|null{
  if(![1,2,3].includes(round)||!Number.isSafeInteger(retryMs))return null;
  if(retryMs===round*60000)return 'STANDARD';
  return retryMs===([180000,600000,1800000] as const)[round-1]?'EXTENDED':null;
 }
 static receipt(groupId:string,member:string,nonce:string,round:number,issued:number,
  deadline:number,retryAt:number,challengeRevision:number,chatPolicyVersion:number):string{
  return 'CAPTCHA_ESCALATION_SESSION:'+sha([groupId,member,nonce,round,issued,deadline,retryAt,challengeRevision,chatPolicyVersion]);
 }
 async configure(actor:string,chat:string,mode:CaptchaEscalationMode,expected:string,confirmationRef?:string):Promise<boolean>{
  if(!group(chat)||!['STANDARD','EXTENDED'].includes(mode)||typeof expected!=='string'||
     !/^[a-f0-9]{64}$/u.test(expected))return false;
  return this.store.transaction(s=>{
   const now=this.clock(),previous=this.state(s,chat);
   if(!validTime(now)||!previous||this.epoch(s,chat)!==expected||!this.policyAccess.isOwner(actor)||
      !this.policyAccess.privateFeature(s,'owner.dashboard',actor)||!this.captcha.settings(s,chat)?.enabled||
      previous.revision>=Number.MAX_SAFE_INTEGER)return false;
   if(confirmationRef!==undefined){
    const rows=s.callbacks.filter(c=>c.ref===confirmationRef),c=rows[0];
    if(!/^captcha-owner:[A-Za-z0-9_-]{24}$/u.test(confirmationRef)||rows.length!==1||!c||
       c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||
       !c.oneShot||!c.used||c.revoked||!validTime(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return false;
   }
   const revision=previous.revision+1,version=this.policyAccess.chatRevision(s,chat),
    record={actorId:actor,updateKey:ROOT+chat,decision:'ALLOW' as const,
     reason:JSON.stringify({mode,revision,stamp:previous.stamp}),policyVersion:version,at:now};
   const change='captcha:escalation-change:'+sha([chat,revision,now,previous.stamp]);
   if(s.audit.some(a=>a.updateKey===change))return false;
   const existing=s.audit.find(a=>a.updateKey===ROOT+chat);
   if(existing)Object.assign(existing,record);else s.audit.push(record);
   s.audit.push({actorId:actor,updateKey:change,decision:'ALLOW',
    reason:'CAPTCHA_ESCALATION_POLICY_CHANGE:'+sha(record),policyVersion:version,at:now});
   return true;
  });
 }
}
