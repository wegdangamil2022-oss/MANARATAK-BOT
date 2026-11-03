import {Phase4CommunityService,type DraftRequest} from './phase4-community.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import type {CommunityDraftKind,ReplyMatch} from './phase4-community-model.js';
const group=/^-[1-9]\d{0,15}$/u,hex=/^[a-f0-9]{24}$/u;
const route=/^p4c:1:(?:l:(?:0|[1-9]\d{0,2})|g:-[1-9]\d{0,15}|r:-[1-9]\d{0,15}:(?:0|[1-9]\d{0,2})|t:-[1-9]\d{0,15}:[wfr]:[01]|d:-[1-9]\d{0,15}:[a-f0-9]{12}|e:-[1-9]\d{0,15}:[a-f0-9]{12}:[01]|[cx]:[a-f0-9]{24})$/u;
export const validPhase4CommunityRoute=(s:unknown):s is string=>typeof s==='string'&&
 Buffer.byteLength(s,'utf8')<=64&&route.test(s);
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const k=(rows:{text:string;callback_data:string}[][]):TelegramInlineKeyboard=>({inline_keyboard:rows});
const btn=(text:string,data:string)=>({text,callback_data:data});
const help='للتعديل أرسل في خاص البوت أحد الأوامر:\n'
 +'<code>/setwelcome -100123 نص الترحيب {العضو}</code>\n'
 +'<code>/setfarewell -100123 نص الوداع</code>\n'
 +'<code>/replyadd -100123 WORD منحة | راجع قسم المنح الدراسية</code>\n'
 +'<code>/replyadd -100123 topic:777 COMMAND m_grants | رابط المنح</code>\n'
 +'<code>/replycheck -100123 منحة دراسية</code>\n'
 +'<code>/replydel -100123 معرف_القاعدة</code>\n'
 +'<code>/replyrate -100123 معرف_القاعدة 90</code>\n'
 +'يظهر تأكيد مستقل لكل تعديل، وتظل الميزات مغلقة حتى تفعّلها.';
