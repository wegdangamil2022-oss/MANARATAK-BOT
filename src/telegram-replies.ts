import {subscriptionVerificationEpoch} from './subscription-verification-access.js';
import {validAdminUIAccess,protectionUIEpoch,ADMIN_UI_TTL_MS} from './protection-ui-access.js';
import {createHash,randomUUID} from 'node:crypto';
import {BotStore,type BotState,type TelegramReplyJob} from './store.js';
import {Policy} from './policy.js';
import {forumTopicEducationMode} from './group-forum-topic-policy.js';
import type {TelegramReplyPlan} from './telegram-transport.js';
import {isValidTelegramReplyKeyboard} from './telegram-menu.js';
import {isValidTelegramInlineKeyboard} from './telegram-inline-owner.js';
import {validGroupRulesMarkup} from './telegram-group-rules-markup.js';
import {validStudioNativeKeyboard} from './telegram-studio-rich.js';
import {groupQuestionEpochDigest,groupMenuEpochDigest,privateGroupEpochDigest} from './telegram-group-access.js';
import {privateLibraryEpoch} from './private-library-access.js';
import {communityFolderEpoch} from './community-folder-access.js';
import {validCommunityMessageMetadata,matchesCommunityClose} from './community-message-receipt.js';
import {studioPreviewEpoch} from './studio-preview-access.js';
import {subscriptionRequirementMode,acceptsActiveSubscriptionEvidence} from './subscription-integrity.js';
import type {SubscriptionGate} from './subscription.js';
import type {MembershipPort} from './education-interactions.js';
import type {TelegramEphemeralTextSender} from './telegram-ephemeral-sender.js';
import type {TelegramTemporaryGroupSender} from './telegram-temporary-group-sender.js';
import {validSubscriptionFallbackCleanup,subscriptionFallbackReceiptDigest,subscriptionFallbackReceiptEvidence,subscriptionFallbackVerified,type SubscriptionFallbackCleanup} from './subscription-fallback-receipt.js';
import {recordSubscriptionDelivery} from './subscription-activity-summary.js';
import {CLEANUP_ATTEMPT_TIMEOUT_MS,cleanupAttemptStartedAt,recordCleanupAttempt,reconcileInterruptedCleanup} from './subscription-cleanup-attempt.js';

export type TelegramSendResult={status:'CONFIRMED';messageId:number}|
 {status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
export type TelegramTemporaryPrivateResult=TelegramSendResult|{status:'PRIVATE_UNAVAILABLE'};
export interface TelegramReplySender {
 send(plan:TelegramReplyPlan):Promise<TelegramSendResult>;
 sendTemporaryPrivate?(plan:TelegramReplyPlan,verifyAuthority:()=>Promise<boolean>):Promise<TelegramTemporaryPrivateResult>;
 deleteOwnPrivate?(chatId:string,messageId:number,verifyAuthority:()=>Promise<boolean>):Promise<'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT'>;
}
const validChat=(chat:string)=>/^(?:[1-9]\d{0,15}|-[1-9]\d{0,15})$/.test(chat)&&
 Number.isSafeInteger(Number(chat));
const validPlan=(p:unknown):p is TelegramReplyPlan=>{
 if(!p||typeof p!=='object'||Array.isArray(p))return false;
 const v=p as Record<string,unknown>;
 return (Object.keys(v).length===(3+(v.replyMarkup===undefined?0:1)+(v.inlineMarkup===undefined?0:1)+(v.studioMarkup===undefined?0:1)+(v.groupRulesMarkup===undefined?0:1)+(v.editMessageId===undefined?0:1)+(v.messageThreadId===undefined?0:1)))&&
  Object.keys(v).every(k=>['chatId','parseMode','text','replyMarkup','inlineMarkup','studioMarkup','groupRulesMarkup','editMessageId','messageThreadId'].includes(k))&&
  (v.messageThreadId===undefined||typeof v.chatId==='string'&&v.chatId.startsWith('-')&&Number.isSafeInteger(v.messageThreadId)&&Number(v.messageThreadId)>0&&Number(v.messageThreadId)<=2147483647)&&
  [v.replyMarkup,v.inlineMarkup,v.studioMarkup,v.groupRulesMarkup].filter(x=>x!==undefined).length<=1&&
  (v.replyMarkup===undefined||isValidTelegramReplyKeyboard(v.replyMarkup))&&
  (v.inlineMarkup===undefined||isValidTelegramInlineKeyboard(v.inlineMarkup))&&
  (v.studioMarkup===undefined||typeof v.chatId==='string'&&!v.chatId.startsWith('-')&&validStudioNativeKeyboard(v.studioMarkup))&&
  (v.groupRulesMarkup===undefined||typeof v.chatId==='string'&&v.chatId.startsWith('-')&&v.editMessageId===undefined&&validGroupRulesMarkup(v.groupRulesMarkup))&&
  (v.editMessageId===undefined||(typeof v.editMessageId==='number'&&
    Number.isSafeInteger(v.editMessageId)&&v.editMessageId>0&&(v.inlineMarkup!==undefined||v.studioMarkup!==undefined)))&&
  v.parseMode==='HTML'&&typeof v.chatId==='string'&&
  validChat(v.chatId)&&typeof v.text==='string'&&v.text.length>0&&
  Buffer.byteLength(v.text,'utf8')<=4096&& !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v.text);
};
/**
 * Real Telegram Bot API boundary, but construction alone performs no network
 * calls. Does not retry ambiguous requests, never returns provider descriptions
 * or the token, and sends only fixed-format HTML text plans.
 */
