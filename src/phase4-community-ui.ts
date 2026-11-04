import {Phase4CommunityService,type DraftRequest} from './phase4-community.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import type {CommunityDraftKind,ReplyMatch,CommunityLanguage,CommunityCalendar,CommunityClockFormat} from './phase4-community-model.js';
import {validCommunityRulesUrl,validCommunityTimeZone} from './phase4-community-model.js';
import {validCommunityLinkButton,validCommunityPhotoId} from './phase4-community-rich.js';
const group=/^-[1-9]\d{0,15}$/u,hex=/^[a-f0-9]{24}$/u;
const route=/^p4c:1:(?:q:-[1-9]\d{0,15}|k:-[1-9]\d{0,15}|z:-[1-9]\d{0,15}|n:-[1-9]\d{0,15}|a:-[1-9]\d{0,15}|y:-[1-9]\d{0,15}(?::[1-9]\d{0,9})?|l:(?:0|[1-9]\d{0,2})|g:-[1-9]\d{0,15}|h:-[1-9]\d{0,15}|v:-[1-9]\d{0,15}:[wf]|j:-[1-9]\d{0,15}:[wf]:[pb]|r:-[1-9]\d{0,15}:(?:0|[1-9]\d{0,2})|t:-[1-9]\d{0,15}:[wfrsgbd]:[01]|d:-[1-9]\d{0,15}:[a-f0-9]{12}|e:-[1-9]\d{0,15}:[a-f0-9]{12}:[01]|u:-[1-9]\d{0,15}:(?:ar|en)|o:-[1-9]\d{0,15}:(?:12|24):[gh]|[cx]:[a-f0-9]{24})$/u;
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
 +'<code>/replylog -100123</code>\n'
 +'<code>/replylogon -100123</code>\n'
 +'<code>/replylogoff -100123</code>\n'
 +'<code>/replydel -100123 معرف_القاعدة</code>\n'
 +'<code>/setruleslink -100123 https://t.me/manaratak_rules</code>\n'
 +'<code>/clearruleslink -100123</code>\n'
 +'<code>/replyrate -100123 معرف_القاعدة 90</code>\n'
 +'<code>/replyquiet -100123 22:00 07:00</code>\n'
 +'<code>/replyquietoff -100123</code>\n'
 +'<code>/replytopicrate -100123 777 10</code>\n'
 +'<code>/replytopicclear -100123 777</code>\n'
 +'<code>/servicedelay -100123 120</code>\n'
 +'<code>/replycleanup -100123 45</code>\n'
 +'<code>/replycleanupon -100123</code>\n'
 +'<code>/replycleanupoff -100123</code>\n'
 +'<code>/greetinglang -100123 en</code>\n'
 +'<code>/greetingtext -100123 welcome en Welcome {العضو}</code>\n'
 +'<code>/greetingclock -100123 +03:00 12 hijri</code>\n'
 +'<code>/greetingzone -100123 Asia/Aden</code>\n'
 +'<code>/greetingzoneoff -100123</code>\n'
 +'<code>/welcomephoto -100123 PHOTO_FILE_ID</code>\n'
 +'<code>/clearwelcomephoto -100123</code>\n'
 +'<code>/welcomebutton -100123 دليل القوانين | https://t.me/StudyinEurope3</code>\n'
 +'<code>/clearwelcomebuttons -100123</code>\n'
 +'يظهر تأكيد مستقل لكل تعديل، وتظل الميزات مغلقة حتى تفعّلها.';