export function parsePhase4CommunityCommand(text:string):
 {kind:'HOME'}|{kind:'VIEW';chatId:string}|{kind:'EDIT';chatId:string;request:DraftRequest}|
 {kind:'DIAGNOSE';chatId:string;sample:string;topicId?:number}|null{
 if(text==='/community')return {kind:'HOME'};
 const rate=/^\/replyrate (-[1-9]\d{0,15}) ([a-f0-9]{12}) (0|[1-9]\d{0,4})$/u.exec(text);
 if(rate){
  const seconds=Number(rate[3]);
  if(seconds<1||seconds>86400)return null;
  return {kind:'EDIT',chatId:rate[1]!,
   request:{kind:'REPLY_COOLDOWN',ruleId:rate[2]!,cooldownMs:seconds*1000}};
 }
 const view=/^\/community (-[1-9]\d{0,15})$/u.exec(text);
 if(view)return {kind:'VIEW',chatId:view[1]!};
 const check=/^\/replycheck (-[1-9]\d{0,15}) (?:(?:topic:([1-9]\d{0,9})) )?([^\u0000-\u001f\u007f]{1,400})$/u.exec(text);
 if(check){
  const topic=check[2]!==undefined?Number(check[2]):undefined;
  if(topic!==undefined&&(!Number.isSafeInteger(topic)||topic>2147483647))return null;
  return {kind:'DIAGNOSE',chatId:check[1]!,sample:check[3]!,
   ...(topic!==undefined?{topicId:topic}:{})};
 }
 const match=/^\/(setwelcome|setfarewell|replyadd|replydel) (-[1-9]\d{0,15}) ([^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+)$/u.exec(text);
 if(!match)return null;
 const [,kind,chatId,rest]=match;
 if(!group.test(chatId!))return null;
 if(kind==='setwelcome'||kind==='setfarewell')
  return {kind:'EDIT',chatId:chatId!,request:{kind:kind==='setwelcome'?'WELCOME_TEXT':'FAREWELL_TEXT',text:rest!.trim()}};
 if(kind==='replydel')
  return /^[a-f0-9]{12}$/u.test(rest!.trim())?{kind:'EDIT',chatId:chatId!,request:{kind:'REPLY_REMOVE',ruleId:rest!.trim()}}:null;
 const parts=/^(?:topic:([1-9]\d{0,9}) )?(EXACT|WORD|CONTAINS|COMMAND) ([^\u000a|]{1,80}) \| ([^\u0000-\u001f]+)$/u.exec(rest!);
 if(!parts)return null;
 const topic=parts[1]!==undefined?Number(parts[1]):undefined;
 if(topic!==undefined&&(!Number.isSafeInteger(topic)||topic>2147483647))return null;
 const matchType=parts[2]! as ReplyMatch,trigger=parts[3]!.trim();
 if(matchType==='COMMAND'&&!/^m_[a-z][a-z0-9_]{0,23}$/u.test(trigger))return null;
 return {kind:'EDIT',chatId:chatId!,request:{kind:'REPLY_ADD',match:matchType,
  trigger,text:parts[4]!.trim(),...(topic!==undefined?{topicId:topic}:{})}};
}
export async function phase4CommunityScreen(service:Phase4CommunityService,actorId:string,
 input:string):Promise<OwnerInlineScreen|null>{
 const cmd=parsePhase4CommunityCommand(input);
 const data=cmd?.kind==='HOME'?'p4c:1:l:0':cmd?.kind==='VIEW'?'p4c:1:g:'+cmd.chatId:input;
 if(cmd?.kind==='DIAGNOSE'){
  const diagnostic=await service.diagnose(actorId,cmd.chatId,cmd.sample,cmd.topicId);
  const text=diagnostic.status==='MATCH'?
   '✅ توجد قاعدة مطابقة: <code>'+diagnostic.ruleId+'</code>\nنص تجريبي: '+diagnostic.preview:
   diagnostic.status==='REPLIES_DISABLED'?'الردود التلقائية متوقفة في هذه المجموعة.':
   'لا توجد قاعدة ترد على هذه الرسالة في هذا الموضوع.';
  return {text:'<b>🧪 تشخيص الردود دون إرسال</b>\n'+text+
   '\nلا تحسب هذه المعاينة حدود المعدّل أو عضوية الطلاب.',
   keyboard:k([[btn('↩️ إعدادات المجموعة','p4c:1:g:'+cmd.chatId)]])};
 }
 if(cmd?.kind==='EDIT'){
  const draft=await service.pending(actorId,cmd.request,cmd.chatId);
  return {text:service.preview(draft)+'\n\nلن يُطبّق التغيير قبل الاعتماد. صالحة لدقيقتين.',
   keyboard:k([[btn('✅ اعتماد التعديل','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ إعدادات المجموعة','p4c:1:g:'+draft.chatId)]])};
 }
 if(data==='mi:1:i:09:01'||data==='mi:1:i:09:05'||data==='mi:1:i:07:10'||data==='p4c:1:l:0'||
   /^p4c:1:l:(?:0|[1-9]\d{0,2})$/u.test(data)){
  const page=data.startsWith('p4c:1:l:')?Number(data.slice(8)):0;
  const groups=await service.listGroups(actorId);
  const pages=Math.max(1,Math.ceil(groups.length/6));
  if(!Number.isSafeInteger(page)||page>=pages)return null;
  const rows=groups.slice(page*6,page*6+6).map(x=>[btn(
   '👥 مجموعة '+x.chatId+(x.configured?' • مهيأة':' • غير مهيأة'),'p4c:1:g:'+x.chatId)]);
  const pager=[] as {text:string;callback_data:string}[];
  if(page>0)pager.push(btn('⬅️ السابق','p4c:1:l:'+(page-1)));
  if(page+1<pages)pager.push(btn('التالي ➡️','p4c:1:l:'+(page+1)));
  if(pager.length)rows.push(pager);
  rows.push([btn('↩️ قسم التفاعل','mi:1:s:09:0'),btn('🏠 لوحة المالك','mi:1:h')]);
  return {text:'<b>👋 الترحيب والردود التلقائية</b>\nالمجموعات المعتمدة: '+groups.length+
   '\nالصفحة '+(page+1)+' / '+pages+'\n\n'+help,keyboard:k(rows)};
 }
 const view=/^p4c:1:g:(-[1-9]\d{0,15})$/u.exec(data);
 if(view){
  const id=view[1]!,c=await service.view(actorId,id);
  const label=(on:boolean)=>on?'✅ مفعّل':'⛔ متوقف';
  return {text:'<b>👋 تفاعل المجموعة</b>\nالمجموعة: <code>'+id+'</code>'+
   '\nالإصدار: '+c.version+'\nالترحيب: '+label(c.welcome.enabled)+
   '\nالوداع: '+label(c.farewell.enabled)+
   '\nالردود: '+label(c.repliesEnabled)+'\nالقواعد: '+c.rules.length+
   '\nفاصل ردود المجموعة: '+Math.floor(c.groupCooldownMs/1000)+' ثوانٍ\n\n'+help,
   keyboard:k([
    [btn('👋 '+(c.welcome.enabled?'إيقاف':'تفعيل')+' الترحيب','p4c:1:t:'+id+':w:'+(c.welcome.enabled?'0':'1'))],
    [btn('👋 '+(c.farewell.enabled?'إيقاف':'تفعيل')+' الوداع','p4c:1:t:'+id+':f:'+(c.farewell.enabled?'0':'1'))],
    [btn('🤖 '+(c.repliesEnabled?'إيقاف':'تفعيل')+' الردود','p4c:1:t:'+id+':r:'+(c.repliesEnabled?'0':'1'))],
    [btn('📋 قائمة الردود','p4c:1:r:'+id+':0')],
    [btn('↩️ المجموعات','p4c:1:l:0'),btn('🏠 لوحة المالك','mi:1:h')]
   ])};
 }
 const toggle=/^p4c:1:t:(-[1-9]\d{0,15}):([wfr]):([01])$/u.exec(data);
 if(toggle){
  const field=toggle[2]!,value=toggle[3]!;
  const kind:CommunityDraftKind=(field==='w'?'WELCOME_':field==='f'?'FAREWELL_':'REPLIES_')+
   (value==='1'?'ON':'OFF') as CommunityDraftKind;
  const draft=await service.pending(actorId,{kind},toggle[1]!);
  return {text:'<b>تأكيد تغيير تفاعل المجموعة</b>\n'+service.preview(draft)+
   '\nالمجموعة: <code>'+draft.chatId+'</code>\nتغيير عام، لن يطبق قبل التأكيد.',
   keyboard:k([[btn('✅ اعتماد','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ رجوع','p4c:1:g:'+draft.chatId)]])};
 }
 const rules=/^p4c:1:r:(-[1-9]\d{0,15}):(0|[1-9]\d{0,2})$/u.exec(data);
 if(rules){
  const c=await service.view(actorId,rules[1]!),page=Number(rules[2]);
  const pages=Math.max(1,Math.ceil(c.rules.length/6));
  if(page>=pages)return null;
  const selected=c.rules.slice(page*6,page*6+6);
  const rows=selected.map(r=>[
   btn(r.enabled?'⏸️ إيقاف':'▶️ تفعيل','p4c:1:e:'+c.chatId+':'+r.id+':'+(r.enabled?'0':'1')),
   btn('🗑️ حذف','p4c:1:d:'+c.chatId+':'+r.id)
  ]);
  const nav=[] as {text:string;callback_data:string}[];
  if(page>0)nav.push(btn('⬅️ السابق','p4c:1:r:'+c.chatId+':'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','p4c:1:r:'+c.chatId+':'+(page+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المجموعة','p4c:1:g:'+c.chatId)]);
  return {text:'<b>🤖 الردود المحفوظة</b>\n'+(selected.length?
   selected.map(r=>'<code>'+r.id+'</code> • '+r.match+' • '+esc(r.trigger.slice(0,65))+
   (r.enabled?' • نشط':' • متوقف')+' • '+(r.cooldownMs/1000)+' ثانية'+
   (r.topicId?' • موضوع '+r.topicId:'')).join('\n'):'لا توجد ردود.')+
   '\n\nإضافة رد: <code>/replyadd '+c.chatId+' WORD كلمة | نص الرد</code>',
   keyboard:k(rows)};
 }
 const perRule=/^p4c:1:e:(-[1-9]\d{0,15}):([a-f0-9]{12}):([01])$/u.exec(data);
 if(perRule){
  const draft=await service.pending(actorId,{kind:perRule[3]==='1'?'REPLY_ENABLE':'REPLY_DISABLE',
   ruleId:perRule[2]!},perRule[1]!);
  return {text:service.preview(draft)+'\nالإجراء لن يطبّق قبل التأكيد.',
   keyboard:k([[btn('✅ اعتماد','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ القواعد','p4c:1:r:'+draft.chatId+':0')]])};
 }
 const remove=/^p4c:1:d:(-[1-9]\d{0,15}):([a-f0-9]{12})$/u.exec(data);
 if(remove){
  const draft=await service.pending(actorId,{kind:'REPLY_REMOVE',ruleId:remove[2]!},remove[1]!);
  return {text:service.preview(draft)+'\nيحتاج تأكيدًا، ولن يحذف السجل القديم بصمت.',
   keyboard:k([[btn('✅ حذف القاعدة','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)]])};
 }
 const decision=/^p4c:1:([cx]):([a-f0-9]{24})$/u.exec(data);
 if(decision){
  const action=decision[1],id=decision[2]!;
  if(!hex.test(id))return null;
  if(action==='x'){
   const done=await service.cancel(actorId,id);
   return done?{text:'أُلغي التعديل ولم تُغيّر إعدادات المجموعة.',
    keyboard:k([[btn('↩️ قوائم المجموعات','p4c:1:l:0')]])}:null;
  }
  const updated=await service.approve(actorId,id);
  return phase4CommunityScreen(service,actorId,'p4c:1:g:'+updated.chatId);
 }
 return null;
}