export class TelegramBotApiTextSender implements TelegramReplySender {
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token))
   throw new Error('INVALID_TELEGRAM_TOKEN');
 }
 async send(plan:TelegramReplyPlan):Promise<TelegramSendResult>{
  if(!validPlan(plan))return {status:'FAILED_CONFIRMED'};
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+
    (plan.editMessageId===undefined?'/sendMessage':'/editMessageText'),{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:plan.chatId,text:plan.text,parse_mode:'HTML',
     link_preview_options:{is_disabled:true},
     ...(plan.editMessageId===undefined?{protect_content:true}:{message_id:plan.editMessageId}),
     ...(plan.editMessageId===undefined&&plan.messageThreadId!==undefined?{message_thread_id:plan.messageThreadId}:{}),
     ...(plan.groupRulesMarkup?{reply_markup:plan.groupRulesMarkup}:plan.studioMarkup?{reply_markup:plan.studioMarkup}:plan.inlineMarkup?{reply_markup:plan.inlineMarkup}:plan.replyMarkup?{reply_markup:plan.replyMarkup}:{})}),
    redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return {status:'UNKNOWN_OUTCOME'};}
  let value:unknown;
  try{
   // Do not keep or log Telegram's response descriptions, tokens or identifiers.
   const raw=await response.text();
   if(raw.length>16_384)return {status:'UNKNOWN_OUTCOME'};
   value=JSON.parse(raw);
  }catch{return {status:'UNKNOWN_OUTCOME'};}
  if(!value||typeof value!=='object'||Array.isArray(value))
   return {status:'UNKNOWN_OUTCOME'};
  const v=value as Record<string,unknown>;
  if(response.ok&&v.ok===true&&v.result&&typeof v.result==='object'&&!Array.isArray(v.result)){
   const msg=v.result as Record<string,unknown>,chat=msg.chat;
   if(Number.isSafeInteger(msg.message_id)&&typeof msg.message_id==='number'&&msg.message_id>0&&
      (plan.editMessageId===undefined||plan.editMessageId===msg.message_id)&&
      (plan.messageThreadId===undefined||plan.messageThreadId===msg.message_thread_id)&&
      chat&&typeof chat==='object'&&!Array.isArray(chat)&&
      (chat as Record<string,unknown>).id===Number(plan.chatId))
    return {status:'CONFIRMED',messageId:msg.message_id};
   return {status:'UNKNOWN_OUTCOME'};
  }
  if(response.status>=400&&response.status<500&&v.ok===false)
   return {status:'FAILED_CONFIRMED'};
  return {status:'UNKNOWN_OUTCOME'};
 }
 async deleteOwnPrivate(chatId:string,messageId:number,verifyAuthority:()=>Promise<boolean>):Promise<'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT'>{
  if(/^[1-9][0-9]{0,15}$/u.exec(chatId)?.[0]!==chatId||!Number.isSafeInteger(Number(chatId))||!Number.isSafeInteger(messageId)||messageId<1||typeof verifyAuthority!=='function')return 'FAILED_CONFIRMED';
  try{if(await verifyAuthority()!==true)return 'NOT_SENT';}catch{return 'NOT_SENT';}
  try{const response=await this.request('https://api.telegram.org/bot'+this.token+'/deleteMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,message_id:messageId}),redirect:'error',signal:AbortSignal.timeout(8000)});const raw=await response.text();if(raw.length>16384)return 'UNKNOWN_OUTCOME';const body:unknown=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))return 'UNKNOWN_OUTCOME';const data=body as Record<string,unknown>;if(response.ok&&response.status===200&&data.ok===true&&data.result===true)return 'ACKNOWLEDGED';if(response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status)return 'FAILED_CONFIRMED';return 'UNKNOWN_OUTCOME';}catch{return 'UNKNOWN_OUTCOME';}
 }
 async sendTemporaryPrivate(plan:TelegramReplyPlan,verifyAuthority:()=>Promise<boolean>):Promise<TelegramTemporaryPrivateResult>{
  try{plan=structuredClone(plan);}catch{return {status:'FAILED_CONFIRMED'};}
  if(!validPlan(plan)||plan.chatId.startsWith('-')||plan.editMessageId!==undefined||typeof verifyAuthority!=='function')return {status:'FAILED_CONFIRMED'};
  try{if(await verifyAuthority()!==true)return {status:'FAILED_CONFIRMED'};}catch{return {status:'FAILED_CONFIRMED'};}
  try{const response=await this.request('https://api.telegram.org/bot'+this.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:plan.chatId,text:plan.text,parse_mode:'HTML',protect_content:true,link_preview_options:{is_disabled:true},...(plan.studioMarkup?{reply_markup:plan.studioMarkup}:plan.inlineMarkup?{reply_markup:plan.inlineMarkup}:plan.replyMarkup?{reply_markup:plan.replyMarkup}:{})}),redirect:'error',signal:AbortSignal.timeout(8000)});const raw=await response.text();if(raw.length>16384)return {status:'UNKNOWN_OUTCOME'};const body:unknown=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))return {status:'UNKNOWN_OUTCOME'};const data=body as Record<string,unknown>,message=data.result;if(response.ok&&response.status===200&&data.ok===true&&message&&typeof message==='object'&&!Array.isArray(message)){const m=message as Record<string,unknown>,chat=m.chat,from=m.from;if(chat&&typeof chat==='object'&&!Array.isArray(chat)&&(chat as Record<string,unknown>).id===Number(plan.chatId)&&from&&typeof from==='object'&&!Array.isArray(from)&&(from as Record<string,unknown>).id===Number(this.token.split(':')[0])&&(from as Record<string,unknown>).is_bot===true&&typeof m.message_id==='number'&&Number.isSafeInteger(m.message_id)&&m.message_id>0)return {status:'CONFIRMED',messageId:m.message_id};return {status:'UNKNOWN_OUTCOME'};}if(response.status===403&&data.ok===false&&data.error_code===403)return {status:'PRIVATE_UNAVAILABLE'};if(response.status>=400&&response.status<500&&data.ok===false&&data.error_code===response.status)return {status:'FAILED_CONFIRMED'};return {status:'UNKNOWN_OUTCOME'};}catch{return {status:'UNKNOWN_OUTCOME'};}
 }
}

/** answerCallbackQuery is a non-durable UI acknowledgement, NOT an action.
 * Never retry an ambiguous HTTP outcome; no provider body or token is logged.
 */
export class TelegramBotApiCallbackAcker {
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token))
   throw new Error('INVALID_TELEGRAM_TOKEN');
 }
 async answer(callbackQueryId:string,outcome?:'APPLIED'|'DUPLICATE'|'DENIED'|'IGNORED'|'UNKNOWN'):Promise<void>{
  if(typeof callbackQueryId!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/u.test(callbackQueryId)))return;
  try{
   await this.request('https://api.telegram.org/bot'+this.token+'/answerCallbackQuery',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({callback_query_id:callbackQueryId,cache_time:0,
     ...(outcome==='DENIED'?{text:'هذا الزر غير متاح أو انتهت صلاحيته. افتح القائمة مجددًا وتحقق من صلاحيتك.',show_alert:true}:
      outcome==='DUPLICATE'?{text:'عولج هذا الطلب سابقًا؛ لم تُكرر العملية.',show_alert:false}:
      outcome==='UNKNOWN'?{text:'نتيجة الطلب غير مؤكدة؛ لن تُعاد العملية تلقائيًا.',show_alert:true}:{})}),
    redirect:'error',signal:AbortSignal.timeout(4000)
   });
  }catch{/* Callback acknowledgement is best effort and never retried. */}
 }
}

export type ReplyDispatchResult={status:'NO_REPLY'|'CONFIRMED'|'SENT'|'SENDING'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'PAUSED'};
const knownStatus=(x:unknown):x is TelegramReplyJob['status']=>[
 'QUEUED','SENDING','SENT','FAILED_CONFIRMED','UNKNOWN_OUTCOME'
].includes(x as string);
const validManualReview=(v:unknown):boolean=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const r=v as Record<string,unknown>;
 return Object.keys(r).length===4 &&
  Object.keys(r).every(k=>['decision','reviewedBy','reviewedAt','attemptId'].includes(k))&&
  (r.decision==='ACKNOWLEDGED_UNRESOLVED'||r.decision==='ESCALATED')&&
  typeof r.reviewedBy==='string'&&/^[1-9]\d{0,19}$/.test(r.reviewedBy)&&
  typeof r.attemptId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(r.attemptId)&&
  typeof r.reviewedAt==='number'&&Number.isSafeInteger(r.reviewedAt)&&r.reviewedAt>=0;
};

/** Only the approved inline library UI carries gl:1 callbacks.
 * Other forum rules, moderation and subscription replies are unaffected. */
