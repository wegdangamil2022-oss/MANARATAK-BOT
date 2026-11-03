import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {TelegramGroupRules,groupRuleDescription,currentGroupRuleVersion} from './telegram-group-rules.js';
import {ruleWarningPolicy,validRuleWarningPolicy,RULE_WARNING_POLICY_PREFIX,type RuleWarningPolicy,type RuleAction} from './group-rule-warning-policy.js';
import {ruleReference} from './group-rule-exemption-model.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const PREFIX='rule-warning-policy-preview:',TTL=120000;
export function validRuleWarningPolicyRoute(data:string):boolean{const m=/^rw:1:g:(-[1-9][0-9]{0,15})$|^rw:1:[cx]:[A-Za-z0-9_-]{24}$/u.exec(data);return m?.[0]===data&&(m[1]===undefined||Number.isSafeInteger(Number(m[1])));}
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
type Draft={policy:RuleWarningPolicy;reference:string;source:string;createdAt:number};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class TelegramRuleWarningPolicy{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 private allowed(s:BotState,actor:string,chat:string):boolean{return this.policy.canUseChat(s,chat,'moderation')&&this.policy.has(s,actor,'chat.manage',chat,this.clock())&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));}
 private source(s:BotState,actor:string,chat:string):string{return hash([actor,s.chats.filter(c=>c.id===chat),s.grants,s.privateFeatures,s.privateSettingsRevision,s.audit.filter(a=>a.updateKey.startsWith('moderation:rules:published:'+chat+':')||a.updateKey.startsWith(RULE_WARNING_POLICY_PREFIX+chat+':'))]);}
 private screen(s:BotState,actor:string,text:string,rows:OwnerInlineScreen['keyboard']['inline_keyboard']):Screen|null{const now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-TTL?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch,expiresAt:now+TTL}}:null;}
 async cancel(actor:string):Promise<void>{const snap=await this.store.snapshot();if(!snap.callbacks.some(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;});}
 async preview(actor:string,text:string):Promise<Screen|null>{
  const warning=/^\/rulewarnings (-[1-9][0-9]{0,15}) ([1-9][0-9]?) ([1-9][0-9]?) ([1-9][0-9]{1,6})$/u.exec(text),actions=/^\/ruleactions (-[1-9][0-9]{0,15}) ([1-9][0-9]?) ([a-z,]{4,30}) ([1-9][0-9]{1,4})$/u.exec(text),m=warning??actions;if(!m||m[0]!==text)return null;
  const chat=m[1]!,reference=await new TelegramGroupRules(this.store,this.policy,this.clock).warningReference(chat,Number(m[2]),1);if(!reference)return null;const ref=ruleReference(reference)!;
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return null;
  await this.cancel(actor);
  return this.store.transaction(s=>{
   const at=this.clock(),current=ruleWarningPolicy(s,chat,reference,at);if(!this.allowed(s,actor,chat)||!groupRuleDescription(s,chat,reference,true)||at<now||at>=now+TTL||current.status==='INVALID')return null;
   const policy:RuleWarningPolicy={...(current.status==='CONFIGURED'?current.policy:{cap:3,seconds:86400}),chat,...ref,revision:current.status==='CONFIGURED'?current.policy.revision+1:1,...(warning?{cap:Number(m[3]),seconds:Number(m[4])}:{actions:m[3]!.split(',') as RuleAction[],muteSeconds:Number(m[4])})};if(!validRuleWarningPolicy(policy))return null;
   const nonce=randomBytes(18).toString('base64url'),draft:Draft={policy,reference,source:this.source(s,actor,chat),createdAt:now};
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>at);
   const old=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX)),drop=new Set(old.slice(0,Math.max(0,old.length-127)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!drop.has(c.ref));
   s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',policyVersion:this.policy.chatRevision(s,chat),expiresAt:now+TTL,oneShot:true,used:false,revoked:false,action:JSON.stringify(draft)});
   return this.screen(s,actor,'<b>معاينة سقف إنذارات الفقرة</b>\nالمجموعة: '+chat+'\nالإصدار: '+ref.version+' · الفقرة: '+ref.paragraph+'\nالإجراءات بالترتيب: '+(policy.actions?.join(' → ')??'الاختيار اليدوي القديم')+(policy.muteSeconds?' · الكتم '+policy.muteSeconds+' ثانية':'')+'\nالترتيب لعرض خيارات المشرف؛ لا تصعيد تلقائي.\nالسقف لكل عضو: '+policy.cap+'\nصلاحية كل إنذار جديد: '+policy.seconds+' ثانية من إصداره.\nعند بلوغ السقف يمتنع إنشاء إنذار إضافي؛ لا يصدر كتم أو حظر تلقائي. يظل قرار التقييد بمعاينة مستقلة. لا تتغير مدد الإنذارات القديمة أو الإعفاءات أو القيود. ينتهي الطلب بعد دقيقتين.',[[{text:'✅ اعتماد السياسة',callback_data:'rw:1:c:'+nonce}],[{text:'↩️ إلغاء',callback_data:'rw:1:x:'+nonce}]]);
  });
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  const group=/^rw:1:g:(-[1-9][0-9]{0,15})$/u.exec(data);
  if(group?.[0]===data){
   const s=await this.store.snapshot(),chat=group[1]!,now=this.clock();if(!this.allowed(s,actor,chat))return null;const version=currentGroupRuleVersion(s,chat),settings:string[]=[];
   if(version!==null)for(let i=1;i<=20;i++){const reference='law_v'+version+'_p'+i+'_m1';if(!groupRuleDescription(s,chat,reference))break;if(!groupRuleDescription(s,chat,reference,true)){settings.push('الفقرة '+i+': معطلة');continue;}const current=ruleWarningPolicy(s,chat,reference,now);settings.push('الفقرة '+i+': '+(current.status==='CONFIGURED'?'السقف '+current.policy.cap+' · المدة '+current.policy.seconds+' ثانية'+(current.policy.actions?' · '+current.policy.actions.join(' → '):''):current.status==='NONE'?'دون سقف أو انتهاء جديدين':'سياسة غير موثوقة؛ الإنذار محجوب'));}
   return this.screen(s,actor,'<b>سقف إنذارات فقرات القوانين</b>\n'+(version===null?'لا يوجد إصدار قوانين صالح.':'الإصدار '+version+'\n'+settings.join('\n'))+'\nلإعداد الإجراءات وترتيب خياراتها: <code>/ruleactions '+chat+' 1 notice,warn,mute,review 300</code>\nمدة الكتم بالثواني من 60 إلى 86400. يحفظ السقف والمدة السابقين؛ إن لم توجد سياسة، تعرض المعاينة سقف 3 إنذارات ومدتها يوم. كل إجراء يحتاج اختيارًا وتأكيدًا مستقلًا، ولا تصعيد تلقائي.\nأرسل في الخاص:\n<code>/rulewarnings '+chat+' رقم_الفقرة السقف المدة_بالثواني</code>\nمثال: <code>/rulewarnings '+chat+' 1 3 86400</code>\nالسقف من 1 إلى 20، ومدة الإنذار من 60 ثانية إلى 30 يومًا. الإعداد خاص بإصدار الفقرة الحالي. لا يطبق أي سقف جديد دون معاينة وتأكيد. لا تتغير الإنذارات السابقة بأثر رجعي.',[[{text:'↩️ قوانين المجموعات',callback_data:'rl:1:h:0'}]]);
  }
  const m=/^rw:1:([cx]):([A-Za-z0-9_-]{24})$/u.exec(data);if(!m||m[0]!==data)return null;
  return this.store.transaction(s=>{
   const rows=s.callbacks.filter(c=>c.ref===PREFIX+m[2]),c=rows[0],now=this.clock();if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used||c.revoked||!c.oneShot||!Number.isSafeInteger(now)||now>=c.expiresAt)return null;
   let draft:Draft;try{const d:unknown=JSON.parse(c.action);if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).sort().join(',')!=='createdAt,policy,reference,source')return null;draft=d as Draft;}catch{return null;}
   if(!validRuleWarningPolicy(draft.policy)||typeof draft.reference!=='string'||typeof draft.source!=='string'||!Number.isSafeInteger(draft.createdAt)||now<draft.createdAt||c.expiresAt!==draft.createdAt+TTL)return null;
   const p=draft.policy,ref=ruleReference(draft.reference),current=ruleWarningPolicy(s,p.chat,draft.reference,now);
   if(!ref||ref.version!==p.version||ref.paragraph!==p.paragraph||!this.allowed(s,actor,p.chat)||!groupRuleDescription(s,p.chat,draft.reference,true)||c.policyVersion!==this.policy.chatRevision(s,p.chat)||this.source(s,actor,p.chat)!==draft.source||current.status==='INVALID'||p.revision!==(current.status==='CONFIGURED'?current.policy.revision+1:1))return null;
   c.used=true;
   if(m[1]==='c')s.audit.push({actorId:actor,updateKey:RULE_WARNING_POLICY_PREFIX+p.chat+':'+p.version+':'+p.paragraph+':'+p.revision,decision:'ALLOW',reason:'RULE_WARNING_POLICY:'+JSON.stringify(p),policyVersion:c.policyVersion,at:now});
   return this.screen(s,actor,m[1]==='c'?'حُفظ سقف الفقرة ومدة الإنذارات الجديدة.':'أُلغي تعديل سياسة الإنذارات.',[[{text:'↩️ سياسة الإنذارات',callback_data:'rw:1:g:'+p.chat}],[{text:'↩️ قوانين المجموعات',callback_data:'rl:1:h:0'}]]);
  });
 }
}
