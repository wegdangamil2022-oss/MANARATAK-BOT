import {validAdminUIAccess,protectionUIEpoch,ADMIN_UI_TTL_MS} from './protection-ui-access.js';
import {randomUUID,createHash} from 'node:crypto';
import {BotStore,type TelegramReplyJob} from './store.js';
import {Policy} from './policy.js';
import type {TelegramReplyPlan} from './telegram-transport.js';
import {isValidTelegramReplyKeyboard} from './telegram-menu.js';
import {isValidTelegramInlineKeyboard} from './telegram-inline-owner.js';
import {validCommunityPhotoId,validCommunityLinkKeyboard} from './phase4-community-rich.js';
import {inCommunityQuietHours,validCommunityConfig} from './phase4-community-model.js';
import {lectureBlocksAutomation} from './phase4-lectures.js';
import {validStudioNativeKeyboard} from './telegram-studio-rich.js';
import {groupQuestionEpochDigest,groupMenuEpochDigest,privateGroupEpochDigest} from './telegram-group-access.js';
import {privateLibraryEpoch} from './private-library-access.js';
import {communityFolderEpoch} from './community-folder-access.js';
import {validCommunityMessageMetadata,matchesCommunityClose} from './community-message-receipt.js';
import {studioPreviewEpoch} from './studio-preview-access.js';
import {subscriptionRequirementMode,acceptsActiveSubscriptionEvidence} from './subscription-integrity.js';
import type {SubscriptionGate} from './subscription.js';
import type {MembershipPort} from './education-interactions.js';

export type TelegramSendResult={status:'CONFIRMED';messageId:number}|
 {status:'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'};
export interface TelegramReplySender {
 send(plan:TelegramReplyPlan):Promise<TelegramSendResult>;
}
const validChat=(chat:string)=>/^(?:[1-9]\d{0,15}|-[1-9]\d{0,15})$/.test(chat)&&
 Number.isSafeInteger(Number(chat));