function isForumEducationalLibraryReply(job:TelegramReplyJob):boolean{
 const plan=job.plan;
 return !!plan&&plan.chatId.startsWith('-')&&
  plan.messageThreadId!==undefined&&
  plan.inlineMarkup?.inline_keyboard.some(row=>row.some(b=>
   b.callback_data.startsWith('gl:1:')))===true;
}
const validGroupReplyAccess=(v:unknown):v is NonNullable<TelegramReplyJob['groupQuestionAccess']>=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const r=v as Record<string,unknown>;
 return Object.keys(r).length===3&&
  typeof r.actorId==='string'&&/^[1-9]\d{0,19}$/u.test(r.actorId)&&
  typeof r.epoch==='string'&&/^[a-f0-9]{64}$/u.test(r.epoch)&&
  typeof r.expiresAt==='number'&&Number.isSafeInteger(r.expiresAt)&&
  r.expiresAt>=0&&r.expiresAt<=8_640_000_000_000_000;
};
const validPrivateGroupAccess=(v:unknown):v is NonNullable<TelegramReplyJob['privateGroupAccess']>=>{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const a=v as Record<string,unknown>;
 return Object.keys(a).length===4&&
  typeof a.actorId==='string'&&/^[1-9]\d{0,19}$/u.test(a.actorId)&&
  typeof a.scope==='string'&&/^-[1-9]\d{0,18}$/u.test(a.scope)&&
  typeof a.epoch==='string'&&/^[a-f0-9]{64}$/u.test(a.epoch)&&
  typeof a.expiresAt==='number'&&Number.isSafeInteger(a.expiresAt)&&
  a.expiresAt>=0&&a.expiresAt<=8_640_000_000_000_000;
};
const publicFallbackProof=(access:NonNullable<TelegramReplyJob['privateGroupAccess']>,topicId:number|undefined)=>createHash('sha256').update(JSON.stringify([access.actorId,access.scope,access.epoch,access.expiresAt,topicId??null])).digest('hex');
export function validTelegramReplyJob(v:unknown):v is TelegramReplyJob{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const j=v as Record<string,unknown>;
 return typeof j.updateKey==='string'&&/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(j.updateKey)&&
  knownStatus(j.status)&&
  validCommunityMessageMetadata(v as TelegramReplyJob)&&
  (j.verificationEphemeral===undefined||(j.verificationEphemeral===true&&j.status==='QUEUED'&&j.privateReplyKind==='VERIFICATION_SCOPED'&&validPlan(j.plan)&&j.plan.editMessageId===undefined&&j.plan.studioMarkup!==undefined&&validPrivateGroupAccess(j.privateGroupAccess)))&&
  (j.verificationEphemeralTopicId===undefined||(j.verificationEphemeral===true&&Number.isSafeInteger(j.verificationEphemeralTopicId)&&Number(j.verificationEphemeralTopicId)>=1&&Number(j.verificationEphemeralTopicId)<=2147483647))&&
  (j.verificationFallback===undefined||(j.verificationFallback===true&&j.status==='QUEUED'&&j.privateReplyKind==='VERIFICATION_SCOPED'&&j.verificationEphemeral===undefined&&validPrivateGroupAccess(j.privateGroupAccess)))&&
  (j.verificationPublicFallback===undefined||(j.verificationPublicFallback===true&&j.status==='QUEUED'&&j.privateReplyKind==='VERIFICATION_SCOPED'&&j.verificationEphemeral===undefined&&j.verificationFallback===undefined&&validPrivateGroupAccess(j.privateGroupAccess)))&&
  (j.verificationFallbackTopicId===undefined||((j.verificationFallback===true||j.verificationPublicFallback===true)&&Number.isSafeInteger(j.verificationFallbackTopicId)&&Number(j.verificationFallbackTopicId)>=1&&Number(j.verificationFallbackTopicId)<=2147483647))&&
  (j.verificationCleanup===undefined||(j.status==='SENT'&&validSubscriptionFallbackCleanup(j.verificationCleanup)&&j.messageId===j.verificationCleanup.messageId&&j.attemptId===j.verificationCleanup.sendAttemptId&&j.verificationFallback===undefined&&j.verificationPublicFallback===undefined))&&
  ((j.plan as TelegramReplyPlan|undefined)?.groupRulesMarkup===undefined||j.groupReplyKind==='GENERAL'&&validGroupReplyAccess(j.groupMenuAccess))&&
  ((j.plan as TelegramReplyPlan|undefined)?.messageThreadId===undefined||j.groupReplyKind==='GENERAL'&&validGroupReplyAccess(j.groupMenuAccess))&&
  (j.status==='QUEUED'?validPlan(j.plan):(j.plan===undefined||validPlan(j.plan)))&&
  (j.queuedAt===undefined||(typeof j.queuedAt==='number'&&Number.isSafeInteger(j.queuedAt)&&j.queuedAt>=0))&&
  (j.startedAt===undefined||(typeof j.startedAt==='number'&&Number.isSafeInteger(j.startedAt)&&j.startedAt>=0))&&
  (j.redactedAt===undefined||(typeof j.redactedAt==='number'&&Number.isSafeInteger(j.redactedAt)&&j.redactedAt>=0))&&
  (j.accessDenialCode===undefined||(j.status==='FAILED_CONFIRMED'&&[
   'LEGACY_UNVERIFIABLE','ACCESS_RECHECK_FAILED','GROUP_UNAVAILABLE'
  ].includes(j.accessDenialCode as string)))&&
  (j.groupReplyKind===undefined||
   (j.status==='QUEUED'&&validPlan(j.plan)&&j.plan.chatId.startsWith('-')&&
    (j.groupReplyKind==='GENERAL'||j.groupReplyKind==='REVIEWED_FAQ')&&
    j.privateReplyKind===undefined&&j.privateGroupAccess===undefined&&
    ((j.groupReplyKind==='GENERAL'&&j.groupQuestionAccess===undefined&&
      (j.groupMenuAccess===undefined||validGroupReplyAccess(j.groupMenuAccess)))||
     (j.groupReplyKind==='REVIEWED_FAQ'&&validGroupReplyAccess(j.groupQuestionAccess)&&
      j.groupMenuAccess===undefined))))&&
  (j.privateReplyKind===undefined||
   (j.status==='QUEUED'&&validPlan(j.plan)&&
    !j.plan.chatId.startsWith('-')&&
    (j.privateReplyKind==='LOCAL'||j.privateReplyKind==='GROUP_SCOPED'||j.privateReplyKind==='VERIFICATION_SCOPED'||j.privateReplyKind==='ADMIN_SCOPED'||j.privateReplyKind==='LIBRARY_SCOPED'||j.privateReplyKind==='STUDIO_SCOPED'||j.privateReplyKind==='COMMUNITY_SCOPED')&&
    j.groupReplyKind===undefined&&j.groupQuestionAccess===undefined&&
    j.groupMenuAccess===undefined&&
    ((j.privateReplyKind==='LOCAL'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined)||
     ((j.privateReplyKind==='ADMIN_SCOPED'||j.privateReplyKind==='STUDIO_SCOPED')&&j.privateGroupAccess===undefined&&j.privateLibraryAccess===undefined&&validAdminUIAccess(j.adminUIAccess)&&j.plan.chatId===j.adminUIAccess.actorId)||
     (j.privateReplyKind==='LIBRARY_SCOPED'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&validAdminUIAccess(j.privateLibraryAccess)&&j.plan.chatId===j.privateLibraryAccess.actorId)||
     (j.privateReplyKind==='COMMUNITY_SCOPED'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined&&validAdminUIAccess(j.communityAccess)&&j.plan.chatId===j.communityAccess.actorId)||
     ((j.privateReplyKind==='GROUP_SCOPED'||j.privateReplyKind==='VERIFICATION_SCOPED')&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined&&
      validPrivateGroupAccess(j.privateGroupAccess)&&
      j.plan.chatId===j.privateGroupAccess.actorId))))&&
  (j.adminUIAccess===undefined||(j.status==='QUEUED'&&validPlan(j.plan)&&validAdminUIAccess(j.adminUIAccess)&&
   j.plan.chatId===j.adminUIAccess.actorId&&(j.privateReplyKind==='ADMIN_SCOPED'||j.privateReplyKind==='STUDIO_SCOPED')&&j.privateGroupAccess===undefined&&
   j.groupReplyKind===undefined&&j.groupQuestionAccess===undefined&&j.groupMenuAccess===undefined))&&
  (j.communityAccess===undefined||(j.status==='QUEUED'&&validPlan(j.plan)&&validAdminUIAccess(j.communityAccess)&&j.plan.chatId===j.communityAccess.actorId&&j.privateReplyKind==='COMMUNITY_SCOPED'&&j.privateLibraryAccess===undefined&&j.adminUIAccess===undefined&&j.privateGroupAccess===undefined&&j.groupReplyKind===undefined&&j.groupQuestionAccess===undefined&&j.groupMenuAccess===undefined))&&
  (j.privateLibraryAccess===undefined||(j.status==='QUEUED'&&validPlan(j.plan)&&validAdminUIAccess(j.privateLibraryAccess)&&
   j.plan.chatId===j.privateLibraryAccess.actorId&&j.privateReplyKind==='LIBRARY_SCOPED'&&j.adminUIAccess===undefined&&j.privateGroupAccess===undefined&&
   j.groupReplyKind===undefined&&j.groupQuestionAccess===undefined&&j.groupMenuAccess===undefined))&&
  (j.privateGroupAccess===undefined||
   (j.status==='QUEUED'&&validPlan(j.plan)&&
    validPrivateGroupAccess(j.privateGroupAccess)&&
    j.plan.chatId===j.privateGroupAccess.actorId&&
    !j.plan.chatId.startsWith('-')&&
    j.groupReplyKind===undefined&&
    j.groupQuestionAccess===undefined&&j.groupMenuAccess===undefined))&&
  (j.groupMenuAccess===undefined||
   (j.status==='QUEUED'&&validPlan(j.plan)&&j.plan.chatId.startsWith('-')&&
    j.groupReplyKind==='GENERAL'&&
    j.groupQuestionAccess===undefined&&validGroupReplyAccess(j.groupMenuAccess)))&&
  (j.groupQuestionAccess===undefined||
   (j.status==='QUEUED'&&validPlan(j.plan)&&j.plan.chatId.startsWith('-')&&
    j.groupMenuAccess===undefined&&validGroupReplyAccess(j.groupQuestionAccess)))&&
  (j.manualReview===undefined||(
   validManualReview(j.manualReview)&&
   (j.status==='SENDING'||j.status==='UNKNOWN_OUTCOME')&&
   typeof j.attemptId==='string'&&
   (j.manualReview as Record<string,unknown>).attemptId===j.attemptId
  ));
}
function publicFallbackEvidence(state:BotState,policy:Policy,job:TelegramReplyJob):boolean{
 const access=job.privateGroupAccess,rows=state.audit.filter(a=>a.updateKey===job.updateKey+':private-rejected'),row=rows[0];
 return job.verificationPublicFallback===true&&!!access&&rows.length===1&&!!row&&row.actorId===access.actorId&&row.decision==='NOOP'&&row.at===job.queuedAt&&row.policyVersion===policy.chatRevision(state,access.scope)&&row.reason==='SUBSCRIPTION_PRIVATE_REJECTED:'+publicFallbackProof(access,job.verificationFallbackTopicId)&&!state.audit.some(a=>a.updateKey===job.updateKey+':public-fallback-start');
}
function quarantinePublicFallback(job:TelegramReplyJob,now:number):void{
 job.status='UNKNOWN_OUTCOME';delete job.plan;delete job.privateGroupAccess;delete job.privateReplyKind;delete job.verificationPublicFallback;delete job.verificationFallbackTopicId;job.redactedAt=now;
}
/** Local snapshot integrity for trial readiness. A restored duplicate key or
 * malformed row is not an independent successful delivery receipt.
 * This is a pure test of durable local evidence, never a Telegram result.
 */
