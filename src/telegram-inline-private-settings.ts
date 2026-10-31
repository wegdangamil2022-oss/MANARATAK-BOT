import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore,PrivateAIMode} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

const features={e:['education.navigate','تصفح التعليم'],s:['support.use','الدعم'],v:['subscription.verify','التحقق من الاشتراك'],u:['content.upload','رفع الملفات'],d:['owner.dashboard','لوحة المالك']} as const;
type Key=keyof typeof features|'a';
const modes=['OFF','STAFF_ONLY','ALL_OPT_IN'] as const;
const labels:Record<PrivateAIMode,string>={OFF:'مغلق',STAFF_ONLY:'الموظفون المصرح لهم',ALL_OPT_IN:'المستخدم الذي وافق'};
const line=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const prefix='private.settings:';
export function validPrivateSettingsRoute(data:string):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data)>64)return false;
 const m=/^(?:ps:1:h|ps:1:r:[esvud]:[01]:[a-f0-9]{16}|ps:1:r:a:(?:OFF|STAFF_ONLY|ALL_OPT_IN):[a-f0-9]{16}|ps:1:c:[A-Za-z0-9_-]{24})$/u.exec(data);return m?.[0]===data;
}
function stateProof(s:BotState):string|null{
 if(!s.privateFeatures||typeof s.privateFeatures!=='object'||Array.isArray(s.privateFeatures)||!modes.includes(s.privateAI)||!Number.isSafeInteger(s.privateSettingsRevision??0)||(s.privateSettingsRevision??0)<0||(s.privateSettingsRevision??0)>=Number.MAX_SAFE_INTEGER-1)return null;
 const values=Object.values(features).map(([name])=>s.privateFeatures[name]);
 if(values.some(v=>v!==undefined&&typeof v!=='boolean'))return null;
 return createHash('sha256').update(JSON.stringify([s.privateSettingsRevision??0,s.privateAI,...values])).digest('hex').slice(0,16);
}
const actual=(s:BotState,key:Key):boolean|PrivateAIMode=>key==='a'?s.privateAI:s.privateFeatures[features[key][0]]===true;
const description=(key:Key,value:boolean|PrivateAIMode)=>key==='a'?labels[value as PrivateAIMode]:value?'مفعّل':'معطّل';
function title(key:Key){return key==='a'?'أسئلة الخاص':features[key][1];}
function parseReview(data:string):{key:Key;target:boolean|PrivateAIMode;proof:string}|null{
 const m=/^ps:1:r:([esvud]):([01]):([a-f0-9]{16})$/u.exec(data);if(m&&m[0]===data)return {key:m[1] as Key,target:m[2]==='1',proof:m[3]!};
 const a=/^ps:1:r:a:(OFF|STAFF_ONLY|ALL_OPT_IN):([a-f0-9]{16})$/u.exec(data);return a&&a[0]===data?{key:'a',target:a[1] as PrivateAIMode,proof:a[2]!}:null;
}
export async function renderPrivateSettings(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor)||data!=='mi:1:i:11:03'&&!validPrivateSettingsRoute(data))return null;
 try{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
  if(data.startsWith('ps:1:c:')){
   const result=await store.transaction(s=>{
    if(!policy.isOwner(actor))return false;
    const ref='c_'+data.slice(7),rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
    if(rows.length!==1||!c||!/^c_[A-Za-z0-9_-]{24}$/u.test(ref)||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000||!c.action.startsWith(prefix))return false;
    const v:unknown=JSON.parse(c.action.slice(prefix.length));if(!Array.isArray(v)||v.length!==3||typeof v[0]!=='string'||typeof v[2]!=='string'||!/^([esvuda])$/u.test(v[0]))return false;
    const key=v[0] as Key,target=v[1];if(key==='a'?!modes.includes(target as PrivateAIMode):typeof target!=='boolean')return false;
    if(stateProof(s)!==v[2]||actual(s,key)===target||!policy.privateFeature(s,'owner.dashboard',actor)&&!(key==='d'&&target===true))return false;
    if(key==='a')s.privateAI=target as PrivateAIMode;else s.privateFeatures[features[key][0]]=target as boolean;
    s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;c.used=true;
    s.audit.push({actorId:actor,updateKey:'private-settings:'+ref,decision:'ALLOW',reason:'PRIVATE_SETTING_CHANGED_'+key,policyVersion:s.privateSettingsRevision,at:now});return true;
   });if(!result)return null;data='ps:1:h';
  }
  const review=parseReview(data);
  if(review){
   const ref=await store.transaction(s=>{
    if(!policy.isOwner(actor)||stateProof(s)!==review.proof||actual(s,review.key)===review.target||!policy.privateFeature(s,'owner.dashboard',actor)&&!(review.key==='d'&&review.target===true))return null;
    s.callbacks=s.callbacks.filter(c=>!c.action.startsWith(prefix)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt>now);
    if(s.callbacks.filter(c=>c.action.startsWith(prefix)&&c.expiresAt>now).length>=100)return null;
    const ref='c_'+randomBytes(18).toString('base64url');s.callbacks.push({ref,action:prefix+JSON.stringify([review.key,review.target,review.proof]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});return ref;
   });if(!ref)return null;
   const s=await store.snapshot();if(stateProof(s)!==review.proof)return null;
   return ui('<b>معاينة إعداد الخاص</b>\n'+title(review.key)+': '+description(review.key,actual(s,review.key))+' ← '+description(review.key,review.target)+'\nالتغيير لهذا المفتاح فقط. تنتهي المعاينة بعد دقيقتين.'+(review.key==='d'&&review.target===false?'\nلاستعادة اللوحة لاحقًا استخدم /ownerrecover في خاص البوت.':''),[[line('✅ تأكيد','ps:1:c:'+ref.slice(2))],[line('إلغاء','ps:1:h')]]);
  }
  if(data!=='ps:1:h'&&data!=='mi:1:i:11:03')return null;
  const s=await store.snapshot(),proof=stateProof(s);if(!proof)return null;
  const enabled=policy.privateFeature(s,'owner.dashboard',actor);
  if(!enabled)return ui('<b>استعادة لوحة المالك</b>\nاللوحة معطلة. يمكن للمالك وحده إعادة تفعيلها بعد المعاينة.',[[line('🟢 إعادة تفعيل اللوحة','ps:1:r:d:1:'+proof)]]);
  const keys=['e','s','v','u','d'] as const,rows=keys.map(key=>[line((actual(s,key)?'🟢 ':'⚪ ')+title(key)+': '+description(key,actual(s,key)),'ps:1:r:'+key+':'+(actual(s,key)?0:1)+':'+proof)]);
  rows.push(...modes.filter(mode=>mode!==s.privateAI).map(mode=>[line('أسئلة الخاص: '+labels[mode],'ps:1:r:a:'+mode+':'+proof)]));
  rows.push([line('↩️ المساعد الذكي','mi:1:s:11:0'),line('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>مفاتيح خدمات الخاص</b>\nأسئلة الخاص: '+labels[s.privateAI]+'\nكل مفتاح مستقل، وتغيير الإعداد لا يُشغّل مزودًا خارجيًا. تظهر حالة سياسة الدعم حتى قبل اكتمال خدمته.',rows);
 }catch{return null;}
}
