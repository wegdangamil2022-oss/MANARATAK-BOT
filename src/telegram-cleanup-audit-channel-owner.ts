import {randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {GroupCleanupAudit} from './group-cleanup-audit.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

const PREFIX='cleanup-audit-channel-owner:',TTL=120000;
const route=/^cu:1:c:([A-Za-z0-9_-]{24})$/u;
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const validTime=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const validHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export const validCleanupAuditChannelRoute=(v:string)=>v==='cu:1:h'||route.test(v);
type View=OwnerInlineScreen&{access:AdminUIAccess};
const controls=(rows:{text:string;callback_data:string}[][]):OwnerInlineScreen['keyboard']=>({inline_keyboard:rows});
/** Only a private owner command can supply a destination; no group-posted
 * text or forwarded message automatically authorizes a channel. */
export class TelegramCleanupAuditChannelOwner{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly audit:GroupCleanupAudit,private readonly clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string,now:number):boolean{
  return validTime(now)&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private async view(actor:string,text:string,keyboard:OwnerInlineScreen['keyboard']):Promise<View|null>{
  const s=await this.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,now);
  return this.auth(s,actor,now)&&epoch?{text,keyboard,access:{actorId:actor,epoch,expiresAt:now+TTL}}:null;
 }
 async handle(actor:string,input:string):Promise<View|null>{
  if(!this.policy.isOwner(actor))return null;
  if(input==='cu:1:h')
   return this.view(actor,'<b>📢 قناة تدقيق الحذف الخاصة</b>\n' +
    'أضف البوت مشرفًا في قناة Telegram خاصة، مع إذن نشر الرسائل. تأكد أن القناة بلا معرّف عام.\n' +
    'من خاص البوت أرسل: <code>/auditchannel رقم_المجموعة رقم_القناة</code>\n' +
    'ولإلغاء وجهة القناة أرسل: <code>/auditchanneloff رقم_المجموعة</code>\n' +
    'سيفحص البوت هوية القناة وحق النشر قبل عرض التأكيد، ويعيدهما قبل كل تقرير. تفعيل تدقيق الحذف نفسه مستقل بعد اختيار القناة.',
    controls([[{text:'↩️ الرسائل الخدمية',callback_data:'mi:1:i:09:04'}]]));
  const callback=route.exec(input);
  if(callback?.[0]===input){
   const pending=await this.store.transaction(s=>{
    const now=this.clock(),matches=s.callbacks.filter(c=>c.ref===PREFIX+callback[1]),c=matches[0];
    if(!this.auth(s,actor,now)||matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||
       c.policyVersion!==0||c.used||c.revoked||!c.oneShot||!validTime(c.expiresAt)||
       c.expiresAt<=now||c.expiresAt>now+TTL)return null;
    let raw:unknown;try{raw=JSON.parse(c.action);}catch{return null;}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).sort().join(',')!=='channel,expected,group,issued'||
       !group(v.group)||v.channel!==null&&(!group(v.channel)||v.channel===v.group)||
       !validHash(v.expected)||!validTime(v.issued)||v.issued>now||c.expiresAt!==v.issued+TTL||
       this.audit.channelEpoch(s,v.group)!==v.expected)return null;
    c.used=true;
    for(const other of s.callbacks)if(other.actorId===actor&&other.ref.startsWith(PREFIX)&&!other.used)other.revoked=true;
    return {group:v.group,channel:v.channel as string|null,expected:v.expected as string,ref:c.ref};
   });
   if(!pending||!await this.audit.configureChannel(actor,pending.group,pending.channel,pending.expected,pending.ref))return null;
   const s=await this.store.snapshot(),channel=this.audit.channel(s,pending.group);
   return this.view(actor,'<b>✅ حُفظ قرار القناة</b>\nالمجموعة: '+pending.group+
    '\nالوجهة: '+(channel?.channel??'لا توجد قناة محددة')+
    '\nإعداد تدقيق الحذف يحتاج موافقة تشغيل جديدة بعد كل تغيير وجهة. لا تُرسل تقارير قديمة بأثر رجعي.',
    controls([[{text:'🧹 إعداد تدقيق الحذف',callback_data:'mi:1:i:09:04'}],
     [{text:'↩️ مساعدة القنوات',callback_data:'cu:1:h'}]]));
  }
  const set=/^\/auditchannel (-[1-9][0-9]{0,15}) (-[1-9][0-9]{0,15})$/u.exec(input);
  const off=/^\/auditchanneloff (-[1-9][0-9]{0,15})$/u.exec(input);
  if((!set||set[0]!==input)&&(!off||off[0]!==input))return null;
  const chat=(set?.[1]??off?.[1])!,destination=set?.[2]??null;
  if(!group(chat)||destination!==null&&(!group(destination)||destination===chat))return null;
  const s=await this.store.snapshot(),now=this.clock();
  if(!this.auth(s,actor,now)||!this.policy.canUseChat(s,chat,'moderation')||
     s.chats.filter(c=>c.id===chat).length!==1)return null;
  if(destination!==null){
   const verified=await this.audit.channelStatus(destination);
   if(verified!=='GRANTED')return this.view(actor,'<b>تعذر اعتماد القناة</b>\nلم تثبت القناة الخاصة الحالية أو صلاحية نشر البوت من Telegram.\nتأكد من رقم القناة وأنها من نوع channel بلا معرّف عام، وأن البوت مشرف يملك can_post_messages.\nلا تغيير في الإعدادات.',
    controls([[{text:'↩️ التعليمات',callback_data:'cu:1:h'}]]));
  }else if(!this.audit.channel(s,chat)?.channel)return null;
  const expected=this.audit.channelEpoch(s,chat),nonce=randomBytes(18).toString('base64url');
  const committed=await this.store.transaction(state=>{
   const at=this.clock();
   if(!this.auth(state,actor,at)||this.audit.channelEpoch(state,chat)!==expected||
      !validTime(at)||at<now||at>now+TTL)return false;
   for(const cb of state.callbacks)if(cb.actorId===actor&&cb.ref.startsWith(PREFIX)&&!cb.used)cb.revoked=true;
   state.callbacks.push({ref:PREFIX+nonce,action:JSON.stringify({group:chat,channel:destination,expected,issued:at}),
    actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:at+TTL});
   return true;
  });
  if(!committed)return null;
  return this.view(actor,'<b>معاينة '+(destination===null?'إلغاء':'ربط')+' قناة تدقيق الحذف</b>\nالمجموعة: '+chat+
   '\nالقناة: '+(destination??this.audit.channel(s,chat)?.channel??'غير موجودة')+
   '\n'+(destination===null?'سيتوقف الإرسال إلى القناة المحددة، ويلزم تفويض جديد لأي وجهة أخرى.':
    'تحقق Telegram من نوع القناة الخاصة وحق البوت في النشر. التأكيد لا يفعل التدقيق تلقائيًا؛ عليك تفعيله من 09:04 بصورة مستقلة.')+
   '\nالتأكيد لمرة واحدة فقط، ويبطل بتغيير اعتماد المجموعة أو إعداد القناة.',
   controls([[{text:'✅ تأكيد قرار القناة',callback_data:'cu:1:c:'+nonce}],
    [{text:'↩️ إلغاء',callback_data:'cu:1:h'}]]));
 }
}
