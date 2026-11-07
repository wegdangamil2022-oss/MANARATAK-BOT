import {randomBytes} from 'node:crypto';
import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {ModerationService} from './moderation.js';
import {ruleWarningPolicy,ruleActionAllowed,type RuleAction} from './group-rule-warning-policy.js';
import {groupRuleDescription} from './group-rules-model.js';
import {exemptFromRule} from './group-rule-exemption-model.js';
import {ModerationCommandReview,type ModerationCommandScreen} from './telegram-moderation-command-review.js';
import {moderationCommandReviewEpoch} from './moderation-command-review-epoch.js';
import {protectionUIEpoch} from './protection-ui-access.js';
const PREFIX='rule-action-choice:',TTL=120000;
const names:Record<RuleAction,string>={notice:'التنبيه الأول',warn:'التحذير',mute:'الكتم المؤقت',review:'مراجعة الفقرة'},codes={n:'notice',w:'warn',m:'mute',r:'review'} as const;
export const validRuleActionRoute=(v:string)=>/^ra:1:[nwmr]:[A-Za-z0-9_-]{24}$/u.exec(v)?.[0]===v;
type Choice={chat:string;member:string;reference:string;epoch:string;at:number};
export class TelegramRuleActions{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly service:ModerationService,private readonly clock:()=>number){}
 async cancel(actor:string):Promise<void>{const s=await this.store.snapshot();if(!s.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;});}
 async choose(actor:string,chat:string,member:string,reference:string):Promise<ModerationCommandScreen|null>{
  await this.cancel(actor);if(!await this.service.canReviewCommand(actor,chat,member))return null;
  return this.store.transaction(s=>{
   const at=this.clock(),epoch=moderationCommandReviewEpoch(s,this.policy,actor,chat,member,at),law=groupRuleDescription(s,chat,reference,true),p=ruleWarningPolicy(s,chat,reference,at);
   if(!epoch||!law||!Number.isSafeInteger(at)||at<0||at>8640000000000000-TTL||p.status==='INVALID'||exemptFromRule(s,chat,member,reference,at))return null;
   const actions=p.status==='CONFIGURED'?p.policy.actions??['notice','warn','mute','review'] as RuleAction[]:['notice','warn','mute','review'] as RuleAction[],nonce=randomBytes(18).toString('base64url'),choice:Choice={chat,member,reference,epoch,at};
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>at);const old=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)),drop=new Set(old.slice(0,Math.max(0,old.length-127)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!drop.has(c.ref));
   s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',policyVersion:this.policy.chatRevision(s,chat),expiresAt:at+TTL,oneShot:true,used:false,revoked:false,action:JSON.stringify(choice)});
   const access=protectionUIEpoch(s,this.policy,actor,at);if(!access)return null;
   return {status:'APPLIED',reason:'RULE_ACTION_CHOICE',text:'<b>إجراءات الفقرة بالترتيب المعتمد</b>\n'+law.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))+'\nاختر الإجراء لعرض معاينته؛ لا تنفيذ أو تصعيد تلقائي. كل اختيار يحتاج تأكيدًا مستقلًا.',keyboard:{inline_keyboard:[...actions.map(action=>[{text:names[action],callback_data:'ra:1:'+Object.entries(codes).find(([,v])=>v===action)![0]+':'+nonce}]),[{text:'↩️ إلغاء والرجوع للقوانين',callback_data:'rl:1:h:0'}]]},access:{actorId:actor,epoch:access,expiresAt:at+TTL}};
  });
 }
 async handle(actor:string,data:string,presentation?:{displayName?:string;botUsername?:string}):Promise<ModerationCommandScreen|null>{
  if(!validRuleActionRoute(data))return null;const action=codes[data[5] as keyof typeof codes];
  const choice=await this.store.transaction(s=>{
   const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(7)),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used||c.revoked||!c.oneShot||now>=c.expiresAt)return null;
   let d:Choice;try{const v=JSON.parse(c.action);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='at,chat,epoch,member,reference')return null;d=v;}catch{return null;}
   if(typeof d.chat!=='string'||typeof d.member!=='string'||typeof d.reference!=='string'||typeof d.epoch!=='string'||!Number.isSafeInteger(d.at)||now<d.at||c.expiresAt!==d.at+TTL||c.policyVersion!==this.policy.chatRevision(s,d.chat)||moderationCommandReviewEpoch(s,this.policy,actor,d.chat,d.member,now)!==d.epoch||!groupRuleDescription(s,d.chat,d.reference,true)||exemptFromRule(s,d.chat,d.member,d.reference,now)||!ruleActionAllowed(s,d.chat,d.reference,action,now))return null;
   const p=ruleWarningPolicy(s,d.chat,d.reference,now);c.used=true;return {d,duration:action==='mute'?(p.status==='CONFIGURED'?p.policy.muteSeconds??300:300):undefined};
  });if(!choice)return null;
  return new ModerationCommandReview(this.store,this.policy,this.service,this.clock).preview(actor,choice.d.chat,{kind:action,reference:choice.d.reference,memberId:choice.d.member,...(choice.duration===undefined?{}:{durationSeconds:choice.duration})},presentation);
 }
}