export function telegramReplyLedgerSafeForTrial(
 jobs:readonly TelegramReplyJob[]|undefined):boolean{
 if(jobs===undefined)return true;
 if(!Array.isArray(jobs))return false;
 const seen=new Set<string>();
 for(const job of jobs){
  if(!validTelegramReplyJob(job)||seen.has(job.updateKey))return false;
  seen.add(job.updateKey);
 }
 return true;
}
/**
 * Durable, one-shot outbound dispatch. Claim is committed before the external
 * call. If an API response is ambiguous or the process crashes in SENDING,
 * never automatically retry and risk duplicate Telegram messages.
 */
export class TelegramReplyDispatcher {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly sender:TelegramReplySender,private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>,
  private readonly subscription?:SubscriptionGate,
  private readonly membership?:MembershipPort,
  private readonly ephemeralSender?:TelegramEphemeralTextSender,
  private readonly fallbackCleanupEnabled=false,
  private readonly publicFallback?:{sender:TelegramTemporaryGroupSender;botUsername:string}){}
 async drainVerificationFallbacks(limit=5):Promise<{status:'DISABLED'|'INVALID'|'STOPPED'|'RAN';checked:number}>{
  if(!this.fallbackCleanupEnabled||!this.safetyGate||!this.sender.sendTemporaryPrivate||!this.sender.deleteOwnPrivate)return {status:'DISABLED',checked:0};
  const clockValid=()=>{const now=this.clock();return Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000;};
  if(!clockValid()||!Number.isSafeInteger(limit)||limit<1||limit>10)return {status:'INVALID',checked:0};
  const allowed=async()=>{try{return await this.safetyGate!()===true;}catch{return false;}};if(!await allowed())return {status:'STOPPED',checked:0};
  const state=await this.store.snapshot(),jobs=state.telegramReplyJobs??[],counts=new Map<string,number>();for(const j of jobs)counts.set(j.updateKey,(counts.get(j.updateKey)??0)+1);
  const malformed=jobs.filter(j=>counts.get(j.updateKey)===1&&j.status==='QUEUED'&&j.verificationPublicFallback===true&&validTelegramReplyJob(j)&&!publicFallbackEvidence(state,this.policy,j)).slice(0,limit).map(j=>j.updateKey);
  if(malformed.length){const quarantined=await this.store.transaction(async s=>{if(!await allowed())return 'STOPPED' as const;const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)return 'INVALID' as const;for(const key of malformed){const found=(s.telegramReplyJobs??[]).filter(j=>j.updateKey===key),job=found[0];if(found.length===1&&job&&job.status==='QUEUED'&&job.verificationPublicFallback===true&&validTelegramReplyJob(job)&&!publicFallbackEvidence(s,this.policy,job))quarantinePublicFallback(job,now);}return 'RAN' as const;});if(quarantined!=='RAN')return {status:quarantined,checked:0};}
  const keys=jobs.filter(j=>counts.get(j.updateKey)===1&&j.status==='QUEUED'&&validTelegramReplyJob(j)&&(j.verificationFallback===true||j.verificationPublicFallback===true&&!!this.publicFallback&&publicFallbackEvidence(state,this.policy,j))).sort((a,b)=>(a.queuedAt??0)-(b.queuedAt??0)||a.updateKey.localeCompare(b.updateKey)).slice(0,limit).map(j=>j.updateKey);let checked=0;
  for(const key of keys){if(!await allowed())return {status:'STOPPED',checked};if(!clockValid())return {status:'INVALID',checked};await this.dispatch(key);checked++;}
  return {status:'RAN',checked};
 }
 async cleanupVerificationFallbacks(limit=5):Promise<{status:'DISABLED'|'INVALID'|'STOPPED'|'RAN';checked:number;acknowledged:number;unresolved:number}>{
  const summary={checked:0,acknowledged:0,unresolved:0};if(!this.fallbackCleanupEnabled||!this.sender.deleteOwnPrivate||!this.safetyGate)return {status:'DISABLED',...summary};
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!Number.isSafeInteger(limit)||limit<1||limit>10)return {status:'INVALID',...summary};
  const permitted=async()=>{try{return await this.safetyGate!()===true;}catch{return false;}};if(!await permitted())return {status:'STOPPED',...summary};
  const recovery=await this.store.transaction(async s=>{
   if(!await permitted())return {status:'STOPPED' as const,count:0};
   const at=this.clock();if(!Number.isSafeInteger(at)||at<now||at>8640000000000000)return {status:'INVALID' as const,count:0};
   return {status:'RAN' as const,count:reconcileInterruptedCleanup(s,at,limit)};
  });
  if(recovery.status!=='RAN')return {status:recovery.status,...summary};
  const recovered=recovery.count;
  summary.checked+=recovered;summary.unresolved+=recovered;
  if(recovered===limit)return {status:'RAN',...summary};
  const snapshot=await this.store.snapshot(),jobs=snapshot.telegramReplyJobs??[],keyCounts=new Map<string,number>(),receiptCounts=new Map<string,number>();
  for(const job of jobs){keyCounts.set(job.updateKey,(keyCounts.get(job.updateKey)??0)+1);const receipt=job.verificationCleanup;if(receipt){const key=JSON.stringify([receipt.chatId,receipt.messageId]);receiptCounts.set(key,(receiptCounts.get(key)??0)+1);}}
  // Filter untrusted or duplicate receipts before applying the batch limit, so
  // they cannot indefinitely hide later, valid notices from cleanup.
  const candidates=jobs.filter(j=>{const receipt=j.verificationCleanup;return j.status==='SENT'&&validTelegramReplyJob(j)&&!!receipt&&receipt.status==='WAITING'&&(receipt.memberId===undefined||this.publicFallback!==undefined)&&keyCounts.get(j.updateKey)===1&&receiptCounts.get(JSON.stringify([receipt.chatId,receipt.messageId]))===1&&subscriptionFallbackReceiptEvidence(snapshot,j,receipt)&&(receipt.deleteAfter<=now||receipt.verifiedAt!==undefined&&receipt.verifiedAt<=now&&subscriptionFallbackVerified(snapshot,j,receipt));}).sort((a,b)=>a.verificationCleanup!.deleteAfter-b.verificationCleanup!.deleteAfter||a.updateKey.localeCompare(b.updateKey)).slice(0,limit-recovered);
  for(const candidate of candidates){
   if(!await permitted())return {status:'STOPPED',...summary};
   const claim=await this.store.transaction(s=>{const jobs=s.telegramReplyJobs?.filter(j=>j.updateKey===candidate.updateKey)??[],job=jobs[0],at=this.clock();if(jobs.length!==1||!job||!validTelegramReplyJob(job)||!Number.isSafeInteger(at)||at<0)return null;const receipt=job.verificationCleanup;if(!receipt||!subscriptionFallbackReceiptEvidence(s,job,receipt)||receipt.status!=='WAITING'||at<receipt.createdAt||at<receipt.deleteAfter&&!(receipt.verifiedAt!==undefined&&receipt.verifiedAt<=at&&subscriptionFallbackVerified(s,job,receipt))||JSON.stringify(receipt)!==JSON.stringify(candidate.verificationCleanup))return null;
    if((s.telegramReplyJobs??[]).filter(j=>j.verificationCleanup?.chatId===receipt.chatId&&j.verificationCleanup?.messageId===receipt.messageId).length!==1)return null;
    const attemptId=randomUUID();receipt.attemptId=attemptId;receipt.status='DELETING';
    if(!recordCleanupAttempt(s,job,receipt,at))throw Error('VERIFICATION_CLEANUP_AUDIT_CONFLICT');
    if(at>=receipt.createdAt+48*3600000){receipt.status='EXPIRED_UNSENT';if(!recordCleanupAttempt(s,job,receipt,at,'EXPIRED_UNSENT'))throw Error('VERIFICATION_CLEANUP_AUDIT_CONFLICT');return {expired:true as const};}
    return {expired:false as const,attemptId,startedAt:at,receipt:structuredClone(receipt)};
   });
   if(!claim)continue;summary.checked++;if(claim.expired)continue;
   let outcome:'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'NOT_SENT';try{
    const deleteNotice=claim.receipt.memberId===undefined?this.sender.deleteOwnPrivate!.bind(this.sender):this.publicFallback?.sender.delete.bind(this.publicFallback.sender);
    outcome=deleteNotice?await deleteNotice(claim.receipt.chatId,claim.receipt.messageId,async()=>{
     if(!await permitted())return false;
     // Safety reads can wait: re-read local evidence and clock afterwards.
     const state=await this.store.snapshot(),rows=state.telegramReplyJobs?.filter(j=>j.updateKey===candidate.updateKey)??[],job=rows[0],at=this.clock();
     return Number.isSafeInteger(at)&&at<=8640000000000000&&at>=claim.startedAt&&at<claim.startedAt+CLEANUP_ATTEMPT_TIMEOUT_MS&&at<claim.receipt.createdAt+48*3600000&&rows.length===1&&!!job&&job.status==='SENT'&&validTelegramReplyJob(job)&&validSubscriptionFallbackCleanup(job.verificationCleanup)&&subscriptionFallbackReceiptEvidence(state,job,job.verificationCleanup)&&cleanupAttemptStartedAt(state,job,job.verificationCleanup)===claim.startedAt&&JSON.stringify(job.verificationCleanup)===JSON.stringify(claim.receipt)&&(at>=job.verificationCleanup.deleteAfter||job.verificationCleanup.verifiedAt!==undefined&&job.verificationCleanup.verifiedAt<=at&&subscriptionFallbackVerified(state,job,job.verificationCleanup))&&(state.telegramReplyJobs??[]).filter(j=>j.verificationCleanup?.chatId===claim.receipt.chatId&&j.verificationCleanup?.messageId===claim.receipt.messageId).length===1;
    }):'NOT_SENT';
   }catch{outcome='UNKNOWN_OUTCOME';}
   if(!['ACKNOWLEDGED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','NOT_SENT'].includes(outcome))outcome='UNKNOWN_OUTCOME';
   const finalized=await this.store.transaction(s=>{
    const rows=s.telegramReplyJobs?.filter(j=>j.updateKey===candidate.updateKey)??[],job=rows[0],at=this.clock();
    if(rows.length!==1||!job||job.status!=='SENT')throw Error('VERIFICATION_CLEANUP_FENCED');
    const receipt=job.verificationCleanup;
    // A timeout reconciliation owns the final result, even if a late adapter returns.
    if(receipt?.status==='UNKNOWN_OUTCOME'&&receipt.attemptId===claim.attemptId&&subscriptionFallbackReceiptDigest(receipt)===subscriptionFallbackReceiptDigest(claim.receipt))return false;
    if(JSON.stringify(receipt)!==JSON.stringify(claim.receipt))throw Error('VERIFICATION_CLEANUP_FENCED');
    if(!Number.isSafeInteger(at)||at<claim.startedAt||!recordCleanupAttempt(s,job,receipt!,at,outcome))throw Error('VERIFICATION_CLEANUP_AUDIT_CONFLICT');
    if(outcome==='NOT_SENT'){receipt!.status='WAITING';delete receipt!.attemptId;}else receipt!.status=outcome;return true;
   });
   if(!finalized){summary.unresolved++;continue;}
   if(outcome==='ACKNOWLEDGED')summary.acknowledged++;if(outcome==='UNKNOWN_OUTCOME')summary.unresolved++;
  }
  return {status:'RAN',...summary};
 }
 /** Membership evidence is checked before the irreversible SENDING claim.
  * A subsequent transactional policy/epoch fence prevents local state changes
  * during the external membership lookup from authorizing a stale send.
  */
 private async checkGroupEligibility(updateKey:string):Promise<
  {access:NonNullable<TelegramReplyJob['groupQuestionAccess']>;
   kind:'FAQ'|'MENU'|'PRIVATE_GROUP'|'PRIVATE_VERIFICATION';allowed:boolean}|undefined>{
  const snap=await this.store.snapshot();
  const matches=snap.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
  // Never initiate remote membership reads from an ambiguous restored key.
  if(matches.length!==1)return undefined;
  const job=matches[0]!;
  if(job.status!=='QUEUED')return undefined;
  if(!validTelegramReplyJob(job))throw Error('INVALID_REPLY_JOB');
  const kind=job.groupQuestionAccess?'FAQ' as const:
   job.groupMenuAccess?'MENU' as const:job.privateGroupAccess?(job.privateReplyKind==='VERIFICATION_SCOPED'?'PRIVATE_VERIFICATION' as const:'PRIVATE_GROUP' as const):null;
  if(!kind)return undefined;
  const access=structuredClone((kind==='FAQ'?job.groupQuestionAccess:
   kind==='MENU'?job.groupMenuAccess:job.privateGroupAccess)!);
  const groupId=kind==='PRIVATE_GROUP'||kind==='PRIVATE_VERIFICATION'?
   (access as NonNullable<TelegramReplyJob['privateGroupAccess']>).scope:
   job.plan!.chatId,actor=access.actorId;
  let allowed=false;
  try{
   const mode=isForumEducationalLibraryReply(job)?
    forumTopicEducationMode(snap,this.policy,groupId,
     job.plan!.messageThreadId!,this.clock()):'INHERIT';
   if(mode!=='INHERIT')return {access,kind,allowed:false};
   if(this.clock()<access.expiresAt&&
      (kind==='FAQ'?this.policy.mayAskGroup(snap,groupId,actor,true):
       this.policy.canUseChat(snap,groupId,'navigation'))&&
      (kind==='FAQ'?groupQuestionEpochDigest(snap,groupId):
       kind==='MENU'?groupMenuEpochDigest(snap,groupId,job.plan!.messageThreadId):
       kind==='PRIVATE_VERIFICATION'?subscriptionVerificationEpoch(snap,this.policy,actor,groupId,this.clock()):privateGroupEpochDigest(snap,groupId))===access.epoch){
    if(kind==='PRIVATE_GROUP'||kind==='PRIVATE_VERIFICATION'){
     if(!this.membership||await this.membership(groupId,actor)!=='VERIFIED')
      return {access,kind,allowed:false};
    }
    const mode=subscriptionRequirementMode(snap,groupId);
    if(kind==='PRIVATE_VERIFICATION')allowed=true;
    else if(mode==='NONE'||mode==='PAUSED')allowed=true;
    else if(mode==='ACTIVE'&&this.subscription){
     const proof=await this.subscription.verify(groupId,actor);
     allowed=acceptsActiveSubscriptionEvidence(proof.status,this.policy.isOwner(actor));
    }
   }
  }catch{/* provider and local failures fail closed */}
  return {access,kind,allowed};
 }
 async dispatch(updateKey:string):Promise<ReplyDispatchResult>{
  if(!/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(updateKey))
   throw new Error('INVALID_REPLY_KEY');
  let groupPrecheck:Awaited<ReturnType<TelegramReplyDispatcher['checkGroupEligibility']>>;
  try{groupPrecheck=await this.checkGroupEligibility(updateKey);}
  catch{/* invalid state gets revalidated inside the transactional claim */}
  const claim=await this.store.transaction(async s=>{
   const matches=s.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
   // A duplicate key can otherwise select a different queued/terminal receipt.
   // Reject without consuming or scrubbing either entry, inside the durable
   // claim, even if the earlier read saw only one record.
   if(matches.length>1)throw Error('REPLY_DUPLICATE_UPDATE_KEY');
   const job=matches[0];
   if(!job)return {status:'NO_REPLY' as const};
   if(!validTelegramReplyJob(job))throw new Error('INVALID_REPLY_JOB');
   if(job.status==='SENDING')return {status:'UNKNOWN_OUTCOME' as const};
   if(job.status!=='QUEUED')return {status:job.status as 'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
   if((job.verificationFallback||job.verificationPublicFallback)&&s.audit.some(a=>a.updateKey===updateKey+':fallback-sent'))return {status:'UNKNOWN_OUTCOME' as const};
   if(job.verificationEphemeral&&!this.ephemeralSender)return {status:'PAUSED' as const};
   if(job.verificationFallback&&(!this.sender.sendTemporaryPrivate||!this.sender.deleteOwnPrivate||!Number.isSafeInteger(this.clock())||this.clock()>8640000000000000-60000))return {status:'PAUSED' as const};
   if(job.verificationPublicFallback){
    if(!this.publicFallback||!this.safetyGate||!this.membership||!Number.isSafeInteger(this.clock())||this.clock()>8640000000000000-60000)return {status:'PAUSED' as const};
    if(!publicFallbackEvidence(s,this.policy,job)){
     quarantinePublicFallback(job,this.clock());return {status:'UNKNOWN_OUTCOME' as const};
    }
   }
   // Fail-closed emergency switch is checked INSIDE the exclusive queue
   // claim, before any started-attempt receipt is persisted or Bot API call.
   // A fresh RUN check is necessary even after the webhook admitted a request.
   if(this.safetyGate){
    let allowed=false;
    try{allowed=await this.safetyGate();}catch{/* fail closed */}
    if(!allowed)return {status:'PAUSED' as const};
   }
   const plan=structuredClone(job.plan!);
   // Serialize edits to a tracked message. An ambiguous earlier edit is
   // quarantine evidence, not permission to try editing the same message again.
   if(plan.editMessageId!==undefined&&(s.telegramReplyJobs??[]).some(other=>other!==job&&other.communityEditTarget?.chatId===plan.chatId&&other.communityEditTarget.messageId===plan.editMessageId))return {status:'UNKNOWN_OUTCOME' as const};
   const faq=job.groupQuestionAccess,menu=job.groupMenuAccess,dm=job.privateGroupAccess;
   const access=faq??menu??dm;
   const verification=job.privateReplyKind==='VERIFICATION_SCOPED';
   const accessKind=faq?'FAQ':menu?'MENU':dm?verification?'PRIVATE_VERIFICATION':'PRIVATE_GROUP':null;
   const accessScope=dm?.scope??plan.chatId;
   // Unknown legacy group origins, plus GENERAL plans created before the
   // menu witness existed, cannot prove original actor/subscription authority.
   const noGroupProof=plan.chatId.startsWith('-')&&!access;
   // Old DM replies could contain a group's private resource titles.
   // Without a scoped B6 witness or a new trusted LOCAL origin tag, their
   // origin cannot be established from the destination or HTML body.
   const noPrivateProvenance=!plan.chatId.startsWith('-')&&
    job.privateReplyKind===undefined&&!dm;
   const admin=job.adminUIAccess,now=this.clock();
   const adminDenied=Boolean(admin&&(admin.actorId!==plan.chatId||!Number.isSafeInteger(job.queuedAt)||
    now<job.queuedAt!||now>=admin.expiresAt||admin.expiresAt>job.queuedAt!+ADMIN_UI_TTL_MS||
    (job.privateReplyKind==='STUDIO_SCOPED'?studioPreviewEpoch(s,this.policy,admin.actorId,now):protectionUIEpoch(s,this.policy,admin.actorId,now))!==admin.epoch));
   const library=job.privateLibraryAccess;
   const libraryDenied=Boolean(library&&(library.actorId!==plan.chatId||!Number.isSafeInteger(job.queuedAt)||
    now<job.queuedAt!||now>=library.expiresAt||library.expiresAt>job.queuedAt!+ADMIN_UI_TTL_MS||
    privateLibraryEpoch(s,this.policy,library.actorId)!==library.epoch));
   const community=job.communityAccess;
   const communityDenied=Boolean(community&&(community.actorId!==plan.chatId||!Number.isSafeInteger(job.queuedAt)||now<job.queuedAt!||now>=community.expiresAt||community.expiresAt>job.queuedAt!+ADMIN_UI_TTL_MS||communityFolderEpoch(s,this.policy,community.actorId)!==community.epoch));
   const closeDenied=Boolean(job.communityClose&&!matchesCommunityClose(s,this.policy,job.communityClose,now));
   // Revalidate inside the exclusive durable claim, after asynchronous
   // subscription checks, before queuing any Telegram send.
   const forumEducationDenied=isForumEducationalLibraryReply(job)&&
    forumTopicEducationMode(s,this.policy,plan.chatId,
     plan.messageThreadId!,now)!=='INHERIT';
   const forbidden=forumEducationDenied||closeDenied||noGroupProof||noPrivateProvenance||adminDenied||libraryDenied||communityDenied||(!!access&&(
    !groupPrecheck?.allowed||
    groupPrecheck.kind!==accessKind||
    groupPrecheck.access.actorId!==access.actorId||
    groupPrecheck.access.epoch!==access.epoch||
    groupPrecheck.access.expiresAt!==access.expiresAt||
    this.clock()>=access.expiresAt||
    !(faq?this.policy.mayAskGroup(s,accessScope,access.actorId,true):
      this.policy.canUseChat(s,accessScope,'navigation'))||
    (faq?groupQuestionEpochDigest(s,accessScope):
      menu?groupMenuEpochDigest(s,accessScope,plan.messageThreadId):
      verification?subscriptionVerificationEpoch(s,this.policy,access.actorId,accessScope,this.clock()):privateGroupEpochDigest(s,accessScope))!==access.epoch));
   const groupUnavailable=plan.chatId.startsWith('-')&&
    !this.policy.canUseChat(s,plan.chatId,'navigation');
   if(forbidden||groupUnavailable){
    // A reason is only set if no provider call was made. Recheck failures
    // intentionally combine unknown membership, expiry and changed sources;
    // the owner report MUST NOT claim which external event occurred.
    job.accessDenialCode=noGroupProof||noPrivateProvenance?
     'LEGACY_UNVERIFIABLE':groupUnavailable?'GROUP_UNAVAILABLE':'ACCESS_RECHECK_FAILED';
    job.status='FAILED_CONFIRMED';delete job.communityClose;
    delete job.plan;delete job.adminUIAccess;delete job.privateLibraryAccess;delete job.communityAccess;delete job.groupQuestionAccess;delete job.groupMenuAccess;delete job.privateGroupAccess;delete job.privateReplyKind;delete job.groupReplyKind;delete job.verificationEphemeral;delete job.verificationEphemeralTopicId;delete job.verificationFallback;delete job.verificationPublicFallback;delete job.verificationFallbackTopicId;job.redactedAt=this.clock();
    return {status:'FAILED_CONFIRMED' as const};
   }
   const attemptId=randomUUID(),ephemeral=job.verificationEphemeral&&dm?{...structuredClone(dm),...(job.verificationEphemeralTopicId!==undefined?{topicId:job.verificationEphemeralTopicId}:{})}:undefined,fallback=job.verificationFallback&&dm?{...structuredClone(dm),...(job.verificationFallbackTopicId!==undefined?{topicId:job.verificationFallbackTopicId}:{})}:undefined,publicFallback=job.verificationPublicFallback&&dm?{...structuredClone(dm),...(job.verificationFallbackTopicId!==undefined?{topicId:job.verificationFallbackTopicId}:{})}:undefined;
   const communityReceipt=community&&plan.studioMarkup?.inline_keyboard.some(row=>row.some(b=>'url' in b))?{chatId:plan.chatId,epoch:community.epoch,expiresAt:community.expiresAt}:undefined;
   if(plan.editMessageId!==undefined&&(community||job.communityClose||(s.telegramReplyJobs??[]).some(old=>old.communityMessage?.chatId===plan.chatId&&old.communityMessage.messageId===plan.editMessageId)))job.communityEditTarget={chatId:plan.chatId,messageId:plan.editMessageId};
   // An attempted edit makes the old contents uncertain, even if its outcome
   // is unknown. Retire its receipt before the call; never replay an edit.
   if(plan.editMessageId!==undefined)for(const old of s.telegramReplyJobs??[])if(old.communityMessage?.chatId===plan.chatId&&old.communityMessage.messageId===plan.editMessageId)delete old.communityMessage;
   const at=this.clock();
   job.status='SENDING';job.attemptId=attemptId;job.startedAt=at;
   if(publicFallback)s.audit.push({updateKey:updateKey+':public-fallback-start',actorId:publicFallback.actorId,decision:'ALLOW',reason:'SUBSCRIPTION_PUBLIC_FALLBACK_STARTED:'+attemptId,policyVersion:this.policy.chatRevision(s,publicFallback.scope),at});
   // Remove the durable body *before* the external call. The immediate local
   // copy goes to the sender, but a crash leaves no replayable payload.
   delete job.plan;delete job.adminUIAccess;delete job.privateLibraryAccess;delete job.communityAccess;delete job.groupQuestionAccess;delete job.groupMenuAccess;delete job.privateGroupAccess;delete job.privateReplyKind;delete job.groupReplyKind;delete job.verificationEphemeral;delete job.verificationEphemeralTopicId;delete job.verificationFallback;delete job.verificationPublicFallback;delete job.verificationFallbackTopicId;job.redactedAt=at;
   delete job.communityClose;
   return {status:'SEND' as const,attemptId,plan,communityReceipt,ephemeral,fallback,publicFallback,startedAt:at};
  });
  if(claim.status!=='SEND')return {status:claim.status};
  let result:TelegramTemporaryPrivateResult|{status:'EPHEMERAL_ACKNOWLEDGED'|'EPHEMERAL_REJECTED'};
  try{
   if(claim.ephemeral){const access=claim.ephemeral,ephemeral=this.ephemeralSender!;
    const outcome=await ephemeral.send({chatId:access.scope,receiverId:access.actorId,text:claim.plan.text,...(access.topicId!==undefined?{topicId:access.topicId}:{}),...(claim.plan.studioMarkup?{keyboard:claim.plan.studioMarkup}:{})},async()=>{
     if(!this.membership||await this.membership(access.scope,access.actorId)!=='VERIFIED')return false;
     const state=await this.store.snapshot(),now=this.clock(),jobs=state.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];return jobs.length===1&&jobs[0]!.status==='SENDING'&&jobs[0]!.attemptId===claim.attemptId&&now>=claim.startedAt&&now<access.expiresAt&&this.policy.canUseChat(state,access.scope,'navigation')&&subscriptionVerificationEpoch(state,this.policy,access.actorId,access.scope,now)===access.epoch;
    });result=outcome.status==='ACKNOWLEDGED'?{status:'EPHEMERAL_ACKNOWLEDGED'}:outcome.status==='PROVIDER_REJECTED'?{status:'EPHEMERAL_REJECTED'}:{status:outcome.status};
   }else if(claim.publicFallback){const access=claim.publicFallback;
    const outcome=await this.publicFallback!.sender.send({chatId:access.scope,botUsername:this.publicFallback!.botUsername,...(access.topicId!==undefined?{topicId:access.topicId}:{})},async()=>{try{if(await this.safetyGate!()!==true||await this.membership!(access.scope,access.actorId)!=='VERIFIED'||await this.safetyGate!()!==true)return false;const state=await this.store.snapshot(),at=this.clock(),jobs=state.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[],audit=state.audit.filter(a=>a.updateKey===updateKey+':public-fallback-start');return jobs.length===1&&jobs[0]!.status==='SENDING'&&jobs[0]!.attemptId===claim.attemptId&&audit.length===1&&audit[0]!.actorId===access.actorId&&audit[0]!.reason==='SUBSCRIPTION_PUBLIC_FALLBACK_STARTED:'+claim.attemptId&&at>=claim.startedAt&&at<access.expiresAt&&this.policy.canUseChat(state,access.scope,'navigation')&&subscriptionVerificationEpoch(state,this.policy,access.actorId,access.scope,at)===access.epoch&&await this.safetyGate!()===true;}catch{return false;}});
    result=outcome.status==='CONFIRMED'?{status:'CONFIRMED',messageId:outcome.messageId}:outcome.status==='UNKNOWN_OUTCOME'?{status:'UNKNOWN_OUTCOME'}:{status:'FAILED_CONFIRMED'};
   }else if(claim.fallback){const access=claim.fallback;result=await this.sender.sendTemporaryPrivate!(claim.plan,async()=>{try{if(!this.safetyGate||await this.safetyGate()!==true||!this.membership||await this.membership(access.scope,access.actorId)!=='VERIFIED'||await this.safetyGate()!==true)return false;const state=await this.store.snapshot(),now=this.clock(),jobs=state.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];return jobs.length===1&&jobs[0]!.status==='SENDING'&&jobs[0]!.attemptId===claim.attemptId&&now>=claim.startedAt&&now<access.expiresAt&&this.policy.canUseChat(state,access.scope,'navigation')&&subscriptionVerificationEpoch(state,this.policy,access.actorId,access.scope,now)===access.epoch&&await this.safetyGate()===true;}catch{return false;}});
   }else result=await this.sender.send(claim.plan);
  }catch{result={status:'UNKNOWN_OUTCOME'};}
  const publicNotice=!!claim.publicFallback;
  if(result.status==='CONFIRMED'&&(!Number.isSafeInteger(result.messageId)||result.messageId<1))result={status:'UNKNOWN_OUTCOME'};
  let terminal:TelegramReplyJob['status']=result.status==='CONFIRMED'||result.status==='EPHEMERAL_ACKNOWLEDGED'?'SENT':result.status==='EPHEMERAL_REJECTED'||result.status==='PRIVATE_UNAVAILABLE'?'FAILED_CONFIRMED':result.status;
  const requeued=await this.store.transaction(s=>{
   const matches=s.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
   // The provider may have returned success, but a restore/other writer may
   // have inserted conflicting local evidence while the network was awaited.
   // Never certify SENT against an ambiguous durable identity.
   if(matches.length>1)throw Error('REPLY_DUPLICATE_UPDATE_KEY');
   const job=matches[0];
   if(!job||job.status!=='SENDING'||job.attemptId!==claim.attemptId)
    throw new Error('REPLY_ATTEMPT_FENCED');
   if(result.status==='EPHEMERAL_REJECTED'&&claim.ephemeral&&this.fallbackCleanupEnabled&&this.sender.sendTemporaryPrivate&&this.sender.deleteOwnPrivate&&this.safetyGate&&this.membership){
    const at=this.clock(),access=claim.ephemeral,rows=s.audit.filter(a=>a.updateKey===updateKey+':ephemeral-rejected');
    if(rows.length===0&&Number.isSafeInteger(at)&&at>=claim.startedAt&&at<access.expiresAt&&this.policy.canUseChat(s,access.scope,'navigation')&&subscriptionVerificationEpoch(s,this.policy,access.actorId,access.scope,at)===access.epoch){
     const ruleRevision=this.policy.chatRevision(s,access.scope),rows=claim.plan.studioMarkup?.inline_keyboard??[];
     job.status='QUEUED';job.plan={...claim.plan,studioMarkup:{inline_keyboard:[...rows,[{text:'✅ إعادة التحقق',callback_data:'sv:1:'+access.scope+':'+ruleRevision}]]}};job.privateReplyKind='VERIFICATION_SCOPED';job.privateGroupAccess={actorId:access.actorId,scope:access.scope,epoch:access.epoch,expiresAt:access.expiresAt};job.verificationFallback=true;if(access.topicId!==undefined)job.verificationFallbackTopicId=access.topicId;job.queuedAt=at;delete job.attemptId;delete job.startedAt;delete job.redactedAt;
     s.audit.push({updateKey:updateKey+':ephemeral-rejected',decision:'NOOP',reason:'SUBSCRIPTION_EPHEMERAL_REJECTED',policyVersion:ruleRevision,at});return true;
    }
   }
   if(result.status==='PRIVATE_UNAVAILABLE'&&claim.fallback&&this.publicFallback&&this.fallbackCleanupEnabled&&this.safetyGate&&this.membership){
    const at=this.clock(),access=claim.fallback,rows=s.audit.filter(a=>a.updateKey===updateKey+':private-rejected');
    if(rows.length===0&&Number.isSafeInteger(at)&&at>=claim.startedAt&&at<access.expiresAt&&this.policy.canUseChat(s,access.scope,'navigation')&&subscriptionVerificationEpoch(s,this.policy,access.actorId,access.scope,at)===access.epoch){
     job.status='QUEUED';job.plan=claim.plan;job.privateReplyKind='VERIFICATION_SCOPED';job.privateGroupAccess={actorId:access.actorId,scope:access.scope,epoch:access.epoch,expiresAt:access.expiresAt};job.verificationPublicFallback=true;if(access.topicId!==undefined)job.verificationFallbackTopicId=access.topicId;job.queuedAt=at;delete job.attemptId;delete job.startedAt;delete job.redactedAt;
     s.audit.push({updateKey:updateKey+':private-rejected',actorId:access.actorId,decision:'NOOP',reason:'SUBSCRIPTION_PRIVATE_REJECTED:'+publicFallbackProof(job.privateGroupAccess,access.topicId),policyVersion:this.policy.chatRevision(s,access.scope),at});return true;
    }
   }
   const cleanupAccess=claim.fallback??claim.publicFallback;
   if(result.status==='CONFIRMED'&&cleanupAccess&&s.audit.some(a=>a.updateKey===updateKey+':fallback-sent')){result={status:'UNKNOWN_OUTCOME'};terminal='UNKNOWN_OUTCOME';}
   job.status=terminal;
   if(terminal!=='UNKNOWN_OUTCOME')delete job.communityEditTarget;
   if(result.status==='CONFIRMED')job.messageId=result.messageId;
   if(result.status==='CONFIRMED'||result.status==='EPHEMERAL_ACKNOWLEDGED')try{recordSubscriptionDelivery(s,job,result.status==='CONFIRMED'?'MESSAGE':'EPHEMERAL',this.clock());}catch{/* Metrics must never change the delivery outcome. */}
   if(result.status==='CONFIRMED'&&cleanupAccess){const receipt:SubscriptionFallbackCleanup={chatId:publicNotice?cleanupAccess.scope:claim.plan.chatId,scope:cleanupAccess.scope,...(publicNotice?{memberId:cleanupAccess.actorId}:{}),messageId:result.messageId,sendAttemptId:claim.attemptId,createdAt:claim.startedAt,deleteAfter:claim.startedAt+60000,status:'WAITING'};job.verificationCleanup=receipt;s.audit.push({updateKey:updateKey+':fallback-sent',actorId:receipt.chatId,decision:'ALLOW',reason:'SUBSCRIPTION_FALLBACK_SENT:'+subscriptionFallbackReceiptDigest(receipt),policyVersion:0,at:claim.startedAt});}
   if(result.status==='CONFIRMED'&&claim.communityReceipt){
    for(const old of s.telegramReplyJobs??[])if(old.communityMessage?.chatId===claim.plan.chatId&&old.communityMessage.messageId===result.messageId)delete old.communityMessage;
    job.communityMessage={...claim.communityReceipt,messageId:result.messageId};
   }
   return false;
  });
  if(requeued)return this.dispatch(updateKey);
  return {status:result.status==='EPHEMERAL_ACKNOWLEDGED'?'CONFIRMED':result.status==='EPHEMERAL_REJECTED'||result.status==='PRIVATE_UNAVAILABLE'?'FAILED_CONFIRMED':result.status};
 }
}
