import {randomBytes} from 'node:crypto';
import type {BotStore} from './store.js';
import type {TelegramReplyKeyboard} from './telegram-menu.js';
import {menuLabels} from './telegram-menu.js';
import type {TelegramInlineKeyboard} from './telegram-inline-owner.js';
const PREFIX='public-navigation:',ACTION='public.menu:',TTL=120000;
export const validPublicNavigationRoute=(data:string):boolean=>data==='pn:1:h'||/^pn:1:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data;
export async function readPublicNavigation(store:BotStore,actor:string,data:string,allowed:(text:string)=>boolean,clock:()=>number):Promise<string|null>{
 if(data==='pn:1:h')return menuLabels.home;
 if(!validPublicNavigationRoute(data))return null;const s=await store.snapshot(),now=clock(),matches=s.callbacks.filter(c=>c.ref===PREFIX+data.slice(5)),c=matches[0];
 if(!Number.isSafeInteger(now)||now<0||matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||c.oneShot!==false||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL||!c.action.startsWith(ACTION))return null;
 try{const text:unknown=JSON.parse(c.action.slice(ACTION.length));return typeof text==='string'&&allowed(text)?text:null;}catch{return null;}
}
/** A short selector for an existing public menu action, never an arbitrary command. */
export async function publicNavigationMarkup(store:BotStore,actor:string,keyboard:TelegramReplyKeyboard,ownerLabel:string,allowed:(text:string)=>boolean,clock:()=>number):Promise<TelegramInlineKeyboard|null>{
 if(!keyboard.keyboard.every(row=>row.every(b=>b.text===ownerLabel||allowed(b.text))))return null;
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL)return null;
  s.callbacks=s.callbacks.filter(c=>!c.ref.startsWith(PREFIX)||c.expiresAt>now);const owned=s.callbacks.filter(c=>c.ref.startsWith(PREFIX)&&c.actorId===actor);
  let created=0;
  const rows=keyboard.keyboard.map(row=>row.map(b=>{
   if(b.text===ownerLabel)return {text:b.text,callback_data:'mi:1:h'};
   const nonce=randomBytes(18).toString('base64url');created++;s.callbacks.push({ref:PREFIX+nonce,action:ACTION+JSON.stringify(b.text),actorId:actor,chatId:'private',policyVersion:0,expiresAt:now+TTL,oneShot:false,used:false,revoked:false});return {text:b.text,callback_data:'pn:1:'+nonce};
  }));
  const excess=owned.length+created-128;if(excess>0){const remove=new Set(owned.slice(0,excess).map(c=>c.ref));s.callbacks=s.callbacks.filter(c=>!remove.has(c.ref));}
  return {inline_keyboard:rows};
 });
}
