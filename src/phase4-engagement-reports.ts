import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';

/** 09:15 — read-only owner report from committed local evidence only.
 * No Telegram views, actual attendance, unique persons or message delivery
 * can be inferred from these bounded local rows.
 */
export const REPORT_WINDOWS={DAY:86_400_000,WEEK:7*86_400_000,
 MONTH:30*86_400_000} as const;
export type EngagementWindow=keyof typeof REPORT_WINDOWS;
export type EngagementMetricKey=
 'welcomeReservations'|'farewellReservations'|'automaticReplyReservations'|
 'guidePostsConfirmed'|'fixedPostsConfirmed'|'fixedPinsConfirmed'|
 'whisperAnnouncementsConfirmed'|'whisperPrivateSendsConfirmed'|
 'discussionQuestions'|'questionsReviewed'|'pollsOpened'|'pollBallotsActive'|
 'eventsOpened'|'eventRegistrationsActive'|'expertSessionsOpened'|
 'expertVotesActive'|'studyCirclesOpened'|'studyMembersActive'|
 'badgesAwarded'|'reactionTargetsOpened'|'postLikesActive'|
 'lectureStarts'|'lectureAutoRepliesSuppressed';
export type EngagementEvidence='LOCAL_RESERVATION'|'LOCAL_RECORD'|'OPTIONAL_LOG';
export interface EngagementMetric{
 key:EngagementMetricKey;
 label:string;
 count:number;
 evidence:EngagementEvidence;
 /** Deliberately does not name student, time slice within the window or item. */
 caveat:string;
 /** Disclosure guard: counts 1..4 never appear individually in owner's UI. */
 privacyFloor:0|5;
}
export interface EngagementReport{
 chatId:string;chatVersion:number;window:EngagementWindow;
 from:number;to:number;metrics:EngagementMetric[];notes:string[];
}
export interface EngagementReportGroup{chatId:string;chatVersion:number}
const groupId=(s:string)=>/^-[1-9][0-9]{0,15}$/u.test(s)&&
 Number.isSafeInteger(Number(s));
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-40*86_400_000;
const approved=(s:BotState,p:Policy,actor:string,id:string,now:number):number|null=>{
 const matches=s.chats.filter(x=>x.id===id),g=matches[0];
 return matches.length===1&&g?.approved&&g.version>=1&&
  g.scopes.includes('navigation')&&p.canUseChat(s,id,'navigation')&&
  p.isOwner(actor)&&p.privateFeature(s,'owner.dashboard',actor)&&
  p.has(s,actor,'chat.manage',id,now)?g.version:null;
};
/** A zero means zero RETAINED rows in the queried window. Retention and
 * optional collection may make this an underestimate; never label as zero
 * engagement, zero real participants or a Telegram delivery failure.
 */
