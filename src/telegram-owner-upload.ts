import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const PREFIX='owner-upload:',TTL=120000;
const epoch=(s:BotState)=>createHash('sha256').update(JSON.stringify([s.privateFeatures,s.privateSettingsRevision,s.chats,s.grants])).digest('hex');
const scopes=(s:BotState,p:Policy,a:string,now:number)=>[
 ...(p.privateFeature(s,'content.upload',a)?['private']:[]),
 ...s.chats.filter(c=>s.chats.filter(x=>x.id===c.id).length===1&&p.canUseChat(s,c.id,'navigation')&&p.has(s,a,'content.upload',c.id,now)).map(c=>c.id).sort()
];
export const validOwnerUploadRoute=(data:string):boolean=>data==='ou:1:h'||data==='ou:1:x'||/^ou:1:p:(0|[1-9][0-9]{0,2})$/u.exec(data)?.[0]===data||/^ou:1:s:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
function cancel(s:BotState,a:string){
 for(const w of s.wizards)if(w.userId===a&&w.chatId===a&&w.flow.startsWith(PREFIX))w.status='CANCELLED';
 for(const c of s.callbacks)if(c.actorId===a&&c.ref.startsWith(PREFIX))c.revoked=true;
}
export async function cancelOwnerUpload(store:BotStore,actor:string):Promise<void>{await store.transaction(s=>{cancel(s,actor);});}
export async function renderOwnerUpload(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor)||!validOwnerUploadRoute(data))return null;
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!policy.privateFeature(s,'owner.dashboard',actor))return null;
  const available=scopes(s,policy,actor,now),back=[{text:'↩️ مراجعة الوارد / إلغاء الرفع',callback_data:'ou:1:x'},{text:'🏠 لوحة المالك',callback_data:'mi:1:h'}];
  if(data==='ou:1:x'){
   cancel(s,actor);return {text:'<b>أُلغي انتظار الملف</b>\nلم يتم تنزيل أو استيراد أي ملف بهذا الإلغاء.',keyboard:{inline_keyboard:[[{text:'🧾 مراجعة الوارد',callback_data:'mi:1:i:13:04'}],back.slice(1)]}};
  }
  if(data.startsWith('ou:1:s:')){
   const rows=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(7)),c=rows[0];
   if(rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.used!==false||c.revoked!==false||c.oneShot!==true||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(PREFIX))return null;
   let value:unknown;try{value=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
   if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||value[1]!==epoch(s)||!available.includes(value[0]))return null;
   c.used=true;const scope=value[0];cancel(s,actor);
   s.wizards=s.wizards.filter(w=>w.key!==PREFIX+actor);
   s.wizards.push({key:PREFIX+actor,userId:actor,chatId:actor,topicId:'',flow:PREFIX+JSON.stringify([scope,epoch(s)]),step:1,version:1,expiresAt:now+TTL,policyVersion:0,status:'ACTIVE'});
   return {text:'<b>أرسل الملف الآن 📥</b>\nالنطاق: <code>'+scope+'</code>\nأرسل ملف JSON أو CSV أو MD أو TXT داخل هذه المحادثة، دون تعليق. تنتهي الخطوة بعد دقيقتين. سيظهر تقرير فحص؛ الاعتماد والإتاحة يحتاجان تأكيدًا منفصلًا.',keyboard:{inline_keyboard:[back]}};
  }
  const page=data==='ou:1:h'?0:Number(data.slice(7)),pages=Math.max(1,Math.ceil(available.length/8));
  if(page>=pages)return null;cancel(s,actor);
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>now);
  const previous=s.callbacks.filter(c=>c.actorId===actor&&c.ref.startsWith(PREFIX));
  const rows=available.slice(page*8,page*8+8).map(scope=>{
   const nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:PREFIX+nonce,actorId:actor,chatId:'private',action:PREFIX+JSON.stringify([scope,epoch(s)]),policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   return [{text:scope==='private'?'👤 المكتبة الخاصة':'👥 المجموعة '+scope,callback_data:'ou:1:s:'+nonce}];
  });
  const remove=new Set(previous.slice(0,Math.max(0,previous.length+rows.length-128)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
  const controls=[] as {text:string;callback_data:string}[];
  if(page>0)controls.push({text:'⬅️ السابق',callback_data:'ou:1:p:'+(page-1)});
  if(page+1<pages)controls.push({text:'➡️ التالي',callback_data:'ou:1:p:'+(page+1)});
  if(controls.length)rows.push(controls);
  rows.push([{text:'⚙️ إعدادات الرفع في الخاص',callback_data:'mi:1:i:11:03'}],back);
  return {text:'<b>اختيار نطاق رفع الملف 📥</b>\nصفحة '+(page+1)+' من '+pages+'\n'+(available.length?'اختر المكتبة المستهدفة. رفع الملف للفحص لا ينشر محتواه.':'لا يوجد نطاق متاح للرفع حاليًا. فعّل رفع الخاص من الإعدادات أو راجع اعتماد المجموعة وصلاحية الرفع.'),keyboard:{inline_keyboard:rows}};
 });
}
/** Claim before any download. A second file needs a new explicit selection. */
export async function claimOwnerUpload(store:BotStore,policy:Policy,actor:string,clock:()=>number):Promise<string|null>{
 if(!policy.isOwner(actor))return null;
 return store.transaction(s=>{
  const now=clock(),rows=s.wizards.filter(w=>w.key===PREFIX+actor),w=rows[0];
  if(!Number.isSafeInteger(now)||now<0||!policy.privateFeature(s,'owner.dashboard',actor)||rows.length!==1||!w||w.userId!==actor||w.chatId!==actor||w.topicId!==''||w.status!=='ACTIVE'||w.step!==1||w.version!==1||w.policyVersion!==0||!Number.isSafeInteger(w.expiresAt)||w.expiresAt<=now||w.expiresAt>now+TTL||!w.flow.startsWith(PREFIX))return null;
  let v:unknown;try{v=JSON.parse(w.flow.slice(PREFIX.length));}catch{return null;}
  if(!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||v[1]!==epoch(s)||!scopes(s,policy,actor,now).includes(v[0]))return null;
  w.status='CANCELLED';return v[0];
 });
}
