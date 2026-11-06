/** Read-only Telegram Bot API proof that a chosen numeric destination is an
 * actual non-public channel and the current bot may publish there. */
const validChat=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const validToken=(v:string)=>/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(v);
const obj=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
type Outcome={status:'OK';value:unknown}|{status:'DENIED'|'UNKNOWN'};
export type PrivateAuditChannelStatus='GRANTED'|'DENIED'|'UNKNOWN';
export class TelegramPrivateAuditChannelReader{
 readonly #brand=true;
 readonly #token:string;
 readonly #request:typeof fetch;
 readonly #botId:number;
 constructor(token:string,request:typeof fetch=fetch){
  if(!validToken(token)||!Number.isSafeInteger(Number(token.split(':')[0])))throw Error('INVALID_TELEGRAM_TOKEN');
  this.#token=token;this.#request=request;this.#botId=Number(token.split(':')[0]);
 }
 static isOfficial(reader:unknown):reader is TelegramPrivateAuditChannelReader{
  try{
   if(typeof reader!=='object'||reader===null||!(#brand in reader))return false;
   const proto=TelegramPrivateAuditChannelReader.prototype;
   return Object.isFrozen(TelegramPrivateAuditChannelReader)&&
    Object.getPrototypeOf(reader)===proto&&proto.inspect===officialInspect&&
    (reader as TelegramPrivateAuditChannelReader).inspect===officialInspect;
  }catch{return false;}
 }
 async #call(method:'getChat'|'getChatMember',body:Record<string,unknown>):Promise<Outcome>{
  try{
   const response=await this.#request('https://api.telegram.org/bot'+this.#token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    redirect:'error',signal:AbortSignal.timeout(8000)});
   const type=response.headers.get('content-type');
   if(type!==null&&!/^application\/json(?:\s*;.*)?$/iu.test(type))return {status:'UNKNOWN'};
   const size=response.headers.get('content-length');
   if(size!==null&&(!/^[0-9]+$/u.test(size)||Number(size)>16384))return {status:'UNKNOWN'};
   const raw=await response.text();if(raw.length>16384)return {status:'UNKNOWN'};
   const data:unknown=JSON.parse(raw);
   if(!obj(data))return {status:'UNKNOWN'};
   if(response.ok&&response.status===200&&data.ok===true)return {status:'OK',value:data.result};
   if(response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status)
    return {status:'DENIED'};
   return {status:'UNKNOWN'};
  }catch{return {status:'UNKNOWN'};}
 }
 /** Verification is never inferred from a numeric channel ID or owner-entered
  * name. Both getChat and getChatMember(bot) must match their exact identities.
  * A missing posting privilege is a denial, not permission. */
 async inspect(channel:string):Promise<PrivateAuditChannelStatus>{
  if(!validChat(channel))return 'UNKNOWN';
  const chat=await this.#call('getChat',{chat_id:channel});
  if(chat.status!=='OK'||!obj(chat.value))return chat.status==='DENIED'?'DENIED':'UNKNOWN';
  const info=chat.value;
  if(info.id!==Number(channel)||'migrated_to_chat_id' in info)return 'UNKNOWN';
  if(info.type!=='channel'||info.is_direct_messages===true)return info.type==='channel'?'UNKNOWN':'DENIED';
  const valid=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_]{5,32}$/u.test(v);
  if(info.username!==undefined&&!valid(info.username)||
     info.active_usernames!==undefined&&(!Array.isArray(info.active_usernames)||
      info.active_usernames.length>100||!info.active_usernames.every(valid)))return 'UNKNOWN';
  if(info.username!==undefined||Array.isArray(info.active_usernames)&&info.active_usernames.length>0)return 'DENIED';
  const bot=await this.#call('getChatMember',{chat_id:channel,user_id:this.#botId});
  if(bot.status!=='OK'||!obj(bot.value))return bot.status==='DENIED'?'DENIED':'UNKNOWN';
  const member=bot.value;
  if(!obj(member.user)||member.user.id!==this.#botId||member.user.is_bot!==true)return 'UNKNOWN';
  if(member.status==='creator')return 'GRANTED';
  if(member.status==='administrator'){
   return member.can_post_messages===true?'GRANTED':
    member.can_post_messages===false||member.can_post_messages===undefined?'DENIED':'UNKNOWN';
  }
  if(['member','restricted','left','kicked'].includes(String(member.status)))return 'DENIED';
  return 'UNKNOWN';
 }
}
const officialInspect=TelegramPrivateAuditChannelReader.prototype.inspect;
Object.freeze(TelegramPrivateAuditChannelReader);
