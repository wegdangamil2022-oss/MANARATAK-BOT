import {versions,lines,ruleContentShape,validRuleLanguage,validRuleTranslations,currentGroupRuleVersion,groupRuleDescription,type Version} from './group-rules-model.js';
export {groupRuleDescription,currentGroupRuleVersion} from './group-rules-model.js';
import {groupMenuEpochDigest} from './telegram-group-access.js';
import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import {countAppealWarningRevocations} from './telegram-moderation-appeals.js';
import {groupRuleRestrictionCounts} from './group-rule-restriction-report.js';
import {warningActive} from './group-rule-warning-policy.js';
import {ruleReviewReports} from './moderation-report-model.js';
import {ruleNotices} from './group-rule-notices.js';
const ROOT='moderation:rules:',PUBLISH='GROUP_RULES_PUBLISHED:',PREVIEW='GROUP_RULES_PREVIEW:';

type Draft={chat:string;base:number;lines:string[];disabled?:number[];translations?:Record<string,string[]>;source:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape=(v:string)=>v.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
const b=(text:string,callback_data:string)=>({text,callback_data});
const ROUTE=/^rl:1:h:(0|[1-9][0-9]{0,2})$|^rl:1:g:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$|^rl:1:([cx]):([A-Za-z0-9_-]{24})$/u;
const REPORT_ROUTE=/^rl:1:r:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$/u;
export const validGroupRulesRoute=(data:string)=>ROUTE.exec(data)?.[0]===data||REPORT_ROUTE.exec(data)?.[0]===data;
export class TelegramGroupRules{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 private manager(s:BotState,actor:string,chat:string):boolean{return this.policy.canUseChat(s,chat,'moderation')&&this.policy.has(s,actor,'chat.manage',chat,this.clock())&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));}
 private source(s:BotState,actor:string,chat:string):string{return hash([actor,s.chats.filter(c=>c.id===chat),s.grants,s.privateFeatures,s.privateSettingsRevision,versions(s,chat)]);}
 private view(s:BotState,actor:string,text:string,rows:{text:string;callback_data:string}[][]):(OwnerInlineScreen&{access:AdminUIAccess})|null{
  const now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);return epoch&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-120000?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch,expiresAt:now+120000}}:null;
 }
 async cancel(actor:string):Promise<void>{const snap=await this.store.snapshot(),done=new Set(snap.audit.map(a=>a.updateKey));if(!snap.audit.some(a=>a.actorId===actor&&/^moderation:rules:preview:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)&&a.reason.startsWith(PREVIEW)&&!done.has(a.updateKey+':done')))return;await this.store.transaction(s=>{for(const a of s.audit.filter(a=>a.actorId===actor&&/^moderation:rules:preview:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)&&a.reason.startsWith(PREVIEW))){if(!s.audit.some(x=>x.updateKey===a.updateKey+':done'))s.audit.push({actorId:actor,updateKey:a.updateKey+':done',decision:'DENY',reason:'GROUP_RULES_PREVIEW_CANCELLED',policyVersion:a.policyVersion,at:this.clock()});}});}
 async warningReference(chat:string,paragraph:number,message:number):Promise<string|null>{const s=await this.store.snapshot(),v=versions(s,chat).at(-1);if(!v||currentGroupRuleVersion(s,chat)!==v.version||v.disabled?.includes(paragraph)||!this.policy.canUseChat(s,chat,'moderation')||!Number.isSafeInteger(paragraph)||paragraph<1||paragraph>v.lines.length||!Number.isSafeInteger(message)||message<=0)return null;return 'law_v'+v.version+'_p'+paragraph+'_m'+message;}
 async published(chat:string):Promise<string|null>{return (await this.publishedView(chat))?.text??null;}
 async historical(actor:string,chat:string,version:number):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  const s=await this.store.snapshot();if(!group(chat)||!Number.isSafeInteger(version)||version<1||!this.manager(s,actor,chat)||currentGroupRuleVersion(s,chat)===null)return null;
  const v=versions(s,chat).find(entry=>entry.version===version);if(!v||v.scope!==this.policy.chatRevision(s,chat))return null;
  return this.view(s,actor,this.format(v)+'\nهذا إصدار تاريخي للعرض؛ لا يجيز اتخاذ إجراء على فقرة قديمة.',[[b('↩️ قوانين المجموعات','rl:1:h:0')]]);
 }
 async publishedView(chat:string,topicId?:number,language?:string):Promise<{text:string;epoch:string}|null>{const s=await this.store.snapshot(),v=versions(s,chat).at(-1);return this.policy.canUseChat(s,chat,'moderation')&&v&&currentGroupRuleVersion(s,chat)===v.version&&(language===undefined||validRuleLanguage(language)&&Object.hasOwn(v.translations??{},language))?{text:this.format(v,language),epoch:groupMenuEpochDigest(s,chat,topicId)}:null;}
 private format(v:Version,language?:string):string{const text=language?v.translations?.[language]:v.lines;return '<b>قوانين المجموعة — الإصدار '+v.version+'</b>'+(language?' · '+language:'')+'\n'+(text??v.lines).map((line,i)=>(i+1)+'. '+(v.disabled?.includes(i+1)?'[معطلة] ':'')+escape(line)).join('\n')+'\nاعتماد: '+new Date(v.at).toISOString().slice(0,10)+(Object.keys(v.translations??{}).length?'\nلغات معتمدة: '+Object.keys(v.translations!).sort().join('، ')+' · العرض: /rules رمز_اللغة':'');}
 async preview(actor:string,text:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  const m=/^\/setrules (-[1-9][0-9]{0,15})\n([\s\S]+)$/u.exec(text),toggle=/^\/(disable|enable)rule (-[1-9][0-9]{0,15}) ([1-9][0-9]?)$/u.exec(text),translation=/^\/translaterules (-[1-9][0-9]{0,15}) ([a-z]{2}(?:-[A-Z]{2})?)\n([\s\S]+)$/u.exec(text),remove=/^\/removerulelang (-[1-9][0-9]{0,15}) ([a-z]{2}(?:-[A-Z]{2})?)$/u.exec(text);if(![m,toggle,translation,remove].some(match=>match?.[0]===text))return null;const chat=(m?.[1]??toggle?.[2]??translation?.[1]??remove?.[1])!,input=m?.[2]?.split('\n');if(!group(chat)||input&&!lines(input))return null;
  await this.cancel(actor);
  return this.store.transaction(s=>{const now=this.clock();if(!this.manager(s,actor,chat)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
   const previous=versions(s,chat).at(-1),base=previous?.version??0;let items=input!,disabled:number[]|undefined,translations:Record<string,string[]>|undefined;
   if(toggle||translation||remove){if(!previous||currentGroupRuleVersion(s,chat)!==previous.version)return null;items=previous.lines;disabled=previous.disabled;translations={...previous.translations};}
   if(toggle){const paragraph=Number(toggle[3]);if(!previous||currentGroupRuleVersion(s,chat)!==previous.version||paragraph>previous.lines.length)return null;items=previous.lines;const old=previous.disabled??[],off=toggle[1]==='disable';if(old.includes(paragraph)===off)return null;disabled=off?[...old,paragraph].sort((a,b)=>a-b):old.filter(n=>n!==paragraph);}
   if(translation){const language=translation[2]!,translated=translation[3]!.split('\n');if(!lines(translated)||translated.length!==items.length)return null;translations![language]=translated;if(!validRuleTranslations(translations,items.length))return null;}
   if(remove){if(!Object.hasOwn(translations!,remove[2]!))return null;delete translations![remove[2]!];}
   const nonce=randomBytes(18).toString('base64url'),draft:Draft={chat,base,lines:items,...(disabled?{disabled}:{}),...(translations?{translations}:{}),source:this.source(s,actor,chat)};
   s.audit.push({actorId:actor,updateKey:ROOT+'preview:'+nonce,decision:'ALLOW',reason:PREVIEW+Buffer.from(JSON.stringify(draft)).toString('base64url'),policyVersion:this.policy.chatRevision(s,chat),at:now});
   return this.view(s,actor,'معاينة اعتماد قوانين المجموعة '+chat+'\n'+this.format({chat,version:base+1,lines:items,...(disabled?{disabled}:{}),...(translations?{translations}:{}),actor,at:now,scope:this.policy.chatRevision(s,chat)},translation?.[2])+'\nتبقى الإصدارات السابقة محفوظة. الترجمة مدخلة للمراجعة وليست ترجمة آلية. تعديل النص الأساسي بـ /setrules يلغي ترجمات الإصدار السابق ويعرض جميع الفقرات المدخلة فعالة. الفقرة المعطلة لا تقبل إجراءات جديدة. التأكيد صالح لدقيقتين؛ الرجوع يلغيه. لا تُصدر هذه العملية عقوبة.',[[b('✅ اعتماد الإصدار','rl:1:c:'+nonce)],[b('↩️ إلغاء','rl:1:x:'+nonce)]]);
  });
 }
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access:AdminUIAccess})|null>{
  if(data==='mi:1:i:02:11'){if(!this.policy.isOwner(actor))return null;data='rl:1:h:0';}
  const m=ROUTE.exec(data),report=REPORT_ROUTE.exec(data);if((!m||m[0]!==data)&&(!report||report[0]!==data)||!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor)))return null;
  return this.store.transaction(s=>{
   const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
   const groups=s.chats.filter(c=>this.manager(s,actor,c.id)).sort((a,b)=>a.id.localeCompare(b.id));
   const proof=hash([actor,groups,s.grants,s.privateFeatures,s.privateSettingsRevision,s.audit.filter(a=>a.updateKey.startsWith(ROOT)||a.updateKey.startsWith('moderation:appeal:')||a.updateKey.startsWith('moderation:rule-notice:')||a.updateKey.startsWith('moderation:report:')),s.warnings.filter(w=>groups.some(c=>c.id===w.chatId))]).slice(0,16);
   if(report?.[0]===data){
    const page=Number(report[1]),slot=Number(report[2]),chat=groups[page*8+slot-1];if(report[3]!==proof||page>=Math.max(1,Math.ceil(groups.length/8))||!chat)return null;
    const history=versions(s,chat.id),lookup=new Map(history.map(v=>[v.version,v]));
    const weekly=s.warnings.filter(w=>w.chatId===chat.id&&person(w.memberId)&&person(w.actorId)&&typeof w.reference==='string'&&Number.isSafeInteger(w.at)&&w.at>=Math.max(0,now-7*86400000)&&w.at<=now&&typeof w.active==='boolean');
    const counts=new Map<string,number>();for(const w of s.warnings){if(w.chatId!==chat.id||typeof w.memberId!=='string'||typeof w.reference!=='string')continue;const key=w.memberId+':'+w.reference;counts.set(key,(counts.get(key)??0)+1);}
    const totals=new Map<string,{version:number;paragraph:number;line:string;count:number}>();
    for(const w of weekly){
     if(counts.get(w.memberId+':'+w.reference)!==1)continue;
     const ref=/^law_v([1-9][0-9]{0,14})_p([1-9][0-9]?)_m([1-9][0-9]{0,15})$/u.exec(w.reference);if(!ref||ref[0]!==w.reference||!Number.isSafeInteger(Number(ref[3])))continue;
     const version=Number(ref[1]),paragraph=Number(ref[2]),line=lookup.get(version)?.lines[paragraph-1];if(!line)continue;
     const key=version+':'+paragraph,old=totals.get(key);if(old)old.count++;else totals.set(key,{version,paragraph,line,count:1});
    }
    const ordered=[...totals.values()].sort((a,b)=>b.count-a.count||b.version-a.version||a.paragraph-b.paragraph),total=ordered.reduce((n,x)=>n+x.count,0),restrictions=groupRuleRestrictionCounts(s,chat.id,now,reference=>!!groupRuleDescription(s,chat.id,reference));
    const reviews=ruleReviewReports(s,now).filter(r=>r.chat===chat.id&&r.at>=Math.max(0,now-7*86400000)&&r.at<=now);
    const notices=ruleNotices(s,now).filter(r=>r.chat===chat.id&&r.at>=Math.max(0,now-7*86400000));
    const shown:string[]=[];let length=0;
    for(const r of ordered.slice(0,10)){const line='الإصدار '+r.version+' · الفقرة '+r.paragraph+': '+r.count+' تحذير\n'+escape(r.line);if(length+line.length>2800)break;shown.push(line);length+=line.length+1;}
    const text='<b>تقرير القوانين خلال الأسبوع</b>\nالمجموعة: '+chat.id+'\nالتحذيرات المسجلة المرتبطة بفقرات موثقة: '+total+'\n'+(shown.length?shown.join('\n'):'لا توجد تحذيرات مرتبطة بفقرات موثقة خلال هذه الفترة.')+'\n'+(ordered.length>shown.length?'تُعرض أول '+shown.length+' فقرات حسب العدد وحدود الرسالة.\n':'')+'الإلغاءات الموثقة بعد اعتراض خلال الأسبوع: '+countAppealWarningRevocations(s,chat.id,now)+'\nيشمل عدد التحذيرات النشط والملغى الصادر خلال الفترة، ولا يعرض هويات الأعضاء. لا يمكن الجزم بسبب الإلغاءات القديمة دون رابط موثق؛ قبول المراجعة لا يلغي التحذير تلقائيًا.';
    return this.view(s,actor,text+'\nتنبيهات أولى مسجلة: '+notices.length+' · وصول مؤكد: '+notices.filter(n=>n.delivery==='CONFIRMED').length+' · معلقة: '+notices.filter(n=>n.delivery==='PENDING').length+' · غير محسومة: '+notices.filter(n=>n.delivery==='UNKNOWN_OUTCOME').length+' · فشل مؤكد أو إلغاء: '+notices.filter(n=>['FAILED_CONFIRMED','CANCELLED'].includes(n.delivery)).length+'\nمراجعات الفقرات المسجلة خلال الأسبوع: '+reviews.length+' · المغلق منها: '+reviews.filter(r=>r.closed).length+'\nإنذارات السجل الأسبوعي المنتهية دون إلغاء: '+weekly.filter(w=>w.active&&!warningActive(w,now)).length+'\nقيود فقرات مؤكدة من Telegram: '+restrictions.telegram+'\nقيود فقرات بمحاكاة محلية: '+restrictions.simulation+'\nمحاولات قيود فقرات غير محسومة: '+restrictions.unresolved+'\nيُعد إيصال القيد مرة واحدة ولو ارتبط بأكثر من فقرة؛ لا تثبت المحاكاة تنفيذًا حيًا.',[[b('↩️ قوانين المجموعة','rl:1:g:'+page+':'+slot+':'+proof)],[b('↩️ المجموعات','rl:1:h:'+page)]]);
   }
   if(!m||m[0]!==data)return null;
   if(m[5]){
    const key=ROOT+'preview:'+m[6],rows=s.audit.filter(a=>a.updateKey===key),a=rows[0];if(rows.length!==1||!a||a.actorId!==actor||!a.reason.startsWith(PREVIEW)||a.at>now||now>=a.at+120000||s.audit.some(a=>a.updateKey===key+':done'))return null;
    let draft:Draft;try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PREVIEW.length),'base64url').toString('utf8'));if(!object(v)||!ruleContentShape(v,'base,chat,lines,source')||!group(v.chat)||!Number.isSafeInteger(v.base)||Number(v.base)<0||typeof v.source!=='string'||!/^[a-f0-9]{64}$/u.test(v.source))return null;draft=v as Draft;}catch{return null;}
    if(!this.manager(s,actor,draft.chat)||a.policyVersion!==this.policy.chatRevision(s,draft.chat)||draft.source!==this.source(s,actor,draft.chat))return null;
    if(m[5]==='x'){s.audit.push({actorId:actor,updateKey:key+':done',decision:'DENY',reason:'GROUP_RULES_PREVIEW_CANCELLED',policyVersion:a.policyVersion,at:now});return this.view(s,actor,'أُلغي اعتماد الإصدار.',[[b('↩️ القوانين','rl:1:h:0')]]);}
    const version=draft.base+1;if((versions(s,draft.chat).at(-1)?.version??0)!==draft.base||s.audit.some(a=>a.updateKey===ROOT+'published:'+draft.chat+':'+version))return null;
    s.audit.push({actorId:actor,updateKey:key+':done',decision:'ALLOW',reason:'GROUP_RULES_PREVIEW_CONFIRMED',policyVersion:a.policyVersion,at:now});
    s.audit.push({actorId:actor,updateKey:ROOT+'published:'+draft.chat+':'+version,decision:'ALLOW',reason:PUBLISH+Buffer.from(JSON.stringify({chat:draft.chat,version,lines:draft.lines,...(draft.disabled?{disabled:draft.disabled}:{}),...(draft.translations?{translations:draft.translations}:{})})).toString('base64url'),policyVersion:a.policyVersion,at:now});return this.view(s,actor,'اعتُمد الإصدار '+version+'. يستطيع الأعضاء عرضه بأمر /rules. بقي سجل الإصدارات القديمة دون تغيير.',[[b('↩️ القوانين','rl:1:h:0')]]);
   }
   const page=Number(m[1]??m[2]);if(page>=Math.max(1,Math.ceil(groups.length/8))||m[4]!==undefined&&m[4]!==proof)return null;
   if(m[3]){const chat=groups[page*8+Number(m[3])-1];if(!chat)return null;const v=versions(s,chat.id).at(-1);return this.view(s,actor,(v&&currentGroupRuleVersion(s,chat.id)===v.version?this.format(v):'لا توجد قوانين معتمدة لنطاق المجموعة الحالي.')+'\n\nلإضافة أو تعديل الإصدار، أرسل في الخاص:\n<code>/setrules '+chat.id+'\nالفقرة الأولى\nالفقرة الثانية</code>\nلتعطيل فقرة أو تفعيلها بمعاينة وتأكيد خاصين: <code>/disablerule '+chat.id+' 1</code> أو <code>/enablerule '+chat.id+' 1</code>. يبقى سجل المخالفات السابق محفوظًا.\nلإضافة ترجمة مراجعة: <code>/translaterules '+chat.id+' en\nFirst paragraph\nSecond paragraph</code> بعدد الفقرات نفسه. حتى 3 لغات اختيارية؛ العرض في المجموعة: <code>/rules en</code>. لحذف لغة بمعاينة: <code>/removerulelang '+chat.id+' en</code>.\nمن 1 إلى 20 فقرة، كل فقرة حتى 120 حرفًا، دون ترقيم يدوي. تظهر معاينة قبل الاعتماد. لإنذار مرتبط بفقرة استخدم إنذار 3 أو /warnrule 3 بالرد على رسالة العضو؛ تعرض معاينة خاصة قبل التحذير. لاختيار إجراء من القائمة المرتبة استخدم /actrule 3 بالرد، وللتنبيه الأول الخاص استخدم /noticerule 3. القائمة وإعداد ترتيبها من زر السياسة أدناه؛ لا تصعيد تلقائي. لإحالة فقرة للمراجعة استخدم /reviewrule 3 بالرد؛ تُعرض معاينة خاصة وتُتابع من بلاغات المجموعات دون عقوبة تلقائية. للتقييد المحدود استخدم /muterule 3 300 بالرد؛ المدة بالثواني من 60 إلى 86400، ويُراجع الإصدار والإعفاء قبل التنفيذ.',[[b('📨 مراجعات الفقرات والبلاغات','rp:1:r:0')],[b('⚙️ سقف ومدة الإنذارات','rw:1:g:'+chat.id)],[b('📊 تقرير الأسبوع','rl:1:r:'+page+':'+m[3]+':'+proof)],[b('🛡️ إعفاء فقرة','le:1:h:'+page+':'+m[3]+':'+proof)],[b('↩️ المجموعات','rl:1:h:'+page)]]);}
   const rows=groups.slice(page*8,page*8+8).map((c,i)=>[b('📜 '+c.id,'rl:1:g:'+page+':'+(i+1)+':'+proof)]);if(page>0)rows.push([b('⬅️ السابق','rl:1:h:'+(page-1))]);if((page+1)*8<groups.length)rows.push([b('➡️ التالي','rl:1:h:'+(page+1))]);rows.push([b('↩️ قسم الحماية',this.policy.isOwner(actor)?'mi:1:s:02:0':'pn:1:h')]);return this.view(s,actor,'قوانين المجموعات المخولة — صفحة '+(page+1)+'\nاختر المجموعة لعرض الإصدار المعتمد وطريقة تعديله.',rows);
  });
 }
}
