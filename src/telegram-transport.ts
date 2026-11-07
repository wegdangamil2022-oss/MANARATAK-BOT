import {protectionMediaFromMessage,type ProtectionMedia} from './telegram-protection-media.js';
import { timingSafeEqual,createHash } from 'node:crypto';
import {staleCommunityMessage,COMMUNITY_CLOSED_TEXT} from './community-message-receipt.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { BotStore, type AuditRecord, type BotState, type TelegramReplyJob } from './store.js';
import {groupQuestionSubscriptionEpoch,groupMenuEpochDigest,privateGroupEpochDigest} from './telegram-group-access.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import { EducationAdminFacade, type VerifiedAdminContext } from './education-admin.js';
import { ApprovedAnswerService, ResourceLinkService, type MembershipPort } from './education-interactions.js';
import type { ImportFormat } from './ingestion.js';
import type { SubscriptionGate } from './subscription.js';
import type {PlatformCatalogPreviewService} from './platform-catalog-preview.js';
import type {B6AnswerPreflight} from './b6-approved-answer-preflight.js';
import {subscriptionRequirementMode,subscriptionRuleWitness,acceptsActiveSubscriptionEvidence} from './subscription-integrity.js';
import type { TelegramReplyDispatcher } from './telegram-replies.js';
import {BoundedIngress,decodeStrictJsonBytes,type IngressOptions} from './http-ingress-guard.js';
import {menuLabels,mainMenuKeyboard,backMenuKeyboard,categoryButton,
 resourceButton,listingKeyboard,categoryButtonId,resourceButtonId,
 matchingCategories,menuPageButton,parseMenuPageCommand,type MenuPageCommand,
 catalogBackToCategories,catalogBackToCategory,parseCatalogBackToCategory,
 type TelegramReplyKeyboard} from './telegram-menu.js';
import {OwnerTelegramMenu,isOwnerMenuText} from './telegram-owner-menu.js';
import {ownerInlineHome,ownerInlineRender,ownerInlineLinkedReadOnly,ownerInlineReturnRoute,type TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {renderOwnerInlineImports} from './telegram-inline-imports.js';
import {renderOwnerUpload,claimOwnerUpload,cancelOwnerUpload} from './telegram-owner-upload.js';
import {renderSubscriptionConfig,cancelSubscriptionConfig} from './telegram-inline-subscription-config.js';
import {CommunityFolderUI,cancelCommunityFolder,publicFolderGroups,type FolderScreen} from './telegram-community-folders.js';
import {renderOwnerInlineFAQ} from './telegram-inline-faq.js';
import {renderOwnerInlineLibrary} from './telegram-inline-library.js';
import {renderOwnerInlineStudio,studioOwnerEntry,studioDraftScreen,studioCatalogueReturn} from './telegram-inline-studio.js';
import {ButtonStudioService} from './button-studio.js';
import {renderOwnerInlineCategories} from './telegram-inline-categories.js';
import {EducationCategoryEditor} from './education-category-editor.js';
import {renderPrivateSettings} from './telegram-inline-private-settings.js';
import {protectionUIEpoch,protectionUISourceEpoch,ADMIN_UI_TTL_MS} from './protection-ui-access.js';
import {privateLibraryEpoch} from './private-library-access.js';
import {studioPreviewEpoch,studioPreviewSourceEpoch} from './studio-preview-access.js';
import {cancelOwnerPreview,ownerPreviewCancelData} from './telegram-owner-preview-cancel.js';
import {OwnerDelegationEditor} from './telegram-inline-delegation-edit.js';
import {renderOwnerInlineGroups} from './telegram-inline-groups.js';
import {OwnerGroupSetup} from './telegram-inline-group-setup.js';
import {OwnerGroupPolicyTemplates} from './telegram-inline-group-templates.js';
import {OwnerGroupSettings} from './telegram-inline-group-settings.js';
import {OwnerGroupBulkRestrict} from './telegram-inline-group-bulk-restrict.js';
import {OwnerNetworkEditor} from './telegram-inline-networks.js';
import {Phase4WhisperService} from './phase4-whispers.js';
import {whisperOwnerScreen} from './phase4-whisper-owner.js';
import {parseWhisperMemberCommand,whisperMemberScreen} from './phase4-whisper-member.js';
import {Phase4DiscussionService} from './phase4-discussions.js';
import {parseDiscussionMemberCommand,discussionMemberScreen} from './phase4-discussion-member.js';
import {discussionOwnerScreen} from './phase4-discussion-owner.js';
import {Phase4PollService} from './phase4-polls.js';
import {parsePollMemberCommand,pollMemberScreen} from './phase4-poll-member.js';
import {pollOwnerScreen} from './phase4-poll-owner.js';
import {Phase4EventService} from './phase4-events.js';
import {eventOwnerScreen} from './phase4-event-owner.js';
import {parseEventMemberCommand,eventMemberScreen} from './phase4-event-member.js';
import {Phase4ExpertService} from './phase4-experts.js';
import {expertOwnerScreen} from './phase4-expert-owner.js';
import {parseExpertMemberCommand,expertMemberScreen} from './phase4-expert-member.js';
import {Phase4StudyPeersService} from './phase4-study-peers.js';
import {studyPeerOwnerScreen} from './phase4-study-peer-owner.js';
import {parseStudyPeerMemberCommand,studyPeerMemberScreen} from './phase4-study-peer-member.js';
import {Phase4BadgesService} from './phase4-badges.js';
import {badgeOwnerScreen} from './phase4-badge-owner.js';
import {parseBadgeMemberCommand,badgeMemberScreen} from './phase4-badge-member.js';
import {Phase4ReactionsService} from './phase4-reactions.js';
import {Phase4QuizService} from './phase4-quizzes.js';
import {Phase4GameCatalogService} from './phase4-game-catalog.js';
import {Phase4ContestService} from './phase4-contests.js';
import {contestOwnerScreen} from './phase4-contest-owner.js';
import {parseContestMemberCommand,contestMemberScreen} from './phase4-contest-member.js';
import {gameCatalogOwnerScreen} from './phase4-game-catalog-owner.js';
import {parseQuizMemberCommand,quizMemberScreen} from './phase4-quiz-member.js';
import {quizOwnerScreen} from './phase4-quiz-owner.js';
import {reactionOwnerScreen} from './phase4-reaction-owner.js';
import {parseReactionMemberCommand,reactionMemberScreen} from './phase4-reaction-member.js';
import {Phase4LectureService} from './phase4-lectures.js';
import {lectureOwnerScreen} from './phase4-lecture-owner.js';
import {Phase4EngagementReportsService} from './phase4-engagement-reports.js';
import {engagementOwnerScreen} from './phase4-engagement-owner.js';
import {phase4SettingsOwnerScreen} from './phase4-settings-owner.js';
import {Phase4GuidanceService,parseGuidanceMemberCommand,parseGuidanceMemberCallback} from './phase4-guidance.js';
import {phase4GuidanceOwnerScreen} from './phase4-guidance-owner.js';
import {OwnerInlineGroupControls} from './telegram-inline-group-controls.js';
import {renderOwnerInlineDelegations,delegationOwnerEntry} from './telegram-inline-delegations.js';
import {renderStaffInline} from './telegram-inline-staff.js';
import {ModerationUnknownOwnerReview} from './moderation-unknown-review.js';
import {ModerationPendingOwnerView} from './moderation-pending-owner-view.js';
import {GroupProtectionPolicyService} from './group-protection-policy.js';
import {TelegramProtectionEditor} from './telegram-protection-editor.js';
import {renderOwnerPurgeQueue} from './telegram-inline-purge.js';
import {renderOwnerModerationRateStatus} from './telegram-inline-moderation-rate-status.js';
import {renderOwnerModerationEmergencyStatus} from './telegram-inline-moderation-emergency.js';
import {renderStudentInline,studentSectionInlineData} from './telegram-inline-student.js';
import {groupLibraryInline} from './telegram-group-library-inline.js';
import {readPublicNavigation,publicNavigationMarkup} from './telegram-public-navigation.js';
import {parseSearchQuery,parseSearchPageCommand,searchPageButton,
 searchResourceButton,parseSearchResourceSelection,searchResultsBreadcrumb,
 parseSearchResultsBreadcrumb} from './telegram-search.js';
import {parsePrivateFAQQuery,privateFAQBrowseLabel,parsePrivateFAQPage,
 privateFAQPageLabel,parsePrivateFAQSelection,privateFAQButton,
 privateFAQBrowseReturnLabel,parsePrivateFAQBrowseReturn,
 isPrivateFAQBrowseText} from './telegram-private-faq.js';
import {privateFAQSearchLabel,parsePrivateFAQSearchQuery,parsePrivateFAQSearchPage,
 privateFAQSearchPageLabel,isPrivateFAQSearchText,
 privateFAQSearchSelectionLabel,parsePrivateFAQSearchSelection,
 privateFAQSearchReturnLabel,parsePrivateFAQSearchReturn} from './telegram-private-faq-search.js';
import {escapeTelegramListPreview} from './telegram-preview.js';
import {parseB6ExplicitMention} from './b6-telegram-mention.js';
import type {ModerationService} from './moderation.js';
import {Phase4CommunityService} from './phase4-community.js';
import {phase4CommunityScreen,parsePhase4CommunityCommand} from './phase4-community-ui.js';
import {Phase4CleanupOperations} from './phase4-cleanup-ops.js';
import {phase4ServiceOpsScreen} from './phase4-service-ops-ui.js';
import type {CommunityInput,CommunityJoinKind,CommunityLeaveKind,CommunityLanguage} from './phase4-community-model.js';
import {validCommunityPhotoId} from './phase4-community-rich.js';
import type {ModerationPurgeService} from './moderation-purge.js';
import {isReplyDeleteCommand,previewReplyDelete,handleReplyDeleteCallback} from './telegram-reply-delete.js';
import {parseReplyModerationCommand,executeReplyModerationCommand} from './telegram-moderation-commands.js';
import {parseB6OwnerReplyTarget} from './b6-telegram-owner-reply.js';

/** Inbound-only boundary. Live downloads use the fixed-host, bounded, safety-gated adapter. */
export interface TelegramDocumentPort {
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
}
const MAX_DOCUMENT_BYTES = 256 * 1024;
const documentFormats: Readonly<Record<string, ImportFormat>> = {
  csv: 'csv', json: 'json', md: 'md', txt: 'txt'
};
const acceptedMimes: Readonly<Record<ImportFormat, ReadonlySet<string>>> = {
  csv: new Set(['text/csv','text/plain','application/octet-stream','application/vnd.ms-excel']),
  json: new Set(['application/json','text/plain','application/octet-stream']),
  md: new Set(['text/markdown','text/plain','application/octet-stream']),
  txt: new Set(['text/plain','application/octet-stream'])
};
interface IncomingDocument {
  fileId: string; filename: string; size: number; format: ImportFormat; caption: string;
}
/** Offline B3 application adapter: creates plans, NEVER sends a message or connects to Telegram. */
export interface TelegramReplyPlan { chatId: string; parseMode: 'HTML'; text: string;
 replyMarkup?:TelegramReplyKeyboard; inlineMarkup?:TelegramInlineKeyboard; studioMarkup?:import('./telegram-studio-rich.js').StudioNativeKeyboard;
 /** Community-only photo: trusted Telegram file_id, never a URL. */
 photoFileId?:string;
 /** Community-only external HTTPS links; NEVER a callback or owner action. */
 communityLinks?:import('./phase4-community-rich.js').CommunityLinkKeyboard;
 editMessageId?:number;messageThreadId?:number; }
export interface TelegramResult { status: 'APPLIED' | 'DUPLICATE' | 'DENIED' | 'IGNORED' | 'UNKNOWN'; reason: string; plan?: TelegramReplyPlan; deliveryKey?: string; callbackQueryId?:string; }
type ProcessedReply={status:TelegramResult['status'];reason:string;plan?:TelegramReplyPlan;
 groupQuestionAccess?:TelegramReplyJob['groupQuestionAccess'];
 groupMenuAccess?:TelegramReplyJob['groupMenuAccess'];
 communityAutomation?:TelegramReplyJob['communityAutomation'];
 privateGroupAccess?:TelegramReplyJob['privateGroupAccess'];
 adminUIAccess?:TelegramReplyJob['adminUIAccess'];
 privateLibraryAccess?:TelegramReplyJob['privateLibraryAccess'];communityAccess?:TelegramReplyJob['communityAccess'];communityClose?:TelegramReplyJob['communityClose']};
export interface TelegramApplicationOptions {
  store: BotStore; policy: Policy; education: EducationService; admin: EducationAdminFacade;
  faq: ApprovedAnswerService; links: ResourceLinkService; membership: MembershipPort;
  botId: string; botUsername: string; subscription?: SubscriptionGate; clock?: () => number; documentDownload?: TelegramDocumentPort;
  /** Optional B5 read-only owner preview; absent in usual offline deployment. */
  platformCatalog?:PlatformCatalogPreviewService;
  /** B6 offline approved-knowledge-only planner; no AI configured by default. */
  answerPreflight?:B6AnswerPreflight;
  /** Optional trusted operator STOP/RUN file for owner-private emergency view. */
  moderationSafetyFile?:string;
  /** Inline is enabled by the live server; legacy remains the default for existing integrations. */
  ownerMenuMode?:'inline'|'legacy';
  /** Existing student catalogue buttons open filtered inline menus in the live runtime. */
  studentMenuMode?:'inline'|'legacy';
  /** Explicitly injected moderation adapter; absent means commands cannot execute. */
  moderation?:ModerationService;
  /** Explicit reviewed-deletion service; no automatic metadata collection. */
  purge?:ModerationPurgeService;
  /** Opt-in phase 4 templates/replies. All policies are disabled until owner approval. */
  community?:Phase4CommunityService;
}

type Event = {updateId: number; actorId: string; chatId: string; kind: 'private' | 'group'; text: string; communityKind?:'JOIN'|'LEAVE'; communityJoinKind?:CommunityJoinKind; communityLeaveKind?:CommunityLeaveKind; communityMemberLanguage?:CommunityLanguage; communityChange?:'TITLE_CHANGED'|'PHOTO_CHANGED'|'PHOTO_REMOVED'; serviceSentAtMs?:number; communityMemberId?:string; memberName?:string; groupName?:string; topicId?:number; entities?:unknown; messageId?:number; replyTo?:unknown; document?: IncomingDocument; protectionMedia?:ProtectionMedia; edited?:true; forwarded?:true; callbackData?:string; callbackQueryId?:string; callbackMessageId?:number};
const isObject=(x:unknown):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
const positiveId=(x:unknown): x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const chatId=(x:unknown): x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x!==0;
/** A joiner's language hint is optional, sanitized and never persisted. */
const telegramCommunityLanguage=(value:unknown):CommunityLanguage|undefined=>{
 if(typeof value!=='string'||!/^(?:ar|en)(?:-[A-Za-z0-9]{2,8}){0,3}$/iu.test(value))
  return undefined;
 return value.slice(0,2).toLowerCase() as CommunityLanguage;
};
export function escapeTelegramHtml(text:string):string {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function eventFrom(value:unknown):{event?:Event;reason:string} {
  if(!isObject(value)||!Number.isSafeInteger(value.update_id)||typeof value.update_id!=='number'||value.update_id<0)return {reason:'INVALID_UPDATE_ID'};
  // Reject ambiguous Telegram envelopes before callback/edited-message dispatch.
  if(value.chat_member!==undefined&&(value.message!==undefined||value.callback_query!==undefined||
     value.edited_message!==undefined||value.my_chat_member!==undefined))
   return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
  if(value.edited_message!==undefined){
   const edited=value.edited_message;
   if(value.message!==undefined||value.callback_query!==undefined||!isObject(edited)||!isObject(edited.chat)||
    typeof edited.chat.type!=='string'||!['group','supergroup'].includes(edited.chat.type)||!positiveId(edited.message_id)||
    typeof edited.edit_date!=='number'||!Number.isSafeInteger(edited.edit_date)||edited.edit_date<=0)return {reason:'INVALID_GROUP_EDIT'};
   const parsed=eventFrom({update_id:value.update_id,message:edited});
   return parsed.event?{event:{...parsed.event,edited:true},reason:'VALID'}:parsed;
  }
  // Only a callback from an actual bot-sent message may navigate this
  // read-only owner UI. A Telegram callback ID is ephemeral, not a grant.
  if(value.callback_query!==undefined){
   const cb=value.callback_query;
   if(!isObject(cb)||!isObject(cb.from)||!positiveId(cb.from.id)||
    cb.from.is_bot!==false||!isObject(cb.message)||!isObject(cb.message.chat)||
    !isObject(cb.message.from)||cb.message.from.is_bot!==true||
    !chatId(cb.message.chat.id)||!positiveId(cb.message.message_id)||
    typeof cb.id!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/u.test(cb.id))||
    typeof cb.data!=='string'||Buffer.byteLength(cb.data,'utf8')>64||
    cb.data.length===0||/[\u0000-\u001f\u007f]/u.test(cb.data))
    return {reason:'INVALID_CALLBACK'};
   const kind=cb.message.chat.type==='private'?'private':
    cb.message.chat.type==='group'||cb.message.chat.type==='supergroup'?'group':null;
   if(!kind||(kind==='private'&&cb.message.chat.id!==cb.from.id)||
    (kind==='group'&&cb.message.chat.id>=0))
    return {reason:'INVALID_CALLBACK_CHAT'};
   if(cb.message.message_thread_id!==undefined&&!positiveId(cb.message.message_thread_id))return {reason:'INVALID_CALLBACK_TOPIC'};
   return {event:{updateId:value.update_id as number,actorId:String(cb.from.id),
    chatId:String(cb.message.chat.id),kind,text:'',
    callbackData:cb.data,callbackQueryId:cb.id,callbackMessageId:cb.message.message_id,...(cb.message.message_thread_id!==undefined?{topicId:cb.message.message_thread_id as number}:{})},reason:'VALID'};
  }
  // Telegram ChatMemberUpdated is NOT a join request: only a transition from
  // absent to present constitutes a confirmed join. A bot must explicitly
  // subscribe to chat_member updates and be a chat administrator to receive it.
  if(value.chat_member!==undefined){
   if(value.message!==undefined||value.callback_query!==undefined||
     value.edited_message!==undefined||value.my_chat_member!==undefined)
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   const cm=value.chat_member;
   if(!isObject(cm)||!isObject(cm.chat)||!chatId(cm.chat.id)||cm.chat.id>=0||
     !['group','supergroup'].includes(String(cm.chat.type))||
     !isObject(cm.from)||!positiveId(cm.from.id)||cm.from.is_bot!==false||
     !positiveId(cm.date)||cm.date>8_640_000_000_000||
     !isObject(cm.old_chat_member)||!isObject(cm.new_chat_member))
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   // Classify only Telegram-provided ChatMemberUpdated invite metadata.
   // Neither a student message nor a forwarded link can claim this source.
   // The invite URL/token is deliberately not copied into the event or storage.
   if(cm.invite_link!==undefined&&
      (!isObject(cm.invite_link)||typeof cm.invite_link.invite_link!=='string'||
       cm.invite_link.invite_link.length>512||
       !/^https:\/\/t\.me\/[^\s]+$/u.test(cm.invite_link.invite_link)))
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   if(cm.via_chat_folder_invite_link!==undefined&&
      typeof cm.via_chat_folder_invite_link!=='boolean')
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   if(cm.via_join_request!==undefined&&typeof cm.via_join_request!=='boolean')
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   const before=cm.old_chat_member,after=cm.new_chat_member;
   if(!isObject(before.user)||!isObject(after.user)||!positiveId(before.user.id)||
      before.user.id!==after.user.id||before.user.is_bot!==false||after.user.is_bot!==false)
    return {reason:'INVALID_CHAT_MEMBER_UPDATE'};
   const oldAbsent=before.status==='left'||before.status==='kicked'||
      before.status==='restricted'&&before.is_member===false;
   const newPresent=after.status==='member'||after.status==='administrator'||
      after.status==='creator'||after.status==='restricted'&&after.is_member===true;
   const oldPresent=before.status==='member'||before.status==='administrator'||
      before.status==='creator'||before.status==='restricted'&&before.is_member===true;
   const newAbsent=after.status==='left'||after.status==='kicked'||
      after.status==='restricted'&&after.is_member===false;
   const joining=oldAbsent&&newPresent,leaving=oldPresent&&newAbsent;
   if(!joining&&!leaving)return {reason:'UNSUPPORTED_EVENT'};
   const user=after.user;
   const memberLanguage=joining?telegramCommunityLanguage(user.language_code):undefined;
   const memberName=typeof user.first_name==='string'&&user.first_name.trim()?
      user.first_name.trim().slice(0,75):'عضو';
   return {reason:'VALID',event:{updateId:value.update_id as number,actorId:String(cm.from.id),
     chatId:String(cm.chat.id),kind:'group',text:'',communityKind:joining?'JOIN':'LEAVE',
     ...(joining?{communityJoinKind:cm.invite_link!==undefined||
       cm.via_chat_folder_invite_link===true?'INVITE' as const:
       cm.from.id===user.id?'SELF' as const:'ADDED' as const}:
      {communityLeaveKind:after.status==='kicked'||cm.from.id!==user.id?'REMOVED' as const:'SELF' as const}),
     communityMemberId:String(user.id),memberName,
     ...(memberLanguage?{communityMemberLanguage:memberLanguage}:{}),
     groupName:typeof cm.chat.title==='string'?cm.chat.title:'المجموعة',
     serviceSentAtMs:(cm.date as number)*1000}};
  }
  if(!isObject(value.message))return {reason:'UNSUPPORTED_EVENT'};
  const msg=value.message;
  if(!isObject(msg.chat)||!isObject(msg.from)||!positiveId(msg.from.id)||msg.from.is_bot!==false||!chatId(msg.chat.id))return {reason:'INVALID_ACTOR_OR_CHAT'};
  if(msg.sender_chat!==undefined||msg.via_bot!==undefined||msg.is_automatic_forward===true)return {reason:'UNTRUSTED_FORWARD'};
  const forwarded=msg.forward_origin!==undefined||msg.forward_date!==undefined;
  if(forwarded){
   if(msg.chat.type!=='group'&&msg.chat.type!=='supergroup')return {reason:'UNTRUSTED_FORWARD'};
   if(msg.forward_origin!==undefined&&(!isObject(msg.forward_origin)||typeof msg.forward_origin.type!=='string'||
    !['user','hidden_user','chat','channel'].includes(msg.forward_origin.type)||!positiveId(msg.forward_origin.date)))return {reason:'UNTRUSTED_FORWARD'};
   if(msg.forward_date!==undefined&&(!positiveId(msg.forward_date)||isObject(msg.forward_origin)&&msg.forward_origin.date!==msg.forward_date))return {reason:'UNTRUSTED_FORWARD'};
  }

  const kind=msg.chat.type==='private'?'private':msg.chat.type==='group'||msg.chat.type==='supergroup'?'group':null;
  if(!kind || (kind==='private'&&(msg.chat.id!==msg.from.id))||(kind==='group'&&msg.chat.id>=0))return {reason:'INVALID_CHAT_CONTEXT'};
  if(msg.message_thread_id!==undefined&&!positiveId(msg.message_thread_id))return {reason:'INVALID_MESSAGE_TOPIC'};
  if(kind==='group'&&(msg.new_chat_title!==undefined||msg.new_chat_photo!==undefined||
    msg.delete_chat_photo!==undefined)){
   const title=msg.new_chat_title,photo=msg.new_chat_photo,removed=msg.delete_chat_photo;
   const count=Number(title!==undefined)+Number(photo!==undefined)+Number(removed!==undefined);
   const validPhoto=Array.isArray(photo)&&photo.length>=1&&photo.length<=8&&
      photo.every(p=>isObject(p)&&typeof p.file_id==='string'&&
       /^[A-Za-z0-9_-]{8,512}$/u.test(p.file_id)&&
       typeof p.file_unique_id==='string'&&/^[A-Za-z0-9_-]{4,512}$/u.test(p.file_unique_id)&&
       Number.isSafeInteger(p.width)&&Number.isSafeInteger(p.height)&&
       (p.width as number)>0&&(p.height as number)>0);
   if(count!==1||!positiveId(msg.message_id)||msg.text!==undefined||msg.document!==undefined||
      (title!==undefined&&(typeof title!=='string'||title.trim().length===0||
       title.length>128||/[\u0000-\u001f\u007f]/u.test(title)))||
      (photo!==undefined&&!validPhoto)||
      (removed!==undefined&&removed!==true)||
      msg.date!==undefined&&(!positiveId(msg.date)||msg.date>8_640_000_000_000))
    return {reason:'INVALID_SERVICE_EVENT'};
   const change=title!==undefined?'TITLE_CHANGED' as const:
       photo!==undefined?'PHOTO_CHANGED' as const:'PHOTO_REMOVED' as const;
   return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),
    chatId:String(msg.chat.id),kind,text:'',communityChange:change,
    messageId:msg.message_id as number,
    ...(msg.date!==undefined?{serviceSentAtMs:(msg.date as number)*1000}:{})},reason:'VALID'};
  }
  if(kind==='group'&&(msg.new_chat_members!==undefined||msg.left_chat_member!==undefined)){
   if(msg.new_chat_members!==undefined&&msg.left_chat_member!==undefined)return {reason:'INVALID_SERVICE_EVENT'};
   if(!positiveId(msg.message_id)||msg.text!==undefined||msg.document!==undefined||
      msg.date!==undefined&&!positiveId(msg.date))return {reason:'INVALID_SERVICE_EVENT'};
   const members=msg.new_chat_members;
   if(members!==undefined&&(!Array.isArray(members)||members.length<1||members.length>20||
     members.some(m=>!isObject(m)||!positiveId(m.id)||typeof m.is_bot!=='boolean')))
    return {reason:'INVALID_SERVICE_EVENT'};
   if(msg.left_chat_member!==undefined&&
     (!isObject(msg.left_chat_member)||!positiveId(msg.left_chat_member.id)||
      typeof msg.left_chat_member.is_bot!=='boolean'))return {reason:'INVALID_SERVICE_EVENT'};
   const left=msg.left_chat_member;
   const human:Record<string,unknown>[]=members!==undefined?
    (members as Record<string,unknown>[]).filter(m=>m.is_bot===false):
    left!==undefined&&isObject(left)&&left.is_bot===false?[left]:[];
   if(human.length===0)return {reason:'UNSUPPORTED_EVENT'};
   const first=human[0]!;
   const name=(m:Record<string,unknown>)=>typeof m.first_name==='string'&&m.first_name.trim()?
     m.first_name.trim().slice(0,75):'عضو';
   const memberName=human.length===1?name(first):human.slice(0,3).map(name).join('، ')+
      (human.length>3?' وآخرين':'');
   // Only Telegram's service fields establish the join category.
   const communityJoinKind:CommunityJoinKind|undefined=members===undefined?undefined:
      human.length>1?'BATCH':msg.from.id===first.id?'SELF':'ADDED';
   const communityLeaveKind:CommunityLeaveKind|undefined=left===undefined?undefined:
      msg.from.id===first.id?'SELF':'REMOVED';
   // A batch may contain many languages: do not guess from the first member.
   const memberLanguage=members!==undefined&&human.length===1?
      telegramCommunityLanguage(first.language_code):undefined;
   return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),
     chatId:String(msg.chat.id),kind,text:'',communityKind:members!==undefined?'JOIN':'LEAVE',
     communityMemberId:String(first.id),memberName,
     ...(communityJoinKind?{communityJoinKind}:{}),
     ...(memberLanguage?{communityMemberLanguage:memberLanguage}:{}),
     ...(communityLeaveKind?{communityLeaveKind}:{}),messageId:msg.message_id as number,
     ...(msg.date!==undefined?{serviceSentAtMs:(msg.date as number)*1000}:{}),
     groupName:typeof msg.chat.title==='string'?msg.chat.title:'المجموعة',
     ...(msg.message_thread_id!==undefined?{topicId:msg.message_thread_id as number}:{})},reason:'VALID'};
  }
  if(kind==='private'&&msg.photo!==undefined){
   // An owner can attach an actual photo to a private command caption.
   // Telegram has already authenticated the inbound update, but owner
   // authorization and group approval are rechecked by the community editor.
   if(msg.text!==undefined||msg.document!==undefined||
     typeof msg.caption!=='string'||!/^\/(?:welcomephoto|farewellphoto) -[1-9]\d{0,15}$|^\/replyphoto -[1-9]\d{0,15} [a-f0-9]{12}$/u.test(msg.caption)||
     !Array.isArray(msg.photo)||msg.photo.length<1||msg.photo.length>10||
     msg.photo.some(p=>!isObject(p)||!validCommunityPhotoId(p.file_id)||
       typeof p.file_unique_id!=='string'||!/^[A-Za-z0-9_-]{8,512}$/u.test(p.file_unique_id)||
       typeof p.width!=='number'||!Number.isSafeInteger(p.width)||p.width<1||p.width>20000||
       typeof p.height!=='number'||!Number.isSafeInteger(p.height)||p.height<1||p.height>20000||
       (p.file_size!==undefined&&(typeof p.file_size!=='number'||!Number.isSafeInteger(p.file_size)||
         p.file_size<1||p.file_size>10_000_000))))
     return {reason:'INVALID_OWNER_PHOTO'};
   const photos=msg.photo as Record<string,unknown>[];
   // Telegram sends increasing sizes, but select on actual bounded area so
   // malformed order cannot replace a higher-resolution file without review.
   const largest=photos.reduce((best,item)=>
    (item.width as number)*(item.height as number)>
     (best.width as number)*(best.height as number)?item:best);
   return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),
     chatId:String(msg.chat.id),kind,text:msg.caption+' '+largest.file_id},reason:'VALID'};
  }
  if(kind==='group'){
   const decoded=protectionMediaFromMessage(msg);
   if(decoded.status==='INVALID')return {reason:'INVALID_GROUP_MEDIA'};
   if(decoded.status==='MEDIA')return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:'',protectionMedia:decoded.media,...(forwarded?{forwarded:true as const}:{})},reason:'VALID'};
  }
  if(msg.document!==undefined){
    // Telegram must not attach both an ordinary text command and a document.
    if (!isObject(msg.document) || msg.text!==undefined) return {reason:'INVALID_DOCUMENT'};
    const d=msg.document;
    if(typeof d.file_id!=='string'||!/^[A-Za-z0-9_-]{8,512}$/.test(d.file_id)
      ||typeof d.file_name!=='string'||d.file_name.length>120
      ||/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(d.file_name)
      ||!Number.isSafeInteger(d.file_size)||typeof d.file_size!=='number'||d.file_size<1||d.file_size>MAX_DOCUMENT_BYTES)
      return {reason:'INVALID_DOCUMENT'};
    const extension=d.file_name.split('.').at(-1)?.toLowerCase()??'';
    const format=documentFormats[extension];
    if(!format || typeof d.mime_type!=='undefined' && (typeof d.mime_type!=='string'||!acceptedMimes[format].has(d.mime_type.toLowerCase())))
      return {reason:'INVALID_DOCUMENT'};
    if(msg.caption!==undefined&&(typeof msg.caption!=='string'||msg.caption.length>100))return {reason:'INVALID_DOCUMENT_CAPTION'};
    const document:IncomingDocument={fileId:d.file_id,filename:d.file_name,size:d.file_size,format,caption:typeof msg.caption==='string'?msg.caption:''};
    return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:'',document,...(msg.message_thread_id!==undefined?{topicId:msg.message_thread_id as number}:{})},reason:'VALID'};
  }
  if(typeof msg.text!=='string'||msg.text.length<1||msg.text.length>4096)return {reason:'UNSUPPORTED_MESSAGE'};
  if(/\u0000/u.test(msg.text))return {reason:'INVALID_TEXT'};
  return {event:{updateId:value.update_id as number,actorId:String(msg.from.id),chatId:String(msg.chat.id),kind,text:msg.text,...(forwarded?{forwarded:true as const}:{}),
   ...(msg.entities!==undefined?{entities:msg.entities}:{}),...(msg.message_thread_id!==undefined?{topicId:msg.message_thread_id as number}:{}),
   ...(msg.message_id!==undefined?{messageId:msg.message_id as number}:{}),
   ...(msg.reply_to_message!==undefined?{replyTo:msg.reply_to_message}:{}),
   ...(kind==='group'?{memberName:typeof msg.from.first_name==='string'?msg.from.first_name:'عضو',groupName:typeof msg.chat.title==='string'?msg.chat.title:'المجموعة'}:
       {memberName:typeof msg.from.first_name==='string'?msg.from.first_name.slice(0,75):'عضو'})},reason:'VALID'};
}

