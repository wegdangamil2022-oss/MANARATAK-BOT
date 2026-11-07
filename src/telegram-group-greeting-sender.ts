import type {GroupGreetingPayload,GroupGreetingSender} from './group-welcome-farewell.js';
import type {TemporaryGroupSendResult,TemporaryGroupDeleteResult} from './telegram-temporary-group-sender.js';
import {studioURL} from './button-studio-model.js';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
function validate(p:GroupGreetingPayload):boolean{
 if(!p||!group(p.chatId)||typeof p.text!=='string'||p.text.length<1||Array.from(p.text).length>2000||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(p.text)||
    p.topicId!==undefined&&!id(p.topicId)||!Array.isArray(p.buttons)||p.buttons.length>4)return false;
 let count=0;
 for(const row of p.buttons){
  if(!Array.isArray(row)||row.length<1||row.length>3)return false;
  for(const b of row){
   if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='text,url'||
      typeof b.text!=='string'||Array.from(b.text).length<1||Array.from(b.text).length>48||
      /[\u0000-\u001f\u007f]/u.test(b.text)||typeof b.url!=='string'||studioURL(b.url)===null)return false;
   count++;
  }
 }
 return count<=4;
}
/** Dedicated public greeting publisher. No private/user destination and no HTML parse mode. */
export class TelegramGroupGreetingSender implements GroupGreetingSender{
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
  this.botId=Number(token.split(':')[0]);
 }
 async send(input:GroupGreetingPayload,verify:()=>Promise<boolean>):Promise<TemporaryGroupSendResult>{
  let p:GroupGreetingPayload;try{p=structuredClone(input);}catch{return {status:'NOT_SENT'};}
  if(!validate(p)||typeof verify!=='function')return {status:'NOT_SENT'};
  try{if(await verify()!==true)return {status:'NOT_SENT'};}catch{return {status:'NOT_SENT'};}
  try{
   const response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),
    body:JSON.stringify({chat_id:p.chatId,text:p.text,disable_notification:true,
     link_preview_options:{is_disabled:true},
     ...(p.buttons.length?{reply_markup:{inline_keyboard:p.buttons}}:{}),
     ...(p.topicId?{message_thread_id:p.topicId}:{})})
   });
   const raw=await response.text();
   if(raw.length>16384)return {status:'UNKNOWN_OUTCOME'};
   const data:unknown=JSON.parse(raw);
   if(!object(data))return {status:'UNKNOWN_OUTCOME'};
   if(response.ok&&response.status===200&&data.ok===true&&object(data.result)){
    const msg=data.result;
    return object(msg.chat)&&msg.chat.id===Number(p.chatId)&&object(msg.from)&&msg.from.id===this.botId&&
     msg.from.is_bot===true&&id(msg.message_id)&&
     (p.topicId===undefined||msg.message_thread_id===p.topicId)
     ?{status:'CONFIRMED',messageId:msg.message_id}:{status:'UNKNOWN_OUTCOME'};
   }
   return response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?
    {status:'FAILED_CONFIRMED'}:{status:'UNKNOWN_OUTCOME'};
  }catch{return {status:'UNKNOWN_OUTCOME'};}
 }
 async delete(chatId:string,messageId:number,verify:()=>Promise<boolean>):Promise<TemporaryGroupDeleteResult>{
  if(!group(chatId)||!id(messageId)||typeof verify!=='function')return 'NOT_SENT';
  try{if(await verify()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  try{
   const response=await this.request('https://api.telegram.org/bot'+this.token+'/deleteMessage',{
    method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),
    body:JSON.stringify({chat_id:chatId,message_id:messageId})
   });
   const raw=await response.text();
   if(raw.length>16384)return 'UNKNOWN_OUTCOME';
   const data:unknown=JSON.parse(raw);
   if(!object(data))return 'UNKNOWN_OUTCOME';
   if(response.ok&&response.status===200&&data.ok===true&&data.result===true)return 'ACKNOWLEDGED';
   return response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
}
