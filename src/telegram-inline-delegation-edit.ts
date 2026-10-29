import {randomBytes} from 'node:crypto';
import type {BotState,BotStore,Capability,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {delegationFingerprint} from './delegation-fingerprint.js';
import {selectedOwnerDelegation} from './telegram-inline-delegations.js';
const roles={a:['ai.ask','سؤال المساعد','assistant'],c:['content.publish','نشر المحتوى','publishing'],d:['content.upload','رفع المحتوى','navigation'],e:['chat.manage','إدارة المجموعة','moderation']} as const;
type Role=keyof typeof roles;
const group='(-[1-9][0-9]{0,18})',ver='([1-9][0-9]{0,9})',page='(0|[1-9][0-9]{0,2})',slot='([1-8])',role='([acde])';
const list=new RegExp('^od:1:g:'+page+'$','u'),choose=new RegExp('^od:1:b:'+group+':'+ver+':'+page+'$','u'),duration=new RegExp('^od:1:k:'+group+':'+ver+':'+page+':'+role+'$','u'),input=new RegExp('^od:1:t:'+group+':'+ver+':'+page+':'+role+':(1|7|30)$','u'),revoke=new RegExp('^od:1:r:'+page+':'+slot+':([a-f0-9]{12})$','u'),confirm=/^od:1:c:([A-Za-z0-9_-]{24})$/u;
export function validDelegationEditRoute(data:string):boolean{
 return typeof data==='string'&&Buffer.byteLength(data)<=64&&(data==='od:1:x'||[list,choose,duration,input,revoke,confirm].some(re=>{const m=re.exec(data);return m?.[0]===data;}));
}
const button=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const escape=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;');
const allGroups=(s:BotState):Chat[]=>s.chats.filter(c=>c.approved&&/^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(Number(c.id))&&Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9999999999&&s.chats.filter(x=>x.id===c.id).length===1).sort((a,b)=>a.id.localeCompare(b.id));
const INPUT='delegation.input:',CONFIRM='delegation.confirm:';
export class OwnerDelegationEditor{
 constructor(private store:BotStore,private policy:Policy,private clock:()=>number=Date.now){}
 private auth(s:BotState,actor:string):number{const now=this.clock();if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-30*86400000)throw Error('DELEGATION_DENIED');return now;}
 private group(s:BotState,id:string,version:number,p:number):Chat{
  if(!Number.isSafeInteger(p)||p<0||p>999)throw Error('DELEGATION_GROUP_STALE');
  const all=allGroups(s),chat=all.slice(p*8,p*8+8).find(x=>x.id===id&&x.version===version);if(!chat)throw Error('DELEGATION_GROUP_STALE');return chat;
 }
 async cancel(actor:string):Promise<void>{await this.store.transaction(s=>{if(!this.policy.isOwner(actor))return;for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false)c.revoked=true;});}
 private async begin(actor:string,id:string,version:number,p:number,code:Role,days:number):Promise<void>{await this.store.transaction(s=>{
  const now=this.auth(s,actor),chat=this.group(s,id,version,p);if(!Object.hasOwn(roles,code)||!chat.scopes.includes(roles[code][2])||![1,7,30].includes(days))throw Error('DELEGATION_INPUT_INVALID');
  for(const c of s.callbacks)if(c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false)c.revoked=true;
  if(s.buttonStudio)s.buttonStudio.inputs=s.buttonStudio.inputs.filter(i=>i.actor!==actor);
  s.callbacks.push({ref:'c_'+randomBytes(18).toString('base64url'),action:INPUT+JSON.stringify([id,version,p,code,days]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+600000});
 });}
 async previewInput(actor:string,text:string):Promise<OwnerInlineScreen|null>{return this.store.transaction(s=>{
  const pending=s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(INPUT)&&c.used===false&&c.revoked===false);if(!pending.length)return null;
  const now=this.auth(s,actor),c=pending[0]!;if(pending.length!==1||!/^c_[A-Za-z0-9_-]{24}$/u.test(c.ref)||s.callbacks.filter(x=>x.ref===c.ref).length!==1||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+600000)throw Error('DELEGATION_INPUT_STALE');
  const v:unknown=JSON.parse(c.action.slice(INPUT.length));if(!Array.isArray(v)||v.length!==5||typeof v[0]!=='string'||!Number.isSafeInteger(v[1])||!Number.isSafeInteger(v[2])||typeof v[3]!=='string'||!Object.hasOwn(roles,v[3])||![1,7,30].includes(v[4]))throw Error('DELEGATION_INPUT_INVALID');
  const id=v[0],version=v[1] as number,p=v[2] as number,code=v[3] as Role,days=v[4] as number,chat=this.group(s,id,version,p);if(!chat.scopes.includes(roles[code][2]))throw Error('DELEGATION_GROUP_STALE');
  if(!/^[1-9][0-9]{0,15}$/u.test(text)||!Number.isSafeInteger(Number(text))||text===actor)throw Error('DELEGATION_MEMBER_INVALID');
  const capability=roles[code][0] as Capability;if(!this.policy.canIssueGroupGrant(s,text,capability,id,now))throw Error('DELEGATION_ALREADY_ACTIVE_OR_AMBIGUOUS');
  s.callbacks=s.callbacks.filter(x=>!x.action.startsWith(CONFIRM)||!Number.isSafeInteger(x.expiresAt)||x.expiresAt>now);
  if(s.callbacks.filter(x=>x.action.startsWith(CONFIRM)&&x.expiresAt>now).length>=200)throw Error('DELEGATION_REVIEW_LIMIT');
  const expiresAt=now+days*86400000,proof=delegationFingerprint(s,text,capability,id),ref='c_'+randomBytes(18).toString('base64url');
  s.callbacks.push({ref,action:CONFIRM+JSON.stringify(['GRANT',text,capability,id,version,expiresAt,p,proof]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:now+120000});c.used=true;
  return ui('<b>معاينة تفويض داخلي</b>\nالنطاق: <code>'+escape(id)+'</code>\nالمستخدم: <code>'+escape(text)+'</code>\nالقدرة: '+roles[code][1]+'\nالمدة: '+days+' يوم\nهذا التفويض محلي فقط ولا يمنح حقوق Telegram. لم يُحفظ بعد.',[[button('✅ تأكيد التفويض','od:1:c:'+ref.slice(2))],[button('إلغاء','od:1:g:'+p)]]);
 });}
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validDelegationEditRoute(data))return null;
  try{
   await this.cancel(actor);
   const selectedConfirm=confirm.exec(data);if(selectedConfirm){const applied=await this.policy.confirmOwnerDelegation(actor,'c_'+selectedConfirm[1],this.clock());if(!applied)return null;
    return ui('<b>حُفظ '+(applied.kind==='GRANT'?'التفويض':'السحب')+' محليًا ✅</b>\nالنطاق: <code>'+escape(applied.chatId)+'</code>\nالمستخدم: <code>'+escape(applied.actor)+'</code>\nالقدرة: <code>'+escape(applied.capability)+'</code>\nلم تتغير حقوق Telegram.',[[button('↩️ التفويضات','mi:1:d:p:'+(applied.kind==='GRANT'?0:applied.page)),button('🏠 لوحة المالك','mi:1:h')]]);
   }
   if(data==='od:1:x')return ui('أُلغيت خطوة التفويض.',[[button('↩️ التفويضات','mi:1:i:03:01')]]);
   const state=await this.store.snapshot(),now=this.auth(state,actor),r=revoke.exec(data);
   if(r){
    const p=Number(r[1]),ordinal=Number(r[2]),grant=selectedOwnerDelegation(state,now,{kind:'detail',page:p,ordinal,digest:r[3]!});
    if(!grant||!grant.chatId.startsWith('-')||!this.policy.has(state,grant.actor,grant.capability,grant.chatId,now))return null;
    const chat=allGroups(state).find(c=>c.id===grant.chatId);if(!chat||grant.chatPolicyVersion!==chat.version)return null;
    const proof=delegationFingerprint(state,grant.actor,grant.capability,grant.chatId);
    const ref=await this.store.transaction(s=>{const at=this.auth(s,actor),current=allGroups(s).find(c=>c.id===chat.id&&c.version===chat.version);
     if(!current||delegationFingerprint(s,grant.actor,grant.capability,grant.chatId)!==proof||!this.policy.has(s,grant.actor,grant.capability,grant.chatId,at))return null;
     s.callbacks=s.callbacks.filter(x=>!x.action.startsWith(CONFIRM)||!Number.isSafeInteger(x.expiresAt)||x.expiresAt>at);if(s.callbacks.filter(x=>x.action.startsWith(CONFIRM)&&x.expiresAt>at).length>=200)return null;
     const ref='c_'+randomBytes(18).toString('base64url');s.callbacks.push({ref,action:CONFIRM+JSON.stringify(['REVOKE',grant.actor,grant.capability,grant.chatId,chat.version,grant.expiresAt,p,proof]),actorId:actor,chatId:'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:at+120000});return ref;});if(!ref)return null;
    return ui('<b>معاينة سحب التفويض</b>\nالنطاق: <code>'+escape(grant.chatId)+'</code>\nالمستخدم: <code>'+escape(grant.actor)+'</code>\nالقدرة: <code>'+escape(grant.capability)+'</code>\nلن تُعدل حقوق Telegram.',[[button('✅ تأكيد السحب','od:1:c:'+ref.slice(2))],[button('إلغاء','mi:1:d:p:'+p)]]);
   }
   const l=list.exec(data);if(l){const p=Number(l[1]),groups=allGroups(state),pages=Math.max(1,Math.ceil(groups.length/8));if(p>=pages)return null;
    const rows=groups.slice(p*8,p*8+8).map(c=>[button('👥 '+c.id,'od:1:b:'+c.id+':'+c.version+':'+p)]),nav=[];
    if(p)nav.push(button('⬅️ السابق','od:1:g:'+(p-1)));if(p+1<pages)nav.push(button('➡️ التالي','od:1:g:'+(p+1)));if(nav.length)rows.push(nav);rows.push([button('↩️ التفويضات','mi:1:i:03:01')]);
    return ui('<b>اختيار النطاق للتفويض</b>\nالصفحة '+(p+1)+' من '+pages+'\nتظهر النطاقات المعتمدة محليًا فقط.',rows);
   }
   const selected=input.exec(data)??duration.exec(data)??choose.exec(data);if(!selected)return null;
   const id=selected[1]!,version=Number(selected[2]),p=Number(selected[3]),chat=this.group(state,id,version,p);
   if((data.startsWith('od:1:t:')||data.startsWith('od:1:k:'))&&!chat.scopes.includes(roles[selected[4] as Role][2]))return null;
   if(data.startsWith('od:1:t:')){await this.begin(actor,id,version,p,selected[4] as Role,Number(selected[5]));return ui('اكتب معرّف المستخدم الرقمي. ستظهر معاينة قبل الحفظ؛ لا ترسل أسماء أو بيانات إضافية. تنتهي الخطوة بعد عشر دقائق.',[[button('إلغاء الإدخال','od:1:x')]]);}
   if(data.startsWith('od:1:k:')){const code=selected[4] as Role;return ui('<b>مدة التفويض</b>\nالنطاق: <code>'+escape(id)+'</code>\nالقدرة: '+roles[code][1],[[1,7,30].map(days=>button(days+' يوم','od:1:t:'+id+':'+version+':'+p+':'+code+':'+days)),[button('↩️ القدرات','od:1:b:'+id+':'+version+':'+p)]]);}
   return ui('<b>اختيار القدرة الداخلية</b>\nالنطاق: <code>'+escape(id)+'</code>\nهذه القدرات لا تمنح صلاحيات Telegram. سؤال المساعد يتطلب تشغيل وضع المشرفين للمجموعة.',[...Object.entries(roles).filter(([,value])=>chat.scopes.includes(value[2])).map(([code,value])=>[button(value[1],'od:1:k:'+id+':'+version+':'+p+':'+code)]),[button('↩️ النطاقات','od:1:g:'+p)]]);
  }catch{return null;}
 }
}
