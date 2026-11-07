import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {ownerGroupCardLink} from './telegram-inline-groups.js';
import {TelegramBotApiModerationGateway,type TelegramGroupProfile} from './telegram-moderation-gateway.js';

/** 01-02: group linking is an owner-only, two-step, privately confirmed action.
 * Read-only Telegram membership preflight is advisory until independently
 * confirmed. No Telegram mutation and no inherited moderation powers.
 */
const PREFIX='owner-group-link:',TTL=120_000;
const CONFIRM=/^og:1:c:([A-Za-z0-9_-]{24})$/u;
const CANCEL=/^og:1:x:([A-Za-z0-9_-]{24})$/u;
const GROUP=/^-[1-9][0-9]{0,15}$/u;
const ACTOR=/^[1-9][0-9]{0,15}$/u;
const SCOPES=['navigation','assistant','moderation','verification','publishing'] as const;
type GroupScope=typeof SCOPES[number];
const labels:Record<GroupScope,string>={
 navigation:'التصفح',assistant:'المساعد',moderation:'الإشراف',
 verification:'التحقق والاشتراك',publishing:'النشر'
};
const validTime=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&
 n>=0&&n<=8_640_000_000_000_000-TTL;
const isGroup=(v:unknown):v is string=>typeof v==='string'&&GROUP.test(v)&&Number.isSafeInteger(Number(v));
const isActor=(v:unknown):v is string=>typeof v==='string'&&ACTOR.test(v)&&Number.isSafeInteger(Number(v));
const sha=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const button=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows}
});
interface Pending {id:string;scopes:GroupScope[];profileHash:string;createdAt:number;epoch:string;}
function validScopes(value:unknown):value is GroupScope[]{
 return Array.isArray(value)&&value.length>=1&&value.length<=SCOPES.length&&
  value[0]==='navigation'&&new Set(value).size===value.length&&
  value.every(x=>typeof x==='string'&&(SCOPES as readonly string[]).includes(x))&&
  value.slice(1).every((x,i,a)=>i===0||a[i-1]!<x);
}
function parsePending(value:string):Pending|null{
 let p:unknown;try{p=JSON.parse(value);}catch{return null;}
 if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const a=p as Record<string,unknown>;
 if(Object.keys(a).sort().join(',')!=='createdAt,epoch,id,profileHash,scopes'||
  !isGroup(a.id)||!validScopes(a.scopes)||!validTime(a.createdAt)||
  typeof a.profileHash!=='string'||!/^[a-f0-9]{64}$/u.test(a.profileHash)||
  typeof a.epoch!=='string'||!/^[a-f0-9]{64}$/u.test(a.epoch))return null;
 return a as unknown as Pending;
}
function parseCommand(cmd:string):{id:string;scopes:GroupScope[]}|null{
 const m=/^\/linkgroup (-[1-9][0-9]{0,15})(?: ([a-z,]{1,75}))?$/u.exec(cmd);
 if(!m||m[0]!==cmd||!isGroup(m[1]))return null;
 let all:GroupScope[]=['navigation'];
 if(m[2]){
  const opts=m[2].split(',');
  if(!opts.length||opts.length>SCOPES.length||new Set(opts).size!==opts.length||
     opts.some(x=>!(SCOPES as readonly string[]).includes(x)))return null;
  all=[...new Set(['navigation',...opts])] as GroupScope[];
 }
 return {id:m[1]!,scopes:['navigation',...all.filter(x=>x!=='navigation').sort()]};
}
/** A pending request becomes stale if group approvals, authorizations or
 * the owner-dashboard control change while Telegram is being consulted. */
