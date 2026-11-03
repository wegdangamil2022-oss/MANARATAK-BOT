import {validStudioNativeKeyboard,type StudioNativeKeyboard} from './telegram-studio-rich.js';

export type EphemeralSendResult={status:'ACKNOWLEDGED';ephemeralMessageId:number}|{status:'FAILED_CONFIRMED'|'PROVIDER_REJECTED'|'UNKNOWN_OUTCOME'};
export type EphemeralTextPlan={chatId:string;receiverId:string;text:string;keyboard?:StudioNativeKeyboard;topicId?:number};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const id=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]{0,15}$/u.exec(value)?.[0]===value&&Number.isSafeInteger(Number(value));
const group=(value:unknown)=>typeof value==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(value)?.[0]===value&&Number.isSafeInteger(Number(value));
export class TelegramEphemeralTextSender{
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch,private readonly safety:()=>Promise<boolean>=async()=>false){
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');this.botId=Number(token.split(':')[0]);
 }
 async send(plan:EphemeralTextPlan,verifyAuthority:()=>Promise<boolean>):Promise<EphemeralSendResult>{
  try{plan=structuredClone(plan);}catch{return {status:'FAILED_CONFIRMED'};}
  if(!plan||!group(plan.chatId)||!id(plan.receiverId)||typeof plan.text!=='string'||plan.text.length===0||Buffer.byteLength(plan.text,'utf8')>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(plan.text)||plan.keyboard!==undefined&&!validStudioNativeKeyboard(plan.keyboard)||plan.topicId!==undefined&&(!positive(plan.topicId)||plan.topicId>2147483647)||typeof verifyAuthority!=='function')return {status:'FAILED_CONFIRMED'};
  try{if(await this.safety()!==true||await verifyAuthority()!==true||await this.safety()!==true)return {status:'FAILED_CONFIRMED'};}catch{return {status:'FAILED_CONFIRMED'};}
  let response:Response;try{response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:plan.chatId,text:plan.text,parse_mode:'HTML',ephemeral_message_parameters:{receiver_user_id:Number(plan.receiverId)},link_preview_options:{is_disabled:true},...(plan.topicId!==undefined?{message_thread_id:plan.topicId}:{}),...(plan.keyboard?{reply_markup:plan.keyboard}:{})}),redirect:'error',signal:AbortSignal.timeout(8000)});}catch{return {status:'UNKNOWN_OUTCOME'};}
  try{
   const type=response.headers.get('content-type'),length=response.headers.get('content-length');if(type!==null&&!/^application\/json(?:\s*;.*)?$/iu.test(type)||length!==null&&(!/^\d+$/u.test(length)||Number(length)>16384))return {status:'UNKNOWN_OUTCOME'};
   const raw=await response.text();if(raw.length>16384)return {status:'UNKNOWN_OUTCOME'};const data:unknown=JSON.parse(raw);if(!object(data))return {status:'UNKNOWN_OUTCOME'};
   if(response.ok&&response.status===200&&data.ok===true&&object(data.result)){const message=data.result,chat=message.chat,receiver=message.receiver_user,from=message.from;if(object(chat)&&chat.id===Number(plan.chatId)&&object(receiver)&&receiver.id===Number(plan.receiverId)&&receiver.is_bot===false&&object(from)&&from.id===this.botId&&from.is_bot===true&&(plan.topicId===undefined||message.message_thread_id===plan.topicId)&&positive(message.ephemeral_message_id))return {status:'ACKNOWLEDGED',ephemeralMessageId:message.ephemeral_message_id};return {status:'UNKNOWN_OUTCOME'};}
   return response.status===400&&data.ok===false&&data.error_code===400?{status:'PROVIDER_REJECTED'}:response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?{status:'FAILED_CONFIRMED'}:{status:'UNKNOWN_OUTCOME'};
  }catch{return {status:'UNKNOWN_OUTCOME'};}
 }
}