export class Phase4EngagementReportsService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 async groups(actor:string):Promise<EngagementReportGroup[]>{
  const s=await this.store.snapshot(),now=this.clock();
  if(!time(now)||!this.policy.isOwner(actor)||
   !this.policy.privateFeature(s,'owner.dashboard',actor))throw Error('REPORT_DENIED');
  return s.chats.filter(x=>groupId(x.id)&&
   approved(s,this.policy,actor,x.id,now)===x.version)
   .map(x=>({chatId:x.id,chatVersion:x.version}))
   .sort((a,b)=>a.chatId.localeCompare(b.chatId)).slice(0,100);
 }
 async report(actor:string,chatId:string,window:EngagementWindow):
 Promise<EngagementReport|null>{
  const now=this.clock();
  if(!time(now)||!groupId(chatId)||!Object.hasOwn(REPORT_WINDOWS,window))
   return null;
  // Single consistent and validated snapshot: never mix counts from
  // successive independently fetched versions of the owner's group.
  const s=await this.store.snapshot();
  const epoch=approved(s,this.policy,actor,chatId,now);
  if(epoch===null)return null;
  const from=now-REPORT_WINDOWS[window];
  if(!time(from))return null;
  const within=(x:number|undefined):boolean=>
   typeof x==='number'&&Number.isSafeInteger(x)&&x>=from&&x<=now;
  const local=(group:string,version:number)=>group===chatId&&version===epoch;
  const metrics:EngagementMetric[]=[];
  const add=(key:EngagementMetricKey,label:string,count:number,
   evidence:EngagementEvidence,caveat:string,privacyFloor:0|5=5)=>{
    metrics.push({key,label,count,evidence,caveat,privacyFloor});
  };
  // Receipt = proposal RESERVED locally, not an acknowledged Telegram send.
  // Community receipts do not carry the approval epoch: they may span group
  // reapprovals. This limitation is exposed prominently in the report.
  const receipts=(s.phase4Community?.receipts??[]).filter(x=>
   x.chatId===chatId&&within(x.at));
  add('welcomeReservations','حجوزات رسائل الترحيب',
   receipts.filter(x=>x.kind==='JOIN').length,'LOCAL_RESERVATION',
   'نية إرسال محلية، وليست إثبات وصول الرسالة إلى Telegram');
  add('farewellReservations','حجوزات رسائل الوداع',
   receipts.filter(x=>x.kind==='LEAVE').length,'LOCAL_RESERVATION',
   'نية إرسال محلية وليست عدد عمليات مغادرة مؤكدة');
  add('automaticReplyReservations','حجوزات الردود التلقائية',
   receipts.filter(x=>x.kind==='TEXT').length,'LOCAL_RESERVATION',
   'حجز رد بعد مطابقة قاعدة؛ قد يفشل الإرسال أو تُمنع الرسالة');
  // Verified publications; request creation time, not Telegram viewing time.
  const community=s.phase4Community;
  const guideJobs=(community?.guidePostJobs??[]).filter(x=>
   local(x.chatId,x.chatVersion)&&within(x.approvedAt));
  add('guidePostsConfirmed','منشورات دليل العضو المؤكدة',
   guideJobs.filter(x=>x.status==='CONFIRMED').length,'LOCAL_RECORD',
   'إقرار Telegram لنشر الدليل، وليس مشاهدة الطالب',0);
  const fixedJobs=(community?.fixedPostJobs??[]).filter(x=>
   local(x.chatId,x.chatVersion)&&within(x.approvedAt));
  add('fixedPostsConfirmed','منشورات القوانين الثابتة المؤكدة',
   fixedJobs.filter(x=>x.status==='CONFIRMED').length,'LOCAL_RECORD',
   'إقرار Telegram لنشر رسالة ثابتة، وليس عدد القراء',0);
  add('fixedPinsConfirmed','تثبيتات المنشورات المؤكدة',
   fixedJobs.filter(x=>x.status==='CONFIRMED'&&x.pinStatus==='CONFIRMED').length,
   'LOCAL_RECORD','تثبيت أقره Telegram ولا يثبت بقاء التثبيت الآن',0);
  // No student identity, whisper content, recipient or secret is exposed.
  const announcements=(s.phase4Whispers?.announcements??[]).filter(x=>
   local(x.chatId,x.chatVersion)&&within(x.createdAt));
  add('whisperAnnouncementsConfirmed','إعلانات الهمسات العامة المؤكدة',
   announcements.filter(x=>x.status==='CONFIRMED').length,'LOCAL_RECORD',
   'إعلان أقره Telegram، وليس فتحًا أو قراءةً للهمسة',0);
  const whisperIds=new Set((s.phase4Whispers?.messages??[]).filter(x=>
   local(x.chatId,x.chatVersion)).map(x=>x.id));
  add('whisperPrivateSendsConfirmed','تأكيدات إرسال الهمسات في الخاص',
   (s.phase4Whispers?.deliveries??[]).filter(x=>
    whisperIds.has(x.messageId)&&within(x.confirmedAt)).length,
   'LOCAL_RECORD','إقرارات Telegram للمحتوى أو الإجابة، لا تثبت قراءتها وقد تنقص بعد تنظيف الرسائل المرجعية');
  const discussions=(s.phase4Discussions?.sessions??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const discussionIds=new Set(discussions.map(x=>x.id));
  const questions=(s.phase4Discussions?.questions??[]).filter(x=>
   discussionIds.has(x.sessionId));
  add('discussionQuestions','أسئلة النقاشات المسجلة',
   questions.filter(x=>within(x.createdAt)).length,'LOCAL_RECORD',
   'الأسئلة التي ما زالت محفوظة، بما فيها المعلقة وغير المعتمدة');
  add('questionsReviewed','الأسئلة التي جرت مراجعتها',
   questions.filter(x=>within(x.reviewedAt)&&
    ['APPROVED','REJECTED','ANSWERED'].includes(x.status)).length,'LOCAL_RECORD',
   'مراجعة بشرية محفوظة؛ إغلاق السؤال آليًا وأرشفته ليسا مراجعة بشرية ولا يعنيان نشره');
  const polls=(s.phase4Polls?.polls??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const pollIds=new Set(polls.map(x=>x.id));
  add('pollsOpened','الاستطلاعات التي فُتحت',
   polls.filter(x=>within(x.openedAt)).length,'LOCAL_RECORD',
   'فتح محلي للاستطلاع، وليس استطلاع Telegram المنشور');
  add('pollBallotsActive','أصوات الاستطلاعات النشطة',
   (s.phase4Polls?.ballots??[]).filter(x=>
    pollIds.has(x.pollId)&&x.status==='CAST'&&within(x.createdAt)).length,
   'LOCAL_RECORD','الأصوات غير المسحوبة المحتفظ بها فقط؛ لا تضم تصويت المسابقات');
  const events=(s.phase4Events?.events??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const eventIds=new Set(events.map(x=>x.id));
  add('eventsOpened','الفعاليات المفتوحة للتسجيل',
   events.filter(x=>within(x.openedAt)).length,'LOCAL_RECORD',
   'فتح باب التسجيل محليًا، وليس حدثًا حضره الطلاب فعليًا',0);
  add('eventRegistrationsActive','تسجيلات الفعاليات القائمة',
   (s.phase4Events?.registrations??[]).filter(x=>
    eventIds.has(x.eventId)&&x.status==='REGISTERED'&&within(x.createdAt)).length,
   'LOCAL_RECORD','التسجيلات التي لم تُسحب؛ لا تثبت الحضور أو سماع المحاضرة');
  const experts=(s.phase4Experts?.sessions??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const expertIds=new Set(experts.map(x=>x.id));
  add('expertSessionsOpened','جلسات الخبير المفتوحة',
   experts.filter(x=>within(x.openedAt)).length,'LOCAL_RECORD',
   'حالة فتح جلسة الأسئلة محليًا، لا إثبات حضور الخبير',0);
  add('expertVotesActive','تأييدات أسئلة الخبير',
   (s.phase4Experts?.votes??[]).filter(x=>
    expertIds.has(x.sessionId)&&x.status==='CAST'&&within(x.createdAt)).length,
   'LOCAL_RECORD','أصوات الأسئلة المعتمدة غير المسحوبة؛ ليست أصوات استطلاع أو مسابقة');
  const circles=(s.phase4StudyPeers?.circles??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const circleIds=new Set(circles.map(x=>x.id));
  add('studyCirclesOpened','دوائر المذاكرة التي فُتحت',
   circles.filter(x=>within(x.openedAt)).length,'LOCAL_RECORD',
   'فتح دائرة جماعية، لا إنشاء مطابقة فردية أو لقاء حضره الطلاب',0);
  add('studyMembersActive','المشاركات النشطة بدوائر الدراسة',
   (s.phase4StudyPeers?.members??[]).filter(x=>
    circleIds.has(x.circleId)&&x.status==='JOINED'&&within(x.createdAt)).length,
   'LOCAL_RECORD','تسجيلات الانضمام غير المسحوبة؛ لا تعني حضور جلسة فعلية');
  add('badgesAwarded','شارات التقدير المعتمدة',
   (s.phase4Badges?.awards??[]).filter(x=>
    local(x.chatId,x.chatVersion)&&x.status==='AWARDED'&&within(x.awardedAt)).length,
   'LOCAL_RECORD','شارات اختيارية لا تعطي رتبة أو شهادة أو أفضلية منحة');
  const reactionTargets=(s.phase4Reactions?.targets??[]).filter(x=>
   local(x.chatId,x.chatVersion));
  const reactionIds=new Set(reactionTargets.map(x=>x.id));
  add('reactionTargetsOpened','منشورات التفاعل المفتوحة',
   reactionTargets.filter(x=>within(x.openedAt)).length,'LOCAL_RECORD',
   'منشورات أدخلها المالك يدويًا، لا إثبات مصدر رسالة Telegram',0);
  add('postLikesActive','إعجابات المنشورات النشطة',
   (s.phase4Reactions?.reactions??[]).filter(x=>
    reactionIds.has(x.targetId)&&x.status==='ACTIVE'&&within(x.createdAt)).length,
   'LOCAL_RECORD','إشارات إعجاب محلية غير مسحوبة، وليست Telegram Reaction أصليًا');
  add('lectureStarts','فترات وضع المحاضرة التي بدأت',
   (s.phase4Lectures?.sessions??[]).filter(x=>
    local(x.chatId,x.chatVersion)&&within(x.startedAt)).length,
   'LOCAL_RECORD','تفعيل وضع تقليل الأتمتة، لا إثبات حضور أي شخص',0);
  const decisionLog=s.phase4Community?.decisionLog??[];
  add('lectureAutoRepliesSuppressed','قرارات إسكات أتمتة المحاضرة',
   decisionLog.filter(x=>x.chatId===chatId&&x.reason==='LECTURE_MODE'&&within(x.at)).length,
   'OPTIONAL_LOG','يُجمع فقط إن فُعّل سجل القرارات وبقيت سجلاته محفوظة');
  return {chatId,chatVersion:epoch,window,from,to:now,metrics,
   notes:[
    'تقرير محلي عند الطلب من حالة التخزين المعتمدة؛ الأرقام ليست مشاهدات أو وصولًا أو حضورًا أو عدد أشخاص فريدين في Telegram.',
    'الترحيب والوداع والردود تُحصى كحجوزات إرسال محلية لا كتسليمات مؤكدة. إيصالاتها لا تحمل إصدار اعتماد المجموعة وقد تشمل فترات اعتماد سابقة.',
    'منشورات الدليل والقوانين وإعلانات الهمسات المؤكدة تملك إقرار Telegram لا مشاهدة الطالب؛ يحتسب التقرير تاريخ طلب النشر.',
    'إرسال الهمسات في الخاص لا يثبت قراءتها، ولا تُدرج هويات أو نصوص أو روابط كشف ضمن التقرير.',
    'سجل قرارات الإسكات اختياري. غيابه أو ظهور صفر في أي بند يعني عدم وجود سجلات محفوظة ضمن النافذة، لا عدم وقوع نشاط.',
    'السجلات تخضع لتنظيف الخصوصية وإلغاء التسجيل وسحب التأييد والحد الأقصى للتخزين. الفترات الطويلة قد تكون ناقصة ولا تصلح للمقارنة الدقيقة.',
    'تُحجب النتائج الفردية الصغيرة (1–4) في عرض لوحة المالك حيث قد تكشف مشاركة في مجموعة صغيرة. لا تظهر أسماء أو أرقام الأعضاء أو تفاصيل أسئلتهم.',
    'البيانات محصورة في مجموعة معتمدة وبنسختها الحالية، باستثناء إيصالات الأتمتة القديمة التي لا تحمل رقم إصدار المجموعة.'
   ]};
 }
}
