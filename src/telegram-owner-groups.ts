import type {BotStore,BotState,Chat,SubscriptionRequirement} from './store.js';
import type {Policy} from './policy.js';
import type {VerifiedAdminContext} from './education-admin.js';
import {menuLabels,type TelegramReplyKeyboard} from './telegram-menu.js';

export const groupMenuLabel='👥 المجموعات المعتمدة';
type GroupScope='navigation'|'assistant'|'moderation'|'verification'|'publishing';
const groupScopes:readonly GroupScope[]=['navigation','assistant','moderation','verification','publishing'];
type Action={kind:'details'|'subscriptionDetails'|'subscriptionReview'|'subscriptionConfirm'|
 'revokeReview'|'revokeConfirm'|'scopeReview'|'scopeConfirm'|'aiReview'|'aiConfirm';
 chatId:string;version?:number;scope?:GroupScope;requirementVersion?:number};
const id='(-[1-9][0-9]{0,18})';
const ver='([1-9][0-9]{0,9})';
const scope='(navigation|assistant|moderation|verification|publishing)';
const detailRe=new RegExp('^🏷️ محادثة · '+id+'$','u');
const subDetailRe=new RegExp('^📋 تفاصيل الاشتراك · '+id+'$','u');
const subReviewRe=new RegExp('^🧊 مراجعة تعليق الاشتراك · '+id+':'+ver+':'+ver+'$','u');
const subConfirmRe=new RegExp('^✅ تأكيد تعليق الاشتراك · '+id+':'+ver+':'+ver+'$','u');
const revPreviewRe=new RegExp('^🚫 مراجعة الإلغاء · '+id+':'+ver+'$','u');
const revConfirmRe=new RegExp('^⛔ تأكيد الإلغاء · '+id+':'+ver+'$','u');
const aiPreviewRe=new RegExp('^🛑 مراجعة إيقاف AI · '+id+':'+ver+'$','u');
const aiConfirmRe=new RegExp('^🔒 تأكيد إيقاف AI · '+id+':'+ver+'$','u');
const scopePreviewRe=new RegExp('^🔐 تقييد '+scope+' · '+id+':'+ver+'$','u');
const scopeConfirmRe=new RegExp('^✅ تأكيد تقييد '+scope+' · '+id+':'+ver+'$','u');
const pageRe=/^(➡️ التالي|⬅️ السابق) · o:g:(0|[1-9][0-9]{0,2})$/u;
export function parseOwnerGroupAction(value:string):Action|null{
 if(typeof value!=='string'||value.length>118)return null;
 let m=detailRe.exec(value);
 if(m)return {kind:'details',chatId:m[1]!};
 m=subDetailRe.exec(value);
 if(m)return {kind:'subscriptionDetails',chatId:m[1]!};
 for(const [regex,kind] of [[subReviewRe,'subscriptionReview'],[subConfirmRe,'subscriptionConfirm']] as const){
  m=regex.exec(value);
  if(m)return {kind,chatId:m[1]!,version:Number(m[2]!),requirementVersion:Number(m[3]!)};
 }
 for(const [re,kind] of [[revPreviewRe,'revokeReview'],[revConfirmRe,'revokeConfirm'],
  [aiPreviewRe,'aiReview'],[aiConfirmRe,'aiConfirm']] as const){
  m=re.exec(value);
  if(m)return {kind,chatId:m[1]!,version:Number(m[2]!)};
 }
 for(const [re,kind] of [[scopePreviewRe,'scopeReview'],[scopeConfirmRe,'scopeConfirm']] as const){
  m=re.exec(value);
  if(m)return {kind,chatId:m[2]!,version:Number(m[3]!),scope:m[1] as GroupScope};
 }
 return null;
}
export function isOwnerGroupText(value:string):boolean{
 return value===groupMenuLabel||value.startsWith('🏷️ محادثة · ')||
  value.startsWith('📋 تفاصيل الاشتراك · ')||value.startsWith('🧊 مراجعة تعليق الاشتراك · ')||
  value.startsWith('✅ تأكيد تعليق الاشتراك · ')||
  value.startsWith('🚫 مراجعة الإلغاء · ')||value.startsWith('⛔ تأكيد الإلغاء · ')||
  value.startsWith('🔐 تقييد ')||value.startsWith('✅ تأكيد تقييد ')||
  value.startsWith('🛑 مراجعة إيقاف AI · ')||value.startsWith('🔒 تأكيد إيقاف AI · ')||
  value.startsWith('➡️ التالي · o:g:')||value.startsWith('⬅️ السابق · o:g:');
}
export interface OwnerGroupScreen{text:string;keyboard:TelegramReplyKeyboard}
function screen(text:string,items:readonly string[]=[],navigation:readonly string[]=[]):OwnerGroupScreen{
 const rows:{text:string}[][]=[];
 for(let i=0;i<Math.min(items.length,10);i+=2)
  rows.push(items.slice(i,i+2).map(text=>({text})));
 if(navigation.length)rows.push(navigation.slice(0,2).map(text=>({text})));
 rows.push([{text:menuLabels.owner},{text:menuLabels.home}]);
 return {text,keyboard:{keyboard:rows,resize_keyboard:true,is_persistent:true}};
}
function pageLabel(page:number,direction:'next'|'previous'):string{
 if(!Number.isInteger(page)||page<0||page>999)throw Error('INVALID_GROUP_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · o:g:'+page;
}
function revisionCurrent(chat:Chat,revision:unknown):boolean{
 return chat.approved&&Number.isSafeInteger(revision)&&revision===chat.version;
}
function details(chat:Chat,subscription?:SubscriptionRequirement):OwnerGroupScreen{
 const scopes=chat.scopes.join(', ')||'بدون نطاقات';
 const body='<b>المحادثة المعتمدة 👥</b>\n'
  +'المعرّف المحلي: <code>'+chat.id+'</code>\n'
  +'التصريح المحلي: '+(chat.approved?'مفعّل':'ملغى')+'\n'
  +'الوجود المحفوظ: '+(chat.present?'موجود':'غير مؤكد')+'\n'
  +'النطاقات: '+scopes+'\n'
  +'وضع AI المحفوظ: '+chat.groupAI+'\n'
  +'إصدار السياسة: '+chat.version+'\n'
  +'الاشتراك المحفوظ: '+(subscription?.channelIds.length?
    subscription.mode+' / '+subscription.channelIds.length+' قناة':'غير مفعّل أو معلّق')+'\n'
  +'هذه معلومات من قاعدة البيانات فقط، وليست تحققًا حيًا من Telegram.';
 if(!chat.approved)return screen(body+'\nلا يمكن إعادة اعتماد محادثة عبر هذا الزر.',
  [groupMenuLabel]);
 const actions=chat.scopes.filter((s):s is GroupScope=>groupScopes.includes(s as GroupScope))
  .map(s=>'🔐 تقييد '+s+' · '+chat.id+':'+chat.version);
 if(chat.scopes.includes('verification')&&subscription?.channelIds.length){
  actions.push('📋 تفاصيل الاشتراك · '+chat.id);
  actions.push('🧊 مراجعة تعليق الاشتراك · '+chat.id+':'+chat.version+':'+subscription.version);
 }
 actions.push('🛑 مراجعة إيقاف AI · '+chat.id+':'+chat.version);
 actions.push('🚫 مراجعة الإلغاء · '+chat.id+':'+chat.version);
 actions.push(groupMenuLabel);
 return screen(body,actions);
}
export class OwnerTelegramGroupMenu{
 constructor(private readonly store:BotStore,private readonly policy:Policy){}
 async handle(value:string,ctx:VerifiedAdminContext):Promise<OwnerGroupScreen|null>{
  if(ctx.origin!=='TELEGRAM_PRIVATE'||!ctx.verified||
    ctx.chatId!==ctx.actorId||!this.policy.isOwner(ctx.actorId))return null;
  const snapshot:BotState=await this.store.snapshot();
  const page=pageRe.exec(value);
  if(value===groupMenuLabel||page){
   const all=[...snapshot.chats].sort((a,b)=>Number(b.approved)-Number(a.approved)||a.id.localeCompare(b.id));
   const position=page?Number(page[2]!):0, pages=Math.ceil(all.length/10);
   const direction=page?(page[1]==='➡️ التالي'?'next':'previous'):undefined;
   if(page&&(!pages||position>=pages||(direction==='next'&&position===0)||
    (direction==='previous'&&position>=pages-1)))return null;
   const current=all.slice(position*10,position*10+10);
   const choices=current.map(c=>'🏷️ محادثة · '+c.id);
   const navigation=[
    ...(position>0?[pageLabel(position-1,'previous')]:[]),
    ...(position+1<pages?[pageLabel(position+1,'next')]:[])
   ];
   return screen('<b>المجموعات المعتمدة 👥</b>\n'
    +'عدد المحادثات المحفوظة: '+all.length+'\n'
    +'المصرّح لها: '+all.filter(c=>c.approved).length+'\n'
    +(pages?'صفحة '+(position+1)+' من '+pages+'\n':'')
    +'اضغط على محادثة لمراجعة السياسة أو تقييدها.\n'
    +'لا تُرسل أوامر حية لإضافة البوت أو مغادرة المجموعة.',
    choices,navigation);
  }
  const action=parseOwnerGroupAction(value);
  if(!action)return null;
  const chat=snapshot.chats.find(c=>c.id===action.chatId);
  if(!chat)return null;
  const subscription=snapshot.subscriptionRequirements.find(c=>c.chatId===chat.id);
  if(action.kind==='details')return details(chat,subscription);
  if(action.kind==='subscriptionDetails'){
   if(!chat.approved || !chat.scopes.includes('verification'))return null;
   const channels=subscription?.channelIds??[];
   return screen('<b>تفاصيل الاشتراك المحفوظة 📋</b>\n'
    +'المحادثة: <code>'+chat.id+'</code>\n'
    +'الوضع: '+(channels.length?subscription!.mode:'غير مفعل')+'\n'
    +'عدد القنوات: '+channels.length+'\n'
    +(channels.length?'القنوات المحلية: '+channels.join(', ')+'\n':'')
    +'لا يوجد تحقق حي من Telegram في هذه الشاشة.\n'
    +'التعليق لا يزيل قيود كتم سابقة ولا يعيد إرسال قرارات إشراف.',
    channels.length?['🧊 مراجعة تعليق الاشتراك · '+chat.id+':'+chat.version+':'+subscription!.version,
      '🏷️ محادثة · '+chat.id]:['🏷️ محادثة · '+chat.id]);
  }
  if(!revisionCurrent(chat,action.version))return null;
  if(action.kind==='subscriptionReview'||action.kind==='subscriptionConfirm'){
   if(!chat.scopes.includes('verification')||!subscription?.channelIds.length||
      subscription.version!==action.requirementVersion)return null;
   const suffix=' · '+chat.id+':'+chat.version+':'+subscription.version;
   if(action.kind==='subscriptionReview')
    return screen('<b>مراجعة تعليق شرط الاشتراك 🧊</b>\n'
     +'سيصبح شرط الاشتراك غير مفعّل لهذه المجموعة محليًا.\n'
     +'القنوات الحالية: '+subscription.channelIds.length+' ('+subscription.mode+').\n'
     +'لا يتم فك أي عقوبات أو تقييدات قائمة تلقائيًا، ولا توجد مكالمات Telegram.',
     ['✅ تأكيد تعليق الاشتراك'+suffix,'🏷️ محادثة · '+chat.id]);
   try{await this.policy.pauseSubscriptionAtRevision(ctx.actorId,chat.id,chat.version,subscription.version);}
   catch{return null;}
   return screen('تم تعليق الاشتراك محليًا ✅\n'
    +'يتطلب استئناف الاشتراك إعدادًا جديدًا مع تحقق مستقل من كل قناة.\n'
    +'لا يتم رفع قيود الاشتراك القديمة تلقائيًا.',
    ['🏷️ محادثة · '+chat.id]);
  }
  const rev=chat.version;
  const suffix=' · '+chat.id+':'+rev;
  if(action.kind==='revokeReview')
   return screen('<b>مراجعة إلغاء التصريح 🚫</b>\n'
    +'سيُلغى التصريح المحلي للمحادثة <code>'+chat.id+'</code>.\n'
    +'سيصبح وضع AI المخزن OFF. لا توجد مغادرة Telegram حية أو حذف رسائل.\n'
    +'تأكد من المقصود قبل التأكيد.',[
     '⛔ تأكيد الإلغاء'+suffix,'🏷️ محادثة · '+chat.id]);
  if(action.kind==='revokeConfirm'){
   try{await this.policy.revokeChatAtRevision(ctx.actorId,chat.id,rev);}
   catch{return null;}
   return screen('تم إلغاء تصريح المحادثة محليًا ✅\n'
    +'لم تُرسل أي عملية إلى Telegram.',[groupMenuLabel]);
  }
  if(action.kind==='aiReview'){
   if(chat.groupAI==='OFF')return screen('وضع AI في هذه المحادثة OFF بالفعل.\n'
    +'لا يوجد إجراء لتمكين AI من لوحة المالك هذه.',[
     '🏷️ محادثة · '+chat.id]);
   return screen('<b>مراجعة إيقاف AI 🛑</b>\n'
    +'سيُحوّل وضع AI المخزن إلى OFF لهذه المحادثة فقط.\n'
    +'لا توجد مكالمات AI أو إعادة تشغيل تلقائي.',[
     '🔒 تأكيد إيقاف AI'+suffix,'🏷️ محادثة · '+chat.id]);
  }
  if(action.kind==='aiConfirm'){
   if(chat.groupAI==='OFF')return null;
   try{await this.policy.disableGroupAIAtRevision(ctx.actorId,chat.id,rev);}
   catch{return null;}
   return screen('تم إيقاف وضع AI المخزن لهذه المحادثة ✅',[
    '🏷️ محادثة · '+chat.id]);
  }
  const scope=action.scope;
  if(!scope||!chat.scopes.includes(scope))return null;
  if(action.kind==='scopeReview')
   return screen('<b>مراجعة تقييد صلاحية 🔐</b>\n'
    +'المحادثة: <code>'+chat.id+'</code>\n'
    +'إزالة نطاق: '+scope+'\n'
    +'هذا الإجراء تقييد محلي فقط، ولا يضيف أية صلاحية.\n'
    +'إذا كان النطاق assistant فسيتحول وضع AI إلى OFF.',[
     '✅ تأكيد تقييد '+scope+suffix,'🏷️ محادثة · '+chat.id]);
  if(action.kind==='scopeConfirm'){
   try{await this.policy.restrictChatScopeAtRevision(ctx.actorId,chat.id,scope,rev);}
   catch{return null;}
   return screen('تم تقييد نطاق '+scope+' محليًا ✅\n'
    +'لم تُرسل عمليات إلى Telegram.',[
     '🏷️ محادثة · '+chat.id]);
  }
  return null;
 }
}