/** Immutable local authorization witness for a B6 group question. Membership
 * checks may finish before a slow approved-FAQ lookup. Compare the exact
 * group + subscription + required-channel state again after that lookup,
 * including when the first state had no required-channel rule.
 */
const isScope=(scope:string):boolean=>scope==='private'||/^-[1-9]\d{0,18}$/.test(scope);
const isId=(value:string):boolean=>/^[a-zA-Z0-9_-]{1,64}$/.test(value);
const asNumber=(value:string):number|null=>/^\d{1,8}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const publicMenuText=(text:string):boolean=>Object.values(menuLabels).some(label=>label===text&&label!==menuLabels.owner)||text===catalogBackToCategories||text===privateFAQBrowseLabel||text===privateFAQSearchLabel||Boolean(
 categoryButtonId(text)||resourceButtonId(text)||parseMenuPageCommand(text)||parseCatalogBackToCategory(text)||parseSearchPageCommand(text)||parseSearchResourceSelection(text)||parseSearchResultsBreadcrumb(text)||
 parsePrivateFAQPage(text)||parsePrivateFAQSelection(text)||parsePrivateFAQBrowseReturn(text)!==null||parsePrivateFAQSearchPage(text)||parsePrivateFAQSearchSelection(text)||parsePrivateFAQSearchReturn(text));
function safeError(err:unknown):string {
  const message=err instanceof Error?err.message:'';
  const known=new Set(['UPLOAD_DENIED','PUBLISH_DENIED','INVALID_UPLOAD_ORIGIN','INVALID_FAQ','INVALID_FORMAT','INVALID_FILENAME','DOCUMENT_TOO_LARGE','NOT_APPROVED','CANDIDATE_NOT_FOUND','IMPORT_NOT_FOUND','CATEGORY_SCOPE_MISMATCH','NEEDS_REVIEW','DUPLICATE_CANDIDATE','RESOURCE_ARCHIVED','CATEGORY_DISABLED_OR_MISSING']);
  return known.has(message)?message:'OPERATION_UNAVAILABLE';
}

