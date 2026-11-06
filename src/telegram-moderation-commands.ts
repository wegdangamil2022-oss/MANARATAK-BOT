import type {ModerationService} from './moderation.js';
import type {BotState} from './store.js';

export type ReplyModerationCommand={kind:'ban'|'mute'|'warn'|'unwarn'|'unban'|'unmute'|'kick'|'review'|'notice';reference:string;memberId:string;durationSeconds?:number};
type Parsed={status:'NO_MATCH'|'INVALID'}|{status:'COMMAND';command:ReplyModerationCommand};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
/** Only an explicit command and a direct, human-authored same-group reply
 * identify a target. Names, forwarded messages and arguments never do. */
export function parseReplyModerationCommand(text:string,botUsername:string,
 chatId:string,messageId:number|undefined,reply:unknown):Parsed{
 const first=/^\/(ban|mute|warn|unwarn|unban|unmute|kick|review|notice)(?:@([A-Za-z][A-Za-z0-9_]{4,31}))?(?=\s|$)/u.exec(text);
 if(!first)return {status:'NO_MATCH'};
 if(first[2]&&first[2].toLowerCase()!==botUsername.toLowerCase())return {status:'NO_MATCH'};
 const syntax=/^\/(ban|mute|warn|unwarn|unban|unmute|kick|review|notice)(?:@[A-Za-z][A-Za-z0-9_]{4,31})? ([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?: ([1-9][0-9]{0,6})([smhd]))?$/u.exec(text);
 const duration=syntax?.[3]===undefined?undefined:Number(syntax[3])*({s:1,m:60,h:3600,d:86400}[syntax[4]!]??NaN);
 if(!syntax||syntax[0]!==text||!/^-[1-9][0-9]{0,15}$/u.test(chatId)||
  !Number.isSafeInteger(Number(chatId))||!positive(messageId)||!object(reply)||
  !positive(reply.message_id)||reply.message_id>=messageId||!object(reply.chat)||
  String(reply.chat.id)!==chatId||!Number.isSafeInteger(reply.chat.id)||
  !['group','supergroup'].includes(String(reply.chat.type))||!object(reply.from)||
  !positive(reply.from.id)||reply.from.is_bot!==false||reply.sender_chat!==undefined||
  reply.via_bot!==undefined||reply.forward_origin!==undefined||reply.forward_date!==undefined||
  reply.is_automatic_forward===true||duration!==undefined&&(!['ban','mute'].includes(syntax[1]!)||!Number.isSafeInteger(duration)||duration<60||duration>2592000))return {status:'INVALID'};
 if(['review','notice'].includes(syntax[1]!)&&!/^law_v[1-9][0-9]{0,14}_p[1-9][0-9]?_m[1-9][0-9]{0,15}$/u.test(syntax[2]!))return {status:'INVALID'};
 if(['warn','mute','review','notice'].includes(syntax[1]!)&&syntax[2]!.startsWith('law_')&&Number(/_m([1-9][0-9]{0,15})$/u.exec(syntax[2]!)?.[1])!==reply.message_id)return {status:'INVALID'};
 return {status:'COMMAND',command:{kind:syntax[1] as ReplyModerationCommand['kind'],reference:syntax[2]!,memberId:String(reply.from.id),...(duration===undefined?{}:{durationSeconds:duration})}};
}
/** Shared domain service owns grants, target protection, pending/unknown
 * quarantine and durable sanction intents. This adapter never calls Bot API
 * itself and never emits target identities or reasons into a group. */
export async function executeReplyModerationCommand(service:ModerationService,
 actorId:string,chatId:string,command:ReplyModerationCommand,stillCurrent?:(s:BotState)=>boolean,reviewedUntil?:number):Promise<{
 status:'APPLIED'|'DENIED'|'IGNORED'|'UNKNOWN';reason:string}> {
 try{
  if(command.kind==='notice'){const result=await service.issueRuleNotice(actorId,chatId,command.memberId,command.reference,stillCurrent);return {status:result==='ADDED'?'APPLIED':result==='NO_CHANGE'?'IGNORED':'DENIED',reason:'RULE_NOTICE_'+result};}
  if(command.kind==='review'){
   const result=await service.requestRuleReview(actorId,chatId,command.memberId,command.reference,stillCurrent);
   return {status:result==='RECORDED'?'APPLIED':result==='DUPLICATE'?'IGNORED':'DENIED',reason:'RULE_REVIEW_'+result};
  }
  if(command.kind==='warn'||command.kind==='unwarn'){
   const result=command.kind==='warn'
    ?await service.issueWarning(actorId,chatId,command.memberId,command.reference,stillCurrent)
    :await service.removeWarning(actorId,chatId,command.memberId,command.reference,stillCurrent);
   return {status:result.status==='DENIED'?'DENIED':result.status==='NO_CHANGE'?'IGNORED':'APPLIED',reason:'MODERATION_'+result.status};
  }
  const result=command.kind==='kick'?await service.kickMember(actorId,chatId,command.memberId,command.reference,stillCurrent,reviewedUntil):command.kind==='unban'||command.kind==='unmute'
   ?await service.removeManualReason(actorId,chatId,command.memberId,command.reference,command.kind==='unban'?'BAN':'MUTE',stillCurrent,reviewedUntil)
   :await service.addManualReason(actorId,chatId,command.memberId,command.reference,command.kind==='ban'?'BAN':'MUTE',stillCurrent,command.durationSeconds,undefined,reviewedUntil);
  return {status:result.status==='APPLIED'?'APPLIED':result.status==='NO_CHANGE'?'IGNORED':(result.status==='UNKNOWN_OUTCOME'||result.status==='BLOCKED_UNKNOWN'&&result.reason!=='NO_SAFE_DISPATCH')?'UNKNOWN':'DENIED',reason:'MODERATION_'+result.status};
 }catch{
  // A storage error can follow an attempted external effect. Never turn an
  // exception into a successful/no-send result or an automatic retry.
  return {status:'UNKNOWN',reason:'MODERATION_REVIEW_REQUIRED'};
 }
}
