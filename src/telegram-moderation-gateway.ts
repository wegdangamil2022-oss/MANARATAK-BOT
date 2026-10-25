import type {ModerationGateway,RestrictionOutcome} from './moderation.js';
import type {RestrictionKind} from './store.js';
import type {RestrictionObservation} from './moderation-reversal-preflight.js';

/**
 * A separately injectable, deliberately DISARMED BY DEFAULT Telegram Bot API
 * moderation adapter. It is NOT connected to createLiveTelegramServer yet.
 *
 * Every mutation checks a trusted safety gate, fresh bot admin rights, target
 * protection, then the safety gate again. Outbound results are never retried,
 * and all ambiguous network/provider outcomes are UNKNOWN_OUTCOME.
 *
 * A 'NONE' release cannot be mapped safely using just RestrictionKind: release
 * would risk overriding unrelated Telegram restrictions or kicking a member via
 * unban. Until a separately audited, evidence-bound reversal exists, deny it.
 */
const validUser=(v:unknown):v is string=>{
 if(typeof v!=='string'||!/^[1-9][0-9]{0,15}$/u.test(v))return false;
 return Number.isSafeInteger(Number(v));
};
const validGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&
 Number.isSafeInteger(Number(v));
const TOKEN=/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u;
const JSON_TYPE=/^application\/json(?:\s*;.*)?$/iu;
type ObjectValue=Record<string,unknown>;
const object=(v:unknown):v is ObjectValue=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
type Member={status:string;user:ObjectValue;is_member?:boolean;can_restrict_members?:boolean};
function readMember(value:unknown,expected:number):Member|null{
 if(!object(value)||typeof value.status!=='string'||!object(value.user)||
  value.user.id!==expected||value.user.is_bot!==false&&value.user.is_bot!==true)return null;
 return value as Member;
}
const MUTE_PERMISSIONS={
 can_send_messages:false,
 can_send_audios:false,
 can_send_documents:false,
 can_send_photos:false,
 can_send_videos:false,
 can_send_video_notes:false,
 can_send_voice_notes:false,
 can_send_polls:false,
 can_send_other_messages:false,
 can_add_web_page_previews:false,
 can_react_to_messages:false
} as const;
type JsonOutcome={status:'HTTP_OK'|'CLIENT_DENIED'|'UNKNOWN';value?:unknown};
export class TelegramBotApiModerationGateway implements ModerationGateway{
 readonly attemptGateway='TELEGRAM_API' as const;
 // A third-party adapter's public attemptGateway string cannot authenticate
 // its implementation. This private brand is created only by this constructor.
 readonly #officialAdapterBrand=true;
 static usesOfficialDispatch(gateway:unknown):boolean{
  if(typeof gateway!=='object'||gateway===null||
    !(#officialAdapterBrand in gateway))return false;
  const adapter=gateway as TelegramBotApiModerationGateway;
  // A subclass or monkey-patched adapter that replaces the rights checks or
  // outbound implementation no longer gets to claim this origin.
  return adapter.setRestriction===TelegramBotApiModerationGateway.prototype.setRestriction&&
   adapter.canRestrict===TelegramBotApiModerationGateway.prototype.canRestrict&&
   adapter.isProtected===TelegramBotApiModerationGateway.prototype.isProtected;
 }
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch,
  private readonly safetyGate:()=>Promise<boolean>=async()=>false){
  if(!TOKEN.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
  const id=token.slice(0,token.indexOf(':'));
  if(!validUser(id))throw Error('INVALID_TELEGRAM_TOKEN');
  this.botId=Number(id);
 }
 private async allowed():Promise<boolean>{
  try{return await this.safetyGate()===true;}catch{return false;}
 }
 private async call(method:string,body:ObjectValue):Promise<JsonOutcome>{
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return {status:'UNKNOWN'};}
  const type=response.headers.get('content-type');
  if(type!==null&&!JSON_TYPE.test(type))return {status:'UNKNOWN'};
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^[0-9]+$/u.test(declared)||Number(declared)>16_384))
   return {status:'UNKNOWN'};
  let v:unknown;
  try{
   const text=await response.text();
   if(text.length>16_384)return {status:'UNKNOWN'};
   v=JSON.parse(text);
  }catch{return {status:'UNKNOWN'};}
  if(!object(v))return {status:'UNKNOWN'};
  if(response.status===200&&response.ok&&v.ok===true)
   return {status:'HTTP_OK',value:v.result};
  if(response.status>=400&&response.status<500&&v.ok===false)
   return {status:'CLIENT_DENIED'};
  return {status:'UNKNOWN'};
 }
 private async getMember(group:string,user:string):Promise<Member|null>{
  if(!validGroup(group)||!validUser(user))return null;
  const read=await this.call('getChatMember',{
   chat_id:group,user_id:Number(user)
  });
  return read.status==='HTTP_OK'?readMember(read.value,Number(user)):null;
 }
 /** A bot being an administrator is insufficient; it must actually hold
  * can_restrict_members. Chat creator status is inherently privileged.
  */
 async canRestrict(chatId:string,memberId:string):Promise<boolean>{
  if(!validGroup(chatId)||!validUser(memberId)||
    Number(memberId)===this.botId)return false;
  const bot=await this.getMember(chatId,String(this.botId));
  return bot!==null&&bot.user.is_bot===true&&
   (bot.status==='creator'||bot.status==='administrator'&&bot.can_restrict_members===true);
 }
 /** Unknown or missing evidence is PROTECTED, not an unprotected assumption.
  * No Telegram group owner, admin, bot, kicked/left or unknown member is a target.
  */
 async isProtected(chatId:string,memberId:string):Promise<boolean>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.botId)return true;
  const member=await this.getMember(chatId,memberId);
  if(!member||member.user.is_bot!==false)return true;
  return !(member.status==='member'||
   member.status==='restricted'&&member.is_member===true);
 }
 /** Owner-only callers may ask for a CURRENT observation. Neither Telegram
  * getChatMember nor the local attempt ledger identifies the original actor,
  * so this method can never approve an automatic unban/unmute.
  * Only getChatMember is sent. No mutating Bot API operation is reachable here.
  */
 async observeRestriction(chatId:string,memberId:string):Promise<RestrictionObservation>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.botId)
   return 'UNKNOWN';
  if(!await this.canRestrict(chatId,memberId))return 'NO_RIGHTS';
  const member=await this.getMember(chatId,memberId);
  if(!member)return 'UNKNOWN';
  if(member.user.is_bot!==false||member.status==='creator'||
    member.status==='administrator')return 'PROTECTED';
  if(member.status==='kicked')return 'BAN_PRESENT';
  if(member.status==='member')return 'NO_RESTRICTION';
  if(member.status==='restricted'&&member.is_member===true){
   const permissionFields=[
    'can_send_messages','can_send_audios','can_send_documents',
    'can_send_photos','can_send_videos','can_send_video_notes',
    'can_send_voice_notes','can_send_polls','can_send_other_messages',
    'can_add_web_page_previews','can_react_to_messages'
   ] as const;
   // A Telegram 'restricted' flag alone does NOT establish an identical
   // all-denied mute; incomplete or weaker restrictions are not a match.
   return permissionFields.every(key=>(member as unknown as ObjectValue)[key]===false)?
    'MUTE_PRESENT':'UNKNOWN';
  }
  return 'UNKNOWN';
 }
 async setRestriction(chatId:string,memberId:string,
  kind:RestrictionKind,verifyCurrentAuthority?:()=>Promise<boolean>):Promise<RestrictionOutcome>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.botId||
    (kind!=='BAN'&&kind!=='MUTE'))return 'FAILED_CONFIRMED';
  if(!await this.allowed())return 'FAILED_CONFIRMED';
  if(!await this.canRestrict(chatId,memberId)||await this.isProtected(chatId,memberId))
   return 'FAILED_CONFIRMED';
  // A STOP triggered during the rights/target lookups must win before write.
  if(!await this.allowed())return 'FAILED_CONFIRMED';
  // Service-owned durable grant/scope/operation evidence may have changed
  // during these remote reads. False, throwing or ambiguous => no mutation.
  // Direct standalone callers still require an independently armed safetyGate.
  if(verifyCurrentAuthority){
   let current=false;
   try{current=await verifyCurrentAuthority()===true;}catch{return 'FAILED_CONFIRMED';}
   if(!current)return 'FAILED_CONFIRMED';
  }
  const result=kind==='BAN'?
   await this.call('banChatMember',{
    chat_id:chatId,user_id:Number(memberId),revoke_messages:false
   }):
   await this.call('restrictChatMember',{
    chat_id:chatId,user_id:Number(memberId),
    permissions:MUTE_PERMISSIONS,use_independent_chat_permissions:true
   });
  return result.status==='HTTP_OK'&&result.value===true?'CONFIRMED':
   result.status==='CLIENT_DENIED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
 }
}
