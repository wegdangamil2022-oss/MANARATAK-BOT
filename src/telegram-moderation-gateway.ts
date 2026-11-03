import type {ModerationGateway,RestrictionOutcome} from './moderation.js';
import type {RestrictionKind} from './store.js';
import type {RestrictionObservation} from './moderation-reversal-preflight.js';
import {GROUP_PERMISSION_KEYS} from './group-permission-model.js';
export interface ReviewedRestorationSource{kind:'BAN'|'MUTE';untilDate?:number;}

/**
 * A separately injectable, deliberately DISARMED BY DEFAULT Telegram Bot API
 * moderation adapter. The live server selects it only through an explicit phase-3 option.
 *
 * Every mutation checks a trusted safety gate, fresh bot admin rights, target
 * protection, then the safety gate again. Outbound results are never retried,
 * and all ambiguous network/provider outcomes are UNKNOWN_OUTCOME.
 *
 * A 'NONE' release cannot be mapped safely using just RestrictionKind: release
 * would risk overriding unrelated Telegram restrictions or kicking a member via
 * unban. Keep that raw path denied. A separate owner-reviewed restoration
 * method requires the service's original baseline and fresh authority callback;
 * matching remote state alone never authorizes it.
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
export type BotAdminRight='GRANTED'|'DENIED'|'UNKNOWN';
export type BotAdminRights={restrict:BotAdminRight;delete:BotAdminRight;invite:BotAdminRight;pin:BotAdminRight;changeInfo:BotAdminRight;promote:BotAdminRight;manageTopics:BotAdminRight};
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
  // Compare against module-initialized immutable function REFERENCES,
  // never a dynamically replaced prototype method. A helper shadow is still
  // considered untrusted even though native # methods ignore it for safety.
  const prototype=TelegramBotApiModerationGateway.prototype;
  return Object.isFrozen(TelegramBotApiModerationGateway)&&
   Object.getPrototypeOf(adapter)===prototype&&
   prototype.setRestriction===officialGatewayMethods.setRestriction&&
   prototype.canRestrict===officialGatewayMethods.canRestrict&&
   prototype.isProtected===officialGatewayMethods.isProtected&&
   adapter.setRestriction===officialGatewayMethods.setRestriction&&
   adapter.canRestrict===officialGatewayMethods.canRestrict&&
   adapter.isProtected===officialGatewayMethods.isProtected&&
   prototype.confirmUnrestricted===officialGatewayMethods.confirmUnrestricted&&adapter.confirmUnrestricted===officialGatewayMethods.confirmUnrestricted&&
   prototype.confirmExpiredRestriction===officialGatewayMethods.confirmExpiredRestriction&&adapter.confirmExpiredRestriction===officialGatewayMethods.confirmExpiredRestriction&&
   prototype.canRestoreReviewed===officialGatewayMethods.canRestoreReviewed&&adapter.canRestoreReviewed===officialGatewayMethods.canRestoreReviewed&&
   prototype.restoreFromReviewedDecision===officialGatewayMethods.restoreFromReviewedDecision&&adapter.restoreFromReviewedDecision===officialGatewayMethods.restoreFromReviewedDecision&&
   prototype.kickMember===officialGatewayMethods.kickMember&&adapter.kickMember===officialGatewayMethods.kickMember&&
   !('allowed' in adapter)&&!('call' in adapter)&&
   !('getMember' in adapter);
 }
 /** Advisory read-only identity check, distinct from dispatch provenance.
  * Typescript structural probes, subclass overrides and mutable public
  * methods must never certify 'GRANTED' without the official getChatMember
  * implementation. This validates adapter provenance, NOT Telegram authorship.
  */
 static usesOfficialRightsRead(gateway:unknown):boolean{
  try{
   if(typeof gateway!=='object'||gateway===null||
     !(#officialAdapterBrand in gateway))return false;
   const adapter=gateway as TelegramBotApiModerationGateway;
   const prototype=TelegramBotApiModerationGateway.prototype;
   return Object.isFrozen(TelegramBotApiModerationGateway)&&
    Object.getPrototypeOf(adapter)===prototype&&
    prototype.inspectBotModerationRights===officialGatewayMethods.inspectBotModerationRights&&
    adapter.inspectBotModerationRights===officialGatewayMethods.inspectBotModerationRights&&
    prototype.inspectBotAdminRights===officialGatewayMethods.inspectBotAdminRights&&
    adapter.inspectBotAdminRights===officialGatewayMethods.inspectBotAdminRights&&
    !('call' in adapter)&&!('getMember' in adapter);
  }catch{return false;}
 }
 /** Trusted provenance for the specifically audited read-only getChat probe.
  * This is a JavaScript method identity check, NOT proof of Telegram truth.
  * Never authenticate against methods freshly read from a mutable prototype.
  */
 static usesOfficialTrialGroupRead(gateway:unknown):boolean{
  try{
   if(typeof gateway!=='object'||gateway===null||
      !(#officialAdapterBrand in gateway))return false;
   const adapter=gateway as TelegramBotApiModerationGateway;
   const prototype=TelegramBotApiModerationGateway.prototype;
   return Object.isFrozen(TelegramBotApiModerationGateway)&&
    Object.getPrototypeOf(adapter)===prototype&&
    prototype.inspectTrialGroupKind===officialGatewayMethods.inspectTrialGroupKind&&
    adapter.inspectTrialGroupKind===officialGatewayMethods.inspectTrialGroupKind&&
    !('call' in adapter);
  }catch{return false;}
 }
 static usesOfficialRoomPrivacyRead(gateway:unknown):boolean{
  try{if(typeof gateway!=='object'||gateway===null||!(#officialAdapterBrand in gateway))return false;const adapter=gateway as TelegramBotApiModerationGateway,prototype=TelegramBotApiModerationGateway.prototype;
   return Object.isFrozen(TelegramBotApiModerationGateway)&&Object.getPrototypeOf(adapter)===prototype&&prototype.inspectRoomPrivacy===officialGatewayMethods.inspectRoomPrivacy&&adapter.inspectRoomPrivacy===officialGatewayMethods.inspectRoomPrivacy&&!('call' in adapter);
  }catch{return false;}
 }
 // Native # fields are inaccessible to Object.assign/proxy-style changes
 // of ordinary TypeScript-private constructor parameter properties. The
 // emergency STOP gate, transport and bot identity stay bound to the
 // originally validated constructor inputs for the entire attempt lifetime.
 readonly #token:string;
 readonly #request:typeof fetch;
 readonly #safetyGate:()=>Promise<boolean>;
 readonly #botId:number;
 readonly #clock:()=>number;
 constructor(token:string,request:typeof fetch=fetch,
  safetyGate:()=>Promise<boolean>=async()=>false,clock:()=>number=Date.now){
  if(!TOKEN.test(token))throw Error('INVALID_TELEGRAM_TOKEN');
  const id=token.slice(0,token.indexOf(':'));
  if(!validUser(id))throw Error('INVALID_TELEGRAM_TOKEN');
  this.#botId=Number(id);
  this.#token=token;
  this.#request=request;
  this.#safetyGate=safetyGate;
  this.#clock=clock;
 }
 async #allowed():Promise<boolean>{
  try{return await this.#safetyGate()===true;}catch{return false;}
 }
 async #call(method:string,body:ObjectValue):Promise<JsonOutcome>{
  let response:Response;
  try{
   response=await this.#request('https://api.telegram.org/bot'+this.#token+'/'+method,{
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
 /** Read-only Telegram getChat probe: verify exact numeric chat identity
  * and supported group topology, rejecting channels/private chats and
  * former basic groups with a migration marker. Never exposes a title
  * or makes any mutation. 'UNKNOWN' never authorizes a trial.
  */
 async inspectTrialGroupKind(chatId:string):Promise<'GROUP'|'SUPERGROUP'|'NOT_GROUP'|'UNKNOWN'>{
  return this.#inspectGroupKind(chatId);
 }
 /** Snapshot of public usernames only. A group without a public username can
  * still admit people through invite links; this is not confidentiality proof. */
 async inspectRoomPrivacy(chatId:string):Promise<'NO_PUBLIC_USERNAME'|'PUBLIC_USERNAME'|'NOT_GROUP'|'UNKNOWN'>{
  if(!validGroup(chatId))return 'UNKNOWN';const reply=await this.#call('getChat',{chat_id:chatId});if(reply.status!=='HTTP_OK'||!object(reply.value))return 'UNKNOWN';const info=reply.value;
  if(info.id!==Number(chatId)||'migrated_to_chat_id' in info)return 'UNKNOWN';if(info.type==='private'||info.type==='channel')return 'NOT_GROUP';if(info.type!=='group'&&info.type!=='supergroup')return 'UNKNOWN';
  const username=info.username,usernames=info.active_usernames,valid=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_]{5,32}$/u.test(v);
  if(username!==undefined&&!valid(username)||usernames!==undefined&&(!Array.isArray(usernames)||usernames.length>100||!usernames.every(valid)))return 'UNKNOWN';
  if(info.type==='group'&&(username!==undefined||Array.isArray(usernames)&&usernames.length>0))return 'UNKNOWN';
  return username!==undefined||Array.isArray(usernames)&&usernames.length>0?'PUBLIC_USERNAME':'NO_PUBLIC_USERNAME';
 }
 async #inspectGroupKind(chatId:string):Promise<'GROUP'|'SUPERGROUP'|'NOT_GROUP'|'UNKNOWN'>{
  if(!validGroup(chatId))return 'UNKNOWN';
  const reply=await this.#call('getChat',{chat_id:chatId});
  if(reply.status!=='HTTP_OK'||!object(reply.value))return 'UNKNOWN';
  const info=reply.value;
  if(info.id!==Number(chatId)||'migrated_to_chat_id' in info)
   return 'UNKNOWN';
  if(info.type==='group')return 'GROUP';
  if(info.type==='supergroup')return 'SUPERGROUP';
  if(info.type==='private'||info.type==='channel')return 'NOT_GROUP';
  return 'UNKNOWN';
 }
 async #getMember(group:string,user:string):Promise<Member|null>{
  if(!validGroup(group)||!validUser(user))return null;
  const read=await this.#call('getChatMember',{
   chat_id:group,user_id:Number(user)
  });
  return read.status==='HTTP_OK'?readMember(read.value,Number(user)):null;
 }
 /** A bot being an administrator is insufficient; it must actually hold
  * can_restrict_members. Chat creator status is inherently privileged.
  */
 async canRestrict(chatId:string,memberId:string):Promise<boolean>{
  return this.#canRestrict(chatId,memberId);
 }
 async #canRestrict(chatId:string,memberId:string):Promise<boolean>{
  if(!validGroup(chatId)||!validUser(memberId)||
    Number(memberId)===this.#botId)return false;
  const bot=await this.#getMember(chatId,String(this.#botId));
  return bot!==null&&bot.user.is_bot===true&&
   (bot.status==='creator'||bot.status==='administrator'&&bot.can_restrict_members===true);
 }
 /** A single narrowly scoped, read-only bot-rights observation.
  * Only getChatMember is reachable: no member target, no mutation, no
  * safety gate arm and no claim that remote Telegram trial is isolated.
  * Network failures, unexpected statuses or mismatched identity are UNKNOWN.
  */
 async inspectBotModerationRights(chatId:string):Promise<'GRANTED'|'DENIED'|'UNKNOWN'>{
  if(!validGroup(chatId))return 'UNKNOWN';
  const bot=await this.#getMember(chatId,String(this.#botId));
  if(!bot||bot.user.is_bot!==true)return 'UNKNOWN';
  if(bot.status==='creator')return 'GRANTED';
  if(bot.status==='administrator'){
   if(bot.can_restrict_members===true)return 'GRANTED';
   return bot.can_restrict_members===false||bot.can_restrict_members===undefined?
    'DENIED':'UNKNOWN';
  }
  if(bot.status==='member'||bot.status==='restricted'||bot.status==='left'||
     bot.status==='kicked')return 'DENIED';
  return 'UNKNOWN';
 }
 async inspectBotAdminRights(chatId:string):Promise<BotAdminRights>{
  const fields={restrict:'can_restrict_members',delete:'can_delete_messages',invite:'can_invite_users',pin:'can_pin_messages',changeInfo:'can_change_info',promote:'can_promote_members',manageTopics:'can_manage_topics'} as const;
  const result:BotAdminRights={restrict:'UNKNOWN',delete:'UNKNOWN',invite:'UNKNOWN',pin:'UNKNOWN',changeInfo:'UNKNOWN',promote:'UNKNOWN',manageTopics:'UNKNOWN'};
  if(!validGroup(chatId))return result;
  const bot=await this.#getMember(chatId,String(this.#botId));if(!bot||bot.user.is_bot!==true)return result;
  const values=bot as unknown as Record<string,unknown>;
  for(const key of Object.keys(fields) as (keyof BotAdminRights)[]){
   if(bot.status==='creator')result[key]='GRANTED';
   else if(bot.status==='administrator'){const value=values[fields[key]];result[key]=value===true?'GRANTED':value===false?'DENIED':'UNKNOWN';}
   else if(['member','restricted','left','kicked'].includes(bot.status))result[key]='DENIED';
  }
  return result;
 }
 /** Unknown or missing evidence is PROTECTED, not an unprotected assumption.
  * A user already restricted by Telegram remains protected EVEN if
  * is_member=true: getChatMember cannot prove which admin imposed the
  * restriction. Never overwrite that external action with our BAN/MUTE.
  * Only a verified ordinary human member is an eligible target.
  */
 async isProtected(chatId:string,memberId:string):Promise<boolean>{
  return this.#isProtected(chatId,memberId);
 }
 async #isProtected(chatId:string,memberId:string):Promise<boolean>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.#botId)return true;
  const member=await this.#getMember(chatId,memberId);
  if(!member||member.user.is_bot!==false)return true;
  return member.status!=='member';
 }
 /** Owner-only callers may ask for a CURRENT observation. Neither Telegram
  * getChatMember nor the local attempt ledger identifies the original actor,
  * so this method can never approve an automatic unban/unmute.
  * Only getChatMember is sent. No mutating Bot API operation is reachable here.
  */
 async observeRestriction(chatId:string,memberId:string):Promise<RestrictionObservation>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.#botId)
   return 'UNKNOWN';
  if(!await this.#canRestrict(chatId,memberId))return 'NO_RIGHTS';
  const member=await this.#getMember(chatId,memberId);
  if(!member)return 'UNKNOWN';
  // Bot authority was checked before the external member observation.
  // A demotion or can_restrict_members revocation during that awaited read
  // invalidates even a matching BAN/MUTE observation. This is advisory-only:
  // no sequence of separate Telegram reads is an atomic authority proof.
  if(!await this.#canRestrict(chatId,memberId))return 'NO_RIGHTS';
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
 /** Matching state is a conflict check, never Telegram authorship evidence.
  * Only the separate owner-reviewed service decision can authorize this path. */
 async #restorationState(chatId:string,memberId:string,source:ReviewedRestorationSource):Promise<'MATCH'|'CLEAR'|'DENIED'>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.#botId||!source||!['BAN','MUTE'].includes(source.kind)||
   source.untilDate!==undefined&&(!Number.isSafeInteger(source.untilDate)||source.untilDate<=0)||!await this.#allowed()||
   await this.#inspectGroupKind(chatId)!=='SUPERGROUP'||!await this.#canRestrict(chatId,memberId))return 'DENIED';
  const member=await this.#getMember(chatId,memberId);
  if(!member||member.user.is_bot!==false||!await this.#canRestrict(chatId,memberId)||!await this.#allowed())return 'DENIED';
  if(member.status==='member'||source.kind==='BAN'&&member.status==='left')return 'CLEAR';
  const raw=member as unknown as ObjectValue;
  if(raw.until_date!==(source.untilDate??0))return 'DENIED';
  if(source.kind==='BAN')return member.status==='kicked'?'MATCH':'DENIED';
  if(member.status!=='restricted'||member.is_member!==true||Object.keys(raw).some(k=>k.startsWith('can_')&&!GROUP_PERMISSION_KEYS.includes(k as typeof GROUP_PERMISSION_KEYS[number])))return 'DENIED';
  return GROUP_PERMISSION_KEYS.every(k=>raw[k]===false)?'MATCH':'DENIED';
 }
 async canRestoreReviewed(chatId:string,memberId:string,source:ReviewedRestorationSource):Promise<boolean>{
  return await this.#restorationState(chatId,memberId,source)!=='DENIED';
 }
 /** Read-only expiry acknowledgement. A still-present restriction is never lifted. */
 async confirmExpiredRestriction(chatId:string,memberId:string,source:ReviewedRestorationSource,verify:()=>Promise<boolean>):Promise<boolean>{
  if(!source||source.untilDate===undefined||!Number.isSafeInteger(source.untilDate)||source.untilDate*1000>this.#clock()||typeof verify!=='function')return false;
  for(let i=0;i<2;i++){try{if(!await verify()||await this.#restorationState(chatId,memberId,source)!=='CLEAR')return false;}catch{return false;}}
  try{return await verify()===true&&await this.#allowed();}catch{return false;}
 }
 async restoreFromReviewedDecision(chatId:string,memberId:string,source:ReviewedRestorationSource,verifyCurrentAuthority:()=>Promise<boolean>):Promise<RestrictionOutcome>{
  if(typeof verifyCurrentAuthority!=='function')return 'FAILED_CONFIRMED';
  const expected=structuredClone(source);let state:'MATCH'|'CLEAR'|'DENIED'='DENIED';
  for(let i=0;i<2;i++){
   state=await this.#restorationState(chatId,memberId,expected);if(state==='DENIED')return 'FAILED_CONFIRMED';
   let current=false;try{current=await verifyCurrentAuthority()===true;}catch{/* denied */}
   if(!current||!await this.#allowed())return 'FAILED_CONFIRMED';
  }
  // Re-read after the awaited local decision. There is no Telegram compare-
  // and-set API; an identical outside restriction remains a human review risk.
  state=await this.#restorationState(chatId,memberId,expected);if(state==='DENIED')return 'FAILED_CONFIRMED';
  let current=false;try{current=await verifyCurrentAuthority()===true;}catch{/* denied */}
  if(!current||!await this.#allowed())return 'FAILED_CONFIRMED';
  state=await this.#restorationState(chatId,memberId,expected);if(state==='DENIED')return 'FAILED_CONFIRMED';
  if(state==='CLEAR')return 'CONFIRMED';
  const reply=expected.kind==='BAN'?await this.#call('unbanChatMember',{chat_id:chatId,user_id:Number(memberId),only_if_banned:true}):
   await this.#call('restrictChatMember',{chat_id:chatId,user_id:Number(memberId),permissions:Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])),use_independent_chat_permissions:true});
  if(reply.status==='CLIENT_DENIED')return 'FAILED_CONFIRMED';
  if(reply.status!=='HTTP_OK'||reply.value!==true)return 'UNKNOWN_OUTCOME';
  try{return await this.#restorationState(chatId,memberId,expected)==='CLEAR'&&await verifyCurrentAuthority()===true?'CONFIRMED':'UNKNOWN_OUTCOME';}catch{return 'UNKNOWN_OUTCOME';}
 }
 /** Explicit removal of a currently ordinary member, not an enduring ban.
  * Telegram unbanChatMember's default removal semantics are used deliberately;
  * a restricted/banned/protected target is refused before reaching that API. */
 async kickMember(chatId:string,memberId:string,verifyCurrentAuthority:()=>Promise<boolean>):Promise<RestrictionOutcome>{
  if(!validGroup(chatId)||!validUser(memberId)||typeof verifyCurrentAuthority!=='function'||!await this.#allowed()||await this.#inspectGroupKind(chatId)!=='SUPERGROUP')return 'FAILED_CONFIRMED';
  for(let i=0;i<3;i++){
   if(!await this.#canRestrict(chatId,memberId)||await this.#isProtected(chatId,memberId))return 'FAILED_CONFIRMED';
   let current=false;try{current=await verifyCurrentAuthority()===true;}catch{/* denied */}
   if(!current||!await this.#allowed())return 'FAILED_CONFIRMED';
  }
  // The last local authority callback awaited disk; refresh remote protection
  // afterwards as well. No sequence of these reads is a remote transaction.
  if(!await this.#canRestrict(chatId,memberId)||await this.#isProtected(chatId,memberId)||!await this.#allowed())return 'FAILED_CONFIRMED';
  const reply=await this.#call('unbanChatMember',{chat_id:chatId,user_id:Number(memberId),only_if_banned:false});
  if(reply.status==='CLIENT_DENIED')return 'FAILED_CONFIRMED';
  if(reply.status!=='HTTP_OK'||reply.value!==true)return 'UNKNOWN_OUTCOME';
  try{
   if(!await this.#canRestrict(chatId,memberId))return 'UNKNOWN_OUTCOME';const after=await this.#getMember(chatId,memberId);
   return after?.status==='left'&&after.user.is_bot===false&&await verifyCurrentAuthority()===true&&await this.#allowed()?'CONFIRMED':'UNKNOWN_OUTCOME';
  }catch{return 'UNKNOWN_OUTCOME';}
 }
 async setRestriction(chatId:string,memberId:string,
  kind:RestrictionKind,verifyCurrentAuthority?:()=>Promise<boolean>,untilDate?:number):Promise<RestrictionOutcome>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.#botId||
    (kind!=='BAN'&&kind!=='MUTE'))return 'FAILED_CONFIRMED';
  if(!await this.#allowed())return 'FAILED_CONFIRMED';
  if(untilDate!==undefined&&(!this.#validDeadline(untilDate)||await this.#inspectGroupKind(chatId)!=='SUPERGROUP'))return 'FAILED_CONFIRMED';
  if(!await this.#canRestrict(chatId,memberId)||await this.#isProtected(chatId,memberId))
   return 'FAILED_CONFIRMED';
  // A STOP triggered during the rights/target lookups must win before write.
  if(!await this.#allowed())return 'FAILED_CONFIRMED';
  // Service-owned durable grant/scope/operation evidence may have changed
  // during these remote reads. False, throwing or ambiguous => no mutation.
  // Direct standalone callers still require an independently armed safetyGate.
  if(verifyCurrentAuthority){
   let current=false;
   try{current=await verifyCurrentAuthority()===true;}catch{return 'FAILED_CONFIRMED';}
   if(!current)return 'FAILED_CONFIRMED';
   // Telegram staff/owner status and the bot's can_restrict_members right
   // can change while the durable callback awaits disk. Never dispatch using
   // target/rights evidence obtained before that await.
   if(!await this.#canRestrict(chatId,memberId)||
      await this.#isProtected(chatId,memberId))return 'FAILED_CONFIRMED';
   // Local staff grants or approval may themselves change during these
   // additional remote reads. Re-evaluate the service-owned proof again.
   try{current=await verifyCurrentAuthority()===true;}catch{return 'FAILED_CONFIRMED';}
   if(!current)return 'FAILED_CONFIRMED';
  }
  // The authority callback itself may await I/O while STOP is applied.
  // Read the independent operator gate once more at the final mutation
  // boundary; a failed/throwing gate is a definitive NO-SEND.
  if(!await this.#allowed())return 'FAILED_CONFIRMED';
  if(untilDate!==undefined){
   if(!this.#validDeadline(untilDate)||await this.#inspectGroupKind(chatId)!=='SUPERGROUP')return 'FAILED_CONFIRMED';
   if(!await this.#canRestrict(chatId,memberId)||await this.#isProtected(chatId,memberId))return 'FAILED_CONFIRMED';
   if(verifyCurrentAuthority){let current=false;try{current=await verifyCurrentAuthority()===true;}catch{/* fail closed */}if(!current)return 'FAILED_CONFIRMED';}
   if(!await this.#allowed()||!this.#validDeadline(untilDate))return 'FAILED_CONFIRMED';
  }
  const result=kind==='BAN'?
   await this.#call('banChatMember',{
    chat_id:chatId,user_id:Number(memberId),revoke_messages:false,...(untilDate===undefined?{}:{until_date:untilDate})
   }):
   await this.#call('restrictChatMember',{
    chat_id:chatId,user_id:Number(memberId),
    permissions:MUTE_PERMISSIONS,use_independent_chat_permissions:true,...(untilDate===undefined?{}:{until_date:untilDate})
   });
  return result.status==='HTTP_OK'&&result.value===true?'CONFIRMED':
   result.status==='CLIENT_DENIED'?'FAILED_CONFIRMED':'UNKNOWN_OUTCOME';
 }
 #validDeadline(untilDate:number):boolean{
  const now=this.#clock();return Number.isSafeInteger(now)&&now>=0&&Number.isSafeInteger(untilDate)&&untilDate-now/1000>=30&&untilDate-Math.ceil(now/1000)<=2592000;
 }
 /** Read-only acknowledgement of an already unrestricted human member.
  * It never unbans, changes permissions, or infers who imposed a restriction. */
 async confirmUnrestricted(chatId:string,memberId:string,verifyCurrentAuthority:()=>Promise<boolean>):Promise<RestrictionOutcome>{
  if(!validGroup(chatId)||!validUser(memberId)||Number(memberId)===this.#botId||!await this.#allowed())return 'FAILED_CONFIRMED';
  for(let i=0;i<2;i++){
   if(!await this.#canRestrict(chatId,memberId))return 'FAILED_CONFIRMED';const target=await this.#getMember(chatId,memberId);
   if(!target||target.user.is_bot!==false||target.status!=='member')return 'FAILED_CONFIRMED';
   let current=false;try{current=await verifyCurrentAuthority()===true;}catch{/* fail closed */}if(!current)return 'FAILED_CONFIRMED';
  }
  return await this.#allowed()?'CONFIRMED':'FAILED_CONFIRMED';
 }
}

// Capture the ORIGINAL functions. The prototype remains mutable for isolated
// test doubles and compatibility, but a mutation never becomes the reference
// against which the module authenticates itself.
const officialGatewayMethods=Object.freeze({
 setRestriction:TelegramBotApiModerationGateway.prototype.setRestriction,
 canRestrict:TelegramBotApiModerationGateway.prototype.canRestrict,
 isProtected:TelegramBotApiModerationGateway.prototype.isProtected,
 confirmUnrestricted:TelegramBotApiModerationGateway.prototype.confirmUnrestricted,
 confirmExpiredRestriction:TelegramBotApiModerationGateway.prototype.confirmExpiredRestriction,
 canRestoreReviewed:TelegramBotApiModerationGateway.prototype.canRestoreReviewed,
 restoreFromReviewedDecision:TelegramBotApiModerationGateway.prototype.restoreFromReviewedDecision,
 kickMember:TelegramBotApiModerationGateway.prototype.kickMember,
 inspectBotModerationRights:TelegramBotApiModerationGateway.prototype.inspectBotModerationRights,
 inspectBotAdminRights:TelegramBotApiModerationGateway.prototype.inspectBotAdminRights,
 inspectTrialGroupKind:TelegramBotApiModerationGateway.prototype.inspectTrialGroupKind,
 inspectRoomPrivacy:TelegramBotApiModerationGateway.prototype.inspectRoomPrivacy
});
// Prevent rebinding the static origin-check functions after their definition.
Object.freeze(TelegramBotApiModerationGateway);
