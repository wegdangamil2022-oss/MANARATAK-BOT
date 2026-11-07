import {Phase4ExpertService} from './phase4-experts.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {validEventSummaryInput,validEventURL} from './phase4-event-model.js';
import {expertName,expertSpecialty} from './phase4-expert-model.js';

const HEX='[a-f0-9]{24}';
const ROUTE=new RegExp('^xa:1:(?:h|[pstv]:'+HEX+'|[rocka]:'+HEX+':[123])$','u');
export const validExpertOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('🎤 جلسات الخبير','xa:1:h');
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:1');
export type ExpertOwnerCommand=
 |{kind:'LIST'}
 |{kind:'PROFILE';chatId:string;name:string;specialty:string;url:string}
 |{kind:'SESSION';profileId:string;discussionId:string}
 |{kind:'DEFER';sessionId:string;questionId:string}
 |{kind:'RANK'|'REPORTS';sessionId:string}
 |{kind:'SUMMARY';sessionId:string;text:string;urls:string[]};
export function parseExpertOwnerCommand(value:string):ExpertOwnerCommand|null{
 if(typeof value!=='string'||value.length>1400||/[\r\n]/u.test(value))return null;
 if(value==='/experts')return {kind:'LIST'};
 const profile=/^\/expertnew (-[1-9][0-9]{0,15}) (\S+) \| (.+) \| (.+)$/u.exec(value);
 if(profile){
  if(!Number.isSafeInteger(Number(profile[1]))||!validEventURL(profile[2])||
   !expertName(profile[3])||!expertSpecialty(profile[4]))return null;
  return {kind:'PROFILE',chatId:profile[1]!,url:profile[2]!,
   name:profile[3]!,specialty:profile[4]!};
 }
 const session=/^\/amanew ([a-f0-9]{24}) ([a-f0-9]{24})$/u.exec(value);
 if(session)return {kind:'SESSION',profileId:session[1]!,discussionId:session[2]!};
 const review=/^\/ama(rank|reports) ([a-f0-9]{24})$/u.exec(value);
 if(review)return {kind:review[1]==='rank'?'RANK':'REPORTS',sessionId:review[2]!};
 const defer=/^\/amadefer ([a-f0-9]{24}) ([a-f0-9]{24})$/u.exec(value);
 if(defer)return {kind:'DEFER',sessionId:defer[1]!,questionId:defer[2]!};
 const summary=/^\/amasummarynew ([a-f0-9]{24}) (.{20,1100})$/u.exec(value);
 if(summary){
  const parts=summary[2]!.split(' | '),text=parts[0]??'',urls=parts.slice(1);
  if(!validEventSummaryInput(text,urls))return null;
  return {kind:'SUMMARY',sessionId:summary[1]!,text,urls};
 }
 return null;
}
async function profileDetail(service:Phase4ExpertService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const p=await service.ownerProfile(actor,id);if(!p)return null;
 const rows:{text:string;callback_data:string}[][]=[];
 if(p.status==='DRAFT')rows.push([btn('✅ تأكيد مراجعة المصدر يدويًا','xa:1:r:'+p.id+':1')]);
 rows.push([home],[back]);
 return ui('<b>🎤 ملف المتحدث — مراجعة المالك فقط</b>\n'+
  'الاسم المعروض: '+esc(p.displayName)+'\n'+
  'المجال: '+esc(p.specialty)+'\n'+
  'المجموعة: <code>'+p.chatId+'</code>\n'+
  'رابط دليل الصفة الذي يتعين على المالك مراجعته: '+esc(p.evidenceUrl)+'\n'+
  'الحالة: '+p.status+'\n'+
  'رقم الملف: <code>'+p.id+'</code>\n'+
  '⚠️ الاعتماد هنا إقرار بشري من المالك بمراجعة المصدر، وليس شهادة جامعية أو تحققًا من Telegram.',
  rows);
}
async function sessionDetail(service:Phase4ExpertService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const row=await service.ownerView(actor,id);if(!row)return null;
 const {session,profile,summary}=row;
 const counts=await service.ownerStats(actor,id);
 const actions:{text:string;callback_data:string}[][]=[];
 if(session.status==='DRAFT')actions.push([btn('✅ فتح إدارة الجلسة','xa:1:o:'+id+':1')]);
 if(session.status==='OPEN')actions.push(
  [btn('📊 ترتيب الأسئلة (للمالك)','xa:1:t:'+id)],
  [btn('🚩 بلاغات الأسئلة (للمالك)','xa:1:v:'+id)],
  [btn('🔒 مراجعة إغلاق الجلسة','xa:1:k:'+id+':2')]);
 if(session.status==='CLOSED'&&summary?.status==='DRAFT')
  actions.push([btn('✅ اعتماد الملخص بعد مراجعته','xa:1:a:'+id+':1')]);
 actions.push([home],[back]);
 return ui('<b>🎤 جلسة اسأل الخبير — 09:10</b>\n'+
  'المتحدث الذي راجع المالك مصدره: '+esc(profile.displayName)+'\n'+
  'التخصص المعلن: '+esc(profile.specialty)+'\n'+
  'الحالة: '+session.status+'\n'+
  'معرّف جلسة الأسئلة الخاصة: <code>'+session.questionSessionId+'</code>\n'+
  'رقم جلسة الخبير: <code>'+session.id+'</code>\n'+
  'نهاية استقبال الأسئلة (UTC): '+new Date(session.expiresAt).toISOString()+'\n'+
  (counts?'الأسئلة: '+counts.total+' | تنتظر: '+counts.pending+
   ' | معتمدة: '+counts.approved+' | مؤجلة: '+counts.deferred+
   ' | مميزة كمجابة: '+counts.answered+'\n':'')+
  (session.status==='OPEN'?'لتأجيل سؤال معتمد: <code>/amadefer '+id+' QUESTION_ID</code>\n'+
   'للمشاركة بعد اعتماد السؤال: <code>/amavote '+id+' QUESTION_ID</code>\n'+
   'للبلاغات: <code>/amareport '+id+' QUESTION_ID CONTACT_DETAILS</code>\n':'')+
  (session.status==='CLOSED'&&!summary?'لإعداد ملخص: <code>/amasummarynew '+id+
   ' خلاصة مراجعة اللجنة ومصادر المعلومات ... | https://university.example.edu/resource</code>\n':'')+
  (summary?'الملخص: '+summary.status+'\n'+
    'النص الذي راجعه المالك: '+esc(summary.text)+'\n':'')+
  '⚠️ هذه إدارة محلية؛ لا تتواصل مع الضيف ولا ترسل ردودًا تلقائيًا، ولا تعد بمنحة أو قرار قبول.',
  actions);
}
async function listing(service:Phase4ExpertService,actor:string):
 Promise<OwnerInlineScreen|null>{
 const {profiles,sessions}=await service.list(actor);
 const rows:{text:string;callback_data:string}[][]=[];
 for(const session of sessions.slice(0,10))
  rows.push([btn('🎤 '+session.status+' '+session.id.slice(0,8),'xa:1:s:'+session.id)]);
 for(const p of profiles.slice(0,10))
  rows.push([btn('📄 '+p.status+' '+p.displayName.slice(0,20),'xa:1:p:'+p.id)]);
 rows.push([back]);
 return ui('<b>🎤 جلسات اسأل الخبير — 09:10</b>\n'+
  'أولًا: أنشئ بطاقة لمتحدث بمصدر يُراجعه المالك:\n'+
  '<code>/expertnew -1001234 https://university.example.edu/staff/advisor | مستشار أكاديمي | القبول والمنح الدراسية</code>\n'+
  'ثانيًا: راجع البطاقة واضغط تأكيد مراجعة المصدر (ليس تحققًا رسميًا).\n'+
  'ثالثًا: افتح جلسة أسئلة في 09:07، ثم اربطها بالمتحدث المعتمد:\n'+
  '<code>/amanew PROFILE_ID DISCUSSION_ID</code>\n'+
  'المراجعة والاعتماد وإغلاق الأسئلة يتمان في خاص المالك فقط.\n'+
  'النشر وإرسال الإجابات التلقائي غير مفعّلين.\n'+
  'الجلسات: '+sessions.length+' · بطاقات المتحدثين: '+profiles.length,rows);
}
async function ranking(service:Phase4ExpertService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const rows=await service.ownerRanking(actor,id);
 if(!rows)return null;
 const items=rows.slice(0,15).map((x,i)=>(i+1)+'. <code>'+x.questionId+
  '</code> — '+x.votes+' تأييد');
 return ui('<b>📊 ترتيب إشارات الاهتمام — للمالك فقط</b>\n'+
  (items.length?items.join('\n'):'لا توجد أسئلة معتمدة بعد.')+
  '\n⚠️ الترتيب مؤشر يساعد المراجع، ولا ينشر السؤال ولا يحدد الأولوية تلقائيًا ولا يكشف أصحاب الأصوات.',
  [[btn('↩️ تفاصيل الجلسة','xa:1:s:'+id)],[home]]);
}
async function reports(service:Phase4ExpertService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const rows=await service.ownerReports(actor,id);
 if(!rows)return null;
 const items=rows.slice(0,12).map(x=>
  '<code>'+x.questionId+'</code> — '+x.count+' بلاغ'+
  ' | بيانات اتصال: '+x.reasons.CONTACT_DETAILS+
  ' | ادعاء استشارة مهنية: '+x.reasons.UNLICENSED_ADVICE+
  ' | إساءة: '+x.reasons.HARASSMENT);
 return ui('<b>🚩 بلاغات خاصة بمراجعة المالك</b>\n'+
  (items.length?items.join('\n'):'لا توجد بلاغات.')+
  '\nلا يكشف النظام أسماء المبلّغين ولا ينشر نصوص أسئلتهم. البلاغ ليس إثباتًا لوقوع مخالفة.',
  [[btn('↩️ تفاصيل الجلسة','xa:1:s:'+id)],[home]]);
}
export async function expertOwnerScreen(
 service:Phase4ExpertService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parseExpertOwnerCommand(input);
  if(parsed?.kind==='PROFILE'){
   const p=await service.draftProfile(actor,parsed.chatId,{
    displayName:parsed.name,specialty:parsed.specialty,evidenceUrl:parsed.url});
   return profileDetail(service,actor,p.id);
  }
  if(parsed?.kind==='SESSION'){
   const s=await service.draftSession(actor,parsed.profileId,parsed.discussionId);
   return sessionDetail(service,actor,s.id);
  }
  if(parsed?.kind==='DEFER'){
   if(!await service.deferQuestion(actor,parsed.sessionId,parsed.questionId))return null;
   return sessionDetail(service,actor,parsed.sessionId);
  }
  if(parsed?.kind==='SUMMARY'){
   await service.draftSummary(actor,parsed.sessionId,parsed.text,parsed.urls);
   return sessionDetail(service,actor,parsed.sessionId);
  }
  if(parsed?.kind==='RANK')return ranking(service,actor,parsed.sessionId);
  if(parsed?.kind==='REPORTS')return reports(service,actor,parsed.sessionId);
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:10'||input==='xa:1:h')
   return listing(service,actor);
  if(!validExpertOwnerRoute(input))return null;
  const p=/^xa:1:p:([a-f0-9]{24})$/u.exec(input);
  if(p)return profileDetail(service,actor,p[1]!);
  const session=/^xa:1:s:([a-f0-9]{24})$/u.exec(input);
  if(session)return sessionDetail(service,actor,session[1]!);
  const ranked=/^xa:1:t:([a-f0-9]{24})$/u.exec(input);
  if(ranked)return ranking(service,actor,ranked[1]!);
  const flagged=/^xa:1:v:([a-f0-9]{24})$/u.exec(input);
  if(flagged)return reports(service,actor,flagged[1]!);
  const reviewed=/^xa:1:r:([a-f0-9]{24}):([123])$/u.exec(input);
  if(reviewed){
   if(!await service.reviewProfile(actor,reviewed[1]!,Number(reviewed[2])))return null;
   return profileDetail(service,actor,reviewed[1]!);
  }
  const opened=/^xa:1:o:([a-f0-9]{24}):([123])$/u.exec(input);
  if(opened){
   if(!await service.openSession(actor,opened[1]!,Number(opened[2])))return null;
   return sessionDetail(service,actor,opened[1]!);
  }
  const check=/^xa:1:k:([a-f0-9]{24}):([123])$/u.exec(input);
  if(check){
   const row=await service.ownerView(actor,check[1]!);
   if(!row||row.session.status!=='OPEN'||row.session.revision!==Number(check[2]))return null;
   return ui('<b>⚠️ تأكيد إغلاق جلسة الأسئلة</b>\n'+
    'سيُغلق استقبال الأسئلة في 09:07 ويُحذف نصها من الحالة النشطة. لا تراجع عن الإغلاق.\n'+
    'المتحدث: '+esc(row.profile.displayName)+'\n'+
    'لن يرسل البوت أي إجابات أو إشعارات جماعية.',
    [[btn('🔒 تأكيد الإغلاق','xa:1:c:'+row.session.id+':'+row.session.revision)],
     [btn('↩️ إلغاء','xa:1:s:'+row.session.id)]]);
  }
  const closed=/^xa:1:c:([a-f0-9]{24}):([123])$/u.exec(input);
  if(closed){
   if(!await service.closeSession(actor,closed[1]!,Number(closed[2])))return null;
   return sessionDetail(service,actor,closed[1]!);
  }
  const approved=/^xa:1:a:([a-f0-9]{24}):([123])$/u.exec(input);
  if(approved){
   if(!await service.approveSummary(actor,approved[1]!,Number(approved[2])))return null;
   return sessionDetail(service,actor,approved[1]!);
  }
  return null;
 }catch{return null;}
}
