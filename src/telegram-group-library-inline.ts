import {randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {groupMenuEpochDigest} from './telegram-group-access.js';
import {visibleEducationCategory} from './education-category-policy.js';
import {subscriptionRequirementMode,acceptsActiveSubscriptionEvidence} from './subscription-integrity.js';
import type {SubscriptionGate} from './subscription.js';
type Path={kind:'categories';page:number}|{kind:'resources';categoryId:string;categoryPage:number;page:number}|{kind:'detail';categoryId:string;categoryPage:number;page:number;resourceId:string};
const PREFIX='group-library:',ACTION='group.library:',TTL=120000;
export const validGroupLibraryInlineRoute=(data:string):boolean=>/^gl:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const brief=(s:string,n=48)=>Array.from(s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ')).slice(0,n).join('');
const page=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=999;
function validPath(value:unknown):value is Path{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const p=value as Record<string,unknown>;
 if(!page(p.page))return false;
 if(p.kind==='categories')return Object.keys(p).length===2;
 if(p.kind!=='resources'&&p.kind!=='detail'||typeof p.categoryId!=='string'||!p.categoryId||p.categoryId.length>64||!page(p.categoryPage))return false;
 return p.kind==='resources'?Object.keys(p).length===4:Object.keys(p).length===5&&typeof p.resourceId==='string'&&p.resourceId.length>0&&p.resourceId.length<=100;
}
function callbackPath(s:BotState,data:string,actor:string,chat:string,epoch:string,now:number):Path|null{
 if(!validGroupLibraryInlineRoute(data))return null;const matches=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=matches[0];
 if(matches.length!==1||!c||c.actorId!==actor||c.chatId!==chat||c.policyVersion!==0||c.oneShot!==false||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(ACTION))return null;
 try{const value=JSON.parse(c.action.slice(ACTION.length)) as {epoch:unknown;path:unknown};return value&&value.epoch===epoch&&validPath(value.path)?value.path:null;}catch{return null;}
}
export async function groupLibraryInline(store:BotStore,policy:Policy,context:{actor:string;chat:string;topic?:number},input:{callback:string}|{categoryId?:string},clock:()=>number,verify?:SubscriptionGate['verify']):Promise<{screen:OwnerInlineScreen;epoch:string;expiresAt:number}|{denied:string}>{
 const {actor,chat}=context,deny=(reason='GROUP_LIBRARY_STALE_OR_UNAUTHORIZED')=>({denied:reason});
 if(context.topic!==undefined&&(!Number.isSafeInteger(context.topic)||context.topic<1||context.topic>2147483647))return deny();
 if(!/^[1-9][0-9]{0,18}$/u.test(actor)||!/^-[1-9][0-9]{0,18}$/u.test(chat))return deny();
 const before=await store.snapshot(),epoch=groupMenuEpochDigest(before,chat,context.topic),now=clock();
 if(!policy.canUseChat(before,chat,'navigation')||!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return deny();
 if('callback' in input&&!callbackPath(before,input.callback,actor,chat,epoch,now))return deny();
 const mode=subscriptionRequirementMode(before,chat);
 if(mode==='INVALID')return deny('SUBSCRIPTION_UNAVAILABLE');
 if(mode==='ACTIVE'){
  if(!verify)return deny('SUBSCRIPTION_UNAVAILABLE');
  try{const proof=await verify(chat,actor);if(!acceptsActiveSubscriptionEvidence(proof.status,policy.isOwner(actor)))return deny(proof.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE');}catch{return deny('SUBSCRIPTION_UNAVAILABLE');}
 }
 return store.transaction(s=>{
  const at=clock();if(!Number.isSafeInteger(at)||at<now||at>8640000000000000-TTL||!policy.canUseChat(s,chat,'navigation')||groupMenuEpochDigest(s,chat,context.topic)!==epoch)return deny('SUBSCRIPTION_UNAVAILABLE');
  const categories=s.educationCategories.filter(c=>c.scope===chat&&visibleEducationCategory(s,c,context.topic)).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  if(!categories.length)return deny('NO_ACCESSIBLE_CATEGORIES');
  let path:Path;
  if('callback' in input){
   const selected=callbackPath(s,input.callback,actor,chat,epoch,at);if(!selected)return deny();path=selected;
  }else if(input.categoryId!==undefined){
   const index=categories.findIndex(c=>c.id===input.categoryId);if(index<0)return deny('NO_ACCESSIBLE_CATEGORIES');path={kind:'resources',categoryId:input.categoryId,categoryPage:Math.floor(index/8),page:0};
  }else path={kind:'categories',page:0};
  const actions:{text:string;path:Path}[][]=[];let text='';
  const add=(text:string,path:Path)=>({text,path});
  const nav=(count:number,current:number,route:(page:number)=>Path)=>{const row=[];if(current)row.push(add('السابق',route(current-1)));if((current+1)*8<count)row.push(add('التالي',route(current+1)));if(row.length)actions.push(row);};
  if(path.kind==='categories'){
   const p=path.page,pages=Math.max(1,Math.ceil(categories.length/8));if(p>=pages)return deny();
   for(const c of categories.slice(p*8,p*8+8))actions.push([add(brief(c.title),{kind:'resources',categoryId:c.id,categoryPage:p,page:0})]);
   nav(categories.length,p,page=>({kind:'categories',page}));text='<b>التعليم والموارد — مكتبة المجموعة</b>\nالصفحة '+(p+1)+' من '+pages+'\n'+categories.slice(p*8,p*8+8).map(c=>'• '+escape(brief(c.title,40))).join('\n');
   actions.push([add('🔄 تحديث الأقسام',{kind:'categories',page:p})]);
  }else{
   const p=path,category=categories.slice(p.categoryPage*8,p.categoryPage*8+8).find(c=>c.id===p.categoryId);if(!category)return deny();
   const resources=s.educationResources.filter(r=>r.scope===chat&&r.categoryId===category.id&&r.status==='PUBLISHED'&&s.educationResources.filter(x=>x.id===r.id).length===1).sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
   const pages=Math.max(1,Math.ceil(resources.length/8));if(p.page>=pages)return deny();
   if(p.kind==='resources'){
    for(const r of resources.slice(p.page*8,p.page*8+8))actions.push([add(brief(r.title),{...p,kind:'detail',resourceId:r.id})]);
    nav(resources.length,p.page,page=>({...p,page}));text='<b>الموارد المنشورة</b>\nالقسم: '+escape(brief(category.title,100))+'\nالصفحة '+(p.page+1)+' من '+pages+(resources.length?'\n'+resources.slice(p.page*8,p.page*8+8).map(r=>'• '+escape(brief(r.title,60))).join('\n'):'\nلا توجد موارد منشورة في هذا القسم.');
   }else{
    const resource=resources.slice(p.page*8,p.page*8+8).find(r=>r.id===p.resourceId);if(!resource)return deny();
    text='<b>مورد تعليمي</b>\nالقسم: '+escape(brief(category.title,100))+'\nالعنوان: '+escape(brief(resource.title,180))+'\nالجامعة: '+escape(brief(resource.university,140))+'\nالدورة: '+escape(brief(resource.cycle,60))+'\nالدرجة: '+escape(brief(resource.degree,60))+'\nالمقاعد: '+(resource.seats??'غير محددة');
    actions.push([add('↩️ موارد القسم',{kind:'resources',categoryId:p.categoryId,categoryPage:p.categoryPage,page:p.page})]);
   }
   actions.push([add('↩️ الأقسام',{kind:'categories',page:p.categoryPage})]);
  }
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>at);
  const owned=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor&&c.chatId===chat),keyboard=actions.map(row=>row.map(action=>{
   const nonce=randomBytes(18).toString('base64url');s.callbacks.push({ref:PREFIX+nonce,action:ACTION+JSON.stringify({epoch,path:action.path}),chatId:chat,actorId:actor,policyVersion:0,expiresAt:at+TTL,oneShot:false,used:false,revoked:false});return {text:action.text,callback_data:'gl:1:'+nonce};
  }));
  const excess=owned.length+actions.flat().length-128;if(excess>0){const remove=new Set(owned.slice(0,excess).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));}
  return {screen:{text,keyboard:{inline_keyboard:keyboard}},epoch,expiresAt:at+TTL};
 });
}
