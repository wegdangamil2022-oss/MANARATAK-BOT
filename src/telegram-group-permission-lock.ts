import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import {GroupPermissionLockService,groupPermissionEpoch} from './group-permission-lock.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissionJob,type GroupLockMode} from './group-permission-model.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';
type Screen={text:string;keyboard:TelegramInlineKeyboard;access:AdminUIAccess;status:'APPLIED'|'DENIED'|'UNKNOWN';reason:string};
const GROUP='(-[1-9][0-9]{0,15}):([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,2})';
const detail=new RegExp('^lk:1:[gt]:'+GROUP+'$','u'),action=new RegExp('^lk:1:([lu]):'+GROUP+':([mvlpidsaonq])$','u');
export const validGroupPermissionRoute=(data:string)=>/^lk:1:(?:h|p:(?:0|[1-9][0-9]{0,2})|[cx]:[A-Za-z0-9_-]{24})$/u.exec(data)?.[0]===data||detail.exec(data)?.[0]===data||action.exec(data)?.[0]===data;
const labels:Record<typeof GROUP_PERMISSION_KEYS[number],string>={can_send_messages:'الرسائل النصية وجهات الاتصال والمواقع',can_send_audios:'الصوتيات',can_send_documents:'الملفات',can_send_photos:'الصور',can_send_videos:'الفيديو',can_send_video_notes:'الدوائر المرئية',can_send_voice_notes:'الرسائل الصوتية',can_send_polls:'الاستطلاعات',can_send_other_messages:'الملصقات والحركة والألعاب',can_add_web_page_previews:'معاينات الروابط',can_react_to_messages:'التفاعلات',can_edit_tag:'تعديل الوسم',can_change_info:'معلومات المجموعة',can_invite_users:'دعوة الأعضاء',can_pin_messages:'التثبيت',can_manage_topics:'إنشاء المواضيع'};
const modes:Record<string,GroupLockMode>={m:'MESSAGES',v:'MEDIA',l:'LINKS',p:'PHOTOS',i:'VIDEOS',d:'DOCUMENTS',s:'OTHER',a:'AUDIOS',o:'VOICE',n:'VIDEO_NOTES',q:'POLLS'};
const b=(text:string,callback_data:string)=>({text,callback_data});
function groups(s:BotState,p:Policy,actor:string,now:number):Chat[]{return s.chats.filter(c=>s.chats.filter(x=>x.id===c.id).length===1&&groupPermissionEpoch(s,p,actor,c.id,now)!==null).sort((a,b)=>a.id.localeCompare(b.id));}
const groupKey=(c:Chat,page:number)=>'lk:1:g:'+c.id+':'+c.version+':'+page;
export class TelegramGroupPermissionLock{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly service:GroupPermissionLockService|undefined,private readonly clock:()=>number){}
 private build(s:BotState,actor:string,text:string,rows:{text:string;callback_data:string}[][],status:Screen['status']='APPLIED',reason='GROUP_PERMISSIONS_VIEW'):Screen|null{
  const now=this.clock(),proof=protectionUIEpoch(s,this.policy,actor,now);return proof?{text,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:proof,expiresAt:now+120000},status,reason}:null;
 }
 private async previewScreen(actor:string,job:GroupPermissionJob,page:number):Promise<Screen|null>{return this.store.transaction(s=>{
  const j=s.groupPermissionJobs?.find(j=>j.id===job.id),now=this.clock();if(!j||j.actorId!==actor||j.status!=='PREVIEW'||now<j.createdAt||now>=j.expiresAt||groupPermissionEpoch(s,this.policy,actor,j.chatId,now,j.id)!==j.sourceEpoch)return null;
  const changed=GROUP_PERMISSION_KEYS.filter(k=>j.before[k]!==j.after[k]);const text='<b>معاينة '+(j.kind==='RESTORE'?'استعادة أذونات المجموعة':'قفل أذونات المجموعة')+'</b>\nالمجموعة: <code>'+j.chatId+'</code>\n'+changed.map(k=>labels[k]+': من '+(j.before[k]?'مسموح':'ممنوع')+' إلى '+(j.after[k]?'مسموح':'ممنوع')).join('\n')+'\nلم يُنفذ التغيير. التأكيد صالح لدقيقتين، والاستعادة تُرفض إذا تغيرت الأذونات منذ القفل. قفل معاينات الروابط لا يمنع نصوص الروابط.';
  return this.build(s,actor,text,[[b('✅ تأكيد', 'lk:1:c:'+j.id),b('↩️ إلغاء','lk:1:x:'+j.id)],[b('↩️ المجموعة','lk:1:g:'+j.chatId+':'+j.scopeVersion+':'+page)]]);
 });}
 async command(actor:string,chat:string,kind:'LOCK'|'RESTORE',mode:GroupLockMode='MESSAGES'):Promise<Screen|null>{
  if(!this.service)return null;const s=await this.store.snapshot(),all=groups(s,this.policy,actor,this.clock()),index=all.findIndex(c=>c.id===chat);if(index<0)return null;const job=await this.service.preview(actor,chat,kind,mode);return job?this.previewScreen(actor,job,Math.floor(index/8)):null;
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(data!=='mi:1:i:02:04'&&!validGroupPermissionRoute(data))return null;
  if(/^lk:1:[cx]:/u.test(data)){
   if(!this.service)return null;const id=data.slice(7),outcome=data[5]==='x'?await this.service.cancel(actor,id)?'CANCELLED':'DENIED':await this.service.confirm(actor,id);
   return this.store.transaction(s=>this.build(s,actor,outcome==='CONFIRMED'?'أُكد تغيير الأذونات وقراءتها من البوابة.':outcome==='CANCELLED'?'أُلغي التغيير قبل الإرسال.':outcome==='UNKNOWN_OUTCOME'?'نتيجة التغيير غير مؤكدة؛ لن تُعاد المحاولة تلقائيًا.':'لم يُعتمد تغيير الأذونات؛ راجع الصلاحيات والحالة الحالية.',[[b('↩️ المجموعات','lk:1:h'),b('🏠 الرئيسية','pn:1:h')]],outcome==='UNKNOWN_OUTCOME'?'UNKNOWN':outcome==='DENIED'||outcome==='FAILED_CONFIRMED'?'DENIED':'APPLIED','GROUP_PERMISSIONS_'+outcome));
  }
  if(this.service)await this.service.cancelForActor(actor);
  const s=await this.store.snapshot(),now=this.clock(),all=groups(s,this.policy,actor,now),d=detail.exec(data),a=action.exec(data);
  if(d||a){const m=(d??a)!,offset=a?1:0,chat=m[1+offset]!,version=Number(m[2+offset]),page=Number(m[3+offset]),c=all.slice(page*8,page*8+8).find(c=>c.id===chat&&c.version===version);if(!c)return null;
   if(a)return this.command(actor,chat,a[1]==='u'?'RESTORE':'LOCK',modes[a[5]!]!);
   if(data.startsWith('lk:1:t:'))return this.build(s,actor,'<b>قفل نوع محدد</b>\nالمجموعة: <code>'+chat+'</code>\nاختر النوع ثم راجع الأذونات قبل التأكيد. تبقى بقية الأذونات كما هي. Telegram يجمع الملصقات وGIF والألعاب في إذن واحد؛ لا فصل بينها من هذا القفل.',
    [...(['p','i','d','s','a','o','n','q'] as const).map(code=>[b('🔒 '+labels[({p:'can_send_photos',i:'can_send_videos',d:'can_send_documents',s:'can_send_other_messages',a:'can_send_audios',o:'can_send_voice_notes',n:'can_send_video_notes',q:'can_send_polls'} as const)[code]],'lk:1:l:'+chat+':'+version+':'+page+':'+code)]),[b('↩️ قفل وفتح المجموعة',groupKey(c,page))]]);
   const stem=':'+chat+':'+version+':'+page+':';return this.build(s,actor,'<b>قفل وفتح المجموعة</b>\nالمجموعة: <code>'+chat+'</code>\nكل تغيير يبدأ بقراءة الأذونات الحالية ومعاينة وتأكيد. الفتح يستعيد لقطة قفل موثقة فقط؛ لا يفتح جميع الصلاحيات.',[[b('🧩 قفل نوع محدد','lk:1:t:'+chat+':'+version+':'+page)],[b('🔒 قفل الإرسال','lk:1:l'+stem+'m')],[b('🎞️ قفل الوسائط','lk:1:l'+stem+'v')],[b('🔗 قفل معاينات الروابط','lk:1:l'+stem+'l')],[b('🔓 استعادة ما قبل القفل','lk:1:u'+stem+'m')],[b('↩️ المجموعات','lk:1:p:'+page)]]);
  }
  const page=data.startsWith('lk:1:p:')?Number(data.slice(7)):0,pages=Math.max(1,Math.ceil(all.length/8));if(page>=pages)return null;
  const rows=all.slice(page*8,page*8+8).map(c=>[b('👥 '+c.id,groupKey(c,page))]);const nav=[];if(page>0)nav.push(b('⬅️ السابق','lk:1:p:'+(page-1)));if(page+1<pages)nav.push(b('➡️ التالي','lk:1:p:'+(page+1)));if(nav.length)rows.push(nav);rows.push([this.policy.isOwner(actor)?b('↩️ قسم الحماية','mi:1:s:02:0'):b('🏠 الرئيسية','pn:1:h')]);
  return this.build(s,actor,'<b>قفل وفتح المجموعات</b>\nالصفحة '+(page+1)+' من '+pages+'\n'+(!this.service?'منفذ تغيير الأذونات غير موصول في هذا التشغيل.':all.length?'اختر مجموعة مخولة.':'لا توجد مجموعات مخولة.'),rows);
 }
}
