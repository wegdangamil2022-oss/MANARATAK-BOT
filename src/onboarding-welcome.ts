import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {CaptchaService} from './captcha.js';
import {CaptchaRuleGate} from './captcha-rules.js';
import {subscriptionRequirementMode} from './subscription-integrity.js';
import {subscriptionVerificationEpoch} from './subscription-verification-access.js';

const ROOT='onboarding:welcome:';
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const person=(v:string)=>/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const group=(v:string)=>/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const validTime=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-120000;

/** Records the FIRST private welcome for a fully verified, unrestricted member.
 * This is a private reply to a user-initiated check. It NEVER sends a message,
 * infers Telegram membership, changes moderation, or makes an owner decision. */
export class VerifiedOnboardingWelcome{
 private readonly rules:CaptchaRuleGate;
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly captcha:CaptchaService,private readonly clock:()=>number){
  this.rules=new CaptchaRuleGate(store,policy,captcha,async()=> 'UNKNOWN',clock);
 }
 private proof(s:BotState,chat:string,member:string,now:number):string|null{
  if(!group(chat)||!person(member)||!validTime(now)||this.policy.isOwner(member)||
     this.policy.has(s,member,'chat.manage',chat,now)||
     !this.policy.canUseChat(s,chat,'verification')||!this.policy.canUseChat(s,chat,'navigation')||
     subscriptionRequirementMode(s,chat)!=='ACTIVE')return null;
  const captcha=this.captcha.status(s,chat,member),rules=this.rules.status(s,chat,member);
  if(!['PASSED','NOT_REQUIRED'].includes(captcha)||!['ACCEPTED','NOT_REQUIRED'].includes(rules))return null;
  if(s.moderationReasons.some(r=>r.chatId===chat&&r.memberId===member&&r.active)||
     s.moderationOperations.some(o=>o.chatId===chat&&o.memberId===member&&
      ['INTENT','STARTED','UNKNOWN_OUTCOME'].includes(o.status)))return null;
  const policyEpoch=subscriptionVerificationEpoch(s,this.policy,member,chat,now);
  if(!policyEpoch)return null;
  const challenge=this.captcha.challenge(s,chat,member);
  return sha([chat,member,this.policy.chatRevision(s,chat),
   challenge?.reference??'NO_CAPTCHA_REQUIRED',this.rules.epoch(s,chat),
   s.subscriptionRequirements.filter(r=>r.chatId===chat),policyEpoch]);
 }
 /** Call only after SubscriptionGate has verified MEMBER through Telegram.
  * If any gate changes while the reply is being built, the claim is denied.
  * A forged or duplicate audit key cannot re-enable a welcome. */
 async claim(chat:string,member:string,verificationEpoch:string):Promise<boolean>{
  const started=this.clock();
  if(!validTime(started)||typeof verificationEpoch!=='string'||
     !/^[a-f0-9]{64}$/u.test(verificationEpoch))return false;
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!validTime(now)||now<started||now>=started+120000||
      subscriptionVerificationEpoch(s,this.policy,member,chat,now)!==verificationEpoch)return false;
   const digest=this.proof(s,chat,member,now);
   if(!digest)return false;
   const key=ROOT+digest;
   if(s.audit.some(a=>a.updateKey===key))return false;
   s.audit.push({actorId:member,updateKey:key,decision:'ALLOW',
    reason:'VERIFIED_PRIVATE_WELCOME:'+digest,policyVersion:this.policy.chatRevision(s,chat),at:now});
   return true;
  });
 }
}
