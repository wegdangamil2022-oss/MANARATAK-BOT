import {Phase4CommunityService,type DraftRequest} from './phase4-community.js';
import {normalizeCommunityMatch,type CommunityReplyRule,type CommunityConfig} from './phase4-community-model.js';
import {validCommunityRulesUrl} from './phase4-community-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

const G='-[1-9][0-9]{0,15}',R='[a-f0-9]{12}',P='(?:0|[1-9][0-9]?)',D='[a-f0-9]{24}';
const ROUTE=new RegExp('^r5:1:(?:h|p:'+P+'|g:'+G+'|l:'+G+':'+P+
 '|d:'+G+':'+R+'|e:'+G+':'+R+':[01]|t:'+G+':'+R+':(?:1|5|15|60|300|3600)'+
 '|[fc]:'+G+':'+R+'|[ax]:'+D+')$','u');
export const validPhase4ReplyOwnerRoute=(raw:unknown):raw is string=>
 typeof raw==='string'&&Buffer.byteLength(raw,'utf8')<=64&&ROUTE.test(raw);
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const truncated=(s:string,max=80)=>esc(Array.from(s).slice(0,max).join(''));
const label=(enabled:boolean)=>enabled?'✅ مفعّل':'⛔ متوقف';
const source=(r:CommunityReplyRule)=>r.source==='FAQ'?'📚 FAQ منشور':
 r.source==='RULES'?'📜 رابط القوانين':
 r.source==='NOTE'?'📝 ملاحظة ثابتة':'📝 نص مالك محفوظ';
const type=(r:CommunityReplyRule)=>r.match==='EXACT'?'مطابقة تامة':
 r.match==='WORD'?'كلمة كاملة':r.match==='COMMAND'?'أمر Telegram':'احتواء عبارة';
