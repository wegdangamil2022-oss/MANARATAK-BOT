import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {Phase4CommunityService,type DraftRequest} from './phase4-community.js';
import type {CommunityDraft} from './phase4-community-model.js';
import {visibleEducationCategory} from './education-category-policy.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityRulesUrl,
 validCommunityFAQId,type CommunityConfig,type CommunityReplyRule} from './phase4-community-model.js';
import {reviewedGroupFAQAnswer} from './phase4-community-sources.js';
import {publicFolderGroups} from './telegram-community-folders.js';
import {communityFolderURL} from './community-folder-model.js';

/** Sections 09:02/09:03 reuse owner-approved material, never copy students' messages.
 * Member rendering is ONLY called after a fresh Telegram membership/subscription
 * check in TelegramUpdateApplication.authorizePrivateGroupBrowse.
 */
const ID='-[1-9][0-9]{0,15}';
export const validGuidanceGroup=(value:unknown):value is string=>
 typeof value==='string'&&new RegExp('^'+ID+'$','u').test(value)&&
 Number.isSafeInteger(Number(value));
export const guidanceEscape=(value:string):string=>value.replace(/&/gu,'&amp;')
 .replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;')
 .replace(/'/gu,'&#39;');
export type GuidanceMemberCommand={kind:'GUIDE'|'RULES';chatId:string}|
 {kind:'FAQ_INDEX'|'NOTES_INDEX';chatId:string;page:number}|
 {kind:'FAQ';chatId:string;faqId:string};
export function parseGuidanceMemberCommand(input:string):GuidanceMemberCommand|null{
 if(typeof input!=='string'||input.length>90)return null;
 const guide=/^\/(groupguide|grouprules) (-[1-9][0-9]{0,15})$/u.exec(input);
 if(guide&&validGuidanceGroup(guide[2]!))return {
  kind:guide[1]==='groupguide'?'GUIDE':'RULES',chatId:guide[2]!
 };
 const index=/^\/(groupfaqs|groupnotes) (-[1-9][0-9]{0,15})(?: ([1-9][0-9]{0,1}))?$/u.exec(input);
 if(index&&validGuidanceGroup(index[2]!))return {
  kind:index[1]==='groupfaqs'?'FAQ_INDEX':'NOTES_INDEX',
  chatId:index[2]!,page:Number(index[3]??1)
 };
 const faq=/^\/groupfaq (-[1-9][0-9]{0,15}) ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.exec(input);
 return faq&&validGuidanceGroup(faq[1]!)&&validCommunityFAQId(faq[2])?
  {kind:'FAQ',chatId:faq[1]!,faqId:faq[2]!}:null;
}
export interface GuidanceFAQ{readonly id:string;readonly question:string;}
export interface GuidanceData{
 readonly chatId:string;readonly policyVersion:number;readonly config:CommunityConfig;
 readonly folderUrl?:string;readonly faqs:readonly GuidanceFAQ[];
 readonly educationTopics:readonly string[];
 readonly notes:readonly CommunityReplyRule[];
}
/** Read and filter on the *same* snapshot; disabled/unpublished FAQ content
 * and community folders without an ACTIVE verified subscription never leak.
 */
function context(s:BotState,policy:Policy,chatId:string):GuidanceData|null{
 if(!validGuidanceGroup(chatId)||!policy.canUseChat(s,chatId,'navigation'))return null;
 const group=s.chats.filter(c=>c.id===chatId);
 if(group.length!==1||!Number.isSafeInteger(group[0]!.version)||
  group[0]!.version<1)return null;
 const configs=s.phase4Community?.configs.filter(c=>c.chatId===chatId)??[];
 if(configs.length>1)return null;
 const config=configs[0]??defaultCommunityConfig(chatId);
 if(!validCommunityConfig(config))return null;
 const folder=publicFolderGroups(s,policy).find(c=>c.id===chatId);
 const ownerLink=folder?s.communityFolders?.find(f=>f.chatId===chatId):undefined;
 const folderUrl=ownerLink?.enabled&&communityFolderURL(ownerLink.url)?
  ownerLink.url:undefined;
 const faqs=s.faqEntries.filter(e=>e.scope===chatId&&e.status==='APPROVED'&&
  reviewedGroupFAQAnswer(s,chatId,e.id)!==null)
  .sort((a,b)=>a.question.localeCompare(b.question)||a.id.localeCompare(b.id))
  .slice(0,100).map(x=>({id:x.id,question:x.question.slice(0,160)}));
 const notes=config.rules.filter(rule=>rule.enabled&&rule.source==='NOTE'&&
  rule.topicId===undefined);
 const educationTopics=s.educationCategories.filter(cat=>
  cat.scope===chatId&&visibleEducationCategory(s,cat)&&
  s.educationResources.some(x=>x.scope===chatId&&x.categoryId===cat.id&&
    x.status==='PUBLISHED'))
  .sort((a,b)=>a.order-b.order||a.title.localeCompare(b.title))
  .slice(0,8).map(x=>x.title.slice(0,60));
 return {chatId,policyVersion:group[0]!.version,config,educationTopics,
  ...(folderUrl?{folderUrl}:{}),faqs,notes};
}
const link=(label:string,url:string)=>'<a href="'+guidanceEscape(url)+'">'+
 guidanceEscape(label)+'</a>';
const number=(n:number)=>n===0?'لا توجد بعد':String(n);
function rulesLink(data:GuidanceData):string{
 const url=data.config.rulesUrl;
 return validCommunityRulesUrl(url)?link('📜 فتح صفحة القوانين المعتمدة',url):
  '📜 لم يعتمد المالك رابط قوانين لهذه المجموعة حتى الآن.';
}
/** A concise educational entrypoint; no stored draft, unsolicited Telegram DM
 * or unsupported official channel URL is created by this view.
 */
export function renderGuidanceWelcome(data:GuidanceData):string{
 const group=data.chatId;
 const folder=data.folderUrl?link('📁 مجتمع منارتك — مجلد القنوات والمجموعات',data.folderUrl):
  '📁 مجلد المجتمع: لا يوجد رابط مفعّل ومؤهل للعرض بعد.';
 return '<b>🧭 دليل العضو الجديد — منارتك</b>\n'+
  'المجموعة: <code>'+group+'</code>\n\n'+
  '<b>نبذة عن المجموعة</b>\n'+
  guidanceEscape(data.config.guideIntro??'مرحبًا بك في المجتمع التعليمي. هذه صفحة تعريف مختصرة بطرق الاستفادة من البوت.')+
  '\n\n<b>المجالات التعليمية</b>\n'+
  (data.config.guideTopics?guidanceEscape(data.config.guideTopics):
   data.educationTopics.length?data.educationTopics.map(x=>'▫ '+guidanceEscape(x)).join('\n'):
   'لم تُحدّد مجالات خاصة بهذه المجموعة بعد.')+'\n\n'+
  '<b>خدمات المجموعة</b>\n'+
  (data.config.guideServices?guidanceEscape(data.config.guideServices):
   'الأسئلة المراجعة وروابط المصادر التعليمية، بحسب ما هو منشور ومتاح في المجموعة.')+'\n\n'+
  '◾ <b>التعرّف على المجموعة</b>: راجع القوانين وروابط المصادر المفعّلة أولًا.\n'+
  '◾ <b>المساعدة التعليمية</b>: استعرض إجابات الأسئلة الشائعة المراجعة ومصادرها، إن توفرت.\n'+
  '◾ <b>الاشتراكات</b>: التزم بمتطلبات المجموعة والقنوات الرسمية المعروضة في قسم الاشتراك.\n\n'+
  rulesLink(data)+'\n'+folder+'\n\n'+
  '<b>كيف تستخدم البوت؟</b>\n'+
  '<code>/grouprules '+group+'</code> — القوانين والملاحظات المعتمدة\n'+
  '<code>/groupguide '+group+'</code> — إعادة فتح هذا الدليل\n'+
  'قائمة الأسئلة المعتمدة، إن وجدت، تعرض معرّفاتها في صفحة القوانين.\n\n'+
  '⚠️ لا تعني هذه الصفحة موافقة على المنح أو إثبات العضوية، ولا تُرسل تلقائيًا لأعضاء جدد.';
}
/** Only approved, enabled NOTE replies are visible as fixed notes. Old plain
 * keyword replies are not silently presented as published group rules.
 */
export function renderGuidanceRules(data:GuidanceData):string{
 const chat=data.chatId;
 // Deliberately cap preview bytes even if an owner approved all 30 note rules.
 // Full reviewed material is available via paginated, membership-checked DMs.
 const notes=data.notes.slice(0,3).map((r,i)=>
  '▫ '+(i+1)+'. '+guidanceEscape(r.response.slice(0,90))).join('\n');
 const faqs=data.faqs.slice(0,4).map((q,i)=>
  '▫ '+(i+1)+'. '+guidanceEscape(q.question.slice(0,75))+'\n'+
  '   <code>/groupfaq '+chat+' '+q.id+'</code>').join('\n');
 return '<b>📜 القوانين والرسائل الثابتة — 09:03</b>\n'+
  'المجموعة: <code>'+chat+'</code>\n\n'+
  rulesLink(data)+'\n'+
  '⚠️ تفاصيل العقوبات والقوانين الأصلية تظل في قسم الحماية والإشراف، وليس هنا.\n\n'+
  '<b>📝 ملاحظات ثابتة معتمدة ('+data.notes.length+')</b>\n'+
  (notes||'لم تُضف ملاحظات ثابتة مفعّلة.')+
  (data.notes.length>3?'\nعرض أول 3 ملاحظات.':'')+
  '\n\n<b>📚 إجابات شائعة بمصادر منشورة ('+number(data.faqs.length)+')</b>\n'+
  (faqs||'لا توجد إجابات منشورة ومرئية لهذه المجموعة حاليًا.')+
  (data.faqs.length>4?'\nعرض أول 4 أسئلة.':'')+
  '\n\n<b>تصفح كل المواد المعتمدة</b>\n'+
  '<code>/groupfaqs '+chat+'</code> — فهرس FAQ (صفحات)\n'+
  '<code>/groupnotes '+chat+'</code> — فهرس الملاحظات (صفحات)\n'+
  'لا يعرض الفهرس FAQ غير منشور أو ملاحظة خاصة بموضوع Forum آخر.';
}
/** A private student index, not an owner preview. Page number is 1-based;
 * never allow unbounded text, callbacks-as-authorization, or stale FAQ rows.
 */
export function renderGuidanceIndex(data:GuidanceData,kind:'FAQ_INDEX'|'NOTES_INDEX',
 page:number):string|null{
 const isFAQ=kind==='FAQ_INDEX';
 const list=isFAQ?data.faqs:data.notes;
 const perPage=4,pages=Math.max(1,Math.ceil(list.length/perPage));
 if(!Number.isSafeInteger(page)||page<1||page>pages)return null;
 const first=(page-1)*perPage;
 const lines=isFAQ?
  data.faqs.slice(first,first+perPage).map((q,i)=>
   '◾ '+(first+i+1)+'. '+guidanceEscape(q.question.slice(0,80))+
   '\n<code>/groupfaq '+data.chatId+' '+q.id+'</code>').join('\n\n'):
  data.notes.slice(first,first+perPage).map((r,i)=>
   '◾ '+(first+i+1)+'. '+guidanceEscape(r.response.slice(0,120))).join('\n\n');
 const cmd=isFAQ?'groupfaqs':'groupnotes';
 return '<b>'+(isFAQ?'📚 فهرس الأسئلة المعتمدة':'📝 فهرس الملاحظات الثابتة')+
  '</b>\nالمجموعة: <code>'+data.chatId+'</code>\n'+
  'صفحة '+page+' من '+pages+' • العدد: '+list.length+'\n\n'+
  (lines||(isFAQ?'لا توجد إجابات معتمدة ومرئية حاليًا.':
   'لا توجد ملاحظات ثابتة عامة مفعّلة.'))+'\n\n'+
  (page>1?'⬅️ السابق: <code>/'+cmd+' '+data.chatId+' '+(page-1)+'</code>\n':'')+
  (page<pages?'➡️ التالي: <code>/'+cmd+' '+data.chatId+' '+(page+1)+'</code>\n':'')+
  'يعاد فحص المصدر والعضوية والاشتراك مع كل طلب، ولا تُرسل إشعارات تلقائية.';
}
export function renderGuidanceFAQ(s:BotState,chatId:string,id:string):string|null{
 if(!validGuidanceGroup(chatId)||!validCommunityFAQId(id))return null;
 const q=s.faqEntries.filter(e=>e.id===id&&e.scope===chatId);
 if(q.length!==1||q[0]!.status!=='APPROVED')return null;
 const answer=reviewedGroupFAQAnswer(s,chatId,id);
 if(answer===null)return null;
 return '<b>📚 إجابة من مصدر تعليمي منشور</b>\n'+
  'المجموعة: <code>'+chatId+'</code>\n'+
  '<b>السؤال:</b> '+guidanceEscape(q[0]!.question.slice(0,240))+'\n'+
  '<b>الإجابة:</b> '+guidanceEscape(answer)+'\n\n'+
  'المصدر: منشور تعليمي مُعتمد ومرئي لهذه المجموعة. هذه المعلومات لا تُعدّ وعدًا بقبول أو منحة.';
}
export class Phase4GuidanceService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly community:Phase4CommunityService){}
 async groups(actor:string):Promise<{chatId:string;configured:boolean}[]>{
  if(!this.policy.isOwner(actor))return [];
  return this.community.listGroups(actor);
 }
 async ownerGroup(actor:string,chatId:string):Promise<GuidanceData|null>{
  if(!this.policy.isOwner(actor))return null;
  try{
   await this.community.view(actor,chatId);
   return context(await this.store.snapshot(),this.policy,chatId);
  }catch{return null;}
 }
 /** The private Telegram transport MUST verify group membership and any
  * mandatory subscription before invoking this method.
  */
 async member(chatId:string,kind:'GUIDE'|'RULES'|'FAQ'|'FAQ_INDEX'|'NOTES_INDEX',
  faqId?:string,page=1):Promise<string|null>{
  const state=await this.store.snapshot();
  const data=context(state,this.policy,chatId);
  if(!data)return null;
  if(kind==='GUIDE')return renderGuidanceWelcome(data);
  if(kind==='RULES')return renderGuidanceRules(data);
  if(kind==='FAQ_INDEX'||kind==='NOTES_INDEX')return renderGuidanceIndex(data,kind,page);
  if(kind==='FAQ'&&faqId!==undefined)return renderGuidanceFAQ(state,chatId,faqId);
  return null;
 }
 /** Owner-only wrapper. Existing community drafts provide 2-minute TTL,
  * approval-epoch check, stale policy protection and durable audit. */
 async edit(actor:string,chatId:string,request:DraftRequest):Promise<CommunityDraft>{
  if(!this.policy.isOwner(actor)||!request.kind.startsWith('GUIDE_'))
   throw Error('COMMUNITY_OWNER_DENIED');
  return this.community.pending(actor,request,chatId);
 }
 preview(draft:CommunityDraft):string{return this.community.preview(draft);}
 async confirm(actor:string,id:string):Promise<string>{
  if(!this.policy.isOwner(actor))throw Error('COMMUNITY_OWNER_DENIED');
  return (await this.community.approve(actor,id)).chatId;
 }
 async cancel(actor:string,id:string):Promise<boolean>{
  if(!this.policy.isOwner(actor))return false;
  return this.community.cancel(actor,id);
 }
 async ownerFAQ(actor:string,chatId:string,faqId:string):Promise<string|null>{
  if(!await this.ownerGroup(actor,chatId))return null;
  const state=await this.store.snapshot();
  if(!context(state,this.policy,chatId))return null;
  return renderGuidanceFAQ(state,chatId,faqId);
 }
}