const validPlan=(p:unknown):p is TelegramReplyPlan=>{
 if(!p||typeof p!=='object'||Array.isArray(p))return false;
 const v=p as Record<string,unknown>;
 return (Object.keys(v).length===(3+(v.replyMarkup===undefined?0:1)+(v.inlineMarkup===undefined?0:1)+(v.studioMarkup===undefined?0:1)+(v.editMessageId===undefined?0:1)+(v.messageThreadId===undefined?0:1)+(v.photoFileId===undefined?0:1)+(v.communityLinks===undefined?0:1)))&&
  Object.keys(v).every(k=>['chatId','parseMode','text','replyMarkup','inlineMarkup','studioMarkup','editMessageId','messageThreadId','photoFileId','communityLinks'].includes(k))&&
  (v.messageThreadId===undefined||typeof v.chatId==='string'&&v.chatId.startsWith('-')&&Number.isSafeInteger(v.messageThreadId)&&Number(v.messageThreadId)>0&&Number(v.messageThreadId)<=2147483647)&&
  [v.replyMarkup,v.inlineMarkup,v.studioMarkup,v.communityLinks].filter(x=>x!==undefined).length<=1&&
  (v.photoFileId===undefined||(typeof v.chatId==='string'&&v.chatId.startsWith('-')&&
    v.editMessageId===undefined&&validCommunityPhotoId(v.photoFileId)))&&
  (v.communityLinks===undefined||(typeof v.chatId==='string'&&v.chatId.startsWith('-')&&
    v.editMessageId===undefined&&validCommunityLinkKeyboard(v.communityLinks)))&&
  (v.replyMarkup===undefined||isValidTelegramReplyKeyboard(v.replyMarkup))&&
  (v.inlineMarkup===undefined||isValidTelegramInlineKeyboard(v.inlineMarkup))&&
  (v.studioMarkup===undefined||typeof v.chatId==='string'&&!v.chatId.startsWith('-')&&validStudioNativeKeyboard(v.studioMarkup))&&
  (v.editMessageId===undefined||(typeof v.editMessageId==='number'&&
    Number.isSafeInteger(v.editMessageId)&&v.editMessageId>0&&(v.inlineMarkup!==undefined||v.studioMarkup!==undefined)))&&
  v.parseMode==='HTML'&&typeof v.chatId==='string'&&
  validChat(v.chatId)&&typeof v.text==='string'&&v.text.length>0&&
  Buffer.byteLength(v.text,'utf8')<=(v.photoFileId===undefined?4096:1024)&& !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v.text);
};
/**
 * Real Telegram Bot API boundary, but construction alone performs no network
 * calls. Does not retry ambiguous requests, never returns provider descriptions
 * or the token; sends only validated HTML text or Telegram photo captions.
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
    (plan.photoFileId!==undefined?'/sendPhoto':plan.editMessageId===undefined?'/sendMessage':'/editMessageText'),{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:plan.chatId,
     ...(plan.photoFileId!==undefined?{photo:plan.photoFileId,caption:plan.text}:
      {text:plan.text,link_preview_options:{is_disabled:true}}),
     parse_mode:'HTML',
     ...(plan.editMessageId===undefined?{protect_content:true}:{message_id:plan.editMessageId}),
     ...(plan.editMessageId===undefined&&plan.messageThreadId!==undefined?{message_thread_id:plan.messageThreadId}:{}),
     ...(plan.communityLinks?{reply_markup:plan.communityLinks}:
        plan.studioMarkup?{reply_markup:plan.studioMarkup}:
        plan.inlineMarkup?{reply_markup:plan.inlineMarkup}:
        plan.replyMarkup?{reply_markup:plan.replyMarkup}:{})}),
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
export function validTelegramReplyJob(v:unknown):v is TelegramReplyJob{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const j=v as Record<string,unknown>;
 return typeof j.updateKey==='string'&&/^b3-webhook:[a-zA-Z0-9_-]{1,80}:\d+$/.test(j.updateKey)&&
  knownStatus(j.status)&&
  validCommunityMessageMetadata(v as TelegramReplyJob)&&
  (j.communityAutomation===undefined||(
   j.status==='QUEUED'&&j.groupReplyKind==='GENERAL'&&validGroupReplyAccess(j.groupMenuAccess)&&
   typeof j.communityAutomation==='object'&&j.communityAutomation!==null&&
   !Array.isArray(j.communityAutomation)&&
   Object.keys(j.communityAutomation as object).every(k=>
     ['kind','configVersion','ruleId'].includes(k))&&
   Object.keys(j.communityAutomation as object).length===
    ((j.communityAutomation as {ruleId?:unknown}).ruleId===undefined?2:3)&&
   ((j.communityAutomation as {ruleId?:unknown}).ruleId===undefined||
     ((j.communityAutomation as {kind?:unknown}).kind==='TEXT'&&
      typeof (j.communityAutomation as {ruleId?:unknown}).ruleId==='string'&&
      /^[a-f0-9]{12}$/u.test((j.communityAutomation as {ruleId:string}).ruleId)))&&
   ['JOIN','LEAVE','TEXT'].includes(String((j.communityAutomation as {kind?:unknown}).kind))&&
   Number.isSafeInteger((j.communityAutomation as {configVersion?:unknown}).configVersion)&&
   Number((j.communityAutomation as {configVersion?:unknown}).configVersion)>=1
  ))&&
  ((j.plan as TelegramReplyPlan|undefined)?.messageThreadId===undefined||j.groupReplyKind==='GENERAL'&&validGroupReplyAccess(j.groupMenuAccess))&&
  (j.status==='QUEUED'?validPlan(j.plan):(j.plan===undefined||validPlan(j.plan)))&&
  ((j.plan as TelegramReplyPlan|undefined)?.photoFileId===undefined&&
   (j.plan as TelegramReplyPlan|undefined)?.communityLinks===undefined||
   (j.status==='QUEUED'&&j.groupReplyKind==='GENERAL'&&
    validGroupReplyAccess(j.groupMenuAccess)))&&
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
    (j.privateReplyKind==='LOCAL'||j.privateReplyKind==='GROUP_SCOPED'||j.privateReplyKind==='ADMIN_SCOPED'||j.privateReplyKind==='LIBRARY_SCOPED'||j.privateReplyKind==='STUDIO_SCOPED'||j.privateReplyKind==='COMMUNITY_SCOPED')&&
    j.groupReplyKind===undefined&&j.groupQuestionAccess===undefined&&
    j.groupMenuAccess===undefined&&
    ((j.privateReplyKind==='LOCAL'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined)||
     ((j.privateReplyKind==='ADMIN_SCOPED'||j.privateReplyKind==='STUDIO_SCOPED')&&j.privateGroupAccess===undefined&&j.privateLibraryAccess===undefined&&validAdminUIAccess(j.adminUIAccess)&&j.plan.chatId===j.adminUIAccess.actorId)||
     (j.privateReplyKind==='LIBRARY_SCOPED'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&validAdminUIAccess(j.privateLibraryAccess)&&j.plan.chatId===j.privateLibraryAccess.actorId)||
     (j.privateReplyKind==='COMMUNITY_SCOPED'&&j.privateGroupAccess===undefined&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined&&validAdminUIAccess(j.communityAccess)&&j.plan.chatId===j.communityAccess.actorId)||
     (j.privateReplyKind==='GROUP_SCOPED'&&j.adminUIAccess===undefined&&j.privateLibraryAccess===undefined&&
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
  private readonly membership?:MembershipPort){}
 /** Membership evidence is checked before the irreversible SENDING claim.
  * A subsequent transactional policy/epoch fence prevents local state changes
  * during the external membership lookup from authorizing a stale send.
  */
 private async checkGroupEligibility(updateKey:string):Promise<
  {access:NonNullable<TelegramReplyJob['groupQuestionAccess']>;
   kind:'FAQ'|'MENU'|'PRIVATE_GROUP';allowed:boolean}|undefined>{
  const snap=await this.store.snapshot();
  const matches=snap.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
  // Never initiate remote membership reads from an ambiguous restored key.
  if(matches.length!==1)return undefined;
  const job=matches[0]!;
  if(job.status!=='QUEUED')return undefined;
  if(!validTelegramReplyJob(job))throw Error('INVALID_REPLY_JOB');
  const kind=job.groupQuestionAccess?'FAQ' as const:
   job.groupMenuAccess?'MENU' as const:job.privateGroupAccess?'PRIVATE_GROUP' as const:null;
  if(!kind)return undefined;
  const access=structuredClone((kind==='FAQ'?job.groupQuestionAccess:
   kind==='MENU'?job.groupMenuAccess:job.privateGroupAccess)!);
  const groupId=kind==='PRIVATE_GROUP'?
   (access as NonNullable<TelegramReplyJob['privateGroupAccess']>).scope:
   job.plan!.chatId,actor=access.actorId;
  let allowed=false;
  try{
   if(this.clock()<access.expiresAt&&
      (kind==='FAQ'?this.policy.mayAskGroup(snap,groupId,actor,true):
       this.policy.canUseChat(snap,groupId,'navigation'))&&
      (kind==='FAQ'?groupQuestionEpochDigest(snap,groupId):
       kind==='MENU'?groupMenuEpochDigest(snap,groupId,job.plan!.messageThreadId):
       privateGroupEpochDigest(snap,groupId))===access.epoch){
    if(kind==='PRIVATE_GROUP'){
     if(!this.membership||await this.membership(groupId,actor)!=='VERIFIED')
      return {access,kind,allowed:false};
    }
    const mode=subscriptionRequirementMode(snap,groupId);
    if(mode==='NONE'||mode==='PAUSED')allowed=true;
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
   const accessKind=faq?'FAQ':menu?'MENU':dm?'PRIVATE_GROUP':null;
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
   // Quiet hours are time-dependent. A reply queued just before the boundary
   // must not be sent when the provider gate opens during the quiet window.
   // Only Phase 4 replies carry this trusted server-generated marker; ordinary
   // navigation/FAQ replies are not affected by the community schedule.
   const automation=job.communityAutomation;
   let automationDenied=false;
   if(automation){
    // Recheck after queue delay at the durable SEND claim boundary.
    // Only voluntary group automation is suppressed; not protection.
    if(lectureBlocksAutomation(s,plan.chatId,now))automationDenied=true;
    const configs=s.phase4Community?.configs.filter(c=>c.chatId===plan.chatId)??[];
    const config=configs.length===1?configs[0]:undefined;
    if(!config||!validCommunityConfig(config)||
       config.version!==automation.configVersion||
       (automation.kind==='TEXT'&&!config.repliesEnabled)||
       (automation.kind==='JOIN'&&!config.welcome.enabled)||
       (automation.kind==='LEAVE'&&!config.farewell.enabled)){
     automationDenied=true;
    }else if(automation.kind==='TEXT'){
     try{
      if(config.quietHours&&inCommunityQuietHours(config.quietHours,now,
         config.utcOffsetMinutes,config.timeZone))automationDenied=true;
      // The exact reviewed rule is bound to this queued reply. Group policy
      // and FAQ/source epochs are separately fenced by the existing ledger.
      if(automation.ruleId){
       const matches=config.rules.filter(r=>r.id===automation.ruleId);
       if(matches.length!==1||!matches[0]!.enabled)automationDenied=true;
       else if(matches[0]!.activeHours&&inCommunityQuietHours(
        matches[0]!.activeHours,now,config.utcOffsetMinutes,config.timeZone))
        automationDenied=true;
      }
     }catch{automationDenied=true;}
    }
   }
   const forbidden=closeDenied||noGroupProof||noPrivateProvenance||adminDenied||libraryDenied||communityDenied||automationDenied||(!!access&&(
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
      privateGroupEpochDigest(s,accessScope))!==access.epoch));
   const groupUnavailable=plan.chatId.startsWith('-')&&
    !this.policy.canUseChat(s,plan.chatId,'navigation');
   if(forbidden||groupUnavailable){
    // A reason is only set if no provider call was made. Recheck failures
    // intentionally combine unknown membership, expiry and changed sources;
    // the owner report MUST NOT claim which external event occurred.
    job.accessDenialCode=noGroupProof||noPrivateProvenance?
     'LEGACY_UNVERIFIABLE':groupUnavailable?'GROUP_UNAVAILABLE':'ACCESS_RECHECK_FAILED';
    job.status='FAILED_CONFIRMED';delete job.communityClose;
    delete job.plan;delete job.adminUIAccess;delete job.privateLibraryAccess;delete job.communityAccess;delete job.groupQuestionAccess;delete job.groupMenuAccess;delete job.privateGroupAccess;delete job.privateReplyKind;delete job.groupReplyKind;delete job.communityAutomation;job.redactedAt=this.clock();
    return {status:'FAILED_CONFIRMED' as const};
   }
   const attemptId=randomUUID();
   const automationForCleanup=job.communityAutomation;
   const communityReceipt=community&&plan.studioMarkup?.inline_keyboard.some(row=>row.some(b=>'url' in b))?{chatId:plan.chatId,epoch:community.epoch,expiresAt:community.expiresAt}:undefined;
   if(plan.editMessageId!==undefined&&(community||job.communityClose||(s.telegramReplyJobs??[]).some(old=>old.communityMessage?.chatId===plan.chatId&&old.communityMessage.messageId===plan.editMessageId)))job.communityEditTarget={chatId:plan.chatId,messageId:plan.editMessageId};
   // An attempted edit makes the old contents uncertain, even if its outcome
   // is unknown. Retire its receipt before the call; never replay an edit.
   if(plan.editMessageId!==undefined)for(const old of s.telegramReplyJobs??[])if(old.communityMessage?.chatId===plan.chatId&&old.communityMessage.messageId===plan.editMessageId)delete old.communityMessage;
   const at=this.clock();
   job.status='SENDING';job.attemptId=attemptId;job.startedAt=at;
   // Remove the durable body *before* the external call. The immediate local
   // copy goes to the sender, but a crash leaves no replayable payload.
   delete job.plan;delete job.adminUIAccess;delete job.privateLibraryAccess;delete job.communityAccess;delete job.groupQuestionAccess;delete job.groupMenuAccess;delete job.privateGroupAccess;delete job.privateReplyKind;delete job.groupReplyKind;delete job.communityAutomation;job.redactedAt=at;
   delete job.communityClose;
   return {status:'SEND' as const,attemptId,plan,communityReceipt,automationForCleanup};
  });
  if(claim.status!=='SEND')return {status:claim.status};
  let result:TelegramSendResult;
  try{result=await this.sender.send(claim.plan);}catch{result={status:'UNKNOWN_OUTCOME'};}
  const terminal=result.status==='CONFIRMED'?'SENT':result.status;
  await this.store.transaction(s=>{
   const matches=s.telegramReplyJobs?.filter(j=>j.updateKey===updateKey)??[];
   // The provider may have returned success, but a restore/other writer may
   // have inserted conflicting local evidence while the network was awaited.
   // Never certify SENT against an ambiguous durable identity.
   if(matches.length>1)throw Error('REPLY_DUPLICATE_UPDATE_KEY');
   const job=matches[0];
   if(!job||job.status!=='SENDING'||job.attemptId!==claim.attemptId)
    throw new Error('REPLY_ATTEMPT_FENCED');
   job.status=terminal;
   if(terminal!=='UNKNOWN_OUTCOME')delete job.communityEditTarget;
   if(result.status==='CONFIRMED')job.messageId=result.messageId;
   // Only a provider-CONFIRMED, bot-authored Phase 4 message can be considered
   // for expiry. This is NOT scheduled from the inbound user's message ID or
   // an uncertain SEND response. A policy edit while Telegram was awaited
   // fences old deletion plans; there is no retry on UNKNOWN_OUTCOME.
   if(result.status==='CONFIRMED'&&claim.automationForCleanup&&
      Number.isSafeInteger(result.messageId)&&result.messageId>0&&
      result.messageId<=2147483647){
    const now=this.clock();
    const configs=s.phase4Community?.configs.filter(x=>x.chatId===claim.plan.chatId)??[];
    const config=configs.length===1?configs[0]:undefined;
    const chat=s.chats.filter(x=>x.id===claim.plan.chatId&&x.approved&&x.present);
    if(Number.isSafeInteger(now)&&now>=0&&now<=8_640_000_000_000_000-3600000&&
       config&&validCommunityConfig(config)&&
       config.version===claim.automationForCleanup.configVersion&&
       config.replyCleanup?.enabled===true&&chat.length===1&&
       this.policy.canUseChat(s,claim.plan.chatId,'navigation')){
     const key=createHash('sha256').update('P4:AUTOMATIC_REPLY:'+updateKey).digest('hex');
     const existing=s.phase4Community!.cleanupJobs??[];
     const kept=existing.filter(x=>x.status==='QUEUED'||x.status==='SENDING'||
      now-x.observedAt<7*86400000);
     if(kept.length<1000&&
        !kept.some(x=>x.key===key||
         x.chatId===claim.plan.chatId&&x.messageId===result.messageId)){
      kept.push({key,chatId:claim.plan.chatId,messageId:result.messageId,
       kind:'AUTOMATIC_REPLY',chatVersion:chat[0]!.version,policyVersion:config.version,
       observedAt:now,dueAt:now+config.replyCleanup.delayMs,status:'QUEUED'});
     }
     s.phase4Community!.cleanupJobs=kept;
    }
   }
   if(result.status==='CONFIRMED'&&claim.communityReceipt){
    for(const old of s.telegramReplyJobs??[])if(old.communityMessage?.chatId===claim.plan.chatId&&old.communityMessage.messageId===result.messageId)delete old.communityMessage;
    job.communityMessage={...claim.communityReceipt,messageId:result.messageId};
   }
  });
  return {status:result.status};
 }
}
