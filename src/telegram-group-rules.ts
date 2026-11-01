import {groupMenuEpochDigest} from './telegram-group-access.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const ROOT='moderation:rules:',PUBLISH='GROUP_RULES_PUBLISHED:',PREVIEW='GROUP_RULES_PREVIEW:';
type Version={chat:string;version:number;lines:string[];actor:string;at:number;scope:number};
type Draft={chat:string;base:number;lines:string[];source:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const lines=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>=1&&v.length<=20&&v.every(x=>typeof x==='string'&&x===x.trim()&&x.length>=1&&x.length<=120&&!/[\u0000-\u001f\u007f]/u.test(x))&&new Set(v).size===v.length&&Buffer.byteLength(v.map(x=>escape(x)).join('\n'),'utf8')<=2400;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape=(v:string)=>v.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
const b=(text:string,callback_data:string)=>({text,callback_data});
const ROUTE=/^rl:1:h:(0|[1-9][0-9]{0,2})$|^rl:1:g:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$|^rl:1:([cx]):([A-Za-z0-9_-]{24})$/u;
export const validGroupRulesRoute=(data:string)=>ROUTE.exec(data)?.[0]===data;
function versions(s:BotState,chat:string):Version[]{
 const result:Version[]=[];
 for(const a of s.audit){if(!a.updateKey.startsWith(ROOT+'published:'+chat+':')||!a.reason.startsWith(PUBLISH)||a.decision!=='ALLOW'||!a.actorId||s.audit.filter(x=>x.updateKey===a.updateKey).length!==1)continue;
  try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PUBLISH.length),'base64url').toString('utf8'));if(!object(v)||Object.keys(v).sort().join(',')!=='chat,lines,version'||v.chat!==chat||!lines(v.lines)||!Number.isSafeInteger(v.version)||Number(v.version)<=0||a.updateKey!==ROOT+'published:'+chat+':'+v.version||!Number.isSafeInteger(a.at)||a.at<0||a.at>8640000000000000)continue;
   result.push({chat,lines:v.lines,version:Number(v.version),actor:a.actorId,at:a.at,scope:a.policyVersion});
  }catch{/* invalid history cannot become approved rules */}
 }
 return result.sort((a,b)=>a.version-b.version);
}
export function groupRuleDescription(s:BotState,chat:string,reference:string,current=false):string|null{
 const m=/^law_v([1-9][0-9]{0,14})_p([1-9][0-9]?)_m([1-9][0-9]{0,15})$/u.exec(reference);if(!m||m[0]!==reference)return null;
 const history=versions(s,chat),v=history.find(v=>v.version===Number(m[1])),line=v?.lines[Number(m[2])-1];if(!v||!line||current&&(history.at(-1)?.version!==v.version||s.chats.filter(c=>c.id===chat).length!==1||s.chats.find(c=>c.id===chat)?.version!==v.scope))return null;
 return 'القانون '+m[2]+' · الإصدار '+m[1]+': '+line;
}
export class TelegramGroupRules{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 private manager(s:BotState,actor:string,chat:string):boolean{return this.policy.canUseChat(s,chat,'moderation')&&this.policy.has(s,actor,'chat.manage',chat,this.clock())&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));}
 private source(s:BotState,actor:string,chat:string):string{return hash([actor,s.chats.filter(c=>c.id===chat),s.grants,s.privateFeatures,s.privateSettingsRevision,versions(s,chat)]);}
 private view(s:BotState,actor:string,text:string,rows:{text:string;callback_data:string}[][]):(OwnerInlineScreen&{access:AdminUIAccess})|null{
  const now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-120000?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch,expiresAt:now+120000}}:null;
 }
 async cancel(actor:string):Promise<void>{const snap=await this.store.snapshot(),done=new Set(snap.audit.map(a=>a.updateKey));if(!snap.audit.some(a=>a.actorId===actor&&/^moderation:rules:preview:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)&&a.reason.startsWith(PREVIEW)&&!done.has(a.updateKey+':done')))return;await this.store.transaction(s=>{for(const a of s.audit.filter(a=>a.actorId===actor&&/^moderation:rules:preview:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)&&a.reason.startsWith(PREVIEW))){if(!s.audit.some(x=>x.updateKey===a.updateKey+':done'))s.audit.push({actorId:actor,updateKey:a.updateKey+':done',decision:'DENY',reason:'GROUP_RULES_PREVIEW_CANCELLED',policyVersion:a.policyVersion,at:this.clock()});}});}
 async warningReference(chat:string,paragraph:number,message:number):Promise<string|null>{const s=await this.store.snapshot(),v=versions(s,chat).at(-1);if(!v||v.scope!==this.policy.chatRevision(s,chat)||!this.policy.canUseChat(s,chat,'moderation')||!Number.isSafeInteger(paragraph)||paragraph<1||paragraph>v.lines.length||!Number.isSafeInteger(message)||message<=0)return null;return 'law_v'+v.version+'_p'+paragraph+'_m'+message;}
 async published(chat:string):Promise<string|null>{return (await this.publishedView(chat))?.text??null;}
 async publishedView(chat:string,topicId?:number):Promise<{text:string;epoch:string}|null>{const s=await this.store.snapshot(),v=versions(s,chat).at(-1);return this.policy.canUseChat(s,chat,'moderation')&&v&&v.scope===this.policy.chatRevision(s,chat)?{text:this.format(v),epoch:groupMenuEpochDigest(s,chat,topicId)}:null;}
 private format(v:Version):string{return '<b>قوانين المجموعة — الإصدار '+v.version+'</b>\n'+v.lines.map((line,i)=>(i+1)+'. '+escape(line)).join('\n')+'\nاعتماد: '+new Date(v.at).toISOString().slice(0,10);}
 async preview(actor:string,text:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  const m=/^\/setrules (-[1-9][0-9]{0,15})\n([\s\S]+)$/u.exec(text);if(!m||m[0]!==text)return null;const chat=m[1]!,items=m[2]!.split('\n');if(!group(chat)||!lines(items))return null;
  await this.cancel(actor);
  return this.store.transaction(s=>{const now=this.clock();if(!this.manager(s,actor,chat)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
   const base=versions(s,chat).at(-1)?.version??0,nonce=randomBytes(18).toString('base64url'),draft:Draft={chat,base,lines:items,source:this.source(s,actor,chat)};
   s.audit.push({actorId:actor,updateKey:ROOT+'preview:'+nonce,decision:'ALLOW',reason:PREVIEW+Buffer.from(JSON.stringify(draft)).toString('base64url'),policyVersion:this.policy.chatRevision(s,chat),at:now});
   return this.view(s,actor,'معاينة اعتماد قوانين المجموعة '+chat+'\n'+this.format({chat,version:base+1,lines:items,actor,at:now,scope:this.policy.chatRevision(s,chat)})+'\nتبقى الإصدارات السابقة محفوظة. التأكيد صالح لدقيقتين؛ الرجوع يلغيه. لا تُصدر هذه العملية عقوبة.',[[b('✅ اعتماد الإصدار','rl:1:c:'+nonce)],[b('↩️ إلغاء','rl:1:x:'+nonce)]]);
  });
 }
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  if(data==='mi:1:i:02:11'){if(!this.policy.isOwner(actor))return null;data='rl:1:h:0';}
  const m=ROUTE.exec(data);if(!m||m[0]!==data||!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor)))return null;
  return this.store.transaction(s=>{
   const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
   if(m[5]){
    const key=ROOT+'preview:'+m[6],rows=s.audit.filter(a=>a.updateKey===key),a=rows[0];if(rows.length!==1||!a||a.actorId!==actor||!a.reason.startsWith(PREVIEW)||a.at>now||now>=a.at+120000||s.audit.some(a=>a.updateKey===key+':done'))return null;
    let draft:Draft;try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PREVIEW.length),'base64url').toString('utf8'));if(!object(v)||Object.keys(v).sort().join(',')!=='base,chat,lines,source'||!group(v.chat)||!lines(v.lines)||!Number.isSafeInteger(v.base)||Number(v.base)<0||typeof v.source!=='string'||!/^[a-f0-9]{64}$/u.test(v.source))return null;draft=v as Draft;}catch{return null;}
    if(!this.manager(s,actor,draft.chat)||a.policyVersion!==this.policy.chatRevision(s,draft.chat)||draft.source!==this.source(s,actor,draft.chat))return null;
    if(m[5]==='x'){s.audit.push({actorId:actor,updateKey:key+':done',decision:'DENY',reason:'GROUP_RULES_PREVIEW_CANCELLED',policyVersion:a.policyVersion,at:now});return this.view(s,actor,'أُلغي اعتماد الإصدار.',[[b('↩️ القوانين','rl:1:h:0')]]);}
    const version=draft.base+1;if((versions(s,draft.chat).at(-1)?.version??0)!==draft.base||s.audit.some(a=>a.updateKey===ROOT+'published:'+draft.chat+':'+version))return null;
    s.audit.push({actorId:actor,updateKey:key+':done',decision:'ALLOW',reason:'GROUP_RULES_PREVIEW_CONFIRMED',policyVersion:a.policyVersion,at:now});
    s.audit.push({actorId:actor,updateKey:ROOT+'published:'+draft.chat+':'+version,decision:'ALLOW',reason:PUBLISH+Buffer.from(JSON.stringify({chat:draft.chat,version,lines:draft.lines})).toString('base64url'),policyVersion:a.policyVersion,at:now});return this.view(s,actor,'اعتُمد الإصدار '+version+'. يستطيع الأعضاء عرضه بأمر /rules. بقي سجل الإصدارات القديمة دون تغيير.',[[b('↩️ القوانين','rl:1:h:0')]]);
   }
   const groups=s.chats.filter(c=>this.manager(s,actor,c.id)).sort((a,b)=>a.id.localeCompare(b.id)),page=Number(m[1]??m[2]),proof=hash([actor,groups,s.grants,s.privateFeatures,s.privateSettingsRevision,s.audit.filter(a=>a.updateKey.startsWith(ROOT))]).slice(0,16);if(page>=Math.max(1,Math.ceil(groups.length/8))||m[4]!==undefined&&m[4]!==proof)return null;
   if(m[3]){const chat=groups[page*8+Number(m[3])-1];if(!chat)return null;const v=versions(s,chat.id).at(-1);return this.view(s,actor,(v&&v.scope===chat.version?this.format(v):'لا توجد قوانين معتمدة لنطاق المجموعة الحالي.')+'\n\nلإضافة أو تعديل الإصدار، أرسل في الخاص:\n<code>/setrules '+chat.id+'\nالفقرة الأولى\nالفقرة الثانية</code>\nمن 1 إلى 20 فقرة، كل فقرة حتى 120 حرفًا، دون ترقيم يدوي. تظهر معاينة قبل الاعتماد. لإنذار مرتبط بفقرة استخدم /warnrule 3 بالرد على رسالة العضو؛ تعرض معاينة خاصة قبل التحذير.',[[b('↩️ المجموعات','rl:1:h:'+page)]]);}
   const rows=groups.slice(page*8,page*8+8).map((c,i)=>[b('📜 '+c.id,'rl:1:g:'+page+':'+(i+1)+':'+proof)]);if(page>0)rows.push([b('⬅️ السابق','rl:1:h:'+(page-1))]);if((page+1)*8<groups.length)rows.push([b('➡️ التالي','rl:1:h:'+(page+1))]);rows.push([b('↩️ قسم الحماية',this.policy.isOwner(actor)?'mi:1:s:02:0':'pn:1:h')]);return this.view(s,actor,'قوانين المجموعات المخولة — صفحة '+(page+1)+'\nاختر المجموعة لعرض الإصدار المعتمد وطريقة تعديله.',rows);
  });
 }
}