export class TelegramUpdateApplication {
  private readonly clock:()=>number;
  constructor(private readonly opts:TelegramApplicationOptions){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(opts.botId)||!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(opts.botUsername))throw Error('INVALID_BOT_CONFIG');
    this.clock=opts.clock??Date.now;
  }
  /** End-of-planning fence, after the FAQ await but before creating a reply.
   * A changed local policy epoch invalidates prior Telegram membership proof.
   * When channels are required, fresh membership evidence must be obtained.
   * This is not an outbound-dispatch-time or remote-API transaction.
   */
  private async finalGroupAnswerGate(groupId:string,actorId:string,
   initialEpoch:string|undefined):Promise<string|null>{
   if(initialEpoch===undefined)return 'SUBSCRIPTION_UNAVAILABLE';
   let before:BotState;
   try{before=await this.opts.store.snapshot();}catch{return 'SUBSCRIPTION_UNAVAILABLE';}
   if(!this.opts.policy.canUseChat(before,groupId,'navigation')||
     groupQuestionSubscriptionEpoch(before,groupId)!==initialEpoch)
    return 'SUBSCRIPTION_UNAVAILABLE';
   const mode=subscriptionRequirementMode(before,groupId);
   if(mode==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
   if(mode==='ACTIVE'){
    if(!this.opts.subscription)return 'SUBSCRIPTION_UNAVAILABLE';
    let status:Awaited<ReturnType<SubscriptionGate['verify']>>['status'];
    try{status=(await this.opts.subscription.verify(groupId,actorId)).status;}
    catch{return 'SUBSCRIPTION_UNAVAILABLE';}
    if(!acceptsActiveSubscriptionEvidence(status,this.opts.policy.isOwner(actorId)))
     return status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE';
   }
   let latest:BotState;
   try{latest=await this.opts.store.snapshot();}catch{return 'SUBSCRIPTION_UNAVAILABLE';}
   if(!this.opts.policy.canUseChat(latest,groupId,'navigation')||
     groupQuestionSubscriptionEpoch(latest,groupId)!==initialEpoch)
    return 'SUBSCRIPTION_UNAVAILABLE';
   return null;
  }
  private plan(chatId:string,text:string,replyMarkup?:TelegramReplyKeyboard,
    inlineMarkup?:TelegramInlineKeyboard,editMessageId?:number):TelegramReplyPlan {
    if(Buffer.byteLength(text,'utf8')>4096)throw Error('REPLY_TOO_LONG');
    if(replyMarkup&&inlineMarkup)throw Error('CONFLICTING_KEYBOARDS');
    if(editMessageId!==undefined){
     if(!Number.isSafeInteger(editMessageId)||editMessageId<=0||!inlineMarkup)
      throw Error('INVALID_EDIT_TARGET');
     return {chatId,parseMode:'HTML',text,inlineMarkup,editMessageId};
    }
    return inlineMarkup?{chatId,parseMode:'HTML',text,inlineMarkup}:
      replyMarkup?{chatId,parseMode:'HTML',text,replyMarkup}:{chatId,parseMode:'HTML',text};
  }
  // A private chat is not proof of membership in an approved group. Group-scoped
  // libraries require a fresh trusted membership check even when opened in DM.
  private async authorizePrivateGroupBrowse(scope:string,actorId:string):Promise<string|null> {
    if(scope==='private')return null;
    const before=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(before,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(subscriptionRequirementMode(before,scope)==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
    // An external membership check is evidence only for the exact group and
    // subscription-rule epochs at which it started. Revoking/reapproving the
    // group, or introducing a required channel mid-check, invalidates it.
    const epoch=(state:Awaited<ReturnType<BotStore['snapshot']>>):string=>{
      const group=state.chats.find(c=>c.id===scope);
      const rules=state.subscriptionRequirements.filter(r=>r.chatId===scope)
       .map(subscriptionRuleWitness);
      return JSON.stringify([group?.version,group?.approved,group?.scopes,rules]);
    };
    const originalEpoch=epoch(before);
    let member:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
    try {member=await this.opts.membership(scope,actorId);}catch{return 'MEMBERSHIP_UNAVAILABLE';}
    const during=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(during,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(epoch(during)!==originalEpoch)return 'MEMBERSHIP_UNAVAILABLE';
    const requirement=subscriptionRequirementMode(during,scope);
    if(requirement==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
    if(member!=='VERIFIED')return member==='NOT_MEMBER'?'GROUP_MEMBERSHIP_REQUIRED':'MEMBERSHIP_UNAVAILABLE';
    if(requirement==='ACTIVE') {
      if(!this.opts.subscription)return 'SUBSCRIPTION_UNAVAILABLE';
      const check=await this.opts.subscription.verify(scope,actorId);
      if(!acceptsActiveSubscriptionEvidence(check.status,this.opts.policy.isOwner(actorId)))
        return check.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE';
    }
    const after=await this.opts.store.snapshot();
    if(!this.opts.policy.canUseChat(after,scope,'navigation'))return 'CHAT_NOT_AUTHORIZED';
    if(epoch(after)!==originalEpoch)return 'MEMBERSHIP_UNAVAILABLE';
    if(subscriptionRequirementMode(after,scope)==='INVALID')return 'SUBSCRIPTION_UNAVAILABLE';
    return null;
  }
  private async handleDocument(event:Event):Promise<TelegramResult> {
    const {actorId,chatId,kind,document}=event;
    if(!document)throw Error('MISSING_DOCUMENT');
    // Even approved groups must not download documents or process them as admin commands.
    if(kind!=='private'||event.topicId!==undefined)return {status:'DENIED',reason:'PRIVATE_ADMIN_UPLOAD_ONLY'};
    const scopeMatch=/^\/upload\s+(private|-[1-9]\d{0,18})$/u.exec(document.caption);
    if(scopeMatch&&this.opts.policy.isOwner(actorId))await cancelOwnerUpload(this.opts.store,actorId);
    const wizard=document.caption===''?await claimOwnerUpload(this.opts.store,this.opts.policy,actorId,this.clock):null;
    if(!scopeMatch&&!wizard)return {status:'DENIED',reason:'INVALID_DOCUMENT_CAPTION'};
    const scope=scopeMatch?.[1]??wizard!;
    const deny=(reason:string):ProcessedReply=>({status:'DENIED',reason,...(wizard?{plan:this.plan(chatId,'<b>تعذر فحص الملف</b>\nلم يُستورد هذا الملف عبر خطوة الرفع الحالية. يمكنك بدء رفع جديد أو الرجوع إلى الوارد.',undefined,{inline_keyboard:[[{text:'📥 بدء رفع جديد',callback_data:'ou:1:h'},{text:'🧾 مراجعة الوارد',callback_data:'mi:1:i:13:04'}]]})}:{})});
    const ctx:VerifiedAdminContext={origin:'TELEGRAM_PRIVATE',actorId,chatId,verified:true};
    const panel=await this.opts.admin.panel(ctx,scope);
    // The permission gate MUST precede any expensive or external download request.
    if(!panel.canUpload)return deny('UPLOAD_DENIED');
    if(!this.opts.documentDownload)return deny('DOCUMENT_DOWNLOAD_NOT_CONFIGURED');
    let data:Uint8Array;
    try{data=await this.opts.documentDownload.download(document.fileId,MAX_DOCUMENT_BYTES);}
    catch{return deny('DOCUMENT_DOWNLOAD_UNAVAILABLE');}
    if(!(data instanceof Uint8Array) || data.byteLength!==document.size || data.byteLength>MAX_DOCUMENT_BYTES)
      return deny('DOCUMENT_SIZE_MISMATCH');
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}
    catch{return deny('DOCUMENT_NOT_UTF8');}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
      return deny('DOCUMENT_BINARY_CONTENT');
    // EducationService rechecks upload authorization under its state transaction
    // after the asynchronous download; revocation wins over a stale preflight.
    const run=await this.opts.admin.upload(ctx,scope,document.format,document.filename,text);
    const report=run.report;
    return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,
      `<b>تقرير استيراد ملف Telegram تجريبي</b>\nالمعرف: <code>${escapeTelegramHtml(run.id)}</code>\nالأقسام: ${report.sections}\nالجامعات: ${report.universities}\nفرص مرشحة: ${report.opportunities}\nيتطلب المراجعة قبل الاعتماد والنشر المحلي.`,undefined,wizard?{inline_keyboard:[[{text:'🧾 مراجعة الوارد',callback_data:'mi:1:i:13:04'}]]}:undefined)};
  }
  private async groupLibrary(event:Event,categoryId?:string):Promise<ProcessedReply>{
   const view=await groupLibraryInline(this.opts.store,this.opts.policy,{actor:event.actorId,chat:event.chatId,...(event.topicId!==undefined?{topic:event.topicId}:{})},event.callbackData!==undefined?{callback:event.callbackData}:{...(categoryId!==undefined?{categoryId}:{})},this.clock,this.opts.subscription?(chat,actor)=>this.opts.subscription!.verify(chat,actor):undefined);
   if('denied' in view)return {status:'DENIED',reason:view.denied};
   return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:{...this.plan(event.chatId,view.screen.text,undefined,view.screen.keyboard,event.callbackMessageId),...(event.topicId!==undefined?{messageThreadId:event.topicId}:{})},groupMenuAccess:{actorId:event.actorId,epoch:view.epoch,expiresAt:view.expiresAt}};
  }
  private folderReply(event:Event,screen:FolderScreen|null):ProcessedReply{
   if(!screen)return {status:'DENIED',reason:'COMMUNITY_FOLDER_UNAVAILABLE'};
   const plain=screen.keyboard.inline_keyboard.every(row=>row.every(b=>'callback_data' in b));
   const markup=plain?{inline_keyboard:screen.keyboard.inline_keyboard.map(row=>row.map(b=>{if(!('callback_data' in b))throw Error('INVALID_FOLDER_KEYBOARD');return {text:b.text,callback_data:b.callback_data};}))}:{inline_keyboard:[[{text:'المجلدات',callback_data:screen.public?'fj:1:h':'cf:1:h'}]]};
   const planned=this.plan(event.chatId,screen.text,undefined,markup,event.callbackMessageId),{inlineMarkup:_,...base}=planned;
   return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:plain?planned:{...base,studioMarkup:screen.keyboard},...(screen.public?{communityAccess:screen.access}:{adminUIAccess:screen.access})};
  }
  /** Reuse the existing one-shot durable reply ledger and group-menu epoch.
   * Revoking the community configuration before dispatch invalidates its digest.
   */
  private async phase4Reply(event:Event):Promise<ProcessedReply|null>{
    if(!this.opts.community||event.kind!=='group'||event.forwarded||event.edited||event.protectionMedia)return null;
    // Only /m_ custom commands may match, enforced by the scoped rule matcher.
    // Standard Telegram and moderation commands can never match this namespace.
    if(!event.communityKind&&!event.text)return null;
    // Every genuine Telegram service event with a trusted timestamp must be
    // fresh before posting a greeting/farewell. ChatMemberUpdated has no
    // deletable service message, so a timestamp is mandatory for that shape.
    // Service messages without a date are tolerated for old test fixtures.
    if(event.communityKind){
      const now=this.clock(),sent=event.serviceSentAtMs;
      if((event.messageId===undefined&&sent===undefined)||
        (sent!==undefined&&(!Number.isSafeInteger(sent)||sent>now+60000||
         now-sent>900000)))return null;
    }
    const input:CommunityInput={kind:event.communityKind??'TEXT',chatId:event.chatId,
      actorId:event.communityMemberId??event.actorId,
      memberName:event.memberName??'عضو',groupName:event.groupName??'المجموعة',
      ...(event.text?{messageText:event.text}:{}),
      ...(event.communityJoinKind?{joinKind:event.communityJoinKind}:{}),
      ...(event.communityKind==='JOIN'&&event.communityMemberLanguage?
       {memberLanguage:event.communityMemberLanguage}:{}),
      ...(event.communityLeaveKind?{leaveKind:event.communityLeaveKind}:{}),
      ...(event.topicId!==undefined?{topicId:event.topicId}:{})};
    const proposal=await this.opts.community.propose(input,
      'b3-webhook:'+this.opts.botId+':'+event.updateId);
    if(!proposal)return null;
    const snapshot=await this.opts.store.snapshot(),now=this.clock();
    // A published FAQ/category can be archived between the atomic reply
    // reservation and this later read. Refuse the now-stale text instead of
    // attaching a new authorization witness to an old source's answer.
    if(!this.opts.policy.canUseChat(snapshot,event.chatId,'navigation')||
       proposal.sourceEpoch!==groupMenuEpochDigest(snapshot,event.chatId,event.topicId)||
       !Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)
      return null;
    // Telegram has no generic private-to-one group message. A public link
    // lets a new member voluntarily open the bot DM; no user IDs/tokens in it.
    const config=snapshot.phase4Community?.configs.find(c=>c.chatId===event.chatId&&
      c.version===proposal.policyVersion);
    const optIn=event.communityKind==='JOIN'&&config?.privateWelcomeEnabled===true&&
      /^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(this.opts.botUsername)?
      '\n🔒 <a href="https://t.me/'+this.opts.botUsername+'?start=welcome_'+event.chatId.slice(1)+
       '">افتح ترحيبك الخاص في البوت (اختياري)</a>':'';
    const welcomeText=optIn&&Buffer.byteLength(proposal.text+optIn,'utf8')<=
      (proposal.photoFileId?1024:4096)?proposal.text+optIn:proposal.text;
    return {status:'APPLIED',reason:'PHASE4_COMMUNITY_PLANNED',
     communityAutomation:{kind:proposal.kind,configVersion:proposal.policyVersion},
     plan:{chatId:event.chatId,parseMode:'HTML',text:welcomeText,
      ...(proposal.photoFileId?{photoFileId:proposal.photoFileId}:{}),
      ...(proposal.communityLinks?{communityLinks:proposal.communityLinks}:{}),
      ...(event.topicId!==undefined?{messageThreadId:event.topicId}:{})},
     groupMenuAccess:{actorId:proposal.actorId,
      epoch:groupMenuEpochDigest(snapshot,event.chatId,event.topicId),
      expiresAt:now+120000}};
  }
  private async process(event:Event):Promise<ProcessedReply> {
    if(event.communityKind||event.communityChange){
     // Only authenticated service-message updates pass this branch. Never
     // submit user-supplied text/media for deletion or audit processing.
     if(event.edited)return {status:'IGNORED',reason:'COMMUNITY_SERVICE_EDIT_IGNORED'};
     const recorded=this.opts.community&&event.messageId!==undefined?
      await this.opts.community.recordServiceEvent({
       chatId:event.chatId,actorId:event.actorId,messageId:event.messageId,
       kind:event.communityChange??event.communityKind!,
       updateKey:'b3-webhook:'+this.opts.botId+':'+event.updateId,
       ...(event.serviceSentAtMs!==undefined?{sentAtMs:event.serviceSentAtMs}:{})
      }):false;
     if(event.communityChange)
      return {status:recorded?'APPLIED':'IGNORED',
       reason:recorded?'COMMUNITY_SERVICE_CHANGE_OBSERVED':'COMMUNITY_SERVICE_LOG_DISABLED'};
     const output=await this.phase4Reply(event);
     return output??{status:recorded?'APPLIED':'IGNORED',
      reason:recorded?'COMMUNITY_SERVICE_CLEANUP_QUEUED':'COMMUNITY_POLICY_DISABLED_OR_THROTTLED'};
    }
    if(event.protectionMedia){
     const media=event.protectionMedia;
     await new GroupProtectionPolicyService(this.opts.store,this.opts.policy,this.clock).observeIncomingMessage(
      {chatId:event.chatId,memberId:event.actorId,type:media.type,caption:media.caption,...(event.forwarded?{forwarded:true}:{})},media.entities,'b3-webhook:'+this.opts.botId+':'+event.updateId,!event.edited);
     return media.type==='DOCUMENT'?{status:'DENIED',reason:'PRIVATE_ADMIN_UPLOAD_ONLY'}:{status:'IGNORED',reason:'PROTECTION_MEDIA_MONITOR_ONLY'};
    }
    if(event.forwarded){
     await new GroupProtectionPolicyService(this.opts.store,this.opts.policy,this.clock).observeIncomingMessage(
      {chatId:event.chatId,memberId:event.actorId,type:'TEXT',text:event.text,forwarded:true},event.entities,'b3-webhook:'+this.opts.botId+':'+event.updateId,!event.edited);
     return {status:'DENIED',reason:'UNTRUSTED_FORWARD'};
    }
    if(event.edited){
     await new GroupProtectionPolicyService(this.opts.store,this.opts.policy,this.clock).observeIncomingText(
      event.actorId,event.chatId,event.text,event.entities,'b3-webhook:'+this.opts.botId+':'+event.updateId,false);
     return {status:'IGNORED',reason:'PROTECTION_EDIT_MONITOR_ONLY'};
    }
    if(event.kind==='private'&&this.opts.policy.isOwner(event.actorId)&&!event.callbackData?.startsWith('sc:1:')&&event.callbackData!=='mi:1:i:04:02'&&event.callbackData!=='mi:1:i:04:04')await cancelSubscriptionConfig(this.opts.store,event.actorId);
    const folderNavigation=event.callbackData!==undefined?!event.callbackData.startsWith('cf:1:')&&event.callbackData!=='mi:1:i:04:03':event.document!==undefined||event.text.startsWith('/')||isOwnerMenuText(event.text)||(Object.values(menuLabels) as string[]).includes(event.text);
    if(event.kind==='private'&&this.opts.policy.isOwner(event.actorId)&&folderNavigation)await cancelCommunityFolder(this.opts.store,event.actorId);
    if(event.document)return this.handleDocument(event);
    const {actorId,chatId,kind,text}=event;
    // 09:02/09:03: group-scoped student reading, private and explicitly requested.
    // No Telegram group ID or text command is proof of membership.
    const memberGuidanceCallback=event.callbackData?.startsWith('gm:1:')===true;
    const guidanceMemberCommand=memberGuidanceCallback?
     parseGuidanceMemberCallback(event.callbackData!):
     parseGuidanceMemberCommand(text);
    if(memberGuidanceCallback&&!guidanceMemberCommand)
     return {status:'DENIED',reason:'PHASE4_GUIDANCE_CALLBACK_INVALID'};
    if(guidanceMemberCommand){
     if(kind!=='private'||actorId!==chatId||event.edited||event.forwarded||
      (event.callbackData!==undefined&&!memberGuidanceCallback)||!this.opts.community)
      return {status:'DENIED',reason:'PHASE4_GUIDANCE_PRIVATE_ONLY'};
     let denied:string|null;
     try{denied=await this.authorizePrivateGroupBrowse(guidanceMemberCommand.chatId,actorId);}
     catch{return {status:'DENIED',reason:'PHASE4_GUIDANCE_MEMBERSHIP_UNAVAILABLE'};}
     if(denied!==null)return {status:'DENIED',reason:'PHASE4_GUIDANCE_'+denied};
     // Private group material must retain its source/entitlement epoch
     // through the durable outbox, not merely pass a planning-time check.
     const scope=guidanceMemberCommand.chatId;
     const beforeGuide=await this.opts.store.snapshot();
     if(!this.opts.policy.canUseChat(beforeGuide,scope,'navigation'))
      return {status:'DENIED',reason:'PHASE4_GUIDANCE_CHAT_REVOKED'};
     const sourceEpoch=privateGroupEpochDigest(beforeGuide,scope);
     const screen=await new Phase4GuidanceService(this.opts.store,this.opts.policy,
      this.opts.community).memberScreen(scope,guidanceMemberCommand.kind,
      guidanceMemberCommand.kind==='FAQ'?
       guidanceMemberCommand.faqId:undefined,
      guidanceMemberCommand.kind==='FAQ_INDEX'||guidanceMemberCommand.kind==='NOTES_INDEX'?
       guidanceMemberCommand.page:undefined);
     if(!screen)return {status:'DENIED',reason:'PHASE4_GUIDANCE_SOURCE_UNAVAILABLE'};
     const afterGuide=await this.opts.store.snapshot(),now=this.clock();
     if(privateGroupEpochDigest(afterGuide,scope)!==sourceEpoch||
       !this.opts.policy.canUseChat(afterGuide,scope,'navigation')||
       !Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000-120000)
      return {status:'DENIED',reason:'PHASE4_GUIDANCE_SOURCE_CHANGED'};
     return {status:'APPLIED',reason:'PHASE4_GUIDANCE_MEMBER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard),
      privateGroupAccess:{actorId,scope,epoch:sourceEpoch,expiresAt:now+120000}};
    }
    // Stage 4 / 09:06 — the recipient's PRIVATE self-service preferences
    // and local seat requests. No Telegram group post, secret delivery or
    // callback-delegated authorization is implemented here.
    if(kind==='private'&&parseWhisperMemberCommand(text)!==null){
     if(actorId!==chatId||event.forwarded||event.edited||
        event.callbackData!==undefined)
      return {status:'DENIED',reason:'WHISPER_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let current:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{current=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(current!=='VERIFIED')return current;
      // A Telegram group membership proof alone does not satisfy mandatory
      // channel subscriptions. Missing gate, corrupt policy or an
      // inconclusive provider check must all deny a new opt-in/seat.
      const state=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(state,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const decision=await this.opts.subscription.verify(groupId,memberId);
       return decision.status==='MEMBER'||decision.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await whisperMemberScreen(new Phase4WhisperService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'WHISPER_MEMBER_COMMAND_INVALID'};
     return {status:'APPLIED',reason:'WHISPER_MEMBER_SELF_SERVICE',
      plan:this.plan(chatId,screen.text)};
    }
    // Stage 4 / 09:06 — private OWNER review of unpublished whisper drafts.
    // Member consent/seat reservations are domain-only; do not create any
    // group post, private DM or Telegram reveal before a separately audited
    // delivery flow exists. Unknown/stale callbacks are denied.
    const whisperInput=kind==='private'&&(
      event.callbackData==='mi:1:i:09:06'||
      event.callbackData?.startsWith('wh:1:')||
      /^\/whispers(?:$|\s)|^\/whisper(?:first|direct)(?:$|\s)/u.test(text));
    if(whisperInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'WHISPER_OWNER_ONLY'};
     const screen=await whisperOwnerScreen(
      new Phase4WhisperService(this.opts.store,this.opts.policy,this.clock),
      actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'WHISPER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_WHISPER_OWNER_REVIEW',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Stage 4 / 09:07 — moderated question intake, entirely in trusted private
    // Telegram chat. A question ID or callback is never authorization.
    // The reviewer sees content privately; no group post is emitted.
    if(kind==='private'&&parseDiscussionMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'DISCUSSION_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const rule=subscriptionRequirementMode(snapshot,groupId);
      if(rule==='INVALID')return 'UNKNOWN';
      if(rule==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await discussionMemberScreen(new Phase4DiscussionService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'DISCUSSION_MEMBER_COMMAND_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_DISCUSSION_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const discussionInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:07'||
     event.callbackData?.startsWith('dq:1:')||
     /^\/discussions(?:$|\s)|^\/discussion(?:new|faq)(?:$|\s)/u.test(text));
    if(discussionInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'DISCUSSION_OWNER_ONLY'};
     const screen=await discussionOwnerScreen(new Phase4DiscussionService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'DISCUSSION_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_DISCUSSION_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:08 — member-only local survey voting. No sendPoll and
    // no group publication. The owner cannot use a callback to cast a vote.
    if(kind==='private'&&parsePollMemberCommand(text)!==null){
     if(actorId!==chatId||event.forwarded||event.edited||
       event.callbackData!==undefined)
      return {status:'DENIED',reason:'POLL_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await pollMemberScreen(new Phase4PollService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'POLL_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_POLL_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const pollInput=kind==='private'&&(
      event.callbackData==='mi:1:i:09:08'||
      event.callbackData?.startsWith('po:1:')||
      /^\/poll(?:s|new|interests|feedback)(?:$|\s)/u.test(text));
    if(pollInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'POLL_OWNER_ONLY'};
     const screen=await pollOwnerScreen(new Phase4PollService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'POLL_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_POLL_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:09. Student self-service is private and opt-in.
    // This path never sends event announcements, reminders or attendance claims.
    if(kind==='private'&&parseEventMemberCommand(text)!==null){
     if(actorId!==chatId||event.forwarded||event.edited||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'EVENT_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await eventMemberScreen(new Phase4EventService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'EVENT_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_EVENT_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const eventInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:09'||
     event.callbackData?.startsWith('ev:1:')||
     /^\/events(?:$|\s)|^\/event(?:new|summarynew|questions|poll)(?:$|\s)/u.test(text));
    if(eventInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'EVENT_OWNER_ONLY'};
     const screen=await eventOwnerScreen(new Phase4EventService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'EVENT_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_EVENT_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:10: owner-only expert credentials review and AMA summaries.
    // All member content is requested in private; no public or auto delivery.
    if(kind==='private'&&parseExpertMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'EXPERT_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await expertMemberScreen(new Phase4ExpertService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'EXPERT_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_EXPERT_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const expertInput=kind==='private'&&(
      event.callbackData==='mi:1:i:09:10'||
      event.callbackData?.startsWith('xa:1:')||
      /^\/experts(?:$|\s)|^\/expertnew(?:$|\s)|^\/ama(?:new|defer|summarynew|rank|reports)(?:$|\s)/u.test(text));
    if(expertInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'EXPERT_OWNER_ONLY'};
     const screen=await expertOwnerScreen(new Phase4ExpertService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'EXPERT_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_EXPERT_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:11 — group-only study circles, no direct personal matching.
    // Identity and membership proof are mandatory for opt-in and reporting.
    if(kind==='private'&&parseStudyPeerMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'STUDY_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await studyPeerMemberScreen(new Phase4StudyPeersService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'STUDY_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_STUDY_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const peerInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:11'||
     event.callbackData?.startsWith('sp:1:')||
     /^\/studies(?:$|\s)|^\/studynew(?:$|\s)/u.test(text));
    if(peerInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'STUDY_OWNER_ONLY'};
     const screen=await studyPeerOwnerScreen(new Phase4StudyPeersService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'STUDY_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_STUDY_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 08:02 — private opt-in registrations and owner-reviewed
    // multi-round educational contests. Contest-bound quiz answers are
    // fenced by group membership, subscriptions and registration state.
    if(kind==='private'&&parseContestMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'CONTEST_MEMBER_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snap=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snap,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await contestMemberScreen(new Phase4ContestService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'CONTEST_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_CONTEST_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const contestOwnerInput=kind==='private'&&(
     event.callbackData==='mi:1:i:08:02'||
     event.callbackData?.startsWith('ct:1:')||
     text==='/contests'||text.startsWith('/contestnew ')||
     text.startsWith('/contestadd '));
    if(contestOwnerInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded)
      return {status:'DENIED',reason:'CONTEST_OWNER_PRIVATE_ONLY'};
     const screen=await contestOwnerScreen(new Phase4ContestService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'CONTEST_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_CONTEST_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 08:01 — owner-reviewed per-group game availability,
    // quiz frequency and UTC quiet hours. No live Telegram game dispatch.
    const gameCatalogInput=kind==='private'&&(
     event.callbackData==='mi:1:i:08:01'||
     event.callbackData?.startsWith('gc:1:')||
     text==='/games'||text.startsWith('/games ')||
     text.startsWith('/gamequiet '));
    if(gameCatalogInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded)
      return {status:'DENIED',reason:'GAME_CATALOG_OWNER_PRIVATE_ONLY'};
     const screen=await gameCatalogOwnerScreen(new Phase4GameCatalogService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'GAME_CATALOG_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_GAME_CATALOG_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 08:03 — educational quiz entry. Student answers are accepted
    // only in a private Telegram message, never a group/forward/edit/callback.
    // Competition scores are local, independently fenced from 09:08 polls
    // and 09:13 social reactions; no Telegram-native voting takes place.
    if(kind==='private'&&parseQuizMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'QUIZ_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snap=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snap,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await quizMemberScreen(new Phase4QuizService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'QUIZ_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_QUIZ_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const quizOwnerInput=kind==='private'&&(
     event.callbackData==='mi:1:i:08:03'||
     event.callbackData?.startsWith('qz:1:')||
     text==='/quizzes'||text.startsWith('/quiznew '));
    if(quizOwnerInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded)
      return {status:'DENIED',reason:'QUIZ_OWNER_PRIVATE_ONLY'};
     const screen=await quizOwnerScreen(new Phase4QuizService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'QUIZ_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_QUIZ_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:12 — student-controlled opt-in or private badge lookup.
    // No group broadcast, social ranking or new Telegram privileges.
    if(kind==='private'&&parseBadgeMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'BADGE_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await badgeMemberScreen(new Phase4BadgesService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'BADGE_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_BADGE_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const badgeInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:12'||
     event.callbackData?.startsWith('bg:1:')||
     /^\/badges(?:$|\s)|^\/badgedraft(?:$|\s)/u.test(text));
    if(badgeInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'BADGE_OWNER_ONLY'};
     const screen=await badgeOwnerScreen(new Phase4BadgesService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'BADGE_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_BADGE_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:13. Local post reactions are unrelated to contest
    // ballots or any public Telegram reaction/update of group messages.
    if(kind==='private'&&parseReactionMemberCommand(text)!==null){
     if(actorId!==chatId||event.edited||event.forwarded||
      event.callbackData!==undefined)
      return {status:'DENIED',reason:'REACTION_PRIVATE_ORIGIN_REQUIRED'};
     const verify=async(groupId:string,memberId:string):Promise<'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'>=>{
      let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='UNKNOWN';
      try{membership=await this.opts.membership(groupId,memberId);}
      catch{return 'UNKNOWN';}
      if(membership!=='VERIFIED')return membership;
      const snapshot=await this.opts.store.snapshot();
      const mode=subscriptionRequirementMode(snapshot,groupId);
      if(mode==='INVALID')return 'UNKNOWN';
      if(mode==='NONE')return 'VERIFIED';
      if(!this.opts.subscription)return 'UNKNOWN';
      try{
       const result=await this.opts.subscription.verify(groupId,memberId);
       return result.status==='MEMBER'||result.status==='NOT_REQUIRED'?
        'VERIFIED':'UNKNOWN';
      }catch{return 'UNKNOWN';}
     };
     const screen=await reactionMemberScreen(new Phase4ReactionsService(
      this.opts.store,this.opts.policy,this.clock,verify),actorId,text);
     if(!screen)return {status:'DENIED',reason:'REACTION_MEMBER_INVALID'};
     return {status:'APPLIED',reason:'PHASE4_REACTION_MEMBER',
      plan:this.plan(chatId,screen.text)};
    }
    const reactionInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:13'||
     event.callbackData?.startsWith('rc:1:')||
     /^\/reactions(?:$|\s)|^\/reactnew(?:$|\s)/u.test(text));
    if(reactionInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId)
      return {status:'DENIED',reason:'REACTION_OWNER_ONLY'};
     const screen=await reactionOwnerScreen(new Phase4ReactionsService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'REACTION_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_REACTION_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:14 — only the owner can start/stop the temporary
    // quiet period. No group commands, moderation bypass or Telegram edits.
    const lectureInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:14'||
     event.callbackData?.startsWith('lc:1:')||
     /^\/lectures(?:$|\s)|^\/lecturenew(?:$|\s)/u.test(text));
    if(lectureInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.forwarded||event.edited)
      return {status:'DENIED',reason:'LECTURE_OWNER_PRIVATE_ONLY'};
     const screen=await lectureOwnerScreen(new Phase4LectureService(
      this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'LECTURE_OWNER_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_LECTURE_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Phase 4 / 09:15 — on-demand, read-only and group-scoped engagement.
    // Owner's private identity is required; never return records to a group.
    const engagementInput=kind==='private'&&(
     event.callbackData==='mi:1:i:09:15'||
     event.callbackData?.startsWith('er:1:')||
     /^\/engagement(?:$|\s)/u.test(text));
    if(engagementInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded)
      return {status:'DENIED',reason:'ENGAGEMENT_OWNER_PRIVATE_ONLY'};
     const screen=await engagementOwnerScreen(
      new Phase4EngagementReportsService(this.opts.store,this.opts.policy,this.clock),
      actorId,event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'ENGAGEMENT_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_ENGAGEMENT_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // 09:02/09:03: approved guide dashboard plus one-shot owner-reviewed posting.
    const phase4GuidanceInput=kind==='private'&&!!this.opts.community&&(
     event.callbackData==='mi:1:i:09:02'||
     event.callbackData==='mi:1:i:09:03'||
     event.callbackData?.startsWith('gd:1:')||
     text==='/newmemberguide'||text.startsWith('/newmemberguide ')||
     text==='/groupfixed'||text.startsWith('/groupfixed ')||
     /^\/(?:guideset|guidetopics|guideservices|guideclear|guidetopicsclear|guideservicesclear|guidepublish|fixedpublish)(?:$|\s)/u.test(text));
    if(phase4GuidanceInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded||!this.opts.community)
      return {status:'DENIED',reason:'PHASE4_GUIDANCE_OWNER_PRIVATE_ONLY'};
     const view=await phase4GuidanceOwnerScreen(new Phase4GuidanceService(
      this.opts.store,this.opts.policy,this.opts.community),
      actorId,event.callbackData??text);
     if(!view)return {status:'DENIED',reason:'PHASE4_GUIDANCE_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_GUIDANCE_OWNER',
      plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
    }
    // 09:16 — dedicated settings dashboard. Authorization is private and owner-only.
    const phase4SettingsInput=kind==='private'&&!!this.opts.community&&(
     event.callbackData==='mi:1:i:09:16'||
     event.callbackData?.startsWith('p4s:1:')||
     text==='/communitysettings'||text.startsWith('/communitysettings '));
    if(phase4SettingsInput){
     if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
      event.edited||event.forwarded||!this.opts.community)
      return {status:'DENIED',reason:'PHASE4_SETTINGS_OWNER_PRIVATE_ONLY'};
     const screen=await phase4SettingsOwnerScreen(this.opts.community,actorId,
      event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'PHASE4_SETTINGS_STALE_OR_DENIED'};
     return {status:'APPLIED',reason:'PHASE4_SETTINGS_OWNER',
      plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    // Dedicated 09:04 panel. Old service-cleanup toggles still use the existing
    // p4c editor, but opening 09:04 now shows actual queue/status controls.
    const serviceOpsInput=kind==='private'&&(
      event.callbackData==='mi:1:i:09:04'||
      event.callbackData?.startsWith('sc4:1:')||
      text==='/servicejobs');
    if(serviceOpsInput){
      if(!this.opts.policy.isOwner(actorId)||actorId!==chatId||
         event.edited||event.forwarded)
        return {status:'DENIED',reason:'SERVICE_OPS_OWNER_PRIVATE_ONLY'};
      const screen=await phase4ServiceOpsScreen(new Phase4CleanupOperations(
        this.opts.store,this.opts.policy,this.clock),actorId,event.callbackData??text);
      if(!screen)return {status:'DENIED',reason:'SERVICE_OPS_STALE_OR_DENIED'};
      return {status:'APPLIED',reason:'PHASE4_SERVICE_OPS_OWNER',
        plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    const communityCommand=kind==='private'?parsePhase4CommunityCommand(text):null;
    if(kind==='private'&&(communityCommand||event.callbackData?.startsWith('p4c:1:')||
      (this.opts.community&&['mi:1:i:09:01','mi:1:i:09:04','mi:1:i:09:05','mi:1:i:09:15','mi:1:i:07:10'].includes(event.callbackData??'')))){
     if(!this.opts.policy.isOwner(actorId)||!this.opts.community)
      return {status:'DENIED',reason:'COMMUNITY_EDITOR_DISABLED'};
     const screen=await phase4CommunityScreen(this.opts.community,actorId,
       event.callbackData??text);
     if(!screen)return {status:'DENIED',reason:'COMMUNITY_EDITOR_STALE'};
     return {status:'APPLIED',reason:'PHASE4_COMMUNITY_EDITOR',
       plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
    }
    if(kind==='private'&&this.opts.policy.isOwner(actorId)&&!event.callbackData?.startsWith('ou:1:'))await cancelOwnerUpload(this.opts.store,actorId);
    if(kind==='private'&&event.topicId!==undefined)return {status:'DENIED',reason:'PRIVATE_TOPIC_NOT_SUPPORTED'};
    if(kind==='private'&&event.callbackData===undefined&&this.opts.policy.isOwner(actorId)&&!folderNavigation){const screen=await new CommunityFolderUI(this.opts.store,this.opts.policy,this.opts.subscription,this.clock).text(actorId,text);if(screen)return this.folderReply(event,screen);}
    if(event.callbackData!==undefined){
     if(kind==='group'&&event.callbackData.startsWith('gl:1:'))return this.groupLibrary(event);
     // Reauthorize the real sender at every tap. Never dispatch a privileged
     // command from untrusted callback_data or from a group context.
     if(kind!=='private'||actorId!==chatId)return {status:'DENIED',reason:'PRIVATE_CALLBACK_ONLY'};
     if(event.callbackData.startsWith('pn:1:')){
      const selected=await readPublicNavigation(this.opts.store,actorId,event.callbackData,publicMenuText,this.clock);if(!selected)return {status:'DENIED',reason:'PUBLIC_NAVIGATION_STALE_OR_INVALID'};
      const {callbackData:_,...base}=event;return this.process({...base,text:selected});
     }
     if(this.opts.policy.isOwner(actorId)&&!event.callbackData.startsWith('ec:1:')&&event.callbackData!=='mi:1:i:10:16')await new EducationCategoryEditor(this.opts.store,this.opts.policy,this.clock).cancel(actorId);
     if(this.opts.policy.isOwner(actorId)&&!event.callbackData.startsWith('nw:1:'))await new OwnerNetworkEditor(this.opts.store,this.opts.policy,this.clock).cancelInput(actorId);
     if(this.opts.policy.isOwner(actorId)&&!event.callbackData.startsWith('od:1:'))await new OwnerDelegationEditor(this.opts.store,this.opts.policy,this.clock).cancel(actorId);
     if(this.opts.policy.isOwner(actorId)&&!event.callbackData.startsWith('st:1:')&&!studioOwnerEntry(event.callbackData))await new ButtonStudioService(this.opts.store,this.opts.policy,this.clock).cancelInput(actorId);
     if(this.opts.policy.isOwner(actorId)&&!event.callbackData.startsWith('ps:1:')&&event.callbackData!=='mi:1:i:11:03'&&!event.callbackData.startsWith('si:1:')&&!event.callbackData.startsWith('si:2:')&&!event.callbackData.startsWith('ms:1:')&&!event.callbackData.startsWith('fj:1:')&&!this.opts.policy.privateFeature(await this.opts.store.snapshot(),'owner.dashboard',actorId))return {status:'DENIED',reason:'OWNER_DASHBOARD_DISABLED'};
     if(event.callbackData==='mi:1:i:04:03'||event.callbackData.startsWith('cf:1:')||event.callbackData.startsWith('fj:1:')){
      const screen=await new CommunityFolderUI(this.opts.store,this.opts.policy,this.opts.subscription,this.clock).handle(actorId,event.callbackData);
      if(!screen&&/^fj:1:[A-Za-z0-9_-]{24}$/u.exec(event.callbackData)?.[0]===event.callbackData&&event.callbackMessageId!==undefined){
       const receipt=staleCommunityMessage(await this.opts.store.snapshot(),this.opts.policy,actorId,event.callbackMessageId,this.clock());
       if(receipt)return {status:'APPLIED',reason:'COMMUNITY_MESSAGE_CLOSURE_PLANNED',communityClose:receipt,plan:this.plan(chatId,COMMUNITY_CLOSED_TEXT,undefined,{inline_keyboard:[[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]},event.callbackMessageId)};
      }
      return this.folderReply(event,screen);
     }
     if(event.callbackData==='mi:1:i:11:03'||event.callbackData.startsWith('ps:1:')){
      const view=await renderPrivateSettings(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'PRIVATE_SETTINGS_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData.startsWith('oc:1:')){
      const view=await cancelOwnerPreview(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'OWNER_PREVIEW_CANCEL_DENIED'};
     }
     if(event.callbackData.startsWith('pr:1:')||/^mi:1:i:02:(?:0[5678]|12)$/u.test(event.callbackData)){
      if(/^mi:1:i:02:(?:0[5678]|12)$/u.test(event.callbackData)&&!this.opts.policy.isOwner(actorId))return {status:'DENIED',reason:'OWNER_ONLY'};
      const view=await new TelegramProtectionEditor(this.opts.store,this.opts.policy,this.clock).handle(event.callbackData,actorId);
      if(!view)return {status:'DENIED',reason:'PROTECTION_EDITOR_NOT_ACCESSIBLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData.startsWith('pd:1:')){
      if(!this.opts.purge)return {status:'DENIED',reason:'DELETE_NOT_CONFIGURED'};
      const result=await handleReplyDeleteCallback(this.opts.store,this.opts.policy,this.opts.purge,actorId,event.callbackData,this.clock());
      const {screen,...outcome}=result;
      return {...outcome,...(screen?{plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)}:{})};
     }
     if(event.callbackData.startsWith('si:1:')||event.callbackData.startsWith('si:2:')){
      const screen=await renderStudentInline(this.opts.store,this.opts.policy,
       actorId,event.callbackData);
      if(!screen)return {status:'DENIED',reason:'STUDENT_CALLBACK_NOT_ACCESSIBLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData.startsWith('ms:1:')){
      const screen=await renderStaffInline(this.opts.store,this.opts.policy,
       actorId,event.callbackData,this.clock());
      if(!screen)return {status:'DENIED',reason:'STAFF_SCOPE_OR_CALLBACK_INVALID'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(!this.opts.policy.isOwner(actorId))return {status:'DENIED',reason:'OWNER_ONLY'};
     if(event.callbackData==='mi:1:i:01:03'||event.callbackData.startsWith('nw:1:')){
      const view=await new OwnerNetworkEditor(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'OWNER_NETWORK_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData.startsWith('gb:1:')){
      const view=await new OwnerGroupBulkRestrict(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'OWNER_BULK_RESTRICTION_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData==='mi:1:i:01:12'||event.callbackData.startsWith('gs:1:')){
      const view=await new OwnerGroupSettings(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'OWNER_GROUP_SETTINGS_STALE_OR_UNAUTHORIZED'};
     }
     if(/^mi:1:i:01:(?:06|07|08)$/u.test(event.callbackData)||event.callbackData.startsWith('gt:1:')){
      const screen=await new OwnerGroupPolicyTemplates(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      if(!screen)return {status:'DENIED',reason:'GROUP_TEMPLATE_STALE_OR_UNAUTHORIZED'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData.startsWith('gw:1:')){
      const view=await new OwnerGroupSetup(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'GROUP_SETUP_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData.startsWith('gp:1:')){
      const m=/^gp:1:p:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,9})$/u.exec(event.callbackData);
      if(!m||m[0]!==event.callbackData)return {status:'DENIED',reason:'INVALID_GROUP_PROTECTION_SELECTOR'};
      const view=await new TelegramProtectionEditor(this.opts.store,this.opts.policy,this.clock).openOwnerGroup(actorId,m[1]!,Number(m[2]));
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'GROUP_PROTECTION_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData.startsWith('od:1:')){
      const view=await new OwnerDelegationEditor(this.opts.store,this.opts.policy,this.clock).handle(actorId,event.callbackData);
      return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'DELEGATION_STALE_OR_UNAUTHORIZED'};
     }
     if(event.callbackData==='mi:1:i:10:16'||event.callbackData.startsWith('ec:1:')){
      const screen=await renderOwnerInlineCategories(this.opts.store,this.opts.policy,this.opts.education,actorId,event.callbackData,this.clock);
      return screen?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)}:{status:'DENIED',reason:'CATEGORY_UI_STALE_OR_UNAUTHORIZED'};
     }
     if(studioOwnerEntry(event.callbackData)||event.callbackData.startsWith('st:1:')){
      const screen=await renderOwnerInlineStudio(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'STUDIO_STALE_OR_UNAUTHORIZED'};
      const planned=this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId);
      if(screen.nativeKeyboard){const {inlineMarkup:_,...base}=planned;return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:{...base,studioMarkup:screen.nativeKeyboard}};}
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:planned};
     }
     if(event.callbackData==='mi:1:i:04:02'||event.callbackData==='mi:1:i:04:04'||event.callbackData.startsWith('sc:1:')){
      const screen=await renderSubscriptionConfig(this.opts.store,this.opts.policy,this.opts.subscription,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'INVALID_OR_STALE_SUBSCRIPTION_CONFIG'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',adminUIAccess:screen.access,plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData.startsWith('ou:1:')){
      const screen=await renderOwnerUpload(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'INVALID_OR_STALE_UPLOAD_CALLBACK'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:13:04'||event.callbackData.startsWith('oi:1:')){
      const menu=new OwnerTelegramMenu(this.opts.store,this.opts.policy,this.opts.education,this.opts.admin,this.opts.platformCatalog,this.clock);
      const screen=await renderOwnerInlineImports(this.opts.store,this.opts.policy,menu,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'INVALID_OR_STALE_IMPORT_CALLBACK'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:10:09'||event.callbackData.startsWith('ol:1:')){
      const screen=await renderOwnerInlineLibrary(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'LIBRARY_INLINE_STALE_OR_UNAUTHORIZED'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:10:08'||event.callbackData.startsWith('of:1:')){
      const screen=await renderOwnerInlineFAQ(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock);
      if(!screen)return {status:'DENIED',reason:'FAQ_INLINE_STALE_OR_UNAUTHORIZED'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:02:13'||event.callbackData.startsWith('pq:1:')){
      const view=await renderOwnerPurgeQueue(this.opts.store,this.opts.policy,actorId,event.callbackData,this.clock(),Boolean(this.opts.purge));
      if(!view)return {status:'DENIED',reason:'PURGE_QUEUE_UNAVAILABLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
     }
     // The owner-private emergency/status screen never permits mutation.
     if(event.callbackData==='mi:1:i:02:16'){
      const view=await renderOwnerModerationEmergencyStatus(
       this.opts.store,this.opts.policy,actorId,this.clock(),
       this.opts.moderationSafetyFile);
      if(!view)return {status:'DENIED',reason:'MODERATION_EMERGENCY_STATUS_UNAVAILABLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:02:15'){
      const view=await renderOwnerModerationRateStatus(
       this.opts.store,this.opts.policy,actorId,this.clock());
      if(!view)return {status:'DENIED',reason:'MODERATION_RATE_STATUS_NOT_ACCESSIBLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
     }
     // UNKNOWN_OUTCOME human triage is annotation only: no retry, no unlock,
     // no Telegram effect. Owner, current policy, and one-shot nonce are
     // independently checked in a single durable transaction.
     if(event.callbackData.startsWith('mp:1:')){
      const page=await new ModerationPendingOwnerView(
       this.opts.store,this.opts.policy,this.clock).handle(event.callbackData,actorId);
      if(!page)return {status:'DENIED',reason:'MODERATION_PENDING_UNAVAILABLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,page.text,undefined,page.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData==='mi:1:i:02:01'||event.callbackData.startsWith('mr:1:')){
      const page=await new ModerationUnknownOwnerReview(
       this.opts.store,this.opts.policy,this.clock).handle(event.callbackData,actorId);
      if(!page)return {status:'DENIED',reason:'MODERATION_REVIEW_UNAVAILABLE'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,page.text,undefined,page.keyboard,event.callbackMessageId)};
     }
     if(event.callbackData.startsWith('c_')){
      const reviewer=new ModerationUnknownOwnerReview(
       this.opts.store,this.opts.policy,this.clock);
      const reviewed=await reviewer.handle(event.callbackData,actorId);
      if(reviewed)return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,reviewed.text,undefined,reviewed.keyboard,event.callbackMessageId)};
      // Other owner c_ callbacks are restricted by their own service.
     }
     // Delegation audit is read-only and owner-private. Paged details are
     // independently checked against the CURRENT stored grant and status.
     if(delegationOwnerEntry(event.callbackData)||event.callbackData.startsWith('mi:1:d:')){
      const screen=await renderOwnerInlineDelegations(this.opts.store,this.opts.policy,
       actorId,event.callbackData,this.clock());
      if(!screen)return {status:'DENIED',reason:'INVALID_OR_STALE_DELEGATION_CALLBACK'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     // Durable one-shot confirmations are owner-only, bounded to the current
     // chat policy revision and never execute live Telegram moderation.
     if(event.callbackData.startsWith('mi:1:g:v:')||
       event.callbackData.startsWith('c_')){
      const control=await new OwnerInlineGroupControls(
       this.opts.store,this.opts.policy,this.clock).handle(event.callbackData,actorId);
      if(!control)return {status:'DENIED',reason:'INVALID_OR_STALE_OWNER_CONFIRMATION'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,control.text,undefined,control.keyboard,event.callbackMessageId)};
     }
     // Group browsing is the first migrated *drill-down* feature. Every page,
     // chat revision and local policy is freshly authorized from durable state.
     if(event.callbackData==='mi:1:i:01:01'||/^mi:1:i:01:(?:09|10|11)$/u.test(event.callbackData)||event.callbackData.startsWith('mi:1:g:')){
      const screen=await renderOwnerInlineGroups(this.opts.store,this.opts.policy,actorId,event.callbackData);
      if(!screen)return {status:'DENIED',reason:'INVALID_OR_STALE_GROUP_CALLBACK'};
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,screen.text,undefined,screen.keyboard,event.callbackMessageId)};
     }
     const view=ownerInlineRender(event.callbackData);
     if(!view)return {status:'DENIED',reason:'INVALID_OWNER_CALLBACK'};
     const linked=ownerInlineLinkedReadOnly(event.callbackData);
     if(linked){
      // Call the original owner menu's verified private and service-level ACLs.
      // Only its READ-ONLY root views are exposed. Its reply keyboard actions
      // are intentionally not translated into mutable inline callbacks.
      const ctx:VerifiedAdminContext={origin:'TELEGRAM_PRIVATE',actorId,chatId,verified:true};
      const screen=await new OwnerTelegramMenu(this.opts.store,this.opts.policy,
       this.opts.education,this.opts.admin,this.opts.platformCatalog,this.clock).handle(linked,ctx);
      if(!screen)return {status:'DENIED',reason:'OWNER_MENU_UNAVAILABLE'};
      const text=screen.text+'\n\n↩️ الرجوع عبر الأزرار الشفافة. الإجراءات الإدارية '
       +'والانتقال التفصيلي ما زالا عبر لوحة المالك القديمة.';
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,text,undefined,view.keyboard,event.callbackMessageId)};
     }
     return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
      plan:this.plan(chatId,view.text,undefined,view.keyboard,event.callbackMessageId)};
    }
    if(kind==='group')await new GroupProtectionPolicyService(this.opts.store,this.opts.policy,this.clock).observeIncomingText(
     actorId,chatId,text,event.entities,'b3-webhook:'+this.opts.botId+':'+event.updateId);
    if(kind==='group'){
     const reply=await this.phase4Reply(event);
     if(reply)return reply;
    }
    if(kind==='group'&&isReplyDeleteCommand(text,this.opts.botUsername)){
     if(!this.opts.purge)return {status:'DENIED',reason:'DELETE_NOT_CONFIGURED'};
     const result=await previewReplyDelete(this.opts.store,this.opts.policy,this.opts.purge,actorId,chatId,event.messageId,text,event.replyTo,this.clock());
     const {screen,...outcome}=result;
     return {...outcome,...(screen?{plan:this.plan(actorId,screen.text,undefined,screen.keyboard)}:{})};
    }
    if(kind==='group'){
     const command=parseReplyModerationCommand(text,this.opts.botUsername,chatId,event.messageId,event.replyTo);
     if(command.status==='INVALID')return {status:'DENIED',reason:'INVALID_MODERATION_COMMAND'};
     if(command.status==='COMMAND'){
      if(!this.opts.moderation)return {status:'DENIED',reason:'MODERATION_NOT_CONFIGURED'};
      return executeReplyModerationCommand(this.opts.moderation,actorId,chatId,command.command);
     }
    }
    if(kind==='group'&&!this.opts.policy.canUseChat(await this.opts.store.snapshot(),chatId,'navigation'))return {status:'DENIED',reason:'CHAT_NOT_AUTHORIZED'};
    const adminCtx:VerifiedAdminContext={origin:'TELEGRAM_PRIVATE',actorId,chatId,verified:true};
    const words=text.split(/\s+/u);
    const cmd=words[0]??'';
    // Telegram's verified MessageEntity is mandatory for a free-text mention.
    // The slash command remains a separate explicit opt-in route.
    const mention=kind==='group'
     ?parseB6ExplicitMention(text,event.entities,this.opts.botUsername)
     :{status:'NO_MATCH'} as const;
    if(mention.status==='INVALID')return {status:'DENIED',reason:'INVALID_MENTION_ENTITIES'};
    const commandPrefix=`/ask@${this.opts.botUsername} `;
    const groupQuestion=kind==='group'
     ?(mention.status==='MATCH'?mention.question:
       text.startsWith(commandPrefix)?text.slice(commandPrefix.length):null)
     :null;
    let groupAnswerSubscriptionEpochValue:string|undefined;
    let privateGroupSource:{scope:string;epoch:string}|undefined;
    const markPrivateGroupSource=async(scope:string):Promise<void>=>{
     if(kind!=='private'||scope==='private')return;
     const snap=await this.opts.store.snapshot();
     privateGroupSource={scope,epoch:privateGroupEpochDigest(snap,scope)};
    };
    if(kind==='group'&&event.topicId!==undefined&&(cmd===`/ask@${this.opts.botUsername}`||groupQuestion!==null))return {status:'DENIED',reason:'TOPIC_ASSISTANT_NOT_CONFIGURED'};
    if(kind==='group'&&(cmd===`/ask@${this.opts.botUsername}`||groupQuestion!==null)) {
      const snapshot=await this.opts.store.snapshot();
      groupAnswerSubscriptionEpochValue=groupQuestionSubscriptionEpoch(snapshot,chatId);
      const requirement=subscriptionRequirementMode(snapshot,chatId);
      if(requirement==='INVALID')
        return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
      if(requirement==='ACTIVE') {
        if(!this.opts.subscription)return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
        const verified=await this.opts.subscription.verify(chatId,actorId);
        if(!acceptsActiveSubscriptionEvidence(verified.status,this.opts.policy.isOwner(actorId)))
          return {status:'DENIED',reason:verified.status==='NOT_MEMBER'?'SUBSCRIPTION_REQUIRED':'SUBSCRIPTION_UNAVAILABLE'};
        // Do not let mid-flight changes (including pause/recreate, policy scope
        // edits or duplicate rules) turn the old proof into access.
        const current=await this.opts.store.snapshot();
        const revision=(state:Awaited<ReturnType<BotStore['snapshot']>>)=>
          JSON.stringify([state.chats.find(c=>c.id===chatId)?.version,
            state.subscriptionRequirements.filter(r=>r?.chatId===chatId)]);
        if(!this.opts.policy.canUseChat(current,chatId,'navigation') ||
          subscriptionRequirementMode(current,chatId)!=='ACTIVE' ||
          revision(current)!==revision(snapshot))
          return {status:'DENIED',reason:'SUBSCRIPTION_UNAVAILABLE'};
      }
    }
    const result=(message:string,replyMarkup?:TelegramReplyKeyboard,
      groupQuestionAccess?:TelegramReplyJob['groupQuestionAccess']):ProcessedReply=>{
      let groupMenuAccess:TelegramReplyJob['groupMenuAccess'];
      let privateGroupAccess:TelegramReplyJob['privateGroupAccess'];
      if(kind==='private'&&privateGroupSource){
       if(chatId!==actorId)throw Error('B6_PRIVATE_RECIPIENT_MISMATCH');
       const at=this.clock();
       if(!Number.isSafeInteger(at)||at<0||at>8_640_000_000_000_000-120_000)
        throw Error('B6_PRIVATE_GROUP_CLOCK');
       privateGroupAccess={actorId,scope:privateGroupSource.scope,
        epoch:privateGroupSource.epoch,expiresAt:at+120_000};
      }
      if(kind==='group'&&!groupQuestionAccess){
       const epoch=groupAnswerSubscriptionEpochValue;
       const at=this.clock();
       if(epoch===undefined||!Number.isSafeInteger(at)||at<0||
          at>8_640_000_000_000_000-120_000)throw Error('B6_MENU_EPOCH_INVALID');
       groupMenuAccess={actorId,epoch:createHash('sha256')
        .update('MANARATAK:B6:GROUP-MENU:DISPATCH:v2:').update(epoch).digest('hex'),
        expiresAt:at+120_000};
      }
      return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
       plan:this.plan(chatId,message,replyMarkup),
       ...(groupQuestionAccess?{groupQuestionAccess}:{}),
       ...(groupMenuAccess?{groupMenuAccess}:{}),
       ...(privateGroupAccess?{privateGroupAccess}:{})};
    };
    const groupAnswerAccess=():TelegramReplyJob['groupQuestionAccess']=>{
      const epoch=groupAnswerSubscriptionEpochValue;
      if(epoch===undefined)throw Error('B6_GROUP_EPOCH_MISSING');
      const at=this.clock();
      if(!Number.isSafeInteger(at)||at<0||at>8_640_000_000_000_000-120_000)
       throw Error('B6_GROUP_CLOCK_INVALID');
      return {
       actorId,epoch:createHash('sha256')
        .update('MANARATAK:B6:GROUP-FAQ:DISPATCH:v2:')
        .update(epoch).digest('hex'),expiresAt:at+120_000
      };
    };
    // The real Telegram reply keyboard uses verified ordinary message texts,
    // not callback claims. Every selection is re-authorized on every tap.
    if(kind==='private'){
      const m=menuLabels;
      const owner=this.opts.policy.isOwner(actorId);
      if(owner){
       const networkEditor=new OwnerNetworkEditor(this.opts.store,this.opts.policy,this.clock);
       if(text.startsWith('/')||Object.values(m).some(label=>label===text)||isOwnerMenuText(text))await networkEditor.cancelInput(actorId);
       else try{
        const preview=await networkEditor.previewName(actorId,text);
        if(preview)return {status:'APPLIED',reason:'NETWORK_TEXT_PREVIEW',plan:this.plan(chatId,preview.text,undefined,preview.keyboard)};
       }catch{return {status:'DENIED',reason:'NETWORK_NAME_INVALID_OR_STALE',plan:this.plan(chatId,'اسم الشبكة غير صالح أو مستخدم سابقًا. اختر اسمًا آخر أو ألغِ إنشاء الشبكة.')};}
       const delegation=new OwnerDelegationEditor(this.opts.store,this.opts.policy,this.clock);
       if(text.startsWith('/')||Object.values(m).some(label=>label===text)||isOwnerMenuText(text))await delegation.cancel(actorId);
       else try{
        const review=await delegation.previewInput(actorId,text);
        if(review)return {status:'APPLIED',reason:'DELEGATION_TEXT_PREVIEW',plan:this.plan(chatId,review.text,undefined,review.keyboard)};
       }catch{return {status:'DENIED',reason:'DELEGATION_INPUT_INVALID_OR_STALE',plan:this.plan(chatId,'تعذّر قبول المعرّف أو انتهت خطوة الإدخال. افتح التفويض وأعد المحاولة.')};}
       const categories=new EducationCategoryEditor(this.opts.store,this.opts.policy,this.clock);
       if(text.startsWith('/')||Object.values(m).some(label=>label===text)||isOwnerMenuText(text))await categories.cancel(actorId);
       else try{
        const preview=await categories.preview(actorId,text);
        if(preview)return {status:'APPLIED',reason:'CATEGORY_TEXT_PREVIEW',plan:this.plan(chatId,'<b>معاينة '+(preview.kind==='GENERAL'?'تغيير ظهور المحادثة العامة':preview.kind==='TOPIC'?'تغيير ظهور الموضوع':preview.kind==='PARENT'?'تغيير القسم الأب':preview.kind==='RENAME'?'تغيير الاسم':preview.kind==='LANG'?'تغيير اللغة':'إنشاء قسم')+'</b>\nالقيمة: '+escapeTelegramHtml(preview.name)+'\nلم يُحفظ التغيير بعد. ينتهي التأكيد بعد دقيقتين.',undefined,{inline_keyboard:[[{text:'✅ تأكيد الحفظ',callback_data:'ec:1:a:'+preview.ref.slice(2)}],[{text:'إلغاء','callback_data':ownerPreviewCancelData(preview.ref)}]]})};
       }catch{return {status:'DENIED',reason:'CATEGORY_TEXT_INVALID_OR_STALE',plan:this.plan(chatId,'تعذّر قبول الاسم أو انتهت خطوة الإدخال. افتح التصنيف الحالي وأعد المحاولة.')};}
       const studio=new ButtonStudioService(this.opts.store,this.opts.policy,this.clock);
       const pending=(await this.opts.store.snapshot()).buttonStudio?.inputs.some(i=>i.actor===actorId);
       if(pending){
        if(text.startsWith('/')||Object.values(m).some(label=>label===text)||isOwnerMenuText(text))await studio.cancelInput(actorId);
        else try{
         const draft=await studio.acceptInput(actorId,text);
         if(draft){const screen=studioDraftScreen(draft);return {status:'APPLIED',reason:'STUDIO_DRAFT_SAVED',plan:this.plan(chatId,screen.text,undefined,screen.keyboard)};}
        }catch{return {status:'DENIED',reason:'STUDIO_INPUT_INVALID_OR_STALE',plan:this.plan(chatId,'تعذّر حفظ الإدخال: تأكد من القيمة أو افتح المسودة الحالية وأعد المحاولة.')};}
       }
      }
      const dashboardEnabled=owner&&this.opts.policy.privateFeature(await this.opts.store.snapshot(),'owner.dashboard',actorId);
      const main=()=>result('<b>أهلًا بك في بوت منارتك 🎓</b>\n'
        +(this.opts.studentMenuMode==='inline'?'اختر أحد الأقسام من الأزرار الشفافة أدناه. تظهر الموارد المعتمدة فقط.\n':'اختر أحد الأقسام من الأزرار أسفل المحادثة. تظهر الموارد المعتمدة فقط.\n')
        +'لتصفح المكتبة بالأزرار الشفافة استخدم /studentinline.\n'
        +(dashboardEnabled?'لفتح لوحة المالك الشفافة استخدم /ownerinline، ولأدوات الإدارة القديمة /ownerlegacy.\n':owner?'لوحة المالك معطلة؛ لاستعادتها استخدم /ownerrecover.\n':'')
        +'يمكنك أيضًا استخدام /categories private و /help.\n'
        +'المساعد الذكي وبعض الخدمات ما زالت قيد التطوير.',
        mainMenuKeyboard(dashboardEnabled));
      const editorResult=await new TelegramProtectionEditor(this.opts.store,this.opts.policy,this.clock).handleText(
       actorId,text,Object.values(m).some(label=>label===text)||isOwnerMenuText(text));
      if(editorResult)return {status:editorResult.status,reason:editorResult.reason,
       plan:this.plan(chatId,editorResult.screen.text,undefined,editorResult.screen.keyboard)};
      const privateWelcome=/^(?:\/start welcome_|\/mywelcome -)([1-9]\d{0,15})$/u.exec(text);
      if(privateWelcome){
       if(!this.opts.community)return {status:'DENIED',reason:'PRIVATE_WELCOME_DISABLED'};
       const scope='-'+privateWelcome[1]!;
       // User explicitly started a private conversation; no auto-DM on join.
       // This check is external membership proof, fenced by the same group
       // approval/subscription witness used by other scoped private resources.
       const denied=await this.authorizePrivateGroupBrowse(scope,actorId);
       if(denied)return {status:'DENIED',reason:'PRIVATE_WELCOME_ACCESS_DENIED'};
       await markPrivateGroupSource(scope);
       const welcome=await this.opts.community.claimPrivateWelcome(actorId,scope,event.memberName??'عضو');
       if(!welcome)return {status:'DENIED',reason:'PRIVATE_WELCOME_UNAVAILABLE'};
       return result('<b>🔒 ترحيب خاص بطلبك</b>\n'+welcome);
      }
      if(cmd==='/start'||cmd==='/help'||text===m.home||text===m.back)return main();
      if(text==='/ownerrecover'){
       if(!owner)return {status:'DENIED',reason:'OWNER_ONLY'};
       const view=await renderPrivateSettings(this.opts.store,this.opts.policy,actorId,'ps:1:h',this.clock);
       return view?{status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,view.text,undefined,view.keyboard)}:{status:'DENIED',reason:'PRIVATE_SETTINGS_UNAVAILABLE'};
      }
      if(owner&&(text==='/ownerinline'||text==='/ownerlegacy'||text===m.owner||isOwnerMenuText(text))&&!this.opts.policy.privateFeature(await this.opts.store.snapshot(),'owner.dashboard',actorId))return {status:'DENIED',reason:'OWNER_DASHBOARD_DISABLED'};
      // The runtime selects the inline owner entry; direct integrations can
      // retain legacy mode. Existing authorized tools remain reachable.
      if(text==='/ownerinline'||text===m.owner&&this.opts.ownerMenuMode==='inline'){
       if(!owner)return {status:'DENIED',reason:'OWNER_ONLY'};
       const view=ownerInlineHome();
       return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
        plan:this.plan(chatId,view.text,undefined,view.keyboard)};
      }
      if(text==='/studentinline'){
       const screen=await renderStudentInline(this.opts.store,this.opts.policy,
        actorId,'student:open');
       if(!screen)return {status:'DENIED',reason:'STUDENT_CATALOGUE_NOT_ACCESSIBLE'};
       return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
        plan:this.plan(chatId,screen.text,undefined,screen.keyboard)};
      }
      if(text==='/staffinline'){
       const screen=await renderStaffInline(this.opts.store,this.opts.policy,
        actorId,'staff:open',this.clock());
       if(!screen)return {status:'DENIED',reason:'STAFF_SCOPE_REQUIRED'};
       return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',
        plan:this.plan(chatId,screen.text,undefined,screen.keyboard)};
      }
      if(text==='/ownerlegacy'||isOwnerMenuText(text)){
        if(!owner)return {status:'DENIED',reason:'OWNER_ONLY'};
        const screen=await new OwnerTelegramMenu(
          this.opts.store,this.opts.policy,this.opts.education,this.opts.admin,
          this.opts.platformCatalog,this.clock
        ).handle(text==='/ownerlegacy'?m.owner:text,adminCtx);
        if(!screen)return {status:'DENIED',reason:'OWNER_MENU_UNAVAILABLE'};
        return result(screen.text,screen.keyboard);
      }
      // Explicit /ask is separate from /faq. This opt-in B6 preview relies
      // solely on current approved B3 FAQ text; no generation or source mixing.
      if(this.opts.answerPreflight&&(text==='/ask'||text.startsWith('/ask '))){
       const plan=await this.opts.answerPreflight.prepare({
        actor:actorId,scope:'private',question:text.slice(5),optedIn:true
       });
       if(plan.status==='NO_APPROVED_SOURCE')return result(
        '<b>المساعد التعليمي</b>\n'
        +'لم نعثر على إجابة معتمدة لهذا السؤال. لا يوجد توليد AI تلقائي.\n'
        +'يمكنك تجربة /faq أو تصفح المكتبة المنشورة.',
        backMenuKeyboard());
       if(plan.status==='AMBIGUOUS')return result(
        '<b>المساعد التعليمي</b>\n'
        +'هناك إجابات معتمدة متعارضة؛ يلزم توضيح أو مراجعة المالك.',
        backMenuKeyboard());
       if(plan.status!=='APPROVED_ANSWER')
        return {status:'DENIED',reason:'B6_'+plan.status};
       return result('<b>إجابة من مصادر منارتك المعتمدة ✅</b>\n'
        +escapeTelegramHtml(plan.answer)+'\n'
        +'هذه إجابة محفوظة وليست مولدة بالذكاء الاصطناعي.',
        backMenuKeyboard());
      }
      if(text==='/faq')return result(
       '<b>الأسئلة الشائعة المعتمدة ❓</b>\n'
       +'للحصول على إجابة من مورد تعليمي منشور ومعتمد، اكتب: '
       +'<code>/faq ما شروط المنحة؟</code>\n'
       +'هذه إجابات محفوظة يراجعها المالك؛ لا يوجد ذكاء اصطناعي توليدي.',
       backMenuKeyboard());
      if(isPrivateFAQSearchText(text)){
       if(text===privateFAQSearchLabel)return result(
        '<b>البحث في الأسئلة المعتمدة 🔎</b>\n'
        +'اكتب <code>/faqsearch منحة</code> للبحث داخل عناوين الأسئلة وصيغها البديلة المعتمدة.\n'
        +'النتائج تأتي من موارد الخاص المنشورة فقط، ولا تستخدم AI خارجيًا.',
        listingKeyboard([privateFAQBrowseLabel]));
       const command=parsePrivateFAQSearchQuery(text);
       const paging=parsePrivateFAQSearchPage(text);
       const returned=parsePrivateFAQSearchReturn(text);
       const selected=parsePrivateFAQSearchSelection(text);
       if(!command&&!paging&&!returned&&!selected)
        return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SEARCH'};
       const query=command??paging?.query??returned?.query??selected!.query;
       // The trusted service matches reviewed titles and approved aliases
       // on a single freshly authorized source snapshot. It exposes only
       // question titles and GLOBAL ordinals, never alias/admin metadata.
       const catalogue=await this.opts.faq.searchPrivateReviewedFAQs(actorId,query);
       if(catalogue.status==='DISABLED')
        return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       const hits=catalogue.items.map(({id,question,ordinal})=>({
        q:{id,question},ordinal
       }));
       const page=paging?.page??returned?.page??selected?.page??0;
       const pages=Math.ceil(hits.length/10);
       if((paging||returned||selected)&&(!pages||page>=pages||
         (paging?.direction==='next'&&page===0)||
         (paging?.direction==='previous'&&page===pages-1)))
        return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SEARCH_PAGE'};
       if(!hits.length)return result(
        '<b>البحث في الأسئلة المعتمدة 🔎</b>\n'
        +'لا توجد أسئلة معتمدة مطابقة لهذه الكلمات ضمن مكتبة الخاص الحالية.\n'
        +'يمكنك تغيير الكلمات أو تصفح القائمة المعتمدة.',
        listingKeyboard([privateFAQBrowseLabel]));
       const shown=hits.slice(page*10,page*10+10);
       if(selected){
        const exact=shown.filter(({q,ordinal})=>
         ordinal===selected.ordinal&&
         privateFAQSearchSelectionLabel(q.id,ordinal,query,page)===text);
        if(exact.length!==1)return {status:'DENIED',reason:'PRIVATE_FAQ_SEARCH_SELECTION_INVALID'};
        const answer=await this.opts.faq.answerPrivateReviewedFAQById(actorId,exact[0]!.q.id);
        if(answer.status!=='ANSWER')
         return {status:'DENIED',reason:'PRIVATE_FAQ_SEARCH_NOT_ACCESSIBLE'};
        return result('<b>إجابة معتمدة من مكتبة منارتك ✅</b>\n'
          +escapeTelegramHtml(answer.answer)+'\n'
          +'مصدرها منشور ومعتمد في مكتبة الخاص، وليس إجابة AI مولدة.',
          listingKeyboard([privateFAQSearchReturnLabel(query,page),privateFAQBrowseLabel]));
       }
       return result('<b>نتائج البحث في الأسئلة 🔎</b>\n'
        +'المطابقات: '+hits.length+'\nصفحة '+(page+1)+' من '+pages+'\n'
        +shown.map(({q,ordinal})=>ordinal+'. '+
          escapeTelegramListPreview(q.question,220)).join('\n')
        +'\nاختر رقم السؤال المطابق لفتح إجابته المعتمدة.',
        listingKeyboard(shown.map(({q,ordinal})=>
         privateFAQSearchSelectionLabel(q.id,ordinal,query,page)),{
         previous:page>0?privateFAQSearchPageLabel(query,page-1,'previous'):undefined,
         next:page+1<pages?privateFAQSearchPageLabel(query,page+1,'next'):undefined
        }));
      }
      if(text.startsWith('/faq')){
       const question=parsePrivateFAQQuery(text);
       if(!question)return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_QUERY'};
       const answer=await this.opts.faq.answerPrivateApprovedFAQ(actorId,question);
       if(answer.status==='DISABLED')return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       if(answer.status==='NO_MATCH')return result(
        '<b>الأسئلة الشائعة ❓</b>\n'
        +'لم نعثر على إجابة معتمدة لهذا السؤال ضمن موارد الخاص المنشورة.\n'
        +'جرّب صياغة أخرى أو تصفح مكتبة المنح.',
        backMenuKeyboard());
       if(answer.status==='AMBIGUOUS')return result(
        '<b>الأسئلة الشائعة ❓</b>\n'
        +'توجد أكثر من إجابة معتمدة متشابهة لهذا السؤال؛ يلزم مراجعة الإدارة.\n'
        +'لم نختر إجابة عشوائية.',
        backMenuKeyboard());
       if(answer.status!=='ANSWER')
        return {status:'DENIED',reason:'PRIVATE_FAQ_UNAVAILABLE'};
       return result('<b>إجابة من موارد منارتك المعتمدة ✅</b>\n'
        +escapeTelegramHtml(answer.answer)+'\n'
        +'هذه إجابة من سؤال شائع معتمد وليست محتوى مولّدًا بالذكاء الاصطناعي.',
        backMenuKeyboard());
      }
      if(isPrivateFAQBrowseText(text)){
       // Every page and choice is independently authorized from the current
       // library snapshot. Opaque button hashes are not grants and can only
       // resolve to exactly one currently visible reviewed private FAQ.
       const catalogue=await this.opts.faq.listPrivateReviewedFAQs(actorId);
       if(catalogue.status==='DISABLED')
        return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       const items=catalogue.items;
       const requested=parsePrivateFAQPage(text);
       const returnPage=parsePrivateFAQBrowseReturn(text);
       if(text===privateFAQBrowseLabel||requested||returnPage!==null){
        const page=requested?.page??returnPage??0;
        const pages=Math.min(1000,Math.ceil(items.length/10));
        if((requested||returnPage!==null)&&(!pages||page>=pages||
          (requested?.direction==='next'&&page===0)||
          (requested?.direction==='previous'&&page===pages-1)))
         return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_PAGE'};
        if(!pages)return result('<b>تصفح الأسئلة المعتمدة 📖</b>\n'
         +'لا توجد أسئلة معتمدة من موارد الخاص المنشورة حاليًا.\n'
         +'يمكنك البحث في المكتبة أو إرسال سؤال محدد عبر /faq.',
         backMenuKeyboard());
        const visible=items.slice(page*10,page*10+10);
        return result('<b>تصفح الأسئلة المعتمدة 📖</b>\n'
          +'عدد الأسئلة المتاحة: '+items.length+'\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +visible.map((q,i)=>(page*10+i+1)+'. '+escapeTelegramListPreview(q.question,220)).join('\n')
          +'\nاختر رقم السؤال المطابق من الأزرار لعرض الإجابة المعتمدة.',
          listingKeyboard(visible.map((q,i)=>privateFAQButton(q.id,page*10+i+1)),{
           previous:page>0?privateFAQPageLabel(page-1,'previous'):undefined,
           next:page+1<pages?privateFAQPageLabel(page+1,'next'):undefined
          }));
       }
       const token=parsePrivateFAQSelection(text);
       if(!token)return {status:'DENIED',reason:'INVALID_PRIVATE_FAQ_SELECTION'};
       const index=items.findIndex((q,i)=>privateFAQButton(q.id,i+1)===text);
       if(index<0)return {status:'DENIED',reason:'PRIVATE_FAQ_NOT_ACCESSIBLE'};
       const answer=await this.opts.faq.answerPrivateReviewedFAQById(actorId,items[index]!.id);
       if(answer.status!=='ANSWER')return {status:'DENIED',reason:'PRIVATE_FAQ_NOT_ACCESSIBLE'};
       return result('<b>إجابة معتمدة من مكتبة منارتك ✅</b>\n'
         +escapeTelegramHtml(answer.answer)+'\n'
         +'مصدرها منشور ومعتمد في مكتبة الخاص، وليس إجابة AI مولدة.',
         listingKeyboard([privateFAQBrowseReturnLabel(Math.floor(index/10)),
           privateFAQBrowseLabel]));
      }
      const sections:Readonly<Record<string,{section:string;title:string}>>={
        [m.scholarships]:{section:'scholarships',title:'المنح الدراسية'},
        [m.courses]:{section:'courses',title:'الدورات التعليمية'},
        [m.universities]:{section:'universities',title:'الجامعات والتخصصات'},
        [m.exams]:{section:'exams',title:'الاختبارات'},
        [m.files]:{section:'files',title:'ملفات ونماذج'},
        [m.library]:{section:'all',title:'التعليم والموارد'}
      };
      if(this.opts.studentMenuMode==='inline'&&sections[text]){
       const selector=studentSectionInlineData(sections[text]!.section);
       const screen=selector?await renderStudentInline(this.opts.store,this.opts.policy,actorId,selector):null;
       if(!screen)return {status:'DENIED',reason:'STUDENT_CATALOGUE_NOT_ACCESSIBLE'};
       return {status:'APPLIED',reason:'RESPONSE_PLANNED_ONLY',plan:this.plan(chatId,screen.text,undefined,screen.keyboard)};
      }
      const denyPage=():TelegramResult=>({status:'DENIED',reason:'INVALID_MENU_PAGE'});
      const sectionPage=async(section:string,title:string,page:number,
        direction?:MenuPageCommand['direction']):Promise<TelegramResult>=>{
        const categories=matchingCategories(
          await this.opts.education.listCategories(actorId,'private'),section);
        if(categories.length===0&&page===0&&!direction)return result(
          '<b>'+escapeTelegramHtml(title)+'</b>\n'
          +'لا توجد أقسام معتمدة متاحة في هذا القسم حاليًا.\n'
          +'لن نعرض فرصًا أو خدمات غير منشورة.',backMenuKeyboard());
        const pages=Math.ceil(categories.length/10);
        if(page<0||page>=pages||
          (direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const view=categories.slice(page*10,page*10+10);
        return result('<b>'+escapeTelegramHtml(title)+'</b>\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +'اختر القسم المناسب:\n'+view.map(c=>'• '+escapeTelegramListPreview(c.title,220)).join('\n'),
          listingKeyboard(view.map(categoryButton),{
            previous:page>0?menuPageButton('c',section,page-1,'previous'):undefined,
            next:page+1<pages?menuPageButton('c',section,page+1,'next'):undefined
          }));
      };
      const resourcesPage=async(catId:string,page:number,
        direction?:MenuPageCommand['direction']):Promise<TelegramResult>=>{
        const visible=await this.opts.education.listCategories(actorId,'private');
        const cat=visible.find(x=>x.id===catId);
        if(!cat)return {status:'DENIED',reason:'CATEGORY_NOT_ACCESSIBLE'};
        const resources=await this.opts.education.listResources(actorId,'private',catId);
        if(resources.length===0&&page===0&&!direction)return result(
          '<b>'+escapeTelegramHtml(cat.title)+'</b>\n'
          +'لا توجد موارد معتمدة منشورة في هذا القسم حاليًا.',
          listingKeyboard([],{},catalogBackToCategories));
        const pages=Math.ceil(resources.length/10);
        if(page<0||page>=pages||
          (direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const view=resources.slice(page*10,page*10+10);
        return result('<b>'+escapeTelegramHtml(cat.title)+'</b>\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +view.map(r=>'• '+escapeTelegramListPreview(r.title,220)).join('\n'),
          listingKeyboard(view.map(resourceButton),{
            previous:page>0?menuPageButton('r',cat.id,page-1,'previous'):undefined,
            next:page+1<pages?menuPageButton('r',cat.id,page+1,'next'):undefined
          },catalogBackToCategories));
      };
      // These are plain Telegram reply-keyboard texts, not auth grants.
      // Re-enter the existing reviewed B3 list services for every tap.
      if(text===catalogBackToCategories)
       return sectionPage('all','التعليم والموارد',0);
      const breadcrumbId=parseCatalogBackToCategory(text);
      if(breadcrumbId)return resourcesPage(breadcrumbId,0);
      if(text.startsWith('↩️ موارد القسم · '))
       return {status:'DENIED',reason:'INVALID_CATEGORY_BREADCRUMB'};
      if(Object.prototype.hasOwnProperty.call(sections,text)){
        const selection=sections[text]!;
        return sectionPage(selection.section,selection.title,0);
      }
      const searchPage=async(query:string,page:number,
        direction?:'next'|'previous'):Promise<TelegramResult>=>{
        // Keep the normal private navigation feature switch independent of AI
        // and owner controls, and re-evaluate it on every untrusted page tap.
        const state=await this.opts.store.snapshot();
        if(!this.opts.policy.privateFeature(state,'education.navigate',actorId))
          return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
        const matches=await this.opts.education.searchPublishedResources(actorId,query);
        if(matches.length===0&&page===0&&!direction)
          return result('<b>نتائج البحث 🔍</b>\n'
            +'لم نعثر على موارد منشورة ومعتمدة تطابق هذا البحث.\n'
            +'جرّب كلمات مختلفة أو تصفح أقسام المكتبة.',backMenuKeyboard());
        const pages=Math.ceil(matches.length/10);
        if(page<0||page>=pages||(direction==='next'&&page===0)||
          (direction==='previous'&&page>=pages-1))return denyPage();
        const selection=matches.slice(page*10,page*10+10);
        return result('<b>نتائج البحث 🔍</b>\n'
          +'البحث: '+escapeTelegramHtml(query)+'\n'
          +'صفحة '+(page+1)+' من '+pages+'\n'
          +selection.map(r=>'• '+escapeTelegramListPreview(r.title,220)).join('\n'),
          listingKeyboard(selection.map(r=>searchResourceButton(r,query,page)),{
            previous:page>0?searchPageButton(query,page-1,'previous'):undefined,
            next:page+1<pages?searchPageButton(query,page+1,'next'):undefined
          }));
      };
      if(text===m.search)return result('<b>البحث في الموارد 🔍</b>\n'
        +'اكتب /search ثم كلمة البحث. مثال: <code>/search Grant</code>\n'
        +'يُعرض المحتوى المنشور والمعتمد فقط؛ لا تُعرض ملفات المراجعة.',
        backMenuKeyboard());
      if(text.startsWith('/search')){
        const term=parseSearchQuery(text);
        return term?searchPage(term,0):{status:'DENIED',reason:'INVALID_SEARCH_QUERY'};
      }
      const searchRequest=parseSearchPageCommand(text);
      if(searchRequest)return searchPage(
        searchRequest.query,searchRequest.page,searchRequest.direction);
      if(text.startsWith('➡️ التالي · s:')||text.startsWith('⬅️ السابق · s:'))
        return denyPage();
      const searchBack=parseSearchResultsBreadcrumb(text);
      if(searchBack)return searchPage(searchBack.query,searchBack.page);
      if(text.startsWith('↩️ نتائج البحث · '))
       return {status:'DENIED',reason:'INVALID_SEARCH_BREADCRUMB'};
      const pageRequest=parseMenuPageCommand(text);
      if(pageRequest){
        if(pageRequest.kind==='c'){
          const chosen=Object.values(sections).find(x=>x.section===pageRequest.id);
          if(!chosen)return denyPage();
          return sectionPage(chosen.section,chosen.title,pageRequest.page,pageRequest.direction);
        }
        return resourcesPage(pageRequest.id,pageRequest.page,pageRequest.direction);
      }
      if(text.startsWith('➡️ التالي · ')||text.startsWith('⬅️ السابق · '))
        return denyPage();
      if(text===m.assistant)return result(
        '<b>المساعد التعليمي 💬</b>\n'
        +'يمكنك السؤال من قاعدة الأسئلة المعتمدة في الخاص عبر '
        +'<code>/faq ما شروط المنحة؟</code>\n'
        +'ضمن المجموعات المسموح بها: <code>/ask@'
        +escapeTelegramHtml(this.opts.botUsername)+' السؤال</code> حسب سياسة المجموعة.\n'
        +'المساعد الذكي التوليدي غير متصل؛ إجابات /faq مستندة إلى موارد منشورة.\n'
        +'اضغط «تصفح الأسئلة المعتمدة» أو «ابحث في الأسئلة» للعثور على إجابة منشورة.',
        listingKeyboard([privateFAQBrowseLabel,privateFAQSearchLabel]));
      if(text===m.communities)return result(
        '<b>المجموعات والقنوات 👥</b>\n'
        +'تُدار صلاحيات المجموعات والتحقق من العضوية ضمن أنظمة منارتك.\n'
        +'دليل عام وروابط انضمام موثقة للمجموعات لم تُنشر بعد.',
        backMenuKeyboard());
      if(text===m.help)return result(
        '<b>المساعدة والدعم 🆘</b>\n'
        +'للتصفح اختر أحد أقسام القائمة أو استخدم /categories private.\n'
        +'التواصل المباشر مع فريق الدعم ونظام التذاكر لم يُفعّلا بعد.',
        backMenuKeyboard());
      // A stateless search-result button may carry a query and page so the
      // student can return to the exact *current* search result page.
      // A forged or stale selector must be both an exact currently rendered
      // button and an item of the freshly authorized search page.
      const searchSelection=parseSearchResourceSelection(text);
      if(searchSelection){
       const now=await this.opts.store.snapshot();
       if(!this.opts.policy.privateFeature(now,'education.navigate',actorId))
        return {status:'DENIED',reason:'PRIVATE_EDUCATION_DISABLED'};
       const matches=await this.opts.education.searchPublishedResources(
        actorId,searchSelection.query);
       const page=matches.slice(searchSelection.page*10,searchSelection.page*10+10);
       const matched=page.find(r=>r.id===searchSelection.resourceId);
       if(!matched||searchResourceButton(matched,searchSelection.query,
         searchSelection.page)!==text)
        return {status:'DENIED',reason:'SEARCH_RESOURCE_NOT_ACCESSIBLE'};
       const visible=await this.opts.education.listResources(
        actorId,'private',matched.categoryId);
       const item=visible.find(r=>r.id===matched.id);
       if(!item||searchResourceButton(item,searchSelection.query,
         searchSelection.page)!==text)
        return {status:'DENIED',reason:'SEARCH_RESOURCE_NOT_ACCESSIBLE'};
       return result('<b>مورد تعليمي معتمد 📄</b>\n'
         +escapeTelegramHtml(item.title)+'\nالجامعة: '+escapeTelegramHtml(item.university)
         +'\nالدورة: '+escapeTelegramHtml(item.cycle)+'\nالدرجة: '
         +escapeTelegramHtml(item.degree),
         listingKeyboard([
          searchResultsBreadcrumb(searchSelection.query,searchSelection.page),
          catalogBackToCategory(item.categoryId),catalogBackToCategories
         ]));
      }
      const categoryId=categoryButtonId(text);
      if(!categoryId&&text.startsWith('📁 '))
        return {status:'DENIED',reason:'INVALID_MENU_SELECTION'};
      if(categoryId){
        const visible=await this.opts.education.listCategories(actorId,'private');
        const cat=visible.find(x=>x.id===categoryId);
        if(!cat||categoryButton(cat)!==text)return {status:'DENIED',reason:'CATEGORY_NOT_ACCESSIBLE'};
        return resourcesPage(categoryId,0);
      }
      const resourceId=resourceButtonId(text);
      if(!resourceId&&text.startsWith('🔎 '))
        return {status:'DENIED',reason:'INVALID_MENU_SELECTION'};
      if(resourceId){
        const snapshot=await this.opts.store.snapshot();
        const candidate=snapshot.educationResources.find(x=>x.id===resourceId&&x.scope==='private');
        if(!candidate)return {status:'DENIED',reason:'RESOURCE_NOT_ACCESSIBLE'};
        const visible=await this.opts.education.listResources(actorId,'private',candidate.categoryId);
        const found=visible.find(x=>x.id===resourceId);
        if(!found||resourceButton(found)!==text)return {status:'DENIED',reason:'RESOURCE_NOT_ACCESSIBLE'};
        return result('<b>مورد تعليمي معتمد 📄</b>\n'
          +escapeTelegramHtml(found.title)+'\nالجامعة: '+escapeTelegramHtml(found.university)
          +'\nالدورة: '+escapeTelegramHtml(found.cycle)+'\nالدرجة: '
          +escapeTelegramHtml(found.degree),
          listingKeyboard([
           catalogBackToCategory(found.categoryId),catalogBackToCategories
          ]));
      }
    }
    if(cmd==='/admin'&&kind==='private'){
      const scope=words[1];if(!scope||!isScope(scope))return {status:'DENIED',reason:'INVALID_SCOPE'};
      const p=await this.opts.admin.panel(adminCtx,scope);
      return result(`<b>لوحة منارتك (${escapeTelegramHtml(scope)})</b>\nرفع: ${p.canUpload?'مسموح':'غير متاح'}\nمراجعة ونشر محلي: ${p.canPublish?'مسموح':'غير متاح'}`);
    }
    if(cmd==='/import'&&kind==='private'){
      const match=/^\/import (private|-[1-9]\d*) (csv|json|txt|md) ([a-zA-Z0-9._-]{1,90})\n([\s\S]+)$/u.exec(text);
      if(!match)return {status:'DENIED',reason:'INVALID_IMPORT_COMMAND'};
      const scope=match[1]!,format=match[2]! as ImportFormat,filename=match[3]!,body=match[4]!;
      const run=await this.opts.admin.upload(adminCtx,scope,format,filename,body);
      return result(`<b>تقرير استيراد تجريبي</b>\nالمعرف: <code>${escapeTelegramHtml(run.id)}</code>\nالأقسام: ${run.report.sections}\nالجامعات: ${run.report.universities}\nفرص مرشحة: ${run.report.opportunities}\nيتطلب المراجعة قبل الاعتماد والنشر المحلي.`);
    }
    if((cmd==='/approve'||cmd==='/publish')&&kind==='private'){
      if(words.length!==4||!isId(words[1]??'')||asNumber(words[2]??'')===null||!isId(words[3]??''))return {status:'DENIED',reason:'INVALID_REVIEW_COMMAND'};
      const importId=words[1]!,index=asNumber(words[2]!)!,categoryId=words[3]!;
      if(cmd==='/approve'){
        await this.opts.admin.approve(adminCtx,importId,index,categoryId);
        return result('تم اعتماد سجل المحتوى محليًا. لم يُنشر بعد.');
      }
      const resource=await this.opts.admin.publish(adminCtx,importId,index,categoryId);
      return result(`تم نشر المورد داخل المكتبة المحلية فقط: ${escapeTelegramHtml(resource.title)}\nلا إرسال إلى قناة Telegram.`);
    }
    if(cmd==='/categories'){
      if(kind==='group')return this.groupLibrary(event);
      const scope=kind==='private'?(words[1]??'private'):chatId;
      if(!isScope(scope))return {status:'DENIED',reason:'INVALID_SCOPE'};
      if(kind==='private') {
        await markPrivateGroupSource(scope);
        const denied=await this.authorizePrivateGroupBrowse(scope,actorId);
        if(denied)return {status:'DENIED',reason:denied};
      }
      const categories=await this.opts.education.listCategories(actorId,scope);
      if(!categories.length)return {status:'DENIED',reason:'NO_ACCESSIBLE_CATEGORIES'};
      return result('<b>التعليم والموارد</b>\n'+categories.slice(0,12).map(c=>`• ${escapeTelegramListPreview(c.title,220)} (<code>${escapeTelegramHtml(c.id)}</code>)`).join('\n'));
    }
    if(cmd==='/resources'){
      const scope=kind==='private'?(words[1]??''):chatId,cat=kind==='private'?words[2]:words[1];
      if(!isScope(scope)||!cat||!isId(cat))return {status:'DENIED',reason:'INVALID_RESOURCE_QUERY'};
      if(kind==='group')return this.groupLibrary(event,cat);
      if(kind==='private') {
        await markPrivateGroupSource(scope);
        const denied=await this.authorizePrivateGroupBrowse(scope,actorId);
        if(denied)return {status:'DENIED',reason:denied};
      }
      const resources=await this.opts.education.listResources(actorId,scope,cat);
      if(!resources.length)return {status:'DENIED',reason:'NO_ACCESSIBLE_RESOURCES'};
      return result('<b>الموارد المنشورة</b>\n'+resources.slice(0,12).map(r=>`• ${escapeTelegramListPreview(r.title,180)}${r.university?` — ${escapeTelegramListPreview(r.university,80)}`:''}`).join('\n'));
    }
    if(cmd==='/resource'&&kind==='private'){
      if(words.length!==2)return {status:'DENIED',reason:'INVALID_RESOURCE_REF'};
      const link=(await this.opts.store.snapshot()).resourceLinks.find(x=>x.ref===words[1]!);
      if(link)await markPrivateGroupSource(link.scope);
      const subscription=this.opts.subscription;
      const opened=await this.opts.links.resolve(words[1]!,actorId,this.opts.membership,
        subscription?async (scope,user)=>(await subscription.verify(scope,user)).status:undefined);
      if(opened.status!=='FOUND')return {status:'DENIED',reason:'RESOURCE_DENIED'};
      return result(`<b>مورد تعليمي</b>\n${escapeTelegramHtml(opened.resource.title)}\n${escapeTelegramHtml(opened.resource.university)}`);
    }
    if(kind==='group'&&groupQuestion!==null){
      let question=groupQuestion;
      // Owner's explicit reply-to invocation is NOT an arbitrary AI prompt:
      // the sole question source is the direct reply_to_message in this update.
      // Never attempt to fetch earlier Telegram conversation history.
      if(question==='أجب عن هذا السؤال'){
       if(!this.opts.policy.isOwner(actorId))
        return {status:'DENIED',reason:'OWNER_ONLY'};
       const target=parseB6OwnerReplyTarget(event.replyTo,chatId,event.messageId,actorId);
       if(target.status==='MISSING_REPLY')
        return result('يرجى استخدام المنشن بالرد على رسالة السؤال نفسها، أو أعد إرفاق السؤال.');
       if(target.status!=='QUESTION')
        return {status:'DENIED',reason:'INVALID_REPLY_TARGET'};
       question=target.question;
      }
      if(this.opts.answerPreflight){
       const plan=await this.opts.answerPreflight.prepare({
        actor:actorId,scope:chatId,question,explicitMention:true
       });
       if(plan.status!=='APPROVED_ANSWER')
        return {status:'DENIED',reason:'B6_'+plan.status};
       const fence=await this.finalGroupAnswerGate(chatId,actorId,groupAnswerSubscriptionEpochValue);
       if(fence)return {status:'DENIED',reason:fence};
       return result('<b>إجابة من موارد منارتك المعتمدة</b>\n'
        +escapeTelegramHtml(plan.answer)+'\n'
        +'جواب محفوظ ومعتمد، لا AI توليدي.',undefined,groupAnswerAccess());
      }
      const ans=await this.opts.faq.answerGroup(actorId,chatId,question,true);
      if(ans.status!=='ANSWER')return {status:'DENIED',reason:`FAQ_${ans.status}`};
      const fence=await this.finalGroupAnswerGate(chatId,actorId,groupAnswerSubscriptionEpochValue);
      if(fence)return {status:'DENIED',reason:fence};
      return result(`<b>إجابة من موارد منارتك المعتمدة</b>\n${escapeTelegramHtml(ans.answer)}`,undefined,groupAnswerAccess());
    }
    // Only the explicit injected reply-moderation handler above can execute
    // group admin commands; all other group admin text remains unsupported.
    return {status:'IGNORED',reason:'UNSUPPORTED_COMMAND'};
  }
  async handle(payload:unknown):Promise<TelegramResult> {
    const parsed=eventFrom(payload);
    if(!parsed.event)return {status:parsed.reason==='UNSUPPORTED_EVENT'?'IGNORED':'DENIED',reason:parsed.reason};
    const event=parsed.event;
    const key=`b3-webhook:${this.opts.botId}:${event.updateId}`;
    const claim=await this.opts.store.claim(key,this.clock());
    if(claim!=='CLAIMED'){
     const duplicate={status:claim==='UNKNOWN'?'UNKNOWN' as const:'DUPLICATE' as const,
      reason:'REPLAY_OR_UNRESOLVED'};
     // Telegram retries or duplicated updates still need an ephemeral ACK;
     // this NEVER re-runs the operation or re-sends the durable reply.
     return event.callbackQueryId?{...duplicate,callbackQueryId:event.callbackQueryId}:duplicate;
    }
    const publicText=event.kind==='private'&&event.callbackData?.startsWith('pn:1:')?await readPublicNavigation(this.opts.store,event.actorId,event.callbackData,publicMenuText,this.clock):null;
    const effectiveText=publicText??event.text;
    const staffInput=event.kind==='private'&&(event.callbackData?.startsWith('ms:1:')||event.text==='/staffinline');
    const beforeStaff=staffInput?protectionUISourceEpoch(await this.opts.store.snapshot(),this.opts.policy,event.actorId,this.clock()):null;
    const libraryInput=event.kind==='private'&&(
     event.callbackData?.startsWith('si:1:')||event.callbackData?.startsWith('si:2:')||event.text==='/studentinline'||
     this.opts.studentMenuMode==='inline'&&(([menuLabels.scholarships,menuLabels.courses,menuLabels.universities,menuLabels.exams,menuLabels.files,menuLabels.library] as string[]).includes(effectiveText)||effectiveText===catalogBackToCategories||isPrivateFAQBrowseText(effectiveText)||isPrivateFAQSearchText(effectiveText)||effectiveText.startsWith('/search')||Boolean(parseSearchResourceSelection(effectiveText)||parseSearchPageCommand(effectiveText)||parseSearchResultsBreadcrumb(effectiveText)||categoryButtonId(effectiveText)||resourceButtonId(effectiveText)||parseMenuPageCommand(effectiveText)||parseCatalogBackToCategory(effectiveText))));
    const beforeLibrary=libraryInput?privateLibraryEpoch(await this.opts.store.snapshot(),this.opts.policy,event.actorId):null;
    const studioInput=event.kind==='private'&&this.opts.policy.isOwner(event.actorId)&&/^(?:st:1:[vtNAKzWQ]:|st:1:e:08:)/u.test(event.callbackData??'');
    const beforeStudio=studioInput?studioPreviewSourceEpoch(await this.opts.store.snapshot()):null;
    let handled:ProcessedReply;
    try{handled=await this.process(event);}catch(err){handled={status:'DENIED',reason:safeError(err)};}
    // Migrated root screens must retain the page of the official entry.
    // This changes navigation only, after normal service authorization.
    const catalogueBack=event.kind==='private'&&this.opts.policy.isOwner(event.actorId)?ownerInlineReturnRoute(event.callbackData??'')??studioCatalogueReturn(event.callbackData??''):null;
    if(catalogueBack&&handled.plan){
     const prefix=catalogueBack.slice(0,-1);
     const inline=handled.plan.inlineMarkup,native=handled.plan.studioMarkup,rows=(inline??native)?.inline_keyboard;
     if(rows){
      const mapped=rows.map(row=>row.map(b=>'callback_data' in b&&b.callback_data.startsWith(prefix)?{...b,callback_data:catalogueBack}:b));
      if(!mapped.flat().some(b=>'callback_data' in b&&b.callback_data===catalogueBack))mapped.push([{text:'↩️ رجوع للقسم',callback_data:catalogueBack}]);
      handled={...handled,plan:{...handled.plan,...(inline?{inlineMarkup:{inline_keyboard:mapped as TelegramInlineKeyboard['inline_keyboard']}}:{studioMarkup:{inline_keyboard:mapped}})}};
     }
    }
    if(event.kind==='private'&&this.opts.studentMenuMode==='inline'&&handled.plan){
     if(handled.plan.replyMarkup){
      const markup=await publicNavigationMarkup(this.opts.store,event.actorId,handled.plan.replyMarkup,menuLabels.owner,publicMenuText,this.clock);
      if(markup){const {replyMarkup:_,...plan}=handled.plan;handled={...handled,plan:{...plan,inlineMarkup:markup}};}
     }
     const mainEntry=['/start','/help',menuLabels.home,menuLabels.back].includes(effectiveText);
     if(mainEntry&&handled.plan?.inlineMarkup){const state=await this.opts.store.snapshot();if(this.opts.policy.privateFeature(state,'education.navigate',event.actorId)&&publicFolderGroups(state,this.opts.policy).length)handled={...handled,plan:{...handled.plan,inlineMarkup:{inline_keyboard:[...handled.plan.inlineMarkup.inline_keyboard,[{text:'📁 مجلدات المجتمع',callback_data:'fj:1:h'}]]}}};}
     if(mainEntry&&handled.plan?.inlineMarkup&&await renderStaffInline(this.opts.store,this.opts.policy,event.actorId,'staff:open',this.clock()))handled={...handled,plan:{...handled.plan,inlineMarkup:{inline_keyboard:[...handled.plan.inlineMarkup.inline_keyboard,[{text:'🛡️ لوحة المشرف',callback_data:'ms:1:h'}]]}}};
     if(handled.plan?.inlineMarkup&&(libraryInput||staffInput||event.callbackData?.startsWith('pn:1:'))){
      const isHome=['/start','/help',menuLabels.home,menuLabels.back].includes(effectiveText),rows=handled.plan.inlineMarkup.inline_keyboard;
      handled={...handled,plan:{...handled.plan,inlineMarkup:{inline_keyboard:[...rows,...(!isHome&&!rows.flat().some(b=>b.callback_data==='pn:1:h')?[[{text:menuLabels.home,callback_data:'pn:1:h'}]]:[])]},...(event.callbackMessageId!==undefined?{editMessageId:event.callbackMessageId}:{})}};
     }
    }
    if(event.kind==='private'&&event.callbackData&&!event.callbackData.startsWith('pr:1:')&&
     !/^mi:1:i:02:(?:0[5678]|12)$/u.test(event.callbackData)&&handled.plan){
     await new TelegramProtectionEditor(this.opts.store,this.opts.policy,this.clock).cancelNavigation(event.actorId);
    }
    if(handled.plan&&!handled.plan.chatId.startsWith('-')&&handled.plan.inlineMarkup?.inline_keyboard.flat().some(b=>b.callback_data.startsWith('pr:1:'))){
     const proof=await new TelegramProtectionEditor(this.opts.store,this.opts.policy,this.clock).witness(event.actorId,handled.plan.inlineMarkup);
     if(proof)handled={...handled,adminUIAccess:proof};
     else{const {plan:_,...withoutPlan}=handled;handled={...withoutPlan,reason:'PROTECTION_RESPONSE_WITHHELD'};}
    }
    const callback=event.callbackData??'';
    const ownerScreen=event.kind==='private'&&this.opts.policy.isOwner(event.actorId)&&(
     /^(?:p4c:1:|mi:1:|oi:1:|ou:1:|sc:1:|cf:1:|ec:1:|oc:1:|od:1:|gw:1:|gt:1:|gs:1:|gb:1:|nw:1:|gp:1:|of:1:|ol:1:|st:1:|ps:1:|pr:1:|pd:1:|pq:1:|mr:1:|mp:1:|c_)/u.test(callback)||
     event.text==='/ownerinline'||event.text==='/ownerlegacy'||event.text==='/ownerrecover'||Boolean(parsePhase4CommunityCommand(event.text))||isOwnerMenuText(event.text)||(event.document!==undefined&&handled.plan?.inlineMarkup!==undefined)||
     handled.reason==='CATEGORY_TEXT_PREVIEW'||handled.reason==='NETWORK_TEXT_PREVIEW'||handled.reason==='DELEGATION_TEXT_PREVIEW'||handled.reason==='STUDIO_DRAFT_SAVED');
    if(ownerScreen&&handled.plan&&!handled.adminUIAccess){
     const state=await this.opts.store.snapshot(),now=this.clock(),epoch=studioInput?studioPreviewEpoch(state,this.opts.policy,event.actorId,now):protectionUIEpoch(state,this.opts.policy,event.actorId,now);
     const recovery=!this.opts.policy.privateFeature(state,'owner.dashboard',event.actorId)&&
      (callback.startsWith('ps:1:')||event.text==='/ownerrecover')&&
      (handled.plan.text.startsWith('<b>استعادة لوحة المالك</b>')||handled.plan.text.startsWith('<b>معاينة إعداد الخاص</b>'));
     if(epoch&&(!studioInput||studioPreviewSourceEpoch(state)===beforeStudio)&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-ADMIN_UI_TTL_MS)handled={...handled,adminUIAccess:{actorId:event.actorId,epoch,expiresAt:now+ADMIN_UI_TTL_MS}};
     else if(!recovery){const {plan:_,...withoutPlan}=handled;handled={...withoutPlan,reason:'OWNER_RESPONSE_WITHHELD'};}
    }
    if(staffInput&&handled.plan){
     const state=await this.opts.store.snapshot(),now=this.clock(),epoch=protectionUIEpoch(state,this.opts.policy,event.actorId,now);
     if(epoch&&beforeStaff!==null&&protectionUISourceEpoch(state,this.opts.policy,event.actorId,now)===beforeStaff&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-ADMIN_UI_TTL_MS)handled={...handled,adminUIAccess:{actorId:event.actorId,epoch,expiresAt:now+ADMIN_UI_TTL_MS}};
     else{const {plan:_,adminUIAccess:__,...withoutPlan}=handled;handled={...withoutPlan,reason:'STAFF_RESPONSE_WITHHELD'};}
    }
    if(libraryInput&&handled.plan){
     const state=await this.opts.store.snapshot(),now=this.clock(),epoch=privateLibraryEpoch(state,this.opts.policy,event.actorId);
     if(epoch&&epoch===beforeLibrary&&Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000-ADMIN_UI_TTL_MS)
      handled={...handled,privateLibraryAccess:{actorId:event.actorId,epoch,expiresAt:now+ADMIN_UI_TTL_MS}};
     else{const {plan:_,...withoutPlan}=handled;handled={...withoutPlan,reason:'LIBRARY_RESPONSE_WITHHELD'};}
    }
    const audit:AuditRecord={updateKey:key,decision:handled.status==='APPLIED'?'ALLOW':handled.status==='DENIED'?'DENY':'NOOP',reason:handled.reason,policyVersion:0,at:this.clock()};
    // Commit the decision and outbound reply intent in one durable transaction.
    // No external call occurs before the outbox row exists.
    await this.opts.store.finish(key,audit,handled.plan,handled.groupQuestionAccess,
     handled.groupMenuAccess,handled.privateGroupAccess,handled.adminUIAccess,handled.privateLibraryAccess,studioInput&&!!handled.adminUIAccess,handled.communityAccess,handled.communityClose,handled.communityAutomation);
    // Temporary actor IDs are only stored in the guarded queue, never returned.
    const {groupQuestionAccess:_,groupMenuAccess:__,privateGroupAccess:___,adminUIAccess:____,privateLibraryAccess:_____,communityAccess:______,communityClose:_______,communityAutomation:________,...publicResult}=handled;
    const visible=publicResult.plan?{...publicResult,deliveryKey:key}:publicResult;
    return event.callbackQueryId?{...visible,callbackQueryId:event.callbackQueryId}:visible;
  }
}

const SECRET_HEADER='x-telegram-bot-api-secret-token';
const MAX_BODY=64*1024;
function secretValid(req:IncomingMessage, secret:string):boolean {
  const headerCount=req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===SECRET_HEADER).length;
  const received=req.headers[SECRET_HEADER];
  if(headerCount!==1||typeof received!=='string')return false;
  const a=Buffer.from(received,'utf8'),b=Buffer.from(secret,'utf8');
  return a.length===b.length&&timingSafeEqual(a,b);
}
function respond(res:ServerResponse,status:number,body:Record<string,unknown>):void {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
}
/** Verifies Telegram's shared webhook secret and HTTP boundaries. Does not send any outbound messages. */
export function telegramWebhookListener(app:TelegramUpdateApplication,secretToken:string,
 outbound?:TelegramReplyDispatcher,ingressOptions:IngressOptions={},
 safetyGate?:()=>Promise<boolean>,
 callbackAcker?:{answer(callbackQueryId:string,outcome?:TelegramResult['status']):Promise<void>}):RequestListener {
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(secretToken))throw Error('INVALID_WEBHOOK_SECRET');
  const guard=new BoundedIngress(ingressOptions);
  return (req,res)=>{
    void (async()=>{
      if(req.method!=='POST'){respond(res,405,{ok:false});return;}
      if(req.url!=='/telegram/webhook'){respond(res,404,{ok:false});return;}
      if(!secretValid(req,secretToken)){respond(res,401,{ok:false});return;}
      const release=guard.enter(req);
      if(!release){respond(res,503,{ok:false});return;}
      try{
      // No new durable update may be claimed while emergency STOP is active.
      // A missing/corrupt safety flag is also STOP. Never trust a request body
      // to supply or override this operator-controlled decision.
      if(safetyGate){
       let allowed=false;
       try{allowed=await safetyGate();}catch{/* fail closed */}
       if(!allowed){respond(res,503,{ok:false});return;}
      }
      if(req.headers['content-encoding']!==undefined){respond(res,415,{ok:false});return;}
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){respond(res,415,{ok:false});return;}
      const declared=req.headers['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY)){respond(res,413,{ok:false});return;}
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=(chunk as Buffer).length;if(length>MAX_BODY){respond(res,413,{ok:false});return;}chunks.push(chunk as Buffer);}
      let payload:unknown;
      try{payload=decodeStrictJsonBytes(chunks);}catch{respond(res,400,{ok:false});return;}
      const result=await app.handle(payload);
      // Live delivery is explicitly opt-in via a separate injected dispatcher.
      // Ambiguous outcomes remain blocked in the durable outbox: never retry
      // automatically, even if Telegram repeats the inbound webhook request.
      // Acknowledge both authorized and denied well-formed callback queries.
      // This is a bounded ephemeral Bot API operation, never a state change
      // or proof of message delivery. Failure does not replay a queued send.
      if(callbackAcker&&result.callbackQueryId)
       await callbackAcker.answer(result.callbackQueryId,result.status);
      if(outbound&&result.plan&&result.deliveryKey)await outbound.dispatch(result.deliveryKey);
      // Keep the reply body minimal: no user text, provider errors or Bot API secret.
      respond(res,result.status==='DENIED'&&result.reason==='INVALID_UPDATE_ID'?422:200,{ok:true,status:result.status});
      }finally{release();}
    })().catch(()=>{if(!res.headersSent)respond(res,503,{ok:false});else res.end();});
  };
}
