import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {TelegramGroupRules,groupRuleDescription} from './telegram-group-rules.js';
import {RULE_EXEMPTION_PREFIX,ruleReference,activeRuleExemptions,ruleExemptionDigest} from './group-rule-exemption-model.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const PREFIX='rule-exemption-preview:',TTL=120000;
const REVOKE='rule-exemption-revoke:';
const route=/^le:1:([cx]):([A-Za-z0-9_-]{24})$/u;
const contextualHome=/^le:1:h:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$/u;
const listRoute=/^le:1:l:(0|[1-9][0-9]{0,2})$|^le:1:v:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$|^le:1:([rz]):([A-Za-z0-9_-]{24})$/u;
export const validRuleExemptionRoute=(data:string)=>data==='le:1:h'||contextualHome.exec(data)?.[0]===data||route.exec(data)?.[0]===data||listRoute.exec(data)?.[0]===data;
type Draft={chat:string;member:string;reference:string;seconds:number;source:string;createdAt:number};
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
const source=(s:BotState,actor:string,chat:string)=>createHash('sha256').update(JSON.stringify([actor,s.chats.filter(c=>c.id===chat),s.grants,s.privateFeatures,s.privateSettingsRevision,s.audit.filter(a=>a.updateKey.startsWith('moderation:rules:published:'+chat+':'))])).digest('hex');
const permitted=(s:BotState,p:Policy,actor:string,chat:string,now:number)=>p.canUseChat(s,chat,'moderation')&&p.has(s,actor,'chat.manage',chat,now)&&(!p.isOwner(actor)||p.privateFeature(s,'owner.dashboard',actor));
function validDraft(x:unknown):x is Draft{if(!x||typeof x!=='object'||Array.isArray(x))return false;const d=x as Record<string,unknown>;return Object.keys(d).sort().join(',')==='chat,createdAt,member,reference,seconds,source'&&typeof d.chat==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(d.chat)?.[0]===d.chat&&Number.isSafeInteger(Number(d.chat))&&typeof d.member==='string'&&/^[1-9][0-9]{0,15}$/u.exec(d.member)?.[0]===d.member&&Number.isSafeInteger(Number(d.member))&&typeof d.reference==='string'&&!!ruleReference(d.reference)&&Number.isSafeInteger(d.seconds)&&Number(d.seconds)>=60&&Number(d.seconds)<=86400&&typeof d.source==='string'&&/^[a-f0-9]{64}$/u.exec(d.source)?.[0]===d.source&&Number.isSafeInteger(d.createdAt)&&Number(d.createdAt)>=0;}
export class TelegramRuleExemptions{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 async cancel(actor:string):Promise<void>{const snap=await this.store.snapshot();if(!snap.callbacks.some(c=>c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(REVOKE))&&!c.used&&!c.revoked))return;await this.store.transaction(s=>{for(const c of s.callbacks)if(c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(REVOKE))&&!c.used)c.revoked=true;});}
 private screen(s:BotState,actor:string,now:number,text:string,keyboard:OwnerInlineScreen['keyboard']):Screen|null{const epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch?{text,keyboard,access:{actorId:actor,epoch,expiresAt:now+TTL}}:null;}
 async preview(actor:string,text:string):Promise<Screen|null>{
  const m=/^\/exemptrule (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([1-9][0-9]?) ([1-9][0-9]{1,4})$/u.exec(text);if(!m||m[0]!==text)return null;
  const now=this.clock(),chat=m[1]!,member=m[2]!,seconds=Number(m[4]);if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-86400000||!Number.isSafeInteger(Number(member))||seconds<60||seconds>86400)return null;
  const reference=await new TelegramGroupRules(this.store,this.policy,this.clock).warningReference(chat,Number(m[3]),1);if(!reference)return null;
  return this.store.transaction(s=>{const at=this.clock();if(!Number.isSafeInteger(at)||at<now||at>=now+TTL||!permitted(s,this.policy,actor,chat,at)||!groupRuleDescription(s,chat,reference,true))return null;
   for(const c of s.callbacks)if(c.actorId===actor&&c.ref.startsWith(PREFIX)&&!c.used)c.revoked=true;
   s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>at);const own=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX));const old=new Set(own.slice(0,Math.max(0,own.length-127)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!old.has(c.ref));
   const draft:Draft={chat,member,reference,seconds,source:source(s,actor,chat),createdAt:now},nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',policyVersion:this.policy.chatRevision(s,chat),expiresAt:now+TTL,oneShot:true,used:false,revoked:false,action:PREFIX+JSON.stringify(draft)});
   return this.screen(s,actor,at,'<b>معاينة إعفاء فقرة</b>\nالمجموعة: <code>'+chat+'</code>\nالعضو: <code>'+member+'</code>\n'+groupRuleDescription(s,chat,reference,true)!.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))+'\nالمدة: '+seconds+' ثانية من التأكيد. يخص الإعفاء هذا الإصدار والفقرة فقط.',{inline_keyboard:[[{text:'✅ تأكيد الإعفاء',callback_data:'le:1:c:'+nonce},{text:'↩️ إلغاء',callback_data:'le:1:x:'+nonce}]]});
  });
 }
 private async management(actor:string,data:string):Promise<Screen|null>{
  const m=listRoute.exec(data);if(!m||m[0]!==data)return null;
  return this.store.transaction(s=>{const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return null;
   const rows=activeRuleExemptions(s,now).filter(e=>permitted(s,this.policy,actor,e.chat,now)),proof=createHash('sha256').update(JSON.stringify([actor,rows,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision])).digest('hex').slice(0,16);
   if(m[5]!==undefined){const matches=s.callbacks.filter(c=>c.ref===REVOKE+m[6]),c=matches[0];if(matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used!==false||c.revoked!==false||c.oneShot!==true||!c.action.startsWith(REVOKE))return null;
    let draft:unknown;try{draft=JSON.parse(c.action.slice(REVOKE.length));}catch{return null;}if(!draft||typeof draft!=='object'||Array.isArray(draft))return null;const v=draft as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='createdAt,id,proof'||typeof v.id!=='string'||typeof v.proof!=='string'||v.proof!==proof||!Number.isSafeInteger(v.createdAt)||now<Number(v.createdAt)||now>=Number(v.createdAt)+TTL||c.expiresAt!==Number(v.createdAt)+TTL)return null;
    const entry=rows.find(e=>e.id===v.id);if(!entry||now<entry.at||c.policyVersion!==this.policy.chatRevision(s,entry.chat)||s.audit.some(a=>a.updateKey===entry.id+':revoked'))return null;
    c.used=true;if(m[5]==='r')s.audit.push({updateKey:entry.id+':revoked',actorId:actor,decision:'ALLOW',reason:'RULE_EXEMPTION_REVOKED:'+ruleExemptionDigest(entry),policyVersion:entry.policyVersion,at:now});
    return this.screen(s,actor,now,m[5]==='r'?'أُلغي الإعفاء المحدد. قد تبقى إعفاءات أخرى للفقرة نفسها.':'أُلغيت معاينة الإزالة؛ لم يتغير الإعفاء.',{inline_keyboard:[[{text:'↩️ قائمة الإعفاءات',callback_data:'le:1:l:0'}],[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]});
   }
   const page=Number(m[1]??m[2]),pages=Math.min(1000,Math.max(1,Math.ceil(rows.length/8)));if(page>=pages)return null;
   if(m[2]!==undefined){const entry=rows[page*8+Number(m[3])-1];if(!entry||now<entry.at||m[4]!==proof||s.audit.some(a=>a.updateKey===entry.id+':revoked'))return null;
    for(const c of s.callbacks)if(c.actorId===actor&&(c.ref.startsWith(PREFIX)||c.ref.startsWith(REVOKE))&&!c.used)c.revoked=true;
    s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(REVOKE)||c.expiresAt>now);const prior=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(REVOKE)),remove=new Set(prior.slice(0,Math.max(0,prior.length-127)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
    const nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:REVOKE+nonce,actorId:actor,chatId:'private',policyVersion:this.policy.chatRevision(s,entry.chat),expiresAt:now+TTL,oneShot:true,used:false,revoked:false,action:REVOKE+JSON.stringify({id:entry.id,proof,createdAt:now})});
    return this.screen(s,actor,now,'<b>معاينة إلغاء الإعفاء</b>\nالمجموعة: <code>'+entry.chat+'</code>\nالعضو: <code>'+entry.member+'</code>\nالفقرة: '+entry.paragraph+' · الإصدار: '+entry.version+'\nمنحه: <code>'+entry.actor+'</code>\nينتهي: '+new Date(entry.until).toISOString()+'\nسيُلغى هذا السجل وحده بعد التأكيد.',{inline_keyboard:[[{text:'✅ تأكيد إلغاء الإعفاء',callback_data:'le:1:r:'+nonce},{text:'↩️ إلغاء',callback_data:'le:1:z:'+nonce}]]});
   }
   const keyboard=rows.slice(page*8,page*8+8).map((e,i)=>[{text:'الفقرة '+e.paragraph+' · '+e.member+' · '+e.chat,callback_data:'le:1:v:'+page+':'+(i+1)+':'+proof}]);if(page>0)keyboard.push([{text:'⬅️ السابق',callback_data:'le:1:l:'+(page-1)}]);if(page+1<pages)keyboard.push([{text:'➡️ التالي',callback_data:'le:1:l:'+(page+1)}]);keyboard.push([{text:'↩️ الإعفاءات',callback_data:'le:1:h'}]);
   return this.screen(s,actor,now,'<b>الإعفاءات السارية للمجموعات المخولة</b>\nاختر إعفاءً لمراجعة إلغائه. صفحة '+(page+1)+' من '+pages+(rows.length?'':'\nلا توجد إعفاءات سارية.'),{inline_keyboard:keyboard});
  });
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(listRoute.exec(data)?.[0]===data)return this.management(actor,data);
  const context=contextualHome.exec(data);
  if(data==='le:1:h'||context?.[0]===data){const back=context?'rl:1:g:'+context[1]+':'+context[2]+':'+context[3]:'rl:1:h:0';if(context&&!await new TelegramGroupRules(this.store,this.policy,this.clock).handle(actor,back))return null;const state=await this.store.snapshot(),now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!state.chats.some(c=>permitted(state,this.policy,actor,c.id,now)))return null;return this.screen(state,actor,now,'<b>إعفاء فقرة محددة</b>\nأرسل في الخاص:\n<code>/exemptrule رقم_المجموعة رقم_العضو رقم_الفقرة المدة_بالثواني</code>\nمثال: <code>/exemptrule -100 400 1 3600</code>\nالمدة بين 60 و86400 ثانية. تظهر معاينة للمراجعة قبل الحفظ.',{inline_keyboard:[[{text:'📋 الإعفاءات السارية',callback_data:'le:1:l:0'}],[{text:context?'↩️ قوانين المجموعة':'↩️ قوانين المجموعات',callback_data:back}]]});}
  const match=route.exec(data);if(!match||match[0]!==data)return null;
  return this.store.transaction(s=>{const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===PREFIX+match[2]),c=rows[0];if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.used||c.revoked||!c.oneShot||!c.action.startsWith(PREFIX))return null;let draft:unknown;try{draft=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
   if(!validDraft(draft)||!Number.isSafeInteger(now)||now<draft.createdAt||now>=draft.createdAt+TTL||now>8640000000000000-draft.seconds*1000||c.expiresAt!==draft.createdAt+TTL||c.policyVersion!==this.policy.chatRevision(s,draft.chat)||!permitted(s,this.policy,actor,draft.chat,now)||source(s,actor,draft.chat)!==draft.source||!groupRuleDescription(s,draft.chat,draft.reference,true))return null;
   c.used=true;const ref=ruleReference(draft.reference)!;if(match[1]==='c')s.audit.push({updateKey:RULE_EXEMPTION_PREFIX+randomBytes(18).toString('base64url'),actorId:actor,decision:'ALLOW',reason:'RULE_EXEMPTION:'+JSON.stringify({chat:draft.chat,member:draft.member,version:ref.version,paragraph:ref.paragraph,until:now+draft.seconds*1000}),policyVersion:this.policy.chatRevision(s,draft.chat),at:now});
   return this.screen(s,actor,now,match[1]==='c'?'حُفظ إعفاء الفقرة المحددة حتى انتهاء المدة.':'أُلغي طلب الإعفاء.',{inline_keyboard:[[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]});
  });
 }
}
