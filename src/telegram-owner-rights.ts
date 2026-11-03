import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {TelegramBotApiModerationGateway,type BotAdminRights} from './telegram-moderation-gateway.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
const ROUTE=/^tr:1:p:(0|[1-9][0-9]{0,2})$|^tr:1:g:(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$/u;
const PREFIX='owner-rights:';
export const validOwnerRightsRoute=(data:string)=>ROUTE.exec(data)?.[0]===data;
const chatId=(v:string)=>/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const groupList=(s:BotState,p:Policy,actor:string,now:number)=>s.chats.filter(c=>chatId(c.id)&&s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'moderation')&&p.has(s,actor,'chat.manage',c.id,now)).sort((a,b)=>a.id.localeCompare(b.id));
const session=(s:BotState,actor:string,now:number)=>{const rows=s.wizards.filter(w=>w.key===PREFIX+actor),w=rows[0];return rows.length===1&&w?.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&/^owner-rights:[A-Za-z0-9_-]{24}$/u.exec(w.flow)?.[0]===w.flow&&Number.isSafeInteger(w.expiresAt)&&w.expiresAt>now&&w.expiresAt<=now+120000?w:null;};
const proof=(s:BotState,p:Policy,actor:string,now:number)=>createHash('sha256').update(JSON.stringify([actor,groupList(s,p,actor,now),s.grants,s.privateFeatures,s.privateSettingsRevision,session(s,actor,now)])).digest('hex').slice(0,16);
const unknownRights=():BotAdminRights=>({restrict:'UNKNOWN',delete:'UNKNOWN',invite:'UNKNOWN',pin:'UNKNOWN',changeInfo:'UNKNOWN',promote:'UNKNOWN',manageTopics:'UNKNOWN'});
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
/** Owner-only advisory check; it never changes Telegram or grants local rights. */
export class TelegramOwnerRights{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gateway:TelegramBotApiModerationGateway|undefined,private readonly clock:()=>number,private readonly safety:()=>Promise<boolean>){}
 async cancel(actor:string):Promise<void>{const snapshot=await this.store.snapshot();if(!snapshot.wizards.some(w=>w.key===PREFIX+actor&&w.status==='ACTIVE'))return;await this.store.transaction(s=>{for(const w of s.wizards)if(w.key===PREFIX+actor)w.status='CANCELLED';});}
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(!this.policy.isOwner(actor))return null;
  const root=data==='mi:1:i:03:06',route=ROUTE.exec(data);if(!root&&(!route||route[0]!==data))return null;
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
  let initial=await this.store.snapshot();if(!this.policy.privateFeature(initial,'owner.dashboard',actor))return null;
  if((root||route?.[1]!==undefined)&&groupList(initial,this.policy,actor,now).length){
   await this.store.transaction(s=>{if(!this.policy.privateFeature(s,'owner.dashboard',actor))return;s.wizards=s.wizards.filter(w=>w.key!==PREFIX+actor);s.wizards.push({key:PREFIX+actor,userId:actor,chatId:actor,topicId:'',flow:PREFIX+randomBytes(18).toString('base64url'),step:0,version:1,policyVersion:0,expiresAt:now+120000,status:'ACTIVE'});});
   initial=await this.store.snapshot();if(!session(initial,actor,now))return null;
  }
  const groups=groupList(initial,this.policy,actor,now),page=root?0:Number(route![1]??route![2]);
  if(page>=Math.max(1,Math.ceil(groups.length/8)))return null;
  let expected=proof(initial,this.policy,actor,now);const slot=route?.[3]===undefined?null:Number(route[3]),selected=slot===null?undefined:groups[page*8+slot-1];
  if(slot!==null&&(!selected||!session(initial,actor,now)||route![4]!==expected))return null;
  if(slot!==null){
   const flow=PREFIX+randomBytes(18).toString('base64url');
   const claimed=await this.store.transaction(s=>{const at=this.clock(),active=session(s,actor,at);if(!Number.isSafeInteger(at)||at<now||at>=now+120000||!active||!this.policy.privateFeature(s,'owner.dashboard',actor)||proof(s,this.policy,actor,at)!==expected)return null;active.flow=flow;return proof(s,this.policy,actor,at);});
   if(!claimed)return null;
   initial=await this.store.snapshot();const at=this.clock();if(!Number.isSafeInteger(at)||at<now||at>=now+120000||session(initial,actor,at)?.flow!==flow||!this.policy.privateFeature(initial,'owner.dashboard',actor)||proof(initial,this.policy,actor,at)!==claimed)return null;
   expected=claimed;
  }
  const current=(state:BotState,at:number)=>Number.isSafeInteger(at)&&at>=now&&at<now+120000&&this.policy.privateFeature(state,'owner.dashboard',actor)&&(slot===null||!!session(state,actor,at))&&proof(state,this.policy,actor,at)===expected;
  let rights=unknownRights();
  if(selected&&this.gateway&&TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway)){
   let allowed=false;try{allowed=await this.safety()===true;}catch{/* fail closed */}
   if(allowed){const beforeRead=await this.store.snapshot();if(!current(beforeRead,this.clock())||!TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway))return null;try{rights=await this.gateway.inspectBotAdminRights(selected.id);}catch{/* no conclusion */}}
   try{if(await this.safety()!==true)rights=unknownRights();}catch{rights=unknownRights();}
   if(!TelegramBotApiModerationGateway.usesOfficialRightsRead(this.gateway))rights=unknownRights();
  }
  const after=await this.store.snapshot(),at=this.clock();
  if(!current(after,at))return null;
  const access=protectionUIEpoch(after,this.policy,actor,at);if(!access)return null;
  const b=(text:string,callback_data:string)=>({text,callback_data});
  const describe=(right:BotAdminRights[keyof BotAdminRights])=>right==='GRANTED'?'متاح':right==='DENIED'?'غير متاح':'تعذر التحقق';
  if(selected)return {text:'<b>صلاحيات البوت في المجموعة</b>\nالمجموعة: '+selected.id+'\nحق تقييد الأعضاء: '+describe(rights.restrict)+'\nحذف الرسائل: '+describe(rights.delete)+'\nدعوة المستخدمين: '+describe(rights.invite)+'\nتثبيت الرسائل: '+describe(rights.pin)+'\nتغيير معلومات المجموعة: '+describe(rights.changeInfo)+'\nإدارة المشرفين: '+describe(rights.promote)+'\nإدارة المواضيع: '+describe(rights.manageTopics)+'\nهذه قراءة لحظة الفحص وقد تتغير. لا تثبت صلاحيات المشرفين الآخرين، ولا تنفذ ترقية أو عقوبة.',keyboard:{inline_keyboard:[[b('🛡 إدارة مشرف Telegram','ar:1:g:'+selected.id)],[b('🧾 مراجعة المحاولات','ar:1:u:'+selected.id+':0')],[b('🔄 إعادة الفحص','tr:1:g:'+page+':'+slot+':'+expected)],[b('↩️ المجموعات','tr:1:p:'+page),b('↩️ قسم المشرفين','mi:1:s:03:0')]]},access:{actorId:actor,epoch:access,expiresAt:now+120000}};
  const pages=Math.max(1,Math.ceil(groups.length/8)),rows=groups.slice(page*8,page*8+8).map((c,i)=>[b('👥 '+c.id,'tr:1:g:'+page+':'+(i+1)+':'+expected)]);
  if(page>0)rows.push([b('⬅️ السابق','tr:1:p:'+(page-1))]);if(page+1<pages)rows.push([b('➡️ التالي','tr:1:p:'+(page+1))]);rows.push([b('↩️ قسم المشرفين','mi:1:s:03:0'),b('🏠 لوحة المالك','mi:1:h')]);
  return {text:'<b>صلاحيات Telegram</b>\nاختر مجموعة مخولة لفحص حقوق البوت الأساسية. هذا فحص قراءة فقط ولا يعين مشرفًا أو يغير صلاحية.\n'+(this.gateway?'الفحص يتحقق عند الاختيار.':'الفحص غير مهيأ في هذا التشغيل.')+'\nصفحة '+(page+1)+' من '+pages,keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:access,expiresAt:now+120000}};
 }
}