const group=(id:string)=>'r5:1:g:'+id;
const listing=(id:string,page=0)=>'r5:1:l:'+id+':'+page;
const detail=(id:string,rid:string)=>'r5:1:d:'+id+':'+rid;
const pane=(c:CommunityConfig):OwnerInlineScreen=>{
 const all=c.rules,active=all.filter(r=>r.enabled);
 const topics=all.filter(r=>r.topicId!==undefined).length;
 return ui('<b>🤖 09:05 — الردود التلقائية</b>\n'+
  'المجموعة: <code>'+c.chatId+'</code>\n'+
  'الردود: '+label(c.repliesEnabled)+' · الإصدار '+c.version+
  '\nالقواعد: '+all.length+' / 30 · المفعلة: '+active.length+
  '\nالقواعد المخصصة لموضوع Forum: '+topics+
  '\nساعات الهدوء: '+(c.quietHours?'محددة':'غير محددة')+
  '\nفاصل المجموعة: '+c.groupCooldownMs/1000+' ثانية'+
  '\nسقف الردود الآلية: '+(c.autoMessagesPerMinute??8)+' في أي 60 ثانية'+
  '\nحدود موضوعات Forum: '+(c.topicCooldowns?.length??0)+
  '\nسجل قرارات التفعيل: '+label(c.decisionLogEnabled===true)+
  '\nحذف ردود البوت المؤقتة: '+label(c.replyCleanup?.enabled===true)+
  '\n\nالقواعد المخصصة للموضوع تقدم على القواعد العامة، ثم الأدق في المطابقة.'+
  '\n\nلإضافة رد: <code>/replynote '+c.chatId+' WORD منحة | راجع دليل المنح</code>'+
  '\nللتحقق دون إرسال: <code>/replycheck '+c.chatId+' نص تجريبي</code>',
  [[btn('📋 عرض قواعد المجموعة',listing(c.chatId))],
   [btn((c.repliesEnabled?'⛔ إيقاف':'✅ تشغيل')+' الردود',
    'p4c:1:t:'+c.chatId+':r:'+(c.repliesEnabled?'0':'1'))],
   [btn('🌙 ساعات الهدوء','p4c:1:q:'+c.chatId),
    btn('🧵 حدود الموضوعات','p4c:1:y:'+c.chatId)],
   [btn('🚦 معدل الرسائل الآلية','p4c:1:i:'+c.chatId),
    btn('🧾 سجل القرارات','p4c:1:k:'+c.chatId)],
   [btn('🧼 حذف ردود البوت','p4c:1:rl:'+c.chatId),
    btn('📜 القوانين وFAQ','gd:1:3:g:'+c.chatId)],
   [btn('↩️ المجموعات','r5:1:p:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
};
const details=(c:CommunityConfig,r:CommunityReplyRule):OwnerInlineScreen=>{
 const urlStatus=r.source==='RULES'?
   '\nرابط القوانين: '+(validCommunityRulesUrl(c.rulesUrl)?'محدد':'غير معتمد'):
   r.source==='FAQ'?'\nمرجع FAQ: '+esc(r.sourceFaqId??''):'';
 const preview=r.source==='NOTE'||r.source===undefined?
  '\nمعاينة النص الثابت:\n'+truncated(r.response,420):'';
 const actionRows:{text:string;callback_data:string}[][]=[
  [btn(r.enabled?'⏸️ معاينة إيقاف':'▶️ معاينة تفعيل',
    'r5:1:e:'+c.chatId+':'+r.id+':'+(r.enabled?'0':'1'))],
  [btn('⏱️ 5 ثوان','r5:1:t:'+c.chatId+':'+r.id+':5'),
   btn('⏱️ 15 ثانية','r5:1:t:'+c.chatId+':'+r.id+':15'),
   btn('⏱️ دقيقة','r5:1:t:'+c.chatId+':'+r.id+':60')],
  [btn('⏱️ 5 دقائق','r5:1:t:'+c.chatId+':'+r.id+':300'),
   btn('⏱️ ساعة','r5:1:t:'+c.chatId+':'+r.id+':3600')],
  [btn('📷 '+(r.photoFileId?'إزالة صورة الرد':'إضافة صورة من الخاص'),
    r.photoFileId?'r5:1:f:'+c.chatId+':'+r.id:detail(c.chatId,r.id))],
  [btn('🔗 '+(r.buttons?.length?'إزالة كل أزرار الروابط':'كيفية إضافة روابط'),
    (r.buttons?.length?'r5:1:c:': 'r5:1:d:')+c.chatId+':'+r.id)],
  [btn('↩️ قائمة الردود',listing(c.chatId))]
 ];
 return ui('<b>🤖 إعدادات قاعدة رد — 09:05</b>\n'+
  'المجموعة: <code>'+c.chatId+'</code>\n'+
  'معرف القاعدة: <code>'+r.id+'</code>\n'+
  'الكلمة/الأمر: '+truncated(r.trigger,80)+
  '\nالمطابقة: '+type(r)+'\nالمصدر: '+source(r)+
  '\nالحالة: '+label(r.enabled)+
  '\nالنطاق: '+(r.topicId===undefined?'المجموعة وجميع الموضوعات':
   'موضوع Forum رقم '+r.topicId)+
  '\nمهلة نفس العضو: '+r.cooldownMs/1000+' ثانية'+
  '\nصورة Telegram: '+(r.photoFileId?'معتمدة':'غير مضافة')+
  '\nأزرار HTTPS: '+(r.buttons?.length??0)+' من 3'+urlStatus+preview+
  '\n\nلإرفاق صورة، أرسل صورة في الخاص مع التعليق:\n'+
  '<code>/replyphoto '+c.chatId+' '+r.id+'</code>'+
  '\nولإضافة زر رابط:\n<code>/replybutton '+c.chatId+' '+r.id+
  ' دليل | https://t.me/StudyinEurope3</code>'+
  '\nلا تنفذ المعاينة التعديل قبل اعتماد مستقل.',
  actionRows);
};
export async function phase4ReplyOwnerScreen(s:Phase4CommunityService,actor:string,
 input:string):Promise<OwnerInlineScreen|null>{
 try{
  if(input==='mi:1:i:09:05'||input==='/replyadmin'||input==='r5:1:h')input='r5:1:p:0';
  const direct=/^\/replyadmin (-[1-9][0-9]{0,15})$/u.exec(input);
  if(direct)input=group(direct[1]!);
  if(!validPhase4ReplyOwnerRoute(input))return null;
  const groups=/^r5:1:p:(0|[1-9][0-9]?)$/u.exec(input);
  if(groups){
   const records=await s.listGroups(actor),page=Number(groups[1]);
   const pages=Math.max(1,Math.ceil(records.length/6));
   if(page>=pages)return null;
   const rows=records.slice(page*6,page*6+6).map(x=>
    [btn('👥 المجموعة '+x.chatId,group(x.chatId))]);
   const pageNav:{text:string;callback_data:string}[]=[];
   if(page>0)pageNav.push(btn('⬅️ السابق','r5:1:p:'+(page-1)));
   if(page+1<pages)pageNav.push(btn('التالي ➡️','r5:1:p:'+(page+1)));
   if(pageNav.length)rows.push(pageNav);
   rows.push([btn('↩️ التفاعل والترحيب','mi:1:s:09:0'),
    btn('🏠 لوحة المالك','mi:1:h')]);
   return ui('<b>🤖 الردود التلقائية — 09:05</b>\n'+
    'المجموعات المعتمدة: '+records.length+' · صفحة '+(page+1)+'/'+pages+
    '\n\nتدير كل مجموعة قوالبها ومطابقاتها وحصصها مستقلة. اختر المجموعة.',
    rows);
  }
  const home=/^r5:1:g:(-[1-9][0-9]{0,15})$/u.exec(input);
  if(home)return pane(await s.view(actor,home[1]!));
  const list=/^r5:1:l:(-[1-9][0-9]{0,15}):(0|[1-9][0-9]?)$/u.exec(input);
  if(list){
   const c=await s.view(actor,list[1]!),page=Number(list[2]);
   const pages=Math.max(1,Math.ceil(c.rules.length/5));
   if(page>=pages)return null;
   const current=c.rules.slice(page*5,page*5+5);
   const rows=current.map(r=>[btn((r.enabled?'✅ ':'⛔ ')+
    r.trigger.slice(0,42),detail(c.chatId,r.id))]);
   const controls:{text:string;callback_data:string}[]=[];
   if(page>0)controls.push(btn('⬅️ السابق',listing(c.chatId,page-1)));
   if(page+1<pages)controls.push(btn('التالي ➡️',listing(c.chatId,page+1)));
   if(controls.length)rows.push(controls);
   rows.push([btn('↩️ إعدادات الردود',group(c.chatId))]);
   return ui('<b>📋 قواعد الردود التلقائية</b>\n'+
    'المجموعة: <code>'+c.chatId+'</code> · صفحة '+(page+1)+'/'+pages+
    '\nالقواعد: '+c.rules.length+' من 30\n\n'+
    (current.length?current.map((r,i)=>
      (page*5+i+1)+'. '+truncated(r.trigger,72)+' — '+type(r)+
      ' • '+source(r)+(r.topicId?' • موضوع '+r.topicId:'')+
      (r.enabled?' ✅':' ⛔')).join('\n'):'لا توجد قواعد مضافة بعد.')+
    '\n\nافتح أي قاعدة لإدارة الصورة والروابط والفاصل وحالة التفعيل.',
    rows);
  }
  const view=/^r5:1:d:(-[1-9][0-9]{0,15}):([a-f0-9]{12})$/u.exec(input);
  if(view){
   const c=await s.view(actor,view[1]!),row=c.rules.filter(r=>r.id===view[2]);
   return row.length===1?details(c,row[0]!):null;
  }
  const simple=/^r5:1:([fc]):(-[1-9][0-9]{0,15}):([a-f0-9]{12})$/u.exec(input);
  if(simple){
   const c=await s.view(actor,simple[2]!);
   const row=c.rules.filter(r=>r.id===simple[3]);
   if(row.length!==1)return null;
   if(simple[1]==='f'&&!row[0]!.photoFileId||
     simple[1]==='c'&&!row[0]!.buttons?.length)
    return details(c,row[0]!);
   const request:DraftRequest={kind:simple[1]==='f'?
    'REPLY_PHOTO_CLEAR':'REPLY_BUTTONS_CLEAR',ruleId:simple[3]!};
   const draft=await s.pending(actor,request,c.chatId);
   return ui(s.preview(draft)+'\nلا تُحذف ملفات Telegram الأصلية أو الرسائل المنشورة سابقًا.',
    [[btn('✅ اعتماد إزالة المرفق','r5:1:a:'+draft.id)],
     [btn('❌ إلغاء','r5:1:x:'+draft.id)],
     [btn('↩️ القاعدة',detail(c.chatId,row[0]!.id))]]);
  }
  const enabled=/^r5:1:e:(-[1-9][0-9]{0,15}):([a-f0-9]{12}):([01])$/u.exec(input);
  const time=/^r5:1:t:(-[1-9][0-9]{0,15}):([a-f0-9]{12}):(1|5|15|60|300|3600)$/u.exec(input);
  if(enabled||time){
   const target=(enabled??time)!,c=await s.view(actor,target[1]!),
    row=c.rules.filter(r=>r.id===target[2]);
   if(row.length!==1)return null;
   const request:DraftRequest=enabled?{kind:enabled[3]==='1'?'REPLY_ENABLE':'REPLY_DISABLE',
    ruleId:target[2]!}:{kind:'REPLY_COOLDOWN',ruleId:target[2]!,
    cooldownMs:Number(time![3])*1000};
   const draft=await s.pending(actor,request,c.chatId);
   return ui(s.preview(draft)+'\nتأكيد خلال دقيقتين، وتُرفض المسودة إذا تغير إصدار سياسة المجموعة.',
    [[btn('✅ اعتماد التعديل','r5:1:a:'+draft.id)],
     [btn('❌ إلغاء','r5:1:x:'+draft.id)],
     [btn('↩️ القاعدة',detail(c.chatId,row[0]!.id))]]);
  }
  const approval=/^r5:1:([ax]):([a-f0-9]{24})$/u.exec(input);
  if(approval){
   if(approval[1]==='x'){
    const ok=await s.cancel(actor,approval[2]!);
    return ok?ui('ألغيت مسودة الرد؛ لم تتغير إعدادات المجموعة.',
     [[btn('↩️ مجموعات الردود','r5:1:p:0')]]):null;
   }
   const c=await s.approve(actor,approval[2]!);
   return pane(c);
  }
  return null;
 }catch{return null;}
}