function authEpoch(s:BotState,p:Policy,actor:string,id:string,now:number):string|null{
 if(!validTime(now)||!p.isOwner(actor)||!p.privateFeature(s,'owner.dashboard',actor)||
    !isActor(actor)||!isGroup(id)||s.chats.filter(c=>c.id===id).length>1||
    s.chats.some(c=>c.id===id&&c.approved))return null;
 return sha([actor,id,s.chats.map(c=>[c.id,c.version,c.approved,c.scopes,c.present,c.groupAI]),
  s.grants.filter(g=>g.actor===actor||g.chatId===id),
  s.privateSettingsRevision??0,s.privateFeatures['owner.dashboard']]);
}
export function validOwnerGroupLinkRoute(value:unknown):boolean{
 return typeof value==='string'&&Buffer.byteLength(value,'utf8')<=64&&
  (value==='mi:1:i:01:02'||CONFIRM.test(value)||CANCEL.test(value));
}
export class TelegramOwnerGroupLink{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:TelegramBotApiModerationGateway|undefined,
  private readonly safety:()=>Promise<boolean>,
  private readonly clock:()=>number=Date.now){}
 private async safe():Promise<boolean>{try{return await this.safety()===true;}catch{return false;}}
 private async eligible(id:string,actor:string,scopes:readonly GroupScope[]):Promise<TelegramGroupProfile|null>{
  if(!this.gateway||
     !TelegramBotApiModerationGateway.usesOfficialGroupLinkRead(this.gateway)||
     !await this.safe())return null;
  let profile:TelegramGroupProfile|null=null;
  try{profile=await this.gateway.inspectGroupLinkEligibility(id,actor);}catch{/* unknown */}
  if(profile&&scopes.includes('moderation')){
   // A chat administrator need not have the separate right to delete or
   // restrict. Do not issue even a *local* moderation scope without evidence.
   if(!TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway))return null;
   try{
    const rights=await this.gateway.inspectBotAdminRights(id);
    if(rights.delete!=='GRANTED'||rights.restrict!=='GRANTED')return null;
   }catch{return null;}
  }
  if(!await this.safe()||
     !TelegramBotApiModerationGateway.usesOfficialGroupLinkRead(this.gateway))return null;
  return profile;
 }
 async home(actor:string):Promise<OwnerInlineScreen|null>{
  const state=await this.store.snapshot(),now=this.clock();
  if(!validTime(now)||!isActor(actor)||!this.policy.isOwner(actor)||
     !this.policy.privateFeature(state,'owner.dashboard',actor))return null;
  return ui('<b>➕ ربط مجموعة بمنارتك</b>\n'+
   'أضف البوت مشرفًا في المجموعة، ويجب أن تكون أنت منشئ المجموعة أو مشرفًا لديها صلاحية إدارة المحادثة.\n'+
   'أرسل في خاص البوت الأمر:\n<code>/linkgroup -1001234567890</code>\n'+
   'يبدأ الربط بنطاق التصفح فقط. لإضافة نطاقات أخرى ضمن طلبك، أرسل مثلًا:\n'+
   '<code>/linkgroup -1001234567890 moderation,verification</code>\n'+
   'النطاقات الاختيارية: assistant، moderation، verification، publishing.\n'+
   'ستظهر معاينة مستقلة وموافقة خلال دقيقتين قبل الحفظ. لا يمنح الربط أي صلاحية Telegram أو يبدأ عقوبة.',
   [[button('📋 مجموعاتي','mi:1:i:01:01')],
    [button('↩️ المجموعات والشبكات','mi:1:s:01:0'),button('🏠 لوحة المالك','mi:1:h')]]);
 }
 async request(actor:string,text:string):Promise<OwnerInlineScreen|null>{
  const command=parseCommand(text);if(!command)return null;
  const now=this.clock(),before=await this.store.snapshot(),
   epoch=authEpoch(before,this.policy,actor,command.id,now);
  if(!epoch)return null;
  const profile=await this.eligible(command.id,actor,command.scopes);
  if(!profile)return null;
  const after=await this.store.snapshot(),at=this.clock();
  if(!validTime(at)||at<now||at>=now+TTL||
     authEpoch(after,this.policy,actor,command.id,at)!==epoch)return null;
  if(!await this.safe())return null;
  const proof=sha(profile);
  return this.store.transaction(s=>{
   const checked=this.clock();
   if(!validTime(checked)||checked<now||checked>=now+TTL||
      authEpoch(s,this.policy,actor,command.id,checked)!==epoch)return null;
   const open=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor&&!c.used&&!c.revoked);
   if(open.length>100)return null;
   for(const c of open)c.revoked=true;
   const token=randomBytes(18).toString('base64url');
   const pending:Pending={id:command.id,scopes:command.scopes,profileHash:proof,
    createdAt:checked,epoch};
   s.callbacks.push({ref:PREFIX+token,action:JSON.stringify(pending),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:checked+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة ربط مجموعة</b>\n'+
    'اسم المجموعة من Telegram: '+escape(profile.title)+'\n'+
    'المعرّف: <code>'+command.id+'</code>\n'+
    'النوع: '+(profile.kind==='GROUP'?'مجموعة':'مجموعة فائقة')+'\n'+
    'المشرفون: جرى التحقق من أن البوت وصاحب الطلب يديران هذه المجموعة وقت الفحص.\n'+
    'النطاقات المحلية المطلوبة: '+command.scopes.map(x=>labels[x]).join('، ')+'\n'+
   (command.scopes.includes('moderation')?
    'حقوق البوت للإشراف: تم رصد الحذف والتقييد وقت الفحص، وقد تتغير لاحقًا.\n':'')+
    'النتيجة: اعتماد محلي فقط؛ لا تُرقّى حسابات ولا تُنفذ عقوبات.\n'+
    'تأكيد واحد خلال دقيقتين، مع إعادة فحص صلاحيات Telegram لحظة التأكيد.',
    [[button('✅ تأكيد ربط المجموعة','og:1:c:'+token)],
     [button('✖ إلغاء الربط','og:1:x:'+token)],
     [button('↩️ قسم المجموعات','mi:1:s:01:0')]]);
  });
 }
 private pending(s:BotState,actor:string,token:string,now:number){
  const rows=s.callbacks.filter(c=>c.ref===PREFIX+token),c=rows[0];
  if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||
     c.policyVersion!==0||c.used||c.revoked||!c.oneShot||
     !validTime(now)||!validTime(c.expiresAt)||c.expiresAt<=now)return null;
  const payload=parsePending(c.action);
  if(!payload||c.expiresAt!==payload.createdAt+TTL||now<payload.createdAt||
     authEpoch(s,this.policy,actor,payload.id,now)!==payload.epoch)return null;
  return {c,payload};
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!validOwnerGroupLinkRoute(data))return null;
  if(data==='mi:1:i:01:02')return this.home(actor);
  const m=CONFIRM.exec(data)??CANCEL.exec(data);if(!m)return null;
  const token=m[1]!,confirm=CONFIRM.test(data);
  const start=this.clock(),snapshot=await this.store.snapshot(),
   attempt=this.pending(snapshot,actor,token,start);
  if(!attempt)return null;
  if(!confirm){
   return this.store.transaction(s=>{
    const current=this.pending(s,actor,token,this.clock());
    if(!current)return null;
    current.c.used=true;
    return ui('أُلغي طلب ربط المجموعة دون أي تعديل.',
     [[button('➕ ربط مجموعة أخرى','mi:1:i:01:02')],
      [button('🏠 لوحة المالك','mi:1:h')]]);
   });
  }
  const profile=await this.eligible(attempt.payload.id,actor,attempt.payload.scopes);
  if(!profile||sha(profile)!==attempt.payload.profileHash||!await this.safe())return null;
  const result=await this.store.transaction(s=>{
   const now=this.clock(),current=this.pending(s,actor,token,now);
   if(!current||!validTime(now)||now<start||now>=start+TTL||
      current.payload.profileHash!==sha(profile)||current.payload.epoch!==attempt.payload.epoch||
      !validScopes(current.payload.scopes))return null;
   const records=s.chats.filter(c=>c.id===current.payload.id);
   if(records.length>1||records[0]?.approved)return null;
   let chat:Chat;
   if(records.length===1){
    chat=records[0]!;
    // Reapproval must never revive a legacy, unversioned staff grant.
    // This is a fresh authorization epoch, not an undo of old privileges.
    for(const grant of s.grants)if(grant.chatId===chat.id)grant.revoked=true;
    if(!Number.isSafeInteger(chat.version)||chat.version<1||chat.version>=9_999_999_999)return null;
    chat.version++;chat.approved=true;chat.present=true;
    chat.scopes=[...current.payload.scopes];chat.groupAI='OFF';
   }else{
    chat={id:current.payload.id,approved:true,present:true,
     scopes:[...current.payload.scopes],version:1,groupAI:'OFF'};
    s.chats.push(chat);
   }
   current.c.used=true;
   s.audit.push({actorId:actor,updateKey:'owner:group:link:'+chat.id+':'+chat.version,
    decision:'ALLOW',reason:'OWNER_GROUP_LINK_REVIEWED_LOCAL',policyVersion:chat.version,at:now});
   return {id:chat.id,scopes:[...chat.scopes],link:ownerGroupCardLink(s,chat.id)};
  });
  if(!result)return null;
  return ui('<b>✅ اعتُمِدت المجموعة محليًا</b>\n'+
   'المعرّف: <code>'+result.id+'</code>\n'+
   'النطاقات: '+result.scopes.map(x=>labels[x as GroupScope]).join('، ')+'\n'+
   'تم حفظ القرار في سجل التدقيق. لا يغيّر الربط رتبة Telegram، ولا يعني تشغيل الحماية الحية.',
   [[button('👥 بطاقة المجموعة',result.link??'mi:1:i:01:01')],
    [button('➕ ربط مجموعة أخرى','mi:1:i:01:02')],
    [button('🏠 لوحة المالك','mi:1:h')]]);
 }
}
