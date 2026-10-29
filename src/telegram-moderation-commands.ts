import type {ModerationService} from './moderation.js';

export type ReplyModerationCommand={kind:'ban'|'mute'|'warn'|'unwarn';reference:string;memberId:string};
type Parsed={status:'NO_MATCH'|'INVALID'}|{status:'COMMAND';command:ReplyModerationCommand};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
/** Only an explicit command and a direct, human-authored same-group reply
 * identify a target. Names, forwarded messages and arguments never do. */
export function parseReplyModerationCommand(text:string,botUsername:string,
 chatId:string,messageId:number|undefined,reply:unknown):Parsed{
 const first=/^\/(ban|mute|warn|unwarn)(?:@([A-Za-z][A-Za-z0-9_]{4,31}))?(?=\s|$)/u.exec(text);
 if(!first)return {status:'NO_MATCH'};
 if(first[2]&&first[2].toLowerCase()!==botUsername.toLowerCase())return {status:'NO_MATCH'};
 const syntax=/^\/(ban|mute|warn|unwarn)(?:@[A-Za-z][A-Za-z0-9_]{4,31})? ([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/u.exec(text);
 if(!syntax||syntax[0]!==text||!/^-[1-9][0-9]{0,15}$/u.test(chatId)||
  !Number.isSafeInteger(Number(chatId))||!positive(messageId)||!object(reply)||
  !positive(reply.message_id)||reply.message_id>=messageId||!object(reply.chat)||
  String(reply.chat.id)!==chatId||!Number.isSafeInteger(reply.chat.id)||
  !['group','supergroup'].includes(String(reply.chat.type))||!object(reply.from)||
  !positive(reply.from.id)||reply.from.is_bot!==false||reply.sender_chat!==undefined||
  reply.via_bot!==undefined||reply.forward_origin!==undefined||reply.forward_date!==undefined||
  reply.is_automatic_forward===true)return {status:'INVALID'};
 return {status:'COMMAND',command:{kind:syntax[1] as ReplyModerationCommand['kind'],reference:syntax[2]!,memberId:String(reply.from.id)}};
}
/** Shared domain service owns grants, target protection, pending/unknown
 * quarantine and durable sanction intents. This adapter never calls Bot API
 * itself and never emits target identities or reasons into a group. */
export async function executeReplyModerationCommand(service:ModerationService,
 actorId:string,chatId:string,command:ReplyModerationCommand):Promise<{
 status:'APPLIED'|'DENIED'|'IGNORED'|'UNKNOWN';reason:string}> {
 try{
  if(command.kind==='warn'||command.kind==='unwarn'){
   const result=command.kind==='warn'
    ?await service.issueWarning(actorId,chatId,command.memberId,command.reference)
    :await service.removeWarning(actorId,chatId,command.memberId,command.reference);
   return {status:result.status==='DENIED'?'DENIED':result.status==='NO_CHANGE'?'IGNORED':'APPLIED',reason:'MODERATION_'+result.status};
  }
  const result=await service.addManualReason(actorId,chatId,command.memberId,command.reference,command.kind==='ban'?'BAN':'MUTE');
  return {status:result.status==='APPLIED'?'APPLIED':result.status==='NO_CHANGE'?'IGNORED':result.status==='UNKNOWN_OUTCOME'?'UNKNOWN':'DENIED',reason:'MODERATION_'+result.status};
 }catch{
  // A storage error can follow an attempted external effect. Never turn an
  // exception into a successful/no-send result or an automatic retry.
  return {status:'UNKNOWN',reason:'MODERATION_REVIEW_REQUIRED'};
 }
}
