import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {menuLabels} from './telegram-menu.js';
import {ownerMenuLabels,parseOwnerMenuAction,parseOwnerMenuPageCommand,type OwnerTelegramMenu} from './telegram-owner-menu.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const PREFIX='owner-import-navigation:',ACTION='owner.import:',TTL=120000;
export const validOwnerImportRoute=(data:string):boolean=>/^oi:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
export const importNavigationEpoch=(s:BotState):string=>createHash('sha256').update(JSON.stringify([s.importRuns,s.educationCategories,s.educationResources,s.chats,s.privateSettingsRevision])).digest('hex');
const allowed=(text:string):boolean=>text===ownerMenuLabels.imports||parseOwnerMenuAction(text)!==null||parseOwnerMenuPageCommand(text)!==null;
/** Opaque owner-only selectors over the existing import service, never arbitrary commands. */
export async function renderOwnerInlineImports(store:BotStore,policy:Policy,menu:OwnerTelegramMenu,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor))return null;
 const request=await store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||!policy.privateFeature(s,'owner.dashboard',actor))return null;
  if(data==='mi:1:i:13:04')return {text:ownerMenuLabels.imports,epoch:importNavigationEpoch(s)};
  if(!validOwnerImportRoute(data))return null;
  const matches=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=matches[0];
  if(matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==true||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(ACTION))return null;
  try{
   const v:unknown=JSON.parse(c.action.slice(ACTION.length));
   if(!v||typeof v!=='object'||Array.isArray(v))return null;const a=v as Record<string,unknown>;
   if(Object.keys(a).length!==2||typeof a.text!=='string'||!allowed(a.text)||a.epoch!==importNavigationEpoch(s))return null;
   c.used=true;return {text:a.text,epoch:importNavigationEpoch(s)};
  }catch{return null;}
 });
 if(request===null)return null;
 const {text}=request;
 const screen=await menu.handle(text,{origin:'TELEGRAM_PRIVATE',actorId:actor,chatId:actor,verified:true});
 if(!screen)return null;
 return store.transaction(s=>{
  const now=clock();if(!policy.privateFeature(s,'owner.dashboard',actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return null;
  const action=parseOwnerMenuAction(text)?.action;
  if(action!=='approve'&&action!=='publish'&&request.epoch!==importNavigationEpoch(s))return null;
  const choices=screen.keyboard.keyboard.flat().map(b=>b.text);
  if(!choices.every(t=>allowed(t)||[menuLabels.owner,menuLabels.home,ownerMenuLabels.library].includes(t as typeof menuLabels.owner)))return null;
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>now);
  const previous=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor),epoch=importNavigationEpoch(s);
  let created=0;
  const rows=screen.keyboard.keyboard.map(row=>row.map(b=>{
   if(b.text===menuLabels.owner)return {text:b.text,callback_data:'mi:1:h'};
   if(b.text===menuLabels.home)return {text:b.text,callback_data:'pn:1:h'};
   if(b.text===ownerMenuLabels.library)return {text:b.text,callback_data:'mi:1:i:10:09'};
   const nonce=randomBytes(18).toString('base64url');created++;
   s.callbacks.push({ref:PREFIX+nonce,action:ACTION+JSON.stringify({text:b.text,epoch}),actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,oneShot:true,used:false,revoked:false});
   return {text:b.text,callback_data:'oi:1:'+nonce};
  }));
  const remove=new Set(previous.slice(0,Math.max(0,previous.length+created-128)).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));
  rows.push([{text:'↩️ الوارد / إلغاء المعاينة',callback_data:'mi:1:i:13:04'},{text:'↩️ التكاملات والبيانات',callback_data:'mi:1:s:13:0'}]);
  // Leaving the preview also revokes outstanding confirmations, including siblings.
  if(data==='mi:1:i:13:04')for(const c of s.callbacks)if(c.ref.startsWith(PREFIX)&&c.actorId===actor&&previous.some(p=>p.ref===c.ref))c.revoked=true;
  return {text:screen.text,keyboard:{inline_keyboard:rows}};
 });
}
