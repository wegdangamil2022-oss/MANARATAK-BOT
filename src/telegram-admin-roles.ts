import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import {TelegramAdminRoleGateway,type AdminRole} from './telegram-admin-role-gateway.js';
const PREFIX='admin-role:';
const attemptKey=(d:Session)=>PREFIX+d.nonce+':'+d.group+':'+d.target+':'+d.role;
const unresolved=(s:BotState,d:Session)=>s.audit.some(a=>a.updateKey.startsWith(PREFIX)&&a.updateKey.split(':')[2]===d.group&&a.updateKey.split(':')[3]===d.target&&['ADMIN_ROLE_STARTED','ADMIN_ROLE_UNKNOWN_OUTCOME'].includes(a.reason));
const ROUTE=/^ar:1:g:(-[1-9][0-9]{0,15})$|^ar:1:p:([A-Za-z0-9_-]{24}):(DELETE|RESTRICT|DEMOTE)$|^ar:1:c:([A-Za-z0-9_-]{24})$/u;
export const validAdminRoleRoute=(v:string)=>ROUTE.exec(v)?.[0]===v;
type Session={nonce:string;group:string;source:string;phase:'INPUT'|'CHOOSE'|'CHECKING'|'CONFIRM'|'STARTED';target?:string;role?:AdminRole;baseline?:string};
const validSession=(d:Session):boolean=>{
 if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.nonce!=='string'||/^[A-Za-z0-9_-]{24}$/u.exec(d.nonce)?.[0]!==d.nonce||typeof d.group!=='string'||/^-[1-9][0-9]{0,15}$/u.exec(d.group)?.[0]!==d.group||!Number.isSafeInteger(Number(d.group))||typeof d.source!=='string'||/^[a-f0-9]{64}$/u.exec(d.source)?.[0]!==d.source||!['INPUT','CHOOSE','CHECKING','CONFIRM','STARTED'].includes(d.phase))return false;
 const keys=['nonce','group','source','phase'];
 if(d.phase!=='INPUT'){if(typeof d.target!=='string'||/^[1-9][0-9]{0,15}$/u.exec(d.target)?.[0]!==d.target||!Number.isSafeInteger(Number(d.target)))return false;keys.push('target');}
 if(['CHECKING','CONFIRM','STARTED'].includes(d.phase)){if(!d.role||!['DELETE','RESTRICT','DEMOTE'].includes(d.role))return false;keys.push('role');}
 if(['CONFIRM','STARTED'].includes(d.phase)){if(typeof d.baseline!=='string'||/^[a-f0-9]{64}$/u.exec(d.baseline)?.[0]!==d.baseline)return false;keys.push('baseline');}
 return Object.keys(d).length===keys.length&&Object.keys(d).every(k=>keys.includes(k));
};
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
const label=(role:AdminRole)=>role==='DELETE'?'ترقية بصلاحية حذف الرسائل':role==='RESTRICT'?'ترقية بصلاحية تقييد الأعضاء':'عزل المشرف وإزالة جميع صلاحياته';
const source=(s:BotState)=>createHash('sha256').update(JSON.stringify([s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null])).digest('hex');
/** Configured owner only. Telegram rights remain independent of internal grants. */
export class TelegramAdminRoles{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly gateway:TelegramAdminRoleGateway|undefined,private readonly clock:()=>number){}
 #authorized(s:BotState,actor:string,group:string,at:number):boolean{return Number.isSafeInteger(at)&&at>=0&&at<=8640000000000000-120000&&this.policy.isOwner(actor)&&this.policy.privateFeature(s,'owner.dashboard',actor)&&s.chats.filter(c=>c.id===group).length===1&&this.policy.canUseChat(s,group,'moderation')&&this.policy.has(s,actor,'chat.manage',group,at);}
 #session(s:BotState,actor:string):{data:Session;expires:number}|null{
  const rows=s.wizards.filter(w=>w.key===PREFIX+actor),w=rows[0],at=this.clock();if(rows.length!==1||!w||w.status!=='ACTIVE'||w.userId!==actor||w.chatId!==actor||!Number.isSafeInteger(w.expiresAt)||at>=w.expiresAt||w.expiresAt>at+120000||typeof w.flow!=='string'||!w.flow.startsWith(PREFIX))return null;
  try{const d=JSON.parse(w.flow.slice(PREFIX.length)) as Session;if(!validSession(d)||w.policyVersion!==this.policy.chatRevision(s,d.group)||w.topicId!==''||w.step!==0||w.version!==1||d.target!==undefined&&(this.policy.isOwner(d.target)||this.gateway?.isBot(d.target))||!this.#authorized(s,actor,d.group,at)||source(s)!==d.source)return null;return {data:d,expires:w.expiresAt};}catch{return null;}
 }
 async #screen(actor:string,text:string,rows:{text:string;callback_data:string}[][]=[]):Promise<Screen|null>{const s=await this.store.snapshot(),at=this.clock(),epoch=protectionUIEpoch(s,this.policy,actor,at);if(!this.policy.isOwner(actor)||!epoch||!Number.isSafeInteger(at)||at<0||at>8640000000000000-120000)return null;return {text,keyboard:{inline_keyboard:[...rows,[{text:'↩️ الصلاحيات والمجموعات',callback_data:'mi:1:i:03:06'},{text:'↩️ قسم المشرفين',callback_data:'mi:1:s:03:0'}]]},access:{actorId:actor,epoch,expiresAt:at+120000}};}
 async cancel(actor:string):Promise<void>{const s=await this.store.snapshot();if(!s.wizards.some(w=>w.key===PREFIX+actor&&w.status==='ACTIVE'))return;await this.store.transaction(s=>{for(const w of s.wizards)if(w.key===PREFIX+actor)w.status='CANCELLED';});}
 async input(actor:string,text:string):Promise<Screen|null>{
  const current=this.#session(await this.store.snapshot(),actor);
  if(current?.data.phase==='INPUT'&&(/^[1-9][0-9]{0,15}$/u.exec(text)?.[0]!==text||!Number.isSafeInteger(Number(text))||this.policy.isOwner(text)||this.gateway?.isBot(text)))return this.#screen(actor,'أرسل المعرف الرقمي لعضو بشري آخر دون مسافات أو رموز. لا يمكن استهداف المالك أو البوت. يمكنك الرجوع لإلغاء الطلب.');
  return this.store.transaction(s=>{const session=this.#session(s,actor);if(!session||session.data.phase!=='INPUT')return null;const d=session.data;if(/^[1-9][0-9]{0,15}$/u.exec(text)?.[0]!==text||!Number.isSafeInteger(Number(text))||this.policy.isOwner(text)||!this.gateway||!TelegramAdminRoleGateway.trusted(this.gateway)||this.gateway.isBot(text))return null;d.target=text;d.phase='CHOOSE';s.wizards.find(w=>w.key===PREFIX+actor)!.flow=PREFIX+JSON.stringify(d);return d;}).then(d=>d?this.#screen(actor,'<b>إدارة مشرف Telegram</b>\nالمجموعة: '+d.group+'\nالعضو: '+d.target+'\nاختر إجراء لمعاينته. الترقية تمنح أيضًا حق إدارة المحادثة الضمني في Telegram؛ لا تمنح إدارة المشرفين.',(['DELETE','RESTRICT','DEMOTE'] as const).map(role=>[{text:label(role),callback_data:'ar:1:p:'+d.nonce+':'+role}])):null);
 }
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(!this.policy.isOwner(actor)||!this.gateway||!TelegramAdminRoleGateway.trusted(this.gateway))return null;const route=ROUTE.exec(data);if(!route||route[0]!==data)return null;
  if(route[1]){
   const group=route[1],at=this.clock(),created=await this.store.transaction(s=>{if(!this.#authorized(s,actor,group,at))return false;s.wizards=s.wizards.filter(w=>w.key!==PREFIX+actor);const d:Session={nonce:randomBytes(18).toString('base64url'),group,source:source(s),phase:'INPUT'};s.wizards.push({key:PREFIX+actor,userId:actor,chatId:actor,topicId:'',flow:PREFIX+JSON.stringify(d),step:0,version:1,policyVersion:this.policy.chatRevision(s,group),expiresAt:at+120000,status:'ACTIVE'});return true;});
   return created?this.#screen(actor,'<b>إدارة مشرف Telegram</b>\nالمجموعة: '+group+'\nأرسل المعرف الرقمي للعضو في رسالة خاصة. لن يُنفذ شيء قبل المعاينة والتأكيد. للعدول استخدم الرجوع.'):null;
  }
  const nonce=route[2]??route[4]!,confirm=route[4]!==undefined;
  const claimed=await this.store.transaction(s=>{const session=this.#session(s,actor);if(!session||session.data.nonce!==nonce||session.data.phase!==(confirm?'CONFIRM':'CHOOSE'))return null;const d=session.data;if(!d.target||this.policy.isOwner(d.target)||unresolved(s,d))return null;
   if(confirm){if(!d.role||!d.baseline||s.audit.some(a=>a.updateKey===attemptKey(d)))return null;d.phase='STARTED';s.audit.push({actorId:actor,updateKey:attemptKey(d),decision:'ALLOW',reason:'ADMIN_ROLE_STARTED',policyVersion:this.policy.chatRevision(s,d.group),at:this.clock()});}else {d.phase='CHECKING';d.role=route[3] as AdminRole;}
   s.wizards.find(w=>w.key===PREFIX+actor)!.flow=PREFIX+JSON.stringify(d);return d;
  });
  if(!claimed)return null;
  const active=async()=>{const state=await this.store.snapshot(),session=this.#session(state,actor),rows=state.audit.filter(a=>a.updateKey===attemptKey(claimed));return !!session&&JSON.stringify(session.data)===JSON.stringify(claimed)&&(!confirm||rows.length===1&&rows[0]!.reason==='ADMIN_ROLE_STARTED');};
  const plan=await this.gateway.prepare(claimed.group,claimed.target!,claimed.role!,active);
  if(!confirm){
   if(!await active())return null;
   if(!plan){await this.store.transaction(s=>{const w=s.wizards.find(w=>w.key===PREFIX+actor);if(w?.flow===PREFIX+JSON.stringify(claimed))w.status='CANCELLED';});return this.#screen(actor,'تعذر اعتماد المعاينة: تحقق من عضوية الشخص، وإمكانية تعديل المشرف، وصلاحيات البوت. لم يُرسل تغيير.');}
   const saved=await this.store.transaction(s=>{const session=this.#session(s,actor);if(!session||JSON.stringify(session.data)!==JSON.stringify(claimed))return false;const d=session.data;d.phase='CONFIRM';d.baseline=plan.baseline;s.wizards.find(w=>w.key===PREFIX+actor)!.flow=PREFIX+JSON.stringify(d);return true;});
   return saved?this.#screen(actor,'<b>تأكيد تغيير مشرف Telegram</b>\nالمجموعة: '+claimed.group+'\nالعضو: '+claimed.target+'\nالإجراء: '+label(claimed.role!)+'\nلن تُمنح صلاحية ترقية مشرفين. التأكيد صالح لمدة دقيقتين من بدء الطلب؛ الرجوع يلغي الطلب.',[[{text:'✅ تأكيد التنفيذ مرة واحدة',callback_data:'ar:1:c:'+nonce}]]):null;
  }
  let outcome:'DENIED'|'CONFIRMED'|'UNKNOWN_OUTCOME'='DENIED';
  try{if(plan&&plan.baseline===claimed.baseline&&await active())outcome=await this.gateway.execute(plan,active);}catch{outcome='UNKNOWN_OUTCOME';}
  const canDisplay=await active();
  await this.store.transaction(s=>{const rows=s.audit.filter(a=>a.updateKey===attemptKey(claimed));if(rows.length===1&&rows[0]!.reason==='ADMIN_ROLE_STARTED'){rows[0]!.reason='ADMIN_ROLE_'+outcome;rows[0]!.decision=outcome==='CONFIRMED'?'ALLOW':'DENY';}const w=s.wizards.find(w=>w.key===PREFIX+actor);if(w?.flow===PREFIX+JSON.stringify(claimed))w.status='CANCELLED';});
  return canDisplay?this.#screen(actor,outcome==='CONFIRMED'?'✅ تأكد تنفيذ التغيير بقراءة حالة العضو من Telegram.':outcome==='DENIED'?'لم يُرسل تغيير؛ تغيرت الصلاحيات أو حالة العضو أو انتهى الطلب.':'نتيجة التغيير غير محسومة. افحص Telegram يدويًا؛ لا إعادة تلقائية لهذه المحاولة.'):null;
 }
}