export function parsePhase4CommunityCommand(text:string):
 {kind:'HOME'}|{kind:'VIEW';chatId:string}|{kind:'EDIT';chatId:string;request:DraftRequest}|
 {kind:'DIAGNOSE';chatId:string;sample:string;topicId?:number}|
 {kind:'DECISIONS';chatId:string}|null{
 if(text==='/community')return {kind:'HOME'};
 const decisionSwitch=/^\/replylog(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(decisionSwitch)return {kind:'EDIT',chatId:decisionSwitch[2]!,
  request:{kind:decisionSwitch[1]==='on'?'DECISION_LOG_ON':'DECISION_LOG_OFF'}};
 const decisionView=/^\/replylog (-[1-9]\d{0,15})$/u.exec(text);
 if(decisionView)return {kind:'DECISIONS',chatId:decisionView[1]!};
 const replyCleanup=/^\/replycleanup (-[1-9]\d{0,15}) ([1-9]\d{0,3})$/u.exec(text);
 if(replyCleanup){
  const seconds=Number(replyCleanup[2]);
  if(seconds<30||seconds>3600)return null;
  return {kind:'EDIT',chatId:replyCleanup[1]!,request:{
   kind:'REPLY_CLEANUP_DELAY',delayMs:seconds*1000}};
 }
 const replyCleanupSwitch=/^\/reply(cleanup(on|off)) (-[1-9]\d{0,15})$/u.exec(text);
 if(replyCleanupSwitch)return {kind:'EDIT',chatId:replyCleanupSwitch[3]!,
  request:{kind:replyCleanupSwitch[2]==='on'?'REPLY_CLEANUP_ON':'REPLY_CLEANUP_OFF'}};
 const quiet=/^\/replyquiet (-[1-9]\d{0,15}) ([01]\d|2[0-3]):([0-5]\d) ([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
 if(quiet){
  const startMinute=Number(quiet[2])*60+Number(quiet[3]);
  const endMinute=Number(quiet[4])*60+Number(quiet[5]);
  return startMinute!==endMinute?{kind:'EDIT',chatId:quiet[1]!,
   request:{kind:'QUIET_HOURS_SET',startMinute,endMinute}}:null;
 }
 const quietOff=/^\/replyquietoff (-[1-9]\d{0,15})$/u.exec(text);
 if(quietOff)return {kind:'EDIT',chatId:quietOff[1]!,request:{kind:'QUIET_HOURS_CLEAR'}};
 const topicRate=/^\/replytopicrate (-[1-9]\d{0,15}) ([1-9]\d{0,9}) ([1-9]\d{0,3})$/u.exec(text);
 if(topicRate){
  const topicId=Number(topicRate[2]),seconds=Number(topicRate[3]);
  if(!Number.isSafeInteger(topicId)||topicId>2147483647||seconds>600)return null;
  return {kind:'EDIT',chatId:topicRate[1]!,request:{kind:'TOPIC_COOLDOWN_SET',
   topicId,cooldownMs:seconds*1000}};
 }
 const topicClear=/^\/replytopicclear (-[1-9]\d{0,15}) ([1-9]\d{0,9})$/u.exec(text);
 if(topicClear){
  const topicId=Number(topicClear[2]);
  return Number.isSafeInteger(topicId)&&topicId<=2147483647?
   {kind:'EDIT',chatId:topicClear[1]!,request:{kind:'TOPIC_COOLDOWN_CLEAR',topicId}}:null;
 }
 const photo=/^\/(welcomephoto|farewellphoto) (-[1-9]\d{0,15}) ([A-Za-z0-9_-]{25,200})$/u.exec(text);
 if(photo)return validCommunityPhotoId(photo[3])?
  {kind:'EDIT',chatId:photo[2]!,request:{
   kind:photo[1]==='welcomephoto'?'WELCOME_PHOTO_SET':'FAREWELL_PHOTO_SET',
   photoFileId:photo[3]!}}:null;
 const clearPhoto=/^\/(clearwelcomephoto|clearfarewellphoto) (-[1-9]\d{0,15})$/u.exec(text);
 if(clearPhoto)return {kind:'EDIT',chatId:clearPhoto[2]!,request:{
  kind:clearPhoto[1]==='clearwelcomephoto'?'WELCOME_PHOTO_CLEAR':'FAREWELL_PHOTO_CLEAR'}};
 const button=/^\/(welcomebutton|farewellbutton) (-[1-9]\d{0,15}) ([^\u0000-\u001f|]{1,70}) \| (\S{15,512})$/u.exec(text);
 if(button){
  const label=button[3]!.trim(),url=button[4]!;
  if(!validCommunityLinkButton({text:label,url}))return null;
  return {kind:'EDIT',chatId:button[2]!,request:{
   kind:button[1]==='welcomebutton'?'WELCOME_BUTTON_ADD':'FAREWELL_BUTTON_ADD',
   buttonText:label,buttonUrl:url}};
 }
 const clearButtons=/^\/(clearwelcomebuttons|clearfarewellbuttons) (-[1-9]\d{0,15})$/u.exec(text);
 if(clearButtons)return {kind:'EDIT',chatId:clearButtons[2]!,request:{
  kind:clearButtons[1]==='clearwelcomebuttons'?'WELCOME_BUTTONS_CLEAR':'FAREWELL_BUTTONS_CLEAR'}};

 const language=/^\/greetinglang (-[1-9]\d{0,15}) (ar|en)$/u.exec(text);
 if(language)return {kind:'EDIT',chatId:language[1]!,
  request:{kind:'GROUP_LANGUAGE',language:language[2]! as CommunityLanguage}};
 const translated=/^\/greetingtext (-[1-9]\d{0,15}) (welcome|farewell) (ar|en) ([^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]{1,800})$/u.exec(text);
 if(translated)return {kind:'EDIT',chatId:translated[1]!,request:{
  kind:translated[2]==='welcome'?'WELCOME_LOCALIZED':'FAREWELL_LOCALIZED',
  language:translated[3]! as CommunityLanguage,text:translated[4]!.trim()}};
 const zone=/^\/greetingzone (-[1-9]\d{0,15}) (\S{1,64})$/u.exec(text);
 if(zone)return validCommunityTimeZone(zone[2])?
  {kind:'EDIT',chatId:zone[1]!,request:{kind:'GROUP_TIMEZONE',timeZone:zone[2]!}}:null;
 const zoneOff=/^\/greetingzoneoff (-[1-9]\d{0,15})$/u.exec(text);
 if(zoneOff)return {kind:'EDIT',chatId:zoneOff[1]!,request:{kind:'GROUP_TIMEZONE_CLEAR'}};
 const clock=/^\/greetingclock (-[1-9]\d{0,15}) ([+-])([01]\d):([0-5]\d) (12|24) (gregorian|hijri)$/u.exec(text);
 if(clock){
  const offset=(clock[2]==='-'?-1:1)*(Number(clock[3])*60+Number(clock[4]));
  if(offset< -720||offset>840)return null;
  return {kind:'EDIT',chatId:clock[1]!,request:{kind:'GROUP_CLOCK',
   utcOffsetMinutes:offset,clockFormat:clock[5]! as CommunityClockFormat,
   calendar:clock[6]! as CommunityCalendar}};
 }

 const link=/^\/setruleslink (-[1-9]\d{0,15}) (\S{1,256})$/u.exec(text);
 if(link)return validCommunityRulesUrl(link[2])?
  {kind:'EDIT',chatId:link[1]!,request:{kind:'RULES_LINK_SET',text:link[2]!}}:null;
 const clear=/^\/clearruleslink (-[1-9]\d{0,15})$/u.exec(text);
 if(clear)return {kind:'EDIT',chatId:clear[1]!,request:{kind:'RULES_LINK_CLEAR'}};

 const serviceDelay=/^\/servicedelay (-[1-9]\d{0,15}) ([1-9]\d{0,3})$/u.exec(text);
 if(serviceDelay){
  const seconds=Number(serviceDelay[2]);
  if(seconds<30||seconds>3600)return null;
  return {kind:'EDIT',chatId:serviceDelay[1]!,
   request:{kind:'SERVICE_CLEANUP_DELAY',delayMs:seconds*1000}};
 }
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
 const data=cmd?.kind==='HOME'?'p4c:1:l:0':cmd?.kind==='VIEW'?'p4c:1:g:'+cmd.chatId:
  cmd?.kind==='DECISIONS'?'p4c:1:k:'+cmd.chatId:input;
 if(cmd?.kind==='DIAGNOSE'){
  const diagnostic=await service.diagnose(actorId,cmd.chatId,cmd.sample,cmd.topicId);
  const text=diagnostic.status==='MATCH'?
   '✅ توجد قاعدة مطابقة: <code>'+diagnostic.ruleId+'</code>\nنص تجريبي: '+diagnostic.preview:
   diagnostic.status==='REPLIES_DISABLED'?'الردود التلقائية متوقفة في هذه المجموعة.':
   diagnostic.status==='QUIET_HOURS'?'الردود متوقفة حاليًا بسبب ساعات الهدوء المعتمدة للمجموعة.':
   diagnostic.status==='RULE_DISABLED'?'القاعدة المطابقة <code>'+diagnostic.ruleId+'</code> معطّلة.':
   diagnostic.status==='TOPIC_MISMATCH'?'القاعدة المطابقة <code>'+diagnostic.ruleId+'</code> مخصصة لموضوع Forum آخر.':
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
 if(['mi:1:i:09:01','mi:1:i:09:04','mi:1:i:09:05','mi:1:i:09:15','mi:1:i:09:16','mi:1:i:07:10','p4c:1:l:0'].includes(data)||
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
   '\nالإصدار: '+c.version+'\nرابط القوانين: '+(c.rulesUrl?esc(c.rulesUrl):'غير محدد')+'\nالترحيب: '+label(c.welcome.enabled)+
   '\nالوداع: '+label(c.farewell.enabled)+
   '\nالردود: '+label(c.repliesEnabled)+'\nالقواعد: '+c.rules.length+
   '\nسجل قرارات الردود: '+label(c.decisionLogEnabled??false)+
   '\nتسجيل تغييرات المجموعة: '+label(c.changeLogEnabled??false)+
   '\nالرسائل الخدمية: '+label(c.serviceCleanup?.enabled??false)+
   '\nحذف ردود البوت المؤقتة: '+label(c.replyCleanup?.enabled??false)+
   '\nمهلة حذف الردود: '+((c.replyCleanup?.delayMs??120000)/1000)+' ثانية'+
   '\nمدة حذف رسائل الخدمة: '+((c.serviceCleanup?.delayMs??120000)/1000)+' ثانية'+
   '\nفاصل ردود المجموعة: '+Math.floor(c.groupCooldownMs/1000)+' ثوانٍ'+
   '\nساعات الهدوء: '+(c.quietHours?'محددة':'غير مفعّلة')+
   '\nحدود الموضوعات: '+(c.topicCooldowns?.length??0)+
   '\nاللغة: '+(c.language??'ar')+'\nنظام الوقت: '+(c.clockFormat??'24')+
   '\nالتقويم: '+(c.calendar??'gregorian')+'\nإزاحة UTC الاحتياطية: '+c.utcOffsetMinutes+' دقيقة'+
   '\nالمنطقة الزمنية: '+(c.timeZone??'غير محددة — إزاحة ثابتة')+
   '\nقالب الترحيب المترجم: '+(c.welcome.localized?.[c.language??'ar']?'متاح':'غير محدد')+
   '\nقالب الوداع المترجم: '+(c.farewell.localized?.[c.language??'ar']?'متاح':'غير محدد')+
   '\nصورة الترحيب: '+(c.welcome.photoFileId?'معتمدة':'غير مضافة')+
   '\nصورة الوداع: '+(c.farewell.photoFileId?'معتمدة':'غير مضافة')+
   '\nأزرار الترحيب الخارجية: '+(c.welcome.buttons?.length??0)+
   '\nأزرار الوداع الخارجية: '+(c.farewell.buttons?.length??0)+
   '\n\n'+help,
   keyboard:k([
    [btn('👋 '+(c.welcome.enabled?'إيقاف':'تفعيل')+' الترحيب','p4c:1:t:'+id+':w:'+(c.welcome.enabled?'0':'1'))],
    [btn('👋 '+(c.farewell.enabled?'إيقاف':'تفعيل')+' الوداع','p4c:1:t:'+id+':f:'+(c.farewell.enabled?'0':'1'))],
    [btn('🤖 '+(c.repliesEnabled?'إيقاف':'تفعيل')+' الردود','p4c:1:t:'+id+':r:'+(c.repliesEnabled?'0':'1'))],
    [btn('📋 قائمة الردود','p4c:1:r:'+id+':0')],
    [btn('🧾 تقرير قرارات الردود','p4c:1:k:'+id)],
    [btn('🧾 '+(c.decisionLogEnabled?'إيقاف':'تفعيل')+' السجل المنقح',
     'p4c:1:t:'+id+':d:'+(c.decisionLogEnabled?'0':'1'))],
    [btn('🌙 ساعات الهدوء','p4c:1:q:'+id),btn('🧵 حدود الموضوعات','p4c:1:y:'+id)],
    [btn('🖼️ وسائط الترحيب','p4c:1:v:'+id+':w'),
     btn('🖼️ وسائط الوداع','p4c:1:v:'+id+':f')],
    [btn('🌐 اللغة: '+(c.language??'ar'),'p4c:1:u:'+id+':'+((c.language??'ar')==='ar'?'en':'ar'))],
    [btn('🕒 الساعة: '+(c.clockFormat??'24'),'p4c:1:o:'+id+':'+((c.clockFormat??'24')==='24'?'12':'24')+':'+((c.calendar??'gregorian')==='hijri'?'h':'g'))],
    [btn('📅 التقويم: '+(c.calendar??'gregorian'),'p4c:1:o:'+id+':'+(c.clockFormat??'24')+':'+((c.calendar??'gregorian')==='hijri'?'g':'h'))],
    [btn('🌍 المنطقة الزمنية','p4c:1:n:'+id)],
    [btn('🧹 '+(c.serviceCleanup?.enabled?'إيقاف':'تفعيل')+' تنظيف رسائل الخدمة','p4c:1:t:'+id+':s:'+(c.serviceCleanup?.enabled?'0':'1'))],
    [btn('🧼 '+(c.replyCleanup?.enabled?'إيقاف':'تفعيل')+' حذف ردود البوت','p4c:1:t:'+id+':b:'+(c.replyCleanup?.enabled?'0':'1'))],
    [btn('📝 '+(c.changeLogEnabled?'إيقاف':'تفعيل')+' سجل تغييرات المجموعة','p4c:1:t:'+id+':g:'+(c.changeLogEnabled?'0':'1'))],
    [btn('🕘 تغييرات اسم/صورة المجموعة','p4c:1:h:'+id)],
    [btn('↩️ المجموعات','p4c:1:l:0'),btn('🏠 لوحة المالك','mi:1:h')]
   ])};
 }
 const decisionReport=/^p4c:1:k:(-[1-9]\d{0,15})$/u.exec(data);
 if(decisionReport){
  const chatId=decisionReport[1]!;
  const config=await service.view(actorId,chatId);
  const events=await service.recentDecisions(actorId,chatId);
  const counts=new Map<string,number>();
  for(const item of events)counts.set(item.reason,(counts.get(item.reason)??0)+1);
  const summary=[...counts].map(([reason,count])=>esc(reason)+': '+count).join('، ');
  return {text:'<b>🧾 سجل قرارات الردود — خاص بالمالك</b>\n'+
   'المجموعة: <code>'+chatId+'</code>\nالحالة: '+
   (config.decisionLogEnabled?'مفعّل':'متوقف — لا يجمع بيانات')+
   '\nآخر '+events.length+' قرار ضمن 7 أيام (الحد 20 في هذا العرض).'+
   '\nالأعداد حسب السبب: '+(summary||'لا توجد قرارات محفوظة.')+
   (events.length?'\n\n'+events.slice(0,12).map(row=>
    '• '+new Date(row.at).toISOString().slice(0,16).replace('T',' ')+' UTC'+
    ' | '+esc(row.kind)+' | '+esc(row.reason)+' | v'+row.configVersion+
    (row.ruleId?' | قاعدة <code>'+row.ruleId+'</code>':'')).join('\n'):'')+
   '\n\nلا يُحفظ نص الطالب أو اسمه أو معرف حسابه. RESERVED تعني حجز إرسال محليًا، لا إثبات تسليم Telegram.'+
   '\nالسجل محصور بأحدث 1000 قرار لمدة أقصاها 7 أيام، ويُمسح عند إيقافه.',
   keyboard:k([[btn('↩️ إعدادات المجموعة','p4c:1:g:'+chatId)]])};
 }
 const showQuiet=/^p4c:1:q:(-[1-9]\d{0,15})$/u.exec(data);
  if(showQuiet){
   const id=showQuiet[1]!,conf=await service.view(actorId,id);
   const hhmm=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+
    ':'+String(n%60).padStart(2,'0');
   const rows=[[btn('↩️ المجموعة','p4c:1:g:'+id)]];
   if(conf.quietHours)rows.unshift([btn('⛔ إلغاء ساعات الهدوء','p4c:1:z:'+id)]);
   return {text:'<b>🌙 ساعات هدوء الردود التلقائية</b>\n'+
    'المجموعة: <code>'+id+'</code>\nالوقت المحلي: '+
    (conf.timeZone?esc(conf.timeZone)+' (مع التوقيت الصيفي)':'UTC '+conf.utcOffsetMinutes+' دقيقة ثابتة')+'.'+
    '\nالفترة: '+(conf.quietHours?hhmm(conf.quietHours.startMinute)+' — '+hhmm(conf.quietHours.endMinute):'غير محددة')+
    '\n\nتخص الردود النصية فقط، ولا توقف الترحيب والوداع أو الحماية.'+
    '\nللتعديل اكتب في الخاص:\n<code>/replyquiet '+id+' 22:00 07:00</code>'+
    '\nويمكن حذفها بعد معاينة واعتماد.',
    keyboard:k(rows)};
  }
  const clearQuiet=/^p4c:1:z:(-[1-9]\d{0,15})$/u.exec(data);
  if(clearQuiet){
   const conf=await service.view(actorId,clearQuiet[1]!);
   if(!conf.quietHours)return null;
   const draft=await service.pending(actorId,{kind:'QUIET_HOURS_CLEAR'},clearQuiet[1]!);
   return {text:service.preview(draft)+'\nلن يُطبّق إلا بعد التأكيد.',
    keyboard:k([[btn('✅ اعتماد الإلغاء','p4c:1:c:'+draft.id)],
     [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
     [btn('↩️ ساعات الهدوء','p4c:1:q:'+draft.chatId)]])};
  }
  const showTopics=/^p4c:1:y:(-[1-9]\d{0,15})$/u.exec(data);
  if(showTopics){
   const id=showTopics[1]!,conf=await service.view(actorId,id);
   const limits=conf.topicCooldowns??[];
   const rows=limits.slice(0,8).map(x=>[btn('🗑️ مسح حد الموضوع '+x.topicId,
    'p4c:1:y:'+id+':'+x.topicId)]);
   rows.push([btn('↩️ المجموعة','p4c:1:g:'+id)]);
   return {text:'<b>🧵 فواصل الردود حسب موضوع Forum</b>\n'+
    (limits.length?limits.map(x=>'• الموضوع '+x.topicId+': '+x.cooldownMs/1000+' ثانية').join('\n'):
    'لا توجد حدود مخصصة. يُستخدم فاصل المجموعة الافتراضي.')+
    '\nالحد العام البالغ 8 ردود في الدقيقة يبقى مطبقًا.'+
    '\n\nأوامر الخاص بعد المعاينة والتأكيد:\n<code>/replytopicrate '+id+' 777 10</code>'+
    '\n<code>/replytopicclear '+id+' 777</code>'+
    (limits.length>8?'\nحذف بقية الحدود من خلال أمر الخاص.':''),
    keyboard:k(rows)};
  }
  const clearTopic=/^p4c:1:y:(-[1-9]\d{0,15}):([1-9]\d{0,9})$/u.exec(data);
  if(clearTopic){
   const id=clearTopic[1]!,topicId=Number(clearTopic[2]);
   if(topicId>2147483647)return null;
   const draft=await service.pending(actorId,{kind:'TOPIC_COOLDOWN_CLEAR',topicId},id);
   return {text:service.preview(draft)+'\nلن يُطبّق إلا بعد التأكيد.',
    keyboard:k([[btn('✅ اعتماد الإلغاء','p4c:1:c:'+draft.id)],
     [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
     [btn('↩️ حدود الموضوعات','p4c:1:y:'+draft.chatId)]])};
  }
  const mediaView=/^p4c:1:v:(-[1-9]\d{0,15}):([wf])$/u.exec(data);
 if(mediaView){
  const id=mediaView[1]!,kind=mediaView[2]!,config=await service.view(actorId,id);
  const media=kind==='w'?config.welcome:config.farewell;
  const heading=kind==='w'?'الترحيب':'الوداع';
  const photoCommand=kind==='w'?'welcomephoto':'farewellphoto';
  const buttonCommand=kind==='w'?'welcomebutton':'farewellbutton';
  const rows:{text:string;callback_data:string}[][]=[];
  if(media.photoFileId)rows.push([btn('🗑️ مسح صورة '+heading,'p4c:1:j:'+id+':'+kind+':p')]);
  if(media.buttons?.length)rows.push([btn('🗑️ مسح جميع أزرار '+heading,'p4c:1:j:'+id+':'+kind+':b')]);
  rows.push([btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]);
  return {text:'<b>🖼️ وسائط '+heading+'</b>\n'+
   'الصورة: '+(media.photoFileId?'معتمدة':'لا توجد')+
   '\nأزرار الروابط الخارجية: '+(media.buttons?.length??0)+' من 3'+
   '\n\nلإضافة صورة: أرسل صورة في خاص البوت، واكتب في وصفها:\n'+
   '<code>/'+photoCommand+' '+id+'</code>'+
   '\n\nلإضافة زر خارجي، اكتب في خاص البوت:\n'+
   '<code>/'+buttonCommand+' '+id+' دليل المنح | https://t.me/StudyinEurope3</code>'+
   '\n\nلن تُعتمد الصورة أو الأزرار حتى تظهر شاشة المعاينة ويؤكدها المالك.'+
   '\nمعرف ملف الصورة لا يُعرض في شاشة المالك.',
   keyboard:k(rows)};
 }
 const mediaClear=/^p4c:1:j:(-[1-9]\d{0,15}):([wf]):([pb])$/u.exec(data);
 if(mediaClear){
  const kind=mediaClear[2]!,part=mediaClear[3]!;
  const draft=await service.pending(actorId,{kind:kind==='w'?
   (part==='p'?'WELCOME_PHOTO_CLEAR':'WELCOME_BUTTONS_CLEAR'):
   (part==='p'?'FAREWELL_PHOTO_CLEAR':'FAREWELL_BUTTONS_CLEAR')},mediaClear[1]!);
  return {text:service.preview(draft)+'\nلا تُطبّق التغييرات إلا بعد الاعتماد.',
   keyboard:k([[btn('✅ اعتماد الحذف','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ الوسائط','p4c:1:v:'+draft.chatId+':'+kind)]])};
 }
 const localeClick=/^p4c:1:u:(-[1-9]\d{0,15}):(ar|en)$/u.exec(data);
 if(localeClick){
  const draft=await service.pending(actorId,{kind:'GROUP_LANGUAGE',
   language:localeClick[2]! as CommunityLanguage},localeClick[1]!);
  return {text:service.preview(draft)+'\nلا يطبّق الإعداد قبل الاعتماد.',
   keyboard:k([[btn('✅ اعتماد','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ المجموعة','p4c:1:g:'+draft.chatId)]])};
 }
 const timeClick=/^p4c:1:o:(-[1-9]\d{0,15}):(12|24):([gh])$/u.exec(data);
 if(timeClick){
  const config=await service.view(actorId,timeClick[1]!);
  const draft=await service.pending(actorId,{kind:'GROUP_CLOCK',
   clockFormat:timeClick[2]! as CommunityClockFormat,
   calendar:timeClick[3]==='h'?'hijri':'gregorian',
   utcOffsetMinutes:config.utcOffsetMinutes},timeClick[1]!);
  return {text:service.preview(draft)+'\nلا يطبّق الإعداد قبل الاعتماد.',
   keyboard:k([[btn('✅ اعتماد','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ المجموعة','p4c:1:g:'+draft.chatId)]])};
 }
 const zoneView=/^p4c:1:n:(-[1-9]\d{0,15})$/u.exec(data);
 if(zoneView){
  const id=zoneView[1]!,conf=await service.view(actorId,id);
  return {text:'<b>🌍 المنطقة الزمنية للمجموعة</b>\n'+
   'المجموعة: <code>'+id+'</code>\nالمنطقة الحالية: '+(conf.timeZone?esc(conf.timeZone):'غير محددة')+
   '\nالإزاحة الاحتياطية: UTC '+conf.utcOffsetMinutes+' دقيقة'+
   '\n\nلا يجري تخمين منطقة الطلاب من Telegram. إعداد المنطقة من اختيار المالك، ووقت الصيف يُحسب تلقائيًا.'+
   '\nلتحديد منطقة:\n<code>/greetingzone '+id+' Asia/Aden</code>'+
   '\nللعودة للإزاحة اليدوية:\n<code>/greetingzoneoff '+id+'</code>',
   keyboard:k([...(conf.timeZone?[[btn('🗑️ إلغاء منطقة IANA','p4c:1:a:'+id)]]:[]),
    [btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]])};
 }
 const zoneClear=/^p4c:1:a:(-[1-9]\d{0,15})$/u.exec(data);
 if(zoneClear){
  const config=await service.view(actorId,zoneClear[1]!);
  if(!config.timeZone)return null;
  const draft=await service.pending(actorId,{kind:'GROUP_TIMEZONE_CLEAR'},zoneClear[1]!);
  return {text:service.preview(draft)+'\nلا يُطبّق الإلغاء حتى يعتمد المالك.',
   keyboard:k([[btn('✅ اعتماد الإلغاء','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ المنطقة الزمنية','p4c:1:n:'+draft.chatId)]])};
 }
 const history=/^p4c:1:h:(-[1-9]\d{0,15})$/u.exec(data);
 if(history){
  const rows=await service.recentChanges(actorId,history[1]!);
  const labels:{[key:string]:string}={
   TITLE_CHANGED:'تغيير اسم المجموعة',PHOTO_CHANGED:'تغيير صورة المجموعة',
   PHOTO_REMOVED:'حذف صورة المجموعة'};
  return {text:'<b>🕘 سجل تغييرات المجموعة</b>\n'+
   (rows.length?rows.map(row=>
    '• '+labels[row.kind]+' — '+new Date(row.at).toISOString().slice(0,16).replace('T',' ')+' UTC'
   ).join('\n'):'لا توجد تغييرات مسجلة في الأيام السبعة الماضية.')+
   '\n\nلا يُخزّن هذا السجل الأسماء والصور نفسها.',
   keyboard:k([[btn('↩️ إعدادات المجموعة','p4c:1:g:'+history[1])]])};
 }
 const toggle=/^p4c:1:t:(-[1-9]\d{0,15}):([wfrsgbd]):([01])$/u.exec(data);
 if(toggle){
  const field=toggle[2]!,value=toggle[3]!;
  const kind:CommunityDraftKind=(field==='w'?'WELCOME_':field==='f'?'FAREWELL_':
    field==='r'?'REPLIES_':field==='s'?'SERVICE_CLEANUP_':field==='b'?'REPLY_CLEANUP_':
    field==='d'?'DECISION_LOG_':'CHANGE_LOG_')+
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
