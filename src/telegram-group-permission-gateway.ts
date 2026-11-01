import {readGroupPermissions,equalGroupPermissions,validGroupPermissions,type GroupPermissions} from './group-permission-model.js';
export interface GroupPermissionPort{
 read(chat:string):Promise<GroupPermissions|null>;
 apply(chat:string,before:GroupPermissions,after:GroupPermissions,current:()=>Promise<boolean>):Promise<'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'>;
}
const officialPorts=new WeakSet<object>();
export const isOfficialGroupPermissionGateway=(port:GroupPermissionPort):boolean=>officialPorts.has(port);
/** Closed-over credentials and functions; no mutable public transport/rights
 * helpers. Construction does not contact Telegram; the default gate is STOP. */
export function telegramGroupPermissionGateway(token:string,request:typeof fetch=fetch,safetyGate:()=>Promise<boolean>=async()=>false):GroupPermissionPort{
 if(/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.exec(token)?.[0]!==token)throw Error('INVALID_TELEGRAM_TOKEN');const bot=Number(token.split(':')[0]);
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const chatOK=(chat:string)=>/^-[1-9][0-9]{0,15}$/u.exec(chat)?.[0]===chat&&Number.isSafeInteger(Number(chat));
 const gate=async()=>{try{return await safetyGate()===true;}catch{return false;}};
 async function call(method:string,body:Record<string,unknown>):Promise<{kind:'OK';value:unknown}|{kind:'DENIED'|'UNKNOWN'}>{
  try{
   const r=await request('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!r.body)return {kind:'UNKNOWN'};const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>16384){await reader.cancel();return {kind:'UNKNOWN'};}chunks.push(next.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(!object(v))return {kind:'UNKNOWN'};if(r.status===200&&v.ok===true)return {kind:'OK',value:v.result};if(r.status>=400&&r.status<500&&v.ok===false)return {kind:'DENIED'};return {kind:'UNKNOWN'};
  }catch{return {kind:'UNKNOWN'};}
 }
 async function rights(chat:string):Promise<boolean>{const r=await call('getChatMember',{chat_id:chat,user_id:bot});if(r.kind!=='OK'||!object(r.value)||!object(r.value.user)||r.value.user.id!==bot||r.value.user.is_bot!==true)return false;return r.value.status==='creator'||r.value.status==='administrator'&&r.value.can_restrict_members===true;}
 async function read(chat:string):Promise<GroupPermissions|null>{
  if(!chatOK(chat)||!await gate()||!await rights(chat))return null;
  const r=await call('getChat',{chat_id:chat});if(r.kind!=='OK'||!object(r.value)||r.value.id!==Number(chat)||!['group','supergroup'].includes(String(r.value.type))||r.value.migrated_to_chat_id!==undefined)return null;
  const p=readGroupPermissions(r.value.permissions);return p&&await rights(chat)&&await gate()?p:null;
 }
 async function apply(chat:string,before:GroupPermissions,after:GroupPermissions,current:()=>Promise<boolean>):Promise<'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'>{
  if(!chatOK(chat)||!validGroupPermissions(before)||!validGroupPermissions(after)||!await gate())return 'FAILED_CONFIRMED';
  const expected=structuredClone(before),desired=structuredClone(after);
  try{if(!await current())return 'FAILED_CONFIRMED';const actual=await read(chat);if(!actual||!equalGroupPermissions(actual,expected)||!await current()||!await rights(chat)||!await current()||!await gate())return 'FAILED_CONFIRMED';}catch{return 'FAILED_CONFIRMED';}
  const result=await call('setChatPermissions',{chat_id:chat,permissions:desired,use_independent_chat_permissions:true});
  if(result.kind==='DENIED')return 'FAILED_CONFIRMED';if(result.kind!=='OK'||result.value!==true)return 'UNKNOWN_OUTCOME';
  const observed=await read(chat);try{return observed&&equalGroupPermissions(observed,desired)&&await current()?'CONFIRMED':'UNKNOWN_OUTCOME';}catch{return 'UNKNOWN_OUTCOME';}
 }
 const port=Object.freeze({read,apply});officialPorts.add(port);return port;
}
