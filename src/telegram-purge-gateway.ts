import type {PurgeGateway,PurgeGatewayResult,PurgeEvidence} from './moderation-purge.js';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const group=(id:unknown):id is string=>typeof id==='string'&&/^-[1-9][0-9]{0,15}$/u.test(id)&&Number.isSafeInteger(Number(id));
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
type Reply={status:'OK';value:unknown}|{status:'DENIED'}|{status:'RATE';milliseconds:number}|{status:'UNKNOWN'};
/** Disarmed by default. Accepts only individually reviewed IDs from the purge
 * service. An API true means request acknowledgement, never proof of physical
 * deletion. No automatic retry or external evidence verification is offered. */
export class TelegramBotApiPurgeGateway implements PurgeGateway{
 readonly #token:string;readonly #botId:number;readonly #request:typeof fetch;
 readonly #gate:()=>Promise<boolean>;
 constructor(token:string,request:typeof fetch=fetch,gate:()=>Promise<boolean>=async()=>false){
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
  this.#token=token;this.#botId=Number(token.split(':')[0]);this.#request=request;this.#gate=gate;
 }
 async #allowed():Promise<boolean>{try{return await this.#gate()===true;}catch{return false;}}
 async #call(method:string,body:Record<string,unknown>):Promise<Reply>{
  try{
   const response=await this.#request('https://api.telegram.org/bot'+this.#token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
   const type=response.headers.get('content-type'),length=response.headers.get('content-length');
   if(type!==null&&!/^application\/json(?:\s*;.*)?$/iu.test(type)||length!==null&&(!/^\d+$/u.test(length)||Number(length)>16384))return {status:'UNKNOWN'};
   const raw=await response.text();if(raw.length>16384)return {status:'UNKNOWN'};
   const value:unknown=JSON.parse(raw);if(!object(value))return {status:'UNKNOWN'};
   if(response.status===200&&response.ok&&value.ok===true)return {status:'OK',value:value.result};
   if(response.status===429&&value.ok===false&&value.error_code===429){
    const seconds=object(value.parameters)?value.parameters.retry_after:null;
    return positive(seconds)&&seconds<=3600?{status:'RATE',milliseconds:seconds*1000}:{status:'UNKNOWN'};
   }
   if(response.status>=400&&response.status<500&&value.ok===false&&value.error_code===response.status)return {status:'DENIED'};
   return {status:'UNKNOWN'};
  }catch{return {status:'UNKNOWN'};}
 }
 async #rights(chatId:string):Promise<boolean>{
  const reply=await this.#call('getChatMember',{chat_id:chatId,user_id:this.#botId});
  if(reply.status!=='OK'||!object(reply.value)||!object(reply.value.user)||
   reply.value.user.id!==this.#botId||reply.value.user.is_bot!==true)return false;
  return reply.value.status==='creator'||reply.value.status==='administrator'&&reply.value.can_delete_messages===true;
 }
 async canDelete(chatId:string):Promise<boolean>{
  return group(chatId)&&await this.#allowed()&&await this.#rights(chatId)&&await this.#allowed();
 }
 async deleteMessage(chatId:string,messageId:number,attemptId:string,
  verifyCurrentAuthority?:()=>Promise<boolean>):Promise<PurgeGatewayResult>{
  if(!group(chatId)||!positive(messageId)||typeof attemptId!=='string'||
   !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(attemptId)||!verifyCurrentAuthority||!await this.#allowed())return 'FAILED_CONFIRMED';
  try{
   if(!await this.#rights(chatId)||!await this.#allowed()||await verifyCurrentAuthority()!==true||!await this.#allowed())return 'FAILED_CONFIRMED';
   // The durable callback may await disk while Telegram rights change.
   // Re-observe the bot, then revalidate the original local reservation.
   if(!await this.#rights(chatId)||await verifyCurrentAuthority()!==true||!await this.#allowed())return 'FAILED_CONFIRMED';
  }catch{return 'FAILED_CONFIRMED';}
  const result=await this.#call('deleteMessage',{chat_id:chatId,message_id:messageId});
  return result.status==='OK'&&result.value===true?'ACKNOWLEDGED':result.status==='DENIED'?'FAILED_CONFIRMED':
   result.status==='RATE'?{status:'RATE_LIMITED',retryAfterMs:result.milliseconds}:'UNKNOWN_OUTCOME';
 }
 async verifyEvidence(_evidence:PurgeEvidence):Promise<boolean>{return false;}
}
