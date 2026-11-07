import {Phase4CommunityService,type DraftRequest} from './phase4-community.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import type {CommunityDraftKind,ReplyMatch,CommunityLanguage,CommunityCalendar,CommunityClockFormat,CommunityJoinKind,CommunityLeaveKind} from './phase4-community-model.js';
import {validCommunityRulesUrl,validCommunityTimeZone,validCommunityFAQId,validCommunityProfileTitle} from './phase4-community-model.js';
import {validCommunityLinkButton,validCommunityPhotoId} from './phase4-community-rich.js';
const group=/^-[1-9]\d{0,15}$/u,hex=/^[a-f0-9]{24}$/u;
const route=/^p4c:1:(?:q:-[1-9]\d{0,15}|i:-[1-9]\d{0,15}|ac:-[1-9]\d{0,15}:[1-8]|b:-[1-9]\d{0,15}(?::[sami])?|m:-[1-9]\d{0,15}(?::[sr])?|p:-[1-9]\d{0,15}|f:-[1-9]\d{0,15}:(?:0|[1-9]\d{0,2})|s:-[1-9]\d{0,15}|k:-[1-9]\d{0,15}|z:-[1-9]\d{0,15}|n:-[1-9]\d{0,15}|a:-[1-9]\d{0,15}|y:-[1-9]\d{0,15}(?::[1-9]\d{0,9})?|l:(?:0|[1-9]\d{0,2})|g:-[1-9]\d{0,15}|h:-[1-9]\d{0,15}|v:-[1-9]\d{0,15}:[wf]|j:-[1-9]\d{0,15}:[wf]:[pb]|r:-[1-9]\d{0,15}:(?:0|[1-9]\d{0,2})|t:-[1-9]\d{0,15}:[wfrsgbdpujlvm]:[01]|d:-[1-9]\d{0,15}:[a-f0-9]{12}|e:-[1-9]\d{0,15}:[a-f0-9]{12}:[01]|u:-[1-9]\d{0,15}:(?:ar|en)|o:-[1-9]\d{0,15}:(?:12|24):[gh]|[cx]:[a-f0-9]{24})$/u;
export const validPhase4CommunityRoute=(s:unknown):s is string=>typeof s==='string'&&
 Buffer.byteLength(s,'utf8')<=64&&route.test(s);
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const k=(rows:{text:string;callback_data:string}[][]):TelegramInlineKeyboard=>({inline_keyboard:rows});
const btn=(text:string,data:string)=>({text,callback_data:data});
const help='للتعديل أرسل في خاص البوت أحد الأوامر:\n'
 +'<code>/setwelcome -100123 نص الترحيب {العضو}</code>\n'
 +'<code>/welcomevariant -100123 SELF أهلًا {العضو}</code>\n'
 +'<code>/welcomevariant -100123 INVITE أهلًا بك عبر رابط الدعوة {العضو}</code>\n'
 +'<code>/privatewelcomeon -100123</code>\n'
 +'<code>/privatewelcomeoff -100123</code>\n'
 +'<code>/clearwelcomevariant -100123 SELF</code>\n'
 +'<code>/setfarewell -100123 نص الوداع</code>\n'
 +'<code>/groupediton -100123</code>\n'
 +'<code>/groupeditoff -100123</code>\n'
 +'<code>/groupname -100123 اسم المجموعة الجديد</code>\n'
 +'<code>/groupclearphoto -100123</code>\n'
 +'<code>/groupphoto -100123 TELEGRAM_PHOTO_FILE_ID</code>\n'
 +'<code>/farewellvariant -100123 SELF مع السلامة {العضو}</code>\n'
 +'<code>/clearfarewellvariant -100123 SELF</code>\n'
 +'<code>/farewellremovedon -100123</code>\n'
 +'<code>/farewellremovedoff -100123</code>\n'
 +'<code>/replyadd -100123 WORD منحة | راجع قسم المنح الدراسية</code>\n'
 +'<code>/replynote -100123 WORD تنبيه | نص الملاحظة الثابتة</code>\n'
 +'<code>/replyrules -100123 WORD القوانين</code>\n'
 +'<code>/replyfaq -100123 WORD القبول | معرف_FAQ_المعتمد</code>\n'
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
 +'<code>/autocap -100123 3</code>\n'
 +'<code>/serviceprofileoff -100123</code>\n'
 +'<code>/servicejoinoff -100123</code>\n'
 +'<code>/serviceleaveoff -100123</code>\n'
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
 const autoLimit=/^\/autocap (-[1-9]\d{0,15}) ([1-8])$/u.exec(text);
 if(autoLimit)return {kind:'EDIT',chatId:autoLimit[1]!,request:{kind:'AUTO_LIMIT_SET',
  autoMessagesPerMinute:Number(autoLimit[2])}};
 const profileService=/^\/serviceprofile(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(profileService)return {kind:'EDIT',chatId:profileService[2]!,request:{kind:profileService[1]==='on'?
  'SERVICE_PROFILE_ON':'SERVICE_PROFILE_OFF'}};
 const profileSwitch=/^\/groupedit(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(profileSwitch)return {kind:'EDIT',chatId:profileSwitch[2]!,
  request:{kind:profileSwitch[1]==='on'?'GROUP_PROFILE_ON':'GROUP_PROFILE_OFF'}};
 const profileName=/^\/groupname (-[1-9]\d{0,15}) ([^\u0000-\u001f\u007f]{1,256})$/u.exec(text);
 if(profileName){
  const title=profileName[2]!.trim();
  return validCommunityProfileTitle(title)?
   {kind:'EDIT',chatId:profileName[1]!,request:{kind:'GROUP_TITLE_SET',text:title}}:null;
 }
 const profileUpload=/^\/groupphoto (-[1-9]\d{0,15}) ([A-Za-z0-9_-]{25,200})$/u.exec(text);
 if(profileUpload)return validCommunityPhotoId(profileUpload[2])?
  {kind:'EDIT',chatId:profileUpload[1]!,request:{kind:'GROUP_PHOTO_SET',photoFileId:profileUpload[2]!}}:null;
 const profilePhoto=/^\/groupclearphoto (-[1-9]\d{0,15})$/u.exec(text);
 if(profilePhoto)return {kind:'EDIT',chatId:profilePhoto[1]!,request:{kind:'GROUP_PHOTO_REMOVE'}};

 const cleanupKind=/^\/service(join|leave)(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(cleanupKind)return {kind:'EDIT',chatId:cleanupKind[3]!,
  request:{kind:('SERVICE_'+cleanupKind[1]!.toUpperCase()+'_'+cleanupKind[2]!.toUpperCase()) as CommunityDraftKind}};
 const removalSwitch=/^\/farewellremoved(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(removalSwitch)return {kind:'EDIT',chatId:removalSwitch[2]!,
  request:{kind:removalSwitch[1]==='on'?'FAREWELL_REMOVED_ON':'FAREWELL_REMOVED_OFF'}};
 const farewellVariant=/^\/farewellvariant (-[1-9]\d{0,15}) (SELF|REMOVED) ([^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]{1,800})$/u.exec(text);
 if(farewellVariant)return {kind:'EDIT',chatId:farewellVariant[1]!,
  request:{kind:'FAREWELL_VARIANT_SET',leaveKind:farewellVariant[2]! as CommunityLeaveKind,text:farewellVariant[3]!.trim()}};
 const farewellClear=/^\/clearfarewellvariant (-[1-9]\d{0,15}) (SELF|REMOVED)$/u.exec(text);
 if(farewellClear)return {kind:'EDIT',chatId:farewellClear[1]!,
  request:{kind:'FAREWELL_VARIANT_CLEAR',leaveKind:farewellClear[2]! as CommunityLeaveKind}};
 const privateGreeting=/^\/privatewelcome(on|off) (-[1-9]\d{0,15})$/u.exec(text);
 if(privateGreeting)return {kind:'EDIT',chatId:privateGreeting[2]!,
  request:{kind:privateGreeting[1]==='on'?'PRIVATE_WELCOME_ON':'PRIVATE_WELCOME_OFF'}};
 const variant=/^\/welcomevariant (-[1-9]\d{0,15}) (SELF|ADDED|BATCH|INVITE) ([^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]{1,800})$/u.exec(text);
 if(variant)return {kind:'EDIT',chatId:variant[1]!,request:{
  kind:'WELCOME_VARIANT_SET',joinKind:variant[2]! as CommunityJoinKind,text:variant[3]!.trim()}};
 const variantClear=/^\/clearwelcomevariant (-[1-9]\d{0,15}) (SELF|ADDED|BATCH|INVITE)$/u.exec(text);
 if(variantClear)return {kind:'EDIT',chatId:variantClear[1]!,request:{
  kind:'WELCOME_VARIANT_CLEAR',joinKind:variantClear[2]! as CommunityJoinKind}};
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
 // Owner-reviewed fixed notes, approved rules URLs and live publication-backed
 // FAQ answers share the existing 8/minute, actor and topic quota machinery.
 const sourced=/^\/(replynote|replyfaq|replyrules) (-[1-9]\d{0,15}) (?:(?:topic:([1-9]\d{0,9}) )?)(EXACT|WORD|CONTAINS|COMMAND) ([^\u0000-\u001f\u007f|]{1,80})(?: \| ([^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]{1,1200}))?$/u.exec(text);
 if(sourced){
  const [,command,chatId,topicRaw,matchType,rawTrigger,payload]=sourced;
  const topic=topicRaw===undefined?undefined:Number(topicRaw),trigger=rawTrigger!.trim();
  if(!trigger||topic!==undefined&&(!Number.isSafeInteger(topic)||topic>2147483647)||
    matchType==='COMMAND'&&!/^m_[a-z][a-z0-9_]{0,23}$/u.test(trigger))return null;
  const common={kind:'REPLY_ADD' as const,match:matchType! as ReplyMatch,trigger,
   ...(topic!==undefined?{topicId:topic}:{})};
  if(command==='replyfaq'){
   if(!validCommunityFAQId(payload))return null;
   return {kind:'EDIT',chatId:chatId!,request:{...common,source:'FAQ',sourceFaqId:payload}};
  }
  if(command==='replyrules'){
   if(payload!==undefined)return null;
   return {kind:'EDIT',chatId:chatId!,request:{...common,source:'RULES'}};
  }
  if(!payload?.trim()||Array.from(payload.trim()).length>800)return null;
  return {kind:'EDIT',chatId:chatId!,request:{...common,source:'NOTE',text:payload.trim()}};
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
   diagnostic.status==='SOURCE_UNAVAILABLE'?'مصدر الرد المعتمد غير متاح حاليًا (سؤال FAQ أو منشوره أو رابط القوانين). لم يُرسل رد.':
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
 if(['mi:1:i:09:01','mi:1:i:09:04','mi:1:i:09:05','mi:1:i:09:15','mi:1:i:07:10','p4c:1:l:0'].includes(data)||
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
   '\nتعديل اسم/صورة المجموعة: '+label(c.profileEditingEnabled??false)+
   '\nالرسائل الخدمية: '+label(c.serviceCleanup?.enabled??false)+
   '\nحذف ردود البوت المؤقتة: '+label(c.replyCleanup?.enabled??false)+
   '\nمهلة حذف الردود: '+((c.replyCleanup?.delayMs??120000)/1000)+' ثانية'+
   '\nمدة حذف رسائل الخدمة: '+((c.serviceCleanup?.delayMs??120000)/1000)+' ثانية'+
   '\nتنظيف الدخول: '+label(c.serviceCleanup?.joinEnabled!==false)+
   '\nتنظيف المغادرة: '+label(c.serviceCleanup?.leaveEnabled!==false)+
   '\nفاصل ردود المجموعة: '+Math.floor(c.groupCooldownMs/1000)+' ثوانٍ'+
   '\nسقف الإعلانات الآلية: '+(c.autoMessagesPerMinute??8)+' رسالة بالدقيقة'+
   '\nساعات الهدوء: '+(c.quietHours?'محددة':'غير مفعّلة')+
   '\nحدود الموضوعات: '+(c.topicCooldowns?.length??0)+
   '\nاللغة: '+(c.language??'ar')+'\nنظام الوقت: '+(c.clockFormat??'24')+
   '\nالتقويم: '+(c.calendar??'gregorian')+'\nإزاحة UTC الاحتياطية: '+c.utcOffsetMinutes+' دقيقة'+
   '\nالمنطقة الزمنية: '+(c.timeZone??'غير محددة — إزاحة ثابتة')+
   '\nقالب الترحيب المترجم: '+(c.welcome.localized?.[c.language??'ar']?'متاح':'غير محدد')+
   '\nقالب الوداع المترجم: '+(c.farewell.localized?.[c.language??'ar']?'متاح':'غير محدد')+
   '\nأنواع الترحيب المخصصة: '+Object.keys(c.welcomeByJoin??{}).length+' من 4'+
   '\nأنواع الوداع المخصصة: '+Object.keys(c.farewellByLeave??{}).length+' من 2'+
   '\nوداع العضو الذي أزالته الإدارة: '+label(c.farewellOnRemoval??false)+
   '\nترحيب خاص بطلب العضو: '+label(c.privateWelcomeEnabled??false)+
   '\nصورة الترحيب: '+(c.welcome.photoFileId?'معتمدة':'غير مضافة')+
   '\nصورة الوداع: '+(c.farewell.photoFileId?'معتمدة':'غير مضافة')+
   '\nأزرار الترحيب الخارجية: '+(c.welcome.buttons?.length??0)+
   '\nأزرار الوداع الخارجية: '+(c.farewell.buttons?.length??0)+
   '\n\nلشرح الأوامر التفصيلي افتح /community، ثم اختر المجموعة؛ هذه الشاشة مخصصة للإعدادات الحالية والأزرار.',
   keyboard:k([
    [btn('👋 '+(c.welcome.enabled?'إيقاف':'تفعيل')+' الترحيب','p4c:1:t:'+id+':w:'+(c.welcome.enabled?'0':'1'))],
    [btn('👋 '+(c.farewell.enabled?'إيقاف':'تفعيل')+' الوداع','p4c:1:t:'+id+':f:'+(c.farewell.enabled?'0':'1'))],
    [btn('🤖 '+(c.repliesEnabled?'إيقاف':'تفعيل')+' الردود','p4c:1:t:'+id+':r:'+(c.repliesEnabled?'0':'1'))],
    [btn('📋 قائمة الردود','p4c:1:r:'+id+':0')],
    [btn('📚 مراجع FAQ المعتمدة','p4c:1:f:'+id+':0')],
    [btn('🚦 سقف الإعلانات الآلية','p4c:1:i:'+id),
     btn('🧾 تقرير قرارات الردود','p4c:1:k:'+id)],
    [btn('🧾 '+(c.decisionLogEnabled?'إيقاف':'تفعيل')+' السجل المنقح',
     'p4c:1:t:'+id+':d:'+(c.decisionLogEnabled?'0':'1'))],
    [btn('🌙 ساعات الهدوء','p4c:1:q:'+id),btn('🧵 حدود الموضوعات','p4c:1:y:'+id)],
    [btn('🚪 أنواع الانضمام','p4c:1:b:'+id)],
    [btn('👋 أنواع المغادرة','p4c:1:m:'+id)],
    [btn('🔒 '+(c.privateWelcomeEnabled?'إيقاف':'تفعيل')+' الترحيب الخاص الاختياري',
     'p4c:1:t:'+id+':p:'+(c.privateWelcomeEnabled?'0':'1'))],
    [btn('🖼️ وسائط الترحيب','p4c:1:v:'+id+':w'),
     btn('🖼️ وسائط الوداع','p4c:1:v:'+id+':f')],
    [btn('🌐 اللغة: '+(c.language??'ar'),'p4c:1:u:'+id+':'+((c.language??'ar')==='ar'?'en':'ar'))],
    [btn('🕒 الساعة: '+(c.clockFormat??'24'),'p4c:1:o:'+id+':'+((c.clockFormat??'24')==='24'?'12':'24')+':'+((c.calendar??'gregorian')==='hijri'?'h':'g'))],
    [btn('📅 التقويم: '+(c.calendar??'gregorian'),'p4c:1:o:'+id+':'+(c.clockFormat??'24')+':'+((c.calendar??'gregorian')==='hijri'?'g':'h'))],
    [btn('🌍 المنطقة الزمنية','p4c:1:n:'+id)],
    [btn('🧹 '+(c.serviceCleanup?.enabled?'إيقاف':'تفعيل')+' تنظيف رسائل الخدمة','p4c:1:t:'+id+':s:'+(c.serviceCleanup?.enabled?'0':'1'))],
    [btn('⚙️ أنواع تنظيف رسائل الخدمة','p4c:1:s:'+id)],
    [btn('🧼 '+(c.replyCleanup?.enabled?'إيقاف':'تفعيل')+' حذف ردود البوت','p4c:1:t:'+id+':b:'+(c.replyCleanup?.enabled?'0':'1'))],
    [btn('📝 '+(c.changeLogEnabled?'إيقاف':'تفعيل')+' سجل تغييرات المجموعة','p4c:1:t:'+id+':g:'+(c.changeLogEnabled?'0':'1'))],
    [btn('🕘 تغييرات اسم/صورة المجموعة','p4c:1:h:'+id)],
    [btn('🛠️ تعديل اسم وصورة المجموعة','p4c:1:p:'+id)],
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
  const joinTypes=/^p4c:1:b:(-[1-9]\d{0,15})$/u.exec(data);
 if(joinTypes){
  const id=joinTypes[1]!,config=await service.view(actorId,id);
  const kinds=[['SELF','انضم بنفسه','s'],['ADDED','أضافه عضو آخر','a'],
   ['BATCH','انضم عدة أعضاء','m'],['INVITE','عبر رابط دعوة','i']] as const;
  const rows:{text:string;callback_data:string}[][]=[];
  for(const [kind,label,code] of kinds){
   if(config.welcomeByJoin?.[kind])rows.push([btn('🗑️ إزالة قالب '+label,'p4c:1:b:'+id+':'+code)]);
  }
  rows.push([btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]);
  return {text:'<b>🚪 قوالب الترحيب حسب نوع الانضمام</b>\nالمجموعة: <code>'+id+'</code>'+
   '\n\n'+kinds.map(([kind,label])=>
    '• '+label+' ('+kind+'): '+
    (config.welcomeByJoin?.[kind]?esc(config.welcomeByJoin[kind]!.slice(0,100)):'القالب العام أو المترجم')).join('\n')+
   '\n\nتُحدد الأنواع من أحداث الخدمة التي يرسلها Telegram فقط؛ لا يحددها الطالب برسالة.'+
   '\nلتعديل أحد الأنواع، أرسل في خاص المالك:\n'+
   '<code>/welcomevariant '+id+' SELF مرحبًا {العضو}</code>'+
   '\n<code>/welcomevariant '+id+' ADDED أهلًا {العضو}</code>'+
   '\n<code>/welcomevariant '+id+' BATCH مرحبًا بكم {العضو}</code>'+
   '\n<code>/welcomevariant '+id+' INVITE أهلًا بك عبر رابط الدعوة {العضو}</code>'+
   '\nلن تُعتمد التعديلات قبل معاينتها وتأكيدها؛ الترحيب العام يظل متوقفًا حتى تفعيله.',
   keyboard:k(rows)};
 }
 const clearJoinType=/^p4c:1:b:(-[1-9]\d{0,15}):([sami])$/u.exec(data);
 if(clearJoinType){
  const id=clearJoinType[1]!,kind:CommunityJoinKind=
   clearJoinType[2]==='s'?'SELF':clearJoinType[2]==='a'?'ADDED':
   clearJoinType[2]==='i'?'INVITE':'BATCH';
  const config=await service.view(actorId,id);
  if(!config.welcomeByJoin?.[kind])return null;
  const draft=await service.pending(actorId,{kind:'WELCOME_VARIANT_CLEAR',joinKind:kind},id);
  return {text:service.preview(draft)+'\nلا يُطبّق الحذف دون اعتماد.',
   keyboard:k([[btn('✅ اعتماد الحذف','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ أنواع الانضمام','p4c:1:b:'+id)]])};
 }
 const farewellKinds=/^p4c:1:m:(-[1-9]\d{0,15})$/u.exec(data);
 if(farewellKinds){
  const id=farewellKinds[1]!,config=await service.view(actorId,id);
  const kinds=[['SELF','غادر بنفسه','s'],['REMOVED','أزالته الإدارة','r']] as const;
  const rows:{text:string;callback_data:string}[][]=[];
  for(const [kind,label,code] of kinds){
   if(config.farewellByLeave?.[kind])
    rows.push([btn('🗑️ إزالة قالب '+label,'p4c:1:m:'+id+':'+code)]);
  }
  rows.push([btn((config.farewellOnRemoval?'⛔ إيقاف':'🔒 تفعيل')+' وداع الإزالة',
   'p4c:1:t:'+id+':u:'+(config.farewellOnRemoval?'0':'1'))]);
  rows.push([btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]);
  return {text:'<b>👋 قوالب الوداع حسب نوع المغادرة</b>\nالمجموعة: <code>'+id+'</code>'+
   '\n\n'+kinds.map(([kind,label])=>'• '+label+' ('+kind+'): '+
    (config.farewellByLeave?.[kind]?esc(config.farewellByLeave[kind]!.slice(0,100)):'القالب العام أو المترجم')).join('\n')+
   '\n\nوداع الإزالة الإدارية: '+(config.farewellOnRemoval?'مسموح بعد اعتماد المالك':'متوقف افتراضيًا حفاظًا على الخصوصية')+
   '\nمن حقول Telegram الرسمية فقط، لا يمكن لرسالة طالب ادعاء مغادرة أحد.'+
   '\nلتخصيص النصوص في خاص المالك:\n'+
   '<code>/farewellvariant '+id+' SELF بالتوفيق {العضو}</code>\n'+
   '<code>/farewellvariant '+id+' REMOVED مع السلامة {العضو}</code>\n'+
   'التخصيص لا يفعّل الوداع أو إعلان الإزالة من تلقاء نفسه. كل تعديل يخضع للمعاينة والموافقة.',
   keyboard:k(rows)};
 }
 const clearFarewellKind=/^p4c:1:m:(-[1-9]\d{0,15}):([sr])$/u.exec(data);
 if(clearFarewellKind){
  const id=clearFarewellKind[1]!,kind:CommunityLeaveKind=
   clearFarewellKind[2]==='s'?'SELF':'REMOVED';
  const config=await service.view(actorId,id);
  if(!config.farewellByLeave?.[kind])return null;
  const draft=await service.pending(actorId,{kind:'FAREWELL_VARIANT_CLEAR',leaveKind:kind},id);
  return {text:service.preview(draft)+'\nلن يطبق الحذف قبل الاعتماد.',
   keyboard:k([[btn('✅ اعتماد الحذف','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ أنواع المغادرة','p4c:1:m:'+id)]])};
 }
 const capView=/^p4c:1:i:(-[1-9]\d{0,15})$/u.exec(data);
 if(capView){
  const id=capView[1]!,config=await service.view(actorId,id);
  const values=[1,2,3,4,6,8] as const;
  return {text:'<b>🚦 سقف رسائل منارتك الآلية</b>\nالمجموعة: <code>'+id+'</code>'+
   '\nالسقف الحالي: '+(config.autoMessagesPerMinute??8)+' رسالة خلال أي 60 ثانية.'+
   '\nيشمل الترحيب والوداع والردود التلقائية ويمتد إلى جميع موضوعات Forum.'+
   '\n\nاضغط سقفًا جديدًا ثم اعتمده؛ لا يتجاوز 8 رسائل بالدقيقة.'+
   '\nيمكنك أيضًا كتابة: <code>/autocap '+id+' 3</code>',
   keyboard:k([...values.map(v=>[btn('🚦 '+v+' / دقيقة'+((config.autoMessagesPerMinute??8)===v?' ✓':''),
    'p4c:1:ac:'+id+':'+v)]),
    [btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]])};
 }
 const capEdit=/^p4c:1:ac:(-[1-9]\d{0,15}):([1-8])$/u.exec(data);
 if(capEdit){
  const draft=await service.pending(actorId,{kind:'AUTO_LIMIT_SET',
   autoMessagesPerMinute:Number(capEdit[2])},capEdit[1]!);
  return {text:service.preview(draft)+'\n\nلا يُطبق السقف قبل اعتماد المالك.',
   keyboard:k([[btn('✅ اعتماد السقف','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ السقف الحالي','p4c:1:i:'+draft.chatId)]])};
 }
 const serviceCleanupMenu=/^p4c:1:s:(-[1-9]\d{0,15})$/u.exec(data);
 if(serviceCleanupMenu){
  const id=serviceCleanupMenu[1]!,config=await service.view(actorId,id);
  const clean=config.serviceCleanup;
  const join=clean?.joinEnabled!==false,leave=clean?.leaveEnabled!==false,
   profile=clean?.profileEnabled!==false;
  const rows=[
   [btn((clean?.enabled?'⛔ إيقاف':'✅ تفعيل')+' تنظيف رسائل الخدمة',
    'p4c:1:t:'+id+':s:'+(clean?.enabled?'0':'1'))],
   [btn((join?'⛔ إيقاف':'✅ تفعيل')+' تنظيف الدخول',
    'p4c:1:t:'+id+':j:'+(join?'0':'1'))],
   [btn((leave?'⛔ إيقاف':'✅ تفعيل')+' تنظيف المغادرة',
    'p4c:1:t:'+id+':l:'+(leave?'0':'1'))],
   [btn((profile?'⛔ إيقاف':'✅ تفعيل')+' تنظيف تغيير الاسم/الصورة',
    'p4c:1:t:'+id+':m:'+(profile?'0':'1'))],
   [btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]
  ];
  return {text:'<b>🧹 تنظيف رسائل خدمة الدخول والمغادرة</b>\nالمجموعة: <code>'+id+'</code>'+
   '\nالتنظيف العام: '+(clean?.enabled?'مفعّل':'متوقف')+
   '\nرسائل الدخول: '+(join?'مسموح عند تفعيل العام':'مستبعدة')+
   '\nرسائل المغادرة: '+(leave?'مسموح عند تفعيل العام':'مستبعدة')+
   '\nرسائل تغيير الاسم والصورة: '+(profile?'مسموح عند تفعيل العام':'مستبعدة')+
   '\nالمهلة: '+((clean?.delayMs??120000)/1000)+' ثانية.'+
   '\n\nلا يُحذف شيء دون صلاحية can_delete_messages والتحقق النهائي من النسخة والحقوق.'+
   '\nالأوامر في خاص المالك: <code>/servicejoinoff '+id+'</code> أو'+
   ' <code>/servicejoinon '+id+'</code> وكذلك'+
   ' <code>/serviceleaveoff '+id+'</code> و<code>/serviceleaveon '+id+'</code>.'+
   '\nولتنظيف تغييرات اسم/صورة المجموعة: <code>/serviceprofileon '+id+'</code> أو'+
   ' <code>/serviceprofileoff '+id+'</code>.'+
   '\nلتغيير المهلة: <code>/servicedelay '+id+' 120</code>.'+
   '\nكل تعديل يخضع للمراجعة والاعتماد، ولا يمكن التراجع عن حذف رسالة تم تأكيده.',
   keyboard:k(rows)};
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
 const groupProfile=/^p4c:1:p:(-[1-9]\d{0,15})$/u.exec(data);
 if(groupProfile){
  const id=groupProfile[1]!,config=await service.view(actorId,id);
  const jobs=await service.recentProfileOperations(actorId,id);
  const enabled=config.profileEditingEnabled===true;
  return {text:'<b>🛠️ تغيير اسم أو صورة المجموعة</b>\nالمجموعة: <code>'+id+'</code>'+
   '\nالتفعيل: '+(enabled?'مسموح بعد مراجعة كل طلب':'متوقف افتراضيًا')+
   '\n\nكل عملية تحتاج: صلاحية المالك، موافقة جديدة، اعتماد المجموعة،'+
   ' مفتاح تشغيل منفصل في الخادم، وصلاحية can_change_info في Telegram.'+
   '\n\nالأوامر في خاص المالك:'+
   '\n<code>/groupname '+id+' اسم المجموعة الجديد</code>'+
   '\n<code>/groupclearphoto '+id+'</code>'+ 
   '\n<code>/groupphoto '+id+' PHOTO_FILE_ID</code>'+
   '\n<code>/groupediton '+id+'</code> أو <code>/groupeditoff '+id+'</code>'+
   '\n\nرفع الصورة يتم من معرّف ملف موثوق يصلح للبوت عبر getFile ثم multipart؛ لا يقبل Telegram تمرير file_id مباشرةً كصورة المجموعة.'+
   '\n\nآخر طلبات التعديل:\n'+(jobs.length?jobs.map(job=>
    '• '+(job.kind==='TITLE_SET'?'تعديل الاسم':job.kind==='PHOTO_SET'?'رفع صورة جديدة':'حذف الصورة')+
    ' — '+esc(job.status)+' — '+new Date(job.createdAt).toISOString().slice(0,16).replace('T',' ')+' UTC'
   ).join('\n'):'لا توجد طلبات تعديل محفوظة.')+
   '\nلا يعرض السجل عنوان المجموعة المطلوب بعد محاولة الإرسال، ولا يكرر الطلب عند نتيجة مجهولة.',
   keyboard:k([[btn((enabled?'⛔ إيقاف':'🔐 تفعيل')+' صلاحية تعديل المجموعة',
    'p4c:1:t:'+id+':v:'+(enabled?'0':'1'))],
    [btn('🕘 سجل تغييرات الاسم/الصورة','p4c:1:h:'+id)],
    [btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]])};
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
 const toggle=/^p4c:1:t:(-[1-9]\d{0,15}):([wfrsgbdpujlvm]):([01])$/u.exec(data);
 if(toggle){
  const field=toggle[2]!,value=toggle[3]!;
  const kind:CommunityDraftKind=(field==='w'?'WELCOME_':field==='f'?'FAREWELL_':
    field==='r'?'REPLIES_':field==='s'?'SERVICE_CLEANUP_':field==='b'?'REPLY_CLEANUP_':
    field==='d'?'DECISION_LOG_':field==='p'?'PRIVATE_WELCOME_':
    field==='u'?'FAREWELL_REMOVED_':field==='j'?'SERVICE_JOIN_':
    field==='l'?'SERVICE_LEAVE_':field==='v'?'GROUP_PROFILE_':
    field==='m'?'SERVICE_PROFILE_':'CHANGE_LOG_')+
   (value==='1'?'ON':'OFF') as CommunityDraftKind;
  const draft=await service.pending(actorId,{kind},toggle[1]!);
  return {text:'<b>تأكيد تغيير تفاعل المجموعة</b>\n'+service.preview(draft)+
   '\nالمجموعة: <code>'+draft.chatId+'</code>\nتغيير عام، لن يطبق قبل التأكيد.',
   keyboard:k([[btn('✅ اعتماد','p4c:1:c:'+draft.id)],
    [btn('❌ إلغاء','p4c:1:x:'+draft.id)],
    [btn('↩️ رجوع','p4c:1:g:'+draft.chatId)]])};
 }
 const reviewedFAQs=/^p4c:1:f:(-[1-9]\d{0,15}):(0|[1-9]\d{0,2})$/u.exec(data);
 if(reviewedFAQs){
  const id=reviewedFAQs[1]!,page=Number(reviewedFAQs[2]);
  const entries=await service.listReviewedFAQs(actorId,id);
  const pages=Math.max(1,Math.ceil(entries.length/6));
  if(page>=pages)return null;
  const rows:{text:string;callback_data:string}[][]=[];
  if(page>0)rows.push([btn('⬅️ السابق','p4c:1:f:'+id+':'+(page-1))]);
  if(page+1<pages)rows.push([btn('التالي ➡️','p4c:1:f:'+id+':'+(page+1))]);
  rows.push([btn('↩️ إعدادات المجموعة','p4c:1:g:'+id)]);
  return {text:'<b>📚 مصادر الأسئلة الشائعة المعتمدة</b>\nالمجموعة: <code>'+id+'</code>'+
   '\nتعرض الأسئلة المعتمدة ذات المنشورات والتصنيفات الظاهرة لهذه المجموعة فقط.'+
   '\n\n'+(entries.length?entries.slice(page*6,page*6+6).map((q,i)=>
    (i+1+page*6)+'. '+esc(q.question.slice(0,100))+'\n<code>'+q.id+'</code>').join('\n'):
    'لا توجد أسئلة منشورة ومراجعة صالحة للربط الآن.')+
   '\n\nلإنشاء رد على كلمة مفتاحية اكتب في خاص البوت:\n'+
   '<code>/replyfaq '+id+' WORD القبول | UUID</code>\n'+
   'استبدل UUID بالمعرّف الظاهر أعلاه. تتغير الإجابة تلقائيًا إذا تغيّر سجل FAQ المعتمد،'+
   ' ويُمنع إرسال الرد عند أرشفة السؤال أو مصدره. جميع التعديلات تخضع لاعتماد المالك.',
   keyboard:k(rows)};
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
   selected.map(r=>'<code>'+r.id+'</code> • '+(r.source??'رد ثابت')+' • '+r.match+' • '+esc(r.trigger.slice(0,65))+
   (r.source==='FAQ'?' • مرجع FAQ معتمد':'')+
   (r.enabled?' • نشط':' • متوقف')+' • '+(r.cooldownMs/1000)+' ثانية'+
   (r.topicId?' • موضوع '+r.topicId:'')).join('\n'):'لا توجد ردود.')+
   '\n\nرد ثابت: <code>/replynote '+c.chatId+' WORD تنبيه | نص الملاحظة</code>'+
   '\nقوانين معتمدة: <code>/replyrules '+c.chatId+' WORD القوانين</code>'+
   '\nFAQ معتمد: <code>/replyfaq '+c.chatId+' WORD القبول | UUID</code>',
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
