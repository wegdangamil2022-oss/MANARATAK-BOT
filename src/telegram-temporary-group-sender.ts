export type TemporaryGroupSendResult={status:'CONFIRMED';messageId:number}|{status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT'};
export type TemporaryGroupDeleteResult='ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT';
export type TemporaryGroupNotice={chatId:string;botUsername:string;topicId?:number;kind?:'CAPTCHA'};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const group=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;

/** Sends a generic notice without exposing a member's subscription result. */
export class TelegramTemporaryGroupSender{
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
  this.botId=Number(token.split(':')[0]);
 }
 async send(input:TemporaryGroupNotice,verify:()=>Promise<boolean>):Promise<TemporaryGroupSendResult>{
  try{input=structuredClone(input);}catch{return {status:'NOT_SENT'};}
  if(!input||!group(input.chatId)||typeof input.botUsername!=='string'||/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.exec(input.botUsername)?.[0]!==input.botUsername||input.topicId!==undefined&&(!positive(input.topicId)||input.topicId>2147483647)||(input.kind!==undefined&&input.kind!=='CAPTCHA')||typeof verify!=='function')return {status:'NOT_SENT'};
  try{if(await verify()!==true)return {status:'NOT_SENT'};}catch{return {status:'NOT_SENT'};}
  try{
   const response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:input.chatId,text:input.kind==='CAPTCHA'?'لإكمال اختبار الانضمام، افتح خاص البوت واتبع خطوات التحقق.':'للتحقق من الاشتراك، افتح خاص البوت واتبع التعليمات.',reply_markup:{inline_keyboard:[[{text:'فتح البوت',url:'https://t.me/'+input.botUsername}]]},link_preview_options:{is_disabled:true},...(input.topicId!==undefined?{message_thread_id:input.topicId}:{})}),redirect:'error',signal:AbortSignal.timeout(8000)});
   const raw=await response.text();if(raw.length>16384)return {status:'UNKNOWN_OUTCOME'};const data:unknown=JSON.parse(raw);if(!object(data))return {status:'UNKNOWN_OUTCOME'};
   if(response.ok&&response.status===200&&data.ok===true&&object(data.result)){const m=data.result;if(object(m.chat)&&m.chat.id===Number(input.chatId)&&object(m.from)&&m.from.id===this.botId&&m.from.is_bot===true&&positive(m.message_id)&&(input.topicId===undefined||m.message_thread_id===input.topicId))return {status:'CONFIRMED',messageId:m.message_id};return {status:'UNKNOWN_OUTCOME'};}
   return response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?{status:'FAILED_CONFIRMED'}:{status:'UNKNOWN_OUTCOME'};
  }catch{return {status:'UNKNOWN_OUTCOME'};}
 }
 async delete(chatId:string,messageId:number,verify:()=>Promise<boolean>):Promise<TemporaryGroupDeleteResult>{
  if(!group(chatId)||!positive(messageId)||typeof verify!=='function')return 'NOT_SENT';
  try{if(await verify()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  try{const response=await this.request('https://api.telegram.org/bot'+this.token+'/deleteMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,message_id:messageId}),redirect:'error',signal:AbortSignal.timeout(8000)});const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';const data:unknown=JSON.parse(raw);if(!object(data))return 'UNKNOWN_OUTCOME';if(response.ok&&response.status===200&&data.ok===true&&data.result===true)return 'ACKNOWLEDGED';return response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';}catch{return 'UNKNOWN_OUTCOME';}
 }
}
