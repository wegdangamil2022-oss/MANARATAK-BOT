import { mkdir, open, readFile, rename, rm, stat, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, isAbsolute } from 'node:path';

export type Capability = 'ai.ask' | 'ai.settings.manage' | 'content.publish' | 'content.upload' | 'chat.manage' | 'education.navigate' | 'owner.dashboard' | 'subscription.verify' | 'support.use';
export type GroupAIMode = 'OFF' | 'OWNER_MENTION' | 'STAFF_MENTION' | 'ALL_MENTION';
export type PrivateAIMode = 'OFF' | 'STAFF_ONLY' | 'ALL_OPT_IN';
export type OperationStatus = 'INTENT' | 'STARTED' | 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'CANCELLED';
export interface Chat { id: string; approved: boolean; present: boolean; scopes: string[]; version: number; groupAI: GroupAIMode; }
export interface Grant { actor: string; capability: Capability; chatId: string; expiresAt: number; grantedBy: string; revoked: boolean; }
export interface CallbackRecord { ref: string; action: string; chatId: string; actorId?: string; policyVersion: number; requirementVersion?: number; moderationOperationId?:string; moderationOperationDigest?:string; expiresAt: number; oneShot: boolean; used: boolean; revoked: boolean; }
export interface Wizard { key: string; userId: string; chatId: string; topicId: string; flow: string; step: number; version: number; expiresAt: number; policyVersion: number; status: 'ACTIVE' | 'CANCELLED'; }
export interface ProcessedUpdate { key: string; status: 'CLAIMED' | 'DONE' | 'UNKNOWN'; leaseUntil: number; }
export interface Operation { id: string; updateKey: string; kind: 'CHAT_LEAVE'; chatId: string; policyVersion: number; status: OperationStatus; startedAt?: number; }
export interface AuditRecord { actorId?: string; updateKey: string; decision: 'ALLOW' | 'DENY' | 'NOOP'; reason: string; policyVersion: number; at: number; }
import type { Candidate, ImportFormat, ImportReport } from './ingestion.js';
export interface EducationCategory { id: string; scope: string; parentId: string | null; title: string; order: number; enabled: boolean; /** Monotonic optional revision for preexisting saved categories. */ revision?: number; }
export interface EducationResource { id: string; categoryId: string; scope: string; title: string; university: string; cycle: string; degree: string; seats: number | null; sourceImportId: string; sourceLocator: string; reviewedBy: string; status: 'PUBLISHED' | 'ARCHIVED'; publicationText?: string; publicationTextReviewedBy?: string; }
export interface ImportRun { id: string; scope: string; uploadedBy: string; origin: 'TELEGRAM_ADMIN' | 'ADMIN_WEB'; format: ImportFormat; filename: string; digest: string; report: ImportReport; candidates: Candidate[]; createdAt: number; }
export type RestrictionKind = 'NONE' | 'MUTE' | 'BAN';
/** Local adapter classification, not proof of remote sanction authorship. */
export type ModerationDispatchGateway='SIMULATION'|'TELEGRAM_API'|'UNSPECIFIED';
export interface ModerationReason { chatId: string; memberId: string; source: 'MANUAL' | 'SUBSCRIPTION'; reference: string; kind: 'MUTE' | 'BAN'; createdBy: string; active: boolean; }
export interface ModerationOperation { id: string; chatId: string; memberId: string; actorId: string; kind: RestrictionKind; reasonFingerprint: string; policyVersion: number; status: OperationStatus; createdAt: number; /** Gateway used when the attempt entered STARTED. Absent on legacy/undispatched rows. */ attemptGateway?:ModerationDispatchGateway; /** Owner triage never alters status or authorizes retry. */ review?:{decision:'ACKNOWLEDGED_UNRESOLVED'|'ESCALATED';reviewedBy:string;reviewedAt:number;/** Approval epoch at review time; optional for legacy records. */policyVersion?:number}; }
export interface Warning { chatId: string; memberId: string; reference: string; actorId: string; at: number; active: boolean; }
export interface SubscriptionRequirement { chatId: string; channelIds: string[]; mode: 'ALL' | 'ANY'; version: number; }
export interface FAQEntry { id: string; scope: string; question: string; aliases: string[]; answer: string; sourceResourceId: string; createdBy: string; approvedBy?: string; status: 'DRAFT' | 'APPROVED' | 'ARCHIVED'; createdAt: number; }
export interface ResourceLink { ref: string; scope: string; resourceId: string; resourceRevision: number; policyVersion: number; expiresAt: number; boundUserId?: string; issuedBy: string; revoked: boolean; }
/** B4 uses snapshots of reviewed content; never treat an item ID as proof of its current revision. */
export interface PublicationPreview { resourceId: string; revision: string; text: string; renderPlan?: import('./publication-preview-plan.js').PublicationRenderPlan; }
export type CampaignStatus = 'DRAFT' | 'APPROVED' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';
export interface PublicationCampaign {
  id: string; sourceScope: string; destination: string; createdBy: string; approvedBy?: string;
  status: CampaignStatus; scheduledAt: number; createdAt: number; sourcePolicyVersion: number; destinationPolicyVersion: number;
  previews: PublicationPreview[];
}
export type DeliveryStatus = 'QUEUED' | 'MULTIPART' | 'SENDING' | 'SENT' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'CANCELLED' | 'SKIPPED';
export interface PublicationDelivery {
  id: string; campaignId: string; resourceId: string; destination: string; revision: string;
  status: DeliveryStatus; attemptId?: string; startedAt?: number; leaseUntil?: number; messageId?: string;
  reviewReason?: string;
  /** B4 offline-only part-level receipts; populated only by CampaignMultipartService. */
  multipart?: {
    fingerprint: string;
    parts: { index: number; payload: import('./publication-preview-plan.js').PublicationRenderPart;
      status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'CANCELLED';
      attemptId?: string; leaseUntil?: number; messageId?: string; }[];
  };
}
/** Historical evidence is an item-specific publication guard, not an outbound delivery or a second sender. */
export interface HistoricalPublicationRecord {
  id: string; sourceScope: string; destination: string; resourceId: string; revision: string;
  status: import('./legacy-publication-migration.js').LegacyReviewStatus;
  diagnostic: string; reviewedBy: string; reviewedAt: number;
  proof?: {evidenceId:string;messageId:string;source:'TRUSTED_RECEIPT'|'FORWARDED_POST'};
  skip?: {actor:string;reason:string};
}
/** B2-Advanced privacy-limited metadata from already observed updates only. No text or media payloads. */
export interface RollingMessageMeta {
  chatId:string; messageId:number; senderKind:'USER'|'CHANNEL'|'UNKNOWN'; senderId?:string;
  sentAt:number; observedAt:number; contentType:'TEXT'|'MEDIA'|'COMMAND'|'OTHER'; hasLinks:boolean;
  pinned:boolean; linkedChannel:boolean; adminLog:boolean; approvedAnnouncement:boolean;
}
export interface PurgeFilter {
  limit:number; beforeMessageId?:number; senderId?:string; linksOnly?:boolean; mediaOnly?:boolean; commandsOnly?:boolean;
}
export type PurgeItemStatus='QUEUED'|'SENDING'|'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'SKIPPED_UNVERIFIED'|'CANCELLED';
export interface PurgeItem {
  messageId:number; metaDigest:string; status:PurgeItemStatus;
  attemptId?:string; startedAt?:number; leaseUntil?:number;
  reconciliation?:{evidenceId?:string;evidenceDigest?:string;reviewedBy:string;at:number;reason?:string;
     verifiedOutcome?:'ACKNOWLEDGED'|'FAILED_CONFIRMED'|'SKIPPED_UNVERIFIED'};
}
/** Separate explicit review required before any mock delete request. */
export interface PurgeJob {
  id:string; chatId:string; actorId:string; scopeVersion:number; createdAt:number; expiresAt:number;
  filter:PurgeFilter; excluded:{protected:number;expired:number};
  status:'PREVIEW'|'READY'|'PAUSED'|'CANCELLED'|'COMPLETED';
  confirmedBy?:string; confirmedAt?:number; rateLimitedUntil?:number; items:PurgeItem[];
}
/** Durable Telegram text reply intent; no automatic retry after unknown sends. */
export interface TelegramReplyJob {
 updateKey:string;plan?:{chatId:string;parseMode:'HTML';text:string;
  replyMarkup?:import('./telegram-menu.js').TelegramReplyKeyboard;
  inlineMarkup?:import('./telegram-inline-owner.js').TelegramInlineKeyboard;
  editMessageId?:number};
 status:'QUEUED'|'SENDING'|'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
 attemptId?:string;startedAt?:number;messageId?:number;
 queuedAt?:number;redactedAt?:number;
 /** Added in B6 v0.7.52: new group jobs must declare their reviewed
  * origin. Missing discriminator on a group QUEUED row indicates an older
  * upgrade-ambiguous job; it must not bypass B6 membership guards.
  */
 groupReplyKind?:'GENERAL'|'REVIEWED_FAQ';
 /** Queued B6 group FAQ only. Brief private membership recheck metadata, removed at dispatch. */
 groupQuestionAccess?:{actorId:string;epoch:string;expiresAt:number};
 /** For new GENERAL group replies; removed at dispatch. Missing on old GENERAL
  * jobs is valid for storage but MUST deny any attempted send.
  */
 groupMenuAccess?:{actorId:string;epoch:string;expiresAt:number};
 /** Temporary source scope + actor used to recheck DM group browsing at send. */
 privateGroupAccess?:{actorId:string;scope:string;epoch:string;expiresAt:number};
 /** New private replies declare origin; pre-v0.7.56 private QUEUED rows
  * without either this or privateGroupAccess are quarantine-only on dispatch.
  */
 privateReplyKind?:'LOCAL'|'GROUP_SCOPED';
 /** Explicit bounded classification of a locally denied QUEUED send.
  * No actor ID, chat ID, text, evidence key or provider description.
  * Historical FAILED_CONFIRMED and network-provider failures remain untagged.
  */
 accessDenialCode?:'LEGACY_UNVERIFIABLE'|'ACCESS_RECHECK_FAILED'|'GROUP_UNAVAILABLE';
 /** Immutable operator acknowledgement; it NEVER proves delivery or permits retry. */
 manualReview?:{decision:'ACKNOWLEDGED_UNRESOLVED'|'ESCALATED';
  reviewedBy:string;reviewedAt:number;attemptId:string};
}
/** Explicit owner-enabled retention REVIEW cadence. Tick only stores a preview, never redacts or deletes. */
export interface PurgeRetentionReviewControl {
 enabled:boolean; cadenceMs:number; version:number; nextCheckAt:number;
 lastCheckedAt?:number; lastNotice?:import('./moderation-purge.js').PurgeRetentionPreview;
}
/** Owner-reviewed external metadata remains quarantined and never acts as a B3 import/publish grant. */
export interface PlatformReviewQueueEntry{
 sourceId:string;sourceRevision:number;title:string;university:string;cycle:string;degree:string;
 digest:string;status:'UNVERIFIED_EXTERNAL'|'REVIEWED_METADATA_ONLY'|'APPROVED_FOR_LOCAL'|'PUBLISHED_LOCALLY';
 stagedBy:string;stagedAt:number;reviewedBy?:string;reviewedAt?:number;
 /** A separate owner decision, never inferred from external PUBLISHED state. */
 approvedBy?:string;approvedAt?:number;approvedCategoryId?:string;
 /** Exactly one local resource, not an outbound Telegram publication receipt. */
 publishedResourceId?:string;
 /** Source page from which the owner reviewed this entry, never authorization. */
 pageCursor?:string;
}
/** B6 opaque conservative attempt reservation, with NO student prompt/user ID, generated text or provider secret. */
export interface B6BudgetAttempt {
  requestKey:string;attemptId:string;day:string;reservedTokens:number;
  reservedAt:number;leaseUntil:number;
  status:'RESERVED'|'COMPLETED'|'UNKNOWN_OUTCOME';
  /** Owner acknowledgement is historical annotation only; it NEVER changes cost or allows retry. */
  operatorReview?:{reviewedBy:string;reviewedAt:number};
}
export interface BotState {
  schemaVersion: 8;
  chats: Chat[];
  grants: Grant[];
  privateAI: PrivateAIMode;
  privateFeatures: Record<string, boolean>;
  updates: ProcessedUpdate[];
  operations: Operation[];
  callbacks: CallbackRecord[];
  wizards: Wizard[];
  audit: AuditRecord[];
  moderationReasons: ModerationReason[];
  moderationOperations: ModerationOperation[];
  subscriptionRequirements: SubscriptionRequirement[];
  warnings: Warning[];
  educationCategories: EducationCategory[];
  educationResources: EducationResource[];
  importRuns: ImportRun[];
  faqEntries: FAQEntry[];
  resourceLinks: ResourceLink[];
  campaigns: PublicationCampaign[];
  deliveries: PublicationDelivery[];
  historicalPublications: HistoricalPublicationRecord[];
  rollingMessageMeta: RollingMessageMeta[];
  purgeJobs: PurgeJob[];
  purgeRetentionReview?: PurgeRetentionReviewControl;
  telegramReplyJobs?: TelegramReplyJob[];
  /** Optional additive B6 durable request ledger; no plaintext questions, IDs, tokens or answers. */
  b6BudgetAttempts?:B6BudgetAttempt[];
  /** Monotonic clock high-water mark rejects rollback of daily budget boundaries. */
  b6BudgetClock?:number;
  /** Versioned, non-secret HMAC verifier pinned when the first Telegram fake attempt is reserved. */
  b6TelegramKeyBinding?:string;
  /** Optional additive B5 owner review queue; absent on old schema-8 files. */
  platformReviewQueue?: PlatformReviewQueueEntry[];
}
const empty = (): BotState => ({
  schemaVersion: 8, chats: [], grants: [], privateAI: 'OFF',
  privateFeatures: { 'owner.dashboard': true, 'education.navigate': true, 'subscription.verify': true, 'support.use': true, 'content.upload': false },
  updates: [], operations: [], callbacks: [], wizards: [], audit: [],
  moderationReasons: [], moderationOperations: [], subscriptionRequirements: [], warnings: [],
  educationCategories: [], educationResources: [], importRuns: [], faqEntries: [], resourceLinks: [], campaigns: [], deliveries: [], historicalPublications: [], rollingMessageMeta: [], purgeJobs: []
});

// A per-process serialized file transaction; atomic rename prevents torn JSON on a crash.
// Production B2 must replace this with a multi-process transactional store + backups.
const locks = new Map<string, Promise<void>>();
export class BotStore {
  constructor(readonly file: string, readonly options: {engine?: 'json' | 'sqlite'} = {}) {}

  /** One source-of-truth schema decoder for the JSON simulation and SQLite state row. */
  private decode(state: unknown): BotState {
    if (!state || typeof state !== 'object') throw new Error('Unsupported state schema');
    const previous = state as Record<string, unknown>;
    if (previous.schemaVersion === 1) {
      previous.schemaVersion = 2;
      previous.moderationReasons = []; previous.moderationOperations = []; previous.subscriptionRequirements = []; previous.warnings = [];
    }
    if (previous.schemaVersion === 2) {
      previous.schemaVersion = 3;
      previous.educationCategories = []; previous.educationResources = []; previous.importRuns = [];
    }
    if (previous.schemaVersion === 3) {
      previous.schemaVersion = 4; previous.faqEntries = []; previous.resourceLinks = [];
    }
    if (previous.schemaVersion === 4) {
      previous.schemaVersion = 5; previous.campaigns = []; previous.deliveries = [];
    }
    if (previous.schemaVersion === 5) previous.schemaVersion = 6;
    if (previous.schemaVersion === 6) {
      previous.schemaVersion = 7;
      previous.historicalPublications = [];
    }
    if (previous.schemaVersion === 7) {
      // Additive privacy-limited moderation index. All prior B3/B4 delivery receipts remain unchanged.
      previous.schemaVersion = 8;
      previous.rollingMessageMeta = [];
      previous.purgeJobs = [];
    }
    if (previous.schemaVersion !== 8 ||
      (previous.b6TelegramKeyBinding!==undefined&&
       (typeof previous.b6TelegramKeyBinding!=='string'||
        !/^[a-f0-9]{64}$/u.test(previous.b6TelegramKeyBinding)||
        /^0{64}$/u.test(previous.b6TelegramKeyBinding)))||
      !Array.isArray(previous.rollingMessageMeta) || !Array.isArray(previous.purgeJobs) ||
      (previous.b6BudgetClock!==undefined&&
        (typeof previous.b6BudgetClock!=='number'||
         !Number.isSafeInteger(previous.b6BudgetClock)||
         previous.b6BudgetClock<0||previous.b6BudgetClock>8_640_000_000_000_000))||
      (previous.b6BudgetAttempts!==undefined&&(
        !Array.isArray(previous.b6BudgetAttempts)||
        previous.b6BudgetAttempts.length>2000||
        previous.b6BudgetAttempts.some((row:unknown)=>{
          if(!row||typeof row!=='object'||Array.isArray(row))return true;
          const a=row as Record<string,unknown>;
          const expected=['requestKey','attemptId','day','reservedTokens',
            'reservedAt','leaseUntil','status'];
          const optional=['operatorReview'];
          const goodId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
          const goodDay=/^\d{4}-\d{2}-\d{2}$/u;
          if(Object.keys(a).some(k=>!expected.includes(k)&&!optional.includes(k))||
             expected.some(k=>!Object.prototype.hasOwnProperty.call(a,k)))return true;
          if(a.operatorReview!==undefined){
            if(!a.operatorReview||typeof a.operatorReview!=='object'||
               Array.isArray(a.operatorReview))return true;
            const review=a.operatorReview as Record<string,unknown>;
            if(Object.keys(review).length!==2||
              typeof review.reviewedBy!=='string'||
              !/^[1-9][0-9]{0,19}$/u.test(review.reviewedBy)||
              typeof review.reviewedAt!=='number'||
              !Number.isSafeInteger(review.reviewedAt)||review.reviewedAt<0||
              a.status!=='UNKNOWN_OUTCOME')return true;
          }
          return typeof a.requestKey!=='string'||
            !/^[A-Za-z0-9_-]{8,96}$/u.test(a.requestKey)||
            typeof a.attemptId!=='string'||!goodId.test(a.attemptId)||
            typeof a.day!=='string'||!goodDay.test(a.day)||
            typeof a.reservedTokens!=='number'||
            !Number.isSafeInteger(a.reservedTokens)||
            a.reservedTokens<1||a.reservedTokens>8192||
            typeof a.reservedAt!=='number'||!Number.isSafeInteger(a.reservedAt)||
            a.reservedAt<0||
            new Date(a.reservedAt).toISOString().slice(0,10)!==a.day||
            typeof a.leaseUntil!=='number'||!Number.isSafeInteger(a.leaseUntil)||
            a.leaseUntil<=a.reservedAt||a.leaseUntil>a.reservedAt+900_000||
            !['RESERVED','COMPLETED','UNKNOWN_OUTCOME'].includes(String(a.status));
        })||
        new Set(previous.b6BudgetAttempts.map((a:B6BudgetAttempt)=>a.requestKey)).size!==
          previous.b6BudgetAttempts.length||
        new Set(previous.b6BudgetAttempts.map((a:B6BudgetAttempt)=>a.attemptId)).size!==
          previous.b6BudgetAttempts.length
      ))||
      (previous.platformReviewQueue!==undefined&&(
        !Array.isArray(previous.platformReviewQueue)||
        previous.platformReviewQueue.length>200||
        previous.platformReviewQueue.some((entry:unknown)=>{
          if(!entry||typeof entry!=='object'||Array.isArray(entry))return true;
          const r=entry as Record<string,unknown>;
          const keys=Object.keys(r),base=['sourceId','sourceRevision','title','university','cycle',
            'degree','digest','status','stagedBy','stagedAt'];
          const optional=['reviewedBy','reviewedAt','pageCursor','approvedBy','approvedAt',
            'approvedCategoryId','publishedResourceId'];
          if(keys.some(key=>!base.includes(key)&&!optional.includes(key))||
            base.some(key=>!Object.prototype.hasOwnProperty.call(r,key)))return true;
          const id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
          const sha=/^[a-f0-9]{64}$/u;
          const safe=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&
            v.length<=max&&v.trim()===v&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
          return (r.pageCursor!==undefined&&
              (typeof r.pageCursor!=='string'||!/^[A-Za-z0-9_-]{1,64}$/u.test(r.pageCursor)))||
            typeof r.sourceId!=='string'||!id.test(r.sourceId)||
            typeof r.sourceRevision!=='number'||!Number.isSafeInteger(r.sourceRevision)||r.sourceRevision<1||
            !safe(r.title,160)||!safe(r.university,120)||!safe(r.cycle,32)||
            !safe(r.degree,64)||typeof r.digest!=='string'||!sha.test(r.digest)||
            !['UNVERIFIED_EXTERNAL','REVIEWED_METADATA_ONLY','APPROVED_FOR_LOCAL',
              'PUBLISHED_LOCALLY'].includes(String(r.status))||
            typeof r.stagedBy!=='string'||!/^\d{1,20}$/u.test(r.stagedBy)||
            typeof r.stagedAt!=='number'||!Number.isSafeInteger(r.stagedAt)||r.stagedAt<0||
            (r.status==='UNVERIFIED_EXTERNAL'&&
              (r.reviewedBy!==undefined||r.reviewedAt!==undefined))||
            (r.status!=='UNVERIFIED_EXTERNAL'&&
              (typeof r.reviewedBy!=='string'||!/^\d{1,20}$/u.test(r.reviewedBy)||
                typeof r.reviewedAt!=='number'||!Number.isSafeInteger(r.reviewedAt)||r.reviewedAt<0))||
            (['UNVERIFIED_EXTERNAL','REVIEWED_METADATA_ONLY'].includes(String(r.status))&&
              (r.approvedBy!==undefined||r.approvedAt!==undefined||
                r.approvedCategoryId!==undefined||r.publishedResourceId!==undefined))||
            (['APPROVED_FOR_LOCAL','PUBLISHED_LOCALLY'].includes(String(r.status))&&
              (typeof r.approvedBy!=='string'||!/^\d{1,20}$/u.test(r.approvedBy)||
               typeof r.approvedAt!=='number'||!Number.isSafeInteger(r.approvedAt)||r.approvedAt<0||
               typeof r.approvedCategoryId!=='string'||!id.test(r.approvedCategoryId)))||
            (r.status!=='PUBLISHED_LOCALLY'&&r.publishedResourceId!==undefined)||
            (r.status==='PUBLISHED_LOCALLY'&&
              (typeof r.publishedResourceId!=='string'||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(r.publishedResourceId)));
        })||
        new Set(previous.platformReviewQueue.map((e:PlatformReviewQueueEntry)=>e.sourceId)).size!==previous.platformReviewQueue.length
      )) ||
      (previous.telegramReplyJobs!==undefined&&(
       !Array.isArray(previous.telegramReplyJobs)||
       previous.telegramReplyJobs.some((raw:unknown)=>{
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return true;
        const job=raw as Record<string,unknown>;
        const plan=job.plan as Record<string,unknown>|undefined;
        if(job.accessDenialCode!==undefined&&(
           job.status!=='FAILED_CONFIRMED'||typeof job.accessDenialCode!=='string'||
           !['LEGACY_UNVERIFIABLE','ACCESS_RECHECK_FAILED','GROUP_UNAVAILABLE']
            .includes(job.accessDenialCode)))
          return true;
        if(job.groupReplyKind!==undefined){
         if(job.status!=='QUEUED'||!plan||typeof plan.chatId!=='string'||
            !/^-[1-9]\d{0,18}$/u.test(plan.chatId)||
            (job.groupReplyKind!=='GENERAL'&&job.groupReplyKind!=='REVIEWED_FAQ')||
            (job.groupReplyKind==='REVIEWED_FAQ'&&job.groupQuestionAccess===undefined)||
            (job.groupReplyKind==='GENERAL'&&job.groupQuestionAccess!==undefined))
          return true;
        }
        if(job.groupMenuAccess!==undefined){
         if(job.groupReplyKind!=='GENERAL'||job.groupQuestionAccess!==undefined||
            job.status!=='QUEUED'||!plan||typeof plan.chatId!=='string'||
            !/^-[1-9]\d{0,18}$/u.test(plan.chatId))return true;
         const menu=job.groupMenuAccess;
         if(!menu||typeof menu!=='object'||Array.isArray(menu))return true;
         const m=menu as Record<string,unknown>;
         if(Object.keys(m).length!==3||
            typeof m.actorId!=='string'||!/^[1-9]\d{0,19}$/u.test(m.actorId)||
            typeof m.epoch!=='string'||!/^[a-f0-9]{64}$/u.test(m.epoch)||
            typeof m.expiresAt!=='number'||!Number.isSafeInteger(m.expiresAt)||
            m.expiresAt<0||m.expiresAt>8_640_000_000_000_000)return true;
        }
        if(job.privateReplyKind!==undefined){
         if(job.status!=='QUEUED'||!plan||typeof plan.chatId!=='string'||
            !/^[1-9]\d{0,15}$/u.test(plan.chatId)||
            !Number.isSafeInteger(Number(plan.chatId))||
            job.groupReplyKind!==undefined||
            job.groupMenuAccess!==undefined||job.groupQuestionAccess!==undefined||
            (job.privateReplyKind!=='LOCAL'&&job.privateReplyKind!=='GROUP_SCOPED')||
            (job.privateReplyKind==='LOCAL'&&job.privateGroupAccess!==undefined)||
            (job.privateReplyKind==='GROUP_SCOPED'&&job.privateGroupAccess===undefined))
          return true;
        }
        if(job.privateGroupAccess!==undefined){
         const v=job.privateGroupAccess;
         if(!v||typeof v!=='object'||Array.isArray(v))return true;
         const a=v as Record<string,unknown>;
         if(job.status!=='QUEUED'||!plan||typeof plan.chatId!=='string'||
            job.groupReplyKind!==undefined||
            job.groupQuestionAccess!==undefined||job.groupMenuAccess!==undefined||
            Object.keys(a).length!==4||
            typeof a.actorId!=='string'||!/^[1-9]\d{0,19}$/u.test(a.actorId)||
            plan.chatId!==a.actorId||
            typeof a.scope!=='string'||!/^-[1-9]\d{0,18}$/u.test(a.scope)||
            typeof a.epoch!=='string'||!/^[a-f0-9]{64}$/u.test(a.epoch)||
            typeof a.expiresAt!=='number'||!Number.isSafeInteger(a.expiresAt)||
            a.expiresAt<0||a.expiresAt>8_640_000_000_000_000)return true;
        }
        if(job.groupQuestionAccess===undefined)return false;
        const g=job.groupQuestionAccess;
        if(!g||typeof g!=='object'||Array.isArray(g))return true;
        const v=g as Record<string,unknown>;
        return job.status!=='QUEUED'||Object.keys(v).length!==3||
         typeof v.actorId!=='string'||!/^[1-9]\d{0,19}$/u.test(v.actorId)||
         typeof v.epoch!=='string'||!/^[a-f0-9]{64}$/u.test(v.epoch)||
         typeof v.expiresAt!=='number'||!Number.isSafeInteger(v.expiresAt)||
         v.expiresAt<0||v.expiresAt>8_640_000_000_000_000||
         !plan||typeof plan.chatId!=='string'||!plan.chatId.startsWith('-');
       })
      )) ||
      !Array.isArray(previous.historicalPublications) || !Array.isArray(previous.campaigns) ||
      !Array.isArray(previous.deliveries) || !Array.isArray(previous.faqEntries) ||
      !Array.isArray(previous.resourceLinks) || !Array.isArray(previous.moderationReasons) ||
      !Array.isArray(previous.moderationOperations) || !Array.isArray(previous.subscriptionRequirements) ||
      !Array.isArray(previous.warnings) || !Array.isArray(previous.educationCategories) ||
      !Array.isArray(previous.educationResources) || !Array.isArray(previous.importRuns))
      throw new Error('Unsupported state schema');
    return previous as unknown as BotState;
  }

  private async openSqlite(): Promise<DatabaseSync> {
    await mkdir(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('CREATE TABLE IF NOT EXISTS bot_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  private readSqliteState(db: DatabaseSync): BotState {
    const row = db.prepare('SELECT data FROM bot_state WHERE id = 1').get() as {data: string} | undefined;
    if (!row) return empty();
    if (typeof row.data !== 'string') throw new Error('Unsupported state schema');
    return this.decode(JSON.parse(row.data) as unknown);
  }

  private async read(): Promise<BotState> {
    if (this.options.engine === 'sqlite') {
      const db = await this.openSqlite();
      try { return this.readSqliteState(db); }
      finally { db.close(); }
    }
    try { return this.decode(JSON.parse(await readFile(this.file, 'utf8')) as unknown); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw err; // corrupt data is never silently reset
    }
  }

  async snapshot(): Promise<BotState> { return structuredClone(await this.read()); }

  async transaction<T>(work: (state: BotState) => T | Promise<T>): Promise<T> {
    const key=resolve(this.file); // aliases of one local file share a per-process mutex
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    locks.set(key, previous.then(() => next));
    await previous;
    try {
      if (this.options.engine === 'sqlite') {
        const db = await this.openSqlite();
        let active = false;
        try {
          // BEGIN IMMEDIATE holds a write reservation across independent Node processes.
          db.exec('BEGIN IMMEDIATE'); active = true;
          const state = this.readSqliteState(db);
          const result = await work(state);
          this.decode(structuredClone(state)); // reject malformed updates before commit
          db.prepare('INSERT INTO bot_state (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
            .run(JSON.stringify(state));
          db.exec('COMMIT'); active = false;
          return result;
        } catch (err) {
          if (active) db.exec('ROLLBACK');
          throw err;
        } finally { db.close(); }
      }
      const state = await this.read();
      const result = await work(state);
      this.decode(structuredClone(state)); // Match SQLite: reject malformed state before a JSON commit.
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, this.file);
      return result;
    } finally { release(); }
  }

  /**
   * Deliberate offline JSON -> SQLite import. Never overwrites an initialized database.
   * An existing invalid source is rejected; an absent JSON source is not an empty state.
   */
  static async importJsonToSqlite(jsonFile: string, sqliteFile: string): Promise<void> {
    if (resolve(jsonFile) === resolve(sqliteFile)) throw new Error('SOURCE_DESTINATION_COLLISION');
    await readFile(jsonFile, 'utf8'); // ENOENT must propagate; no fabricated empty migration
    const source = await new BotStore(jsonFile).snapshot();
    const destination = new BotStore(sqliteFile, {engine:'sqlite'});
    const db = await destination.openSqlite();
    let active = false;
    try {
      db.exec('BEGIN IMMEDIATE'); active = true;
      if (db.prepare('SELECT id FROM bot_state WHERE id=1').get()) throw new Error('SQLITE_ALREADY_INITIALIZED');
      db.prepare('INSERT INTO bot_state (id,data) VALUES (1,?)').run(JSON.stringify(source));
      db.exec('COMMIT'); active = false;
    } catch (err) {
      if (active) db.exec('ROLLBACK');
      throw err;
    } finally { db.close(); }
  }
  /**
   * Online SQLite snapshot uses SQLite's backup API, NOT a raw copy of a live WAL file.
   * Reserve a new output path with O_EXCL; never overwrite an existing backup.
   */
  /**
   * Fail-closed local SQLite point-in-time backup. Validate the initialized
   * source READ ONLY before creating any backup path; an existing empty or
   * forged *.sqlite file must never be initialized by openSqlite() as a side
   * effect. Checks are advisory in the face of a hostile filesystem actor;
   * the host must enforce exclusive ownership / directory ACLs.
   */
  /**
   * Offline backup health-check: never calls openSqlite (which enables WAL and
   * creates a table). Returns false on invalid, corrupt or uninitialized data.
   * It does not grant deletion/restore permission, or attempt to repair files.
   */
  static async verifySqliteBackupReadOnly(filePath:string):Promise<boolean>{
    let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      const meta=await lstat(filePath);
      if(!meta.isFile()||meta.isSymbolicLink()||meta.size<16)return false;
      if(await realpath(filePath)!==filePath)return false;
      handle=await open(filePath,'r');
      const header=Buffer.alloc(16);
      const {bytesRead}=await handle.read(header,0,16,0);
      if(bytesRead!==16||
         !header.equals(Buffer.concat([Buffer.from('SQLite format 3'),Buffer.from([0])])))return false;
    }catch{return false;}
    finally{await handle?.close();}
    let db:DatabaseSync;
    try{db=new DatabaseSync(filePath,{readOnly:true});}
    catch{return false;}
    try{
      const check=db.prepare('PRAGMA quick_check').get() as {quick_check?:unknown}|undefined;
      if(check?.quick_check!=='ok')return false;
      const row=db.prepare('SELECT data FROM bot_state WHERE id=1').get() as {data?:unknown}|undefined;
      if(typeof row?.data!=='string')return false;
      new BotStore(filePath,{engine:'sqlite'}).decode(JSON.parse(row.data));
      return true;
    }catch{return false;}
    finally{db.close();}
  }

  /**
   * Read an initialized SQLite BotState WITHOUT invoking openSqlite(), WAL
   * initialization, schema creation or a write transaction. Requires an exact
   * canonical, privately owned file path. For local operator inventories only.
   * The host must separately prevent filesystem races and protect sidecars.
   */
  static async snapshotSqliteReadOnly(filePath:string):Promise<BotState>{
    const invalid=():never=>{throw Error('TELEGRAM_OUTBOX_STATE_INVALID');};
    if(typeof filePath!=='string'||!isAbsolute(filePath)||filePath!==resolve(filePath))
      return invalid();
    try{
      const info=await lstat(filePath);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||
        await realpath(filePath)!==filePath||
        !(await BotStore.verifySqliteBackupReadOnly(filePath)))return invalid();
    }catch{return invalid();}
    let db:DatabaseSync;
    try{db=new DatabaseSync(filePath,{readOnly:true});}
    catch{return invalid();}
    try{
      const row=db.prepare('SELECT data FROM bot_state WHERE id=1').get() as {data?:unknown}|undefined;
      if(typeof row?.data!=='string')return invalid();
      const state=new BotStore(filePath,{engine:'sqlite'}).decode(JSON.parse(row.data) as unknown);
      return structuredClone(state);
    }catch{return invalid();}
    finally{db.close();}
  }

  static async backupSqlite(sourceFile: string, backupFile: string): Promise<void> {
    if(!isAbsolute(sourceFile)||!isAbsolute(backupFile)||
       sourceFile!==resolve(sourceFile)||backupFile!==resolve(backupFile))
      throw new Error('BACKUP_INVALID_PATH');
    if(sourceFile===backupFile)throw new Error('BACKUP_DESTINATION_COLLISION');
    const sourceInfo=await lstat(sourceFile); // missing source stays ENOENT
    if(sourceInfo.isSymbolicLink())throw new Error('BACKUP_SOURCE_ALIAS');
    if(!sourceInfo.isFile())throw new Error('BACKUP_SOURCE_INVALID');
    let actualSource:string;
    try {actualSource=await realpath(sourceFile);}
    catch {throw new Error('BACKUP_SOURCE_INVALID');}
    if(actualSource!==sourceFile)throw new Error('BACKUP_SOURCE_ALIAS');
    if(sourceInfo.size<16)throw new Error('BACKUP_SOURCE_INVALID');
    const sourceHandle=await open(sourceFile,'r').catch(()=>{throw new Error('BACKUP_SOURCE_INVALID');});
    try {
      const header=Buffer.alloc(16);
      const {bytesRead}=await sourceHandle.read(header,0,16,0).catch(()=>{
        throw new Error('BACKUP_SOURCE_INVALID');
      });
      if(bytesRead!==16||!header.equals(Buffer.from('SQLite format 3\0')))
        throw new Error('BACKUP_SOURCE_INVALID');
    }finally{await sourceHandle.close();}
    // This readonly connection cannot manufacture a missing bot_state table
    // or replace a bad schema with an apparently valid empty state.
    let db:DatabaseSync;
    try{db=new DatabaseSync(sourceFile,{readOnly:true});}
    catch{throw new Error('BACKUP_SOURCE_INVALID');}
    try{
      let raw:string;
      try{
        const result=db.prepare("PRAGMA quick_check").get() as {quick_check?:unknown}|undefined;
        if(result?.quick_check!=='ok')throw new Error('BACKUP_SOURCE_INVALID');
        const row=db.prepare('SELECT data FROM bot_state WHERE id = 1').get() as {data?:unknown}|undefined;
        if(typeof row?.data!=='string')throw new Error('BACKUP_SOURCE_INVALID');
        raw=row.data;
        // Decode in memory only. Supports known older schemas without writing.
        new BotStore(sourceFile,{engine:'sqlite'}).decode(JSON.parse(raw));
      }catch{throw new Error('BACKUP_SOURCE_INVALID');}
      await mkdir(dirname(backupFile),{recursive:true});
      let realParent:string;
      try{realParent=await realpath(dirname(backupFile));}
      catch{throw new Error('BACKUP_DESTINATION_ALIAS');}
      if(realParent!==dirname(backupFile))throw new Error('BACKUP_DESTINATION_ALIAS');
      let reserved;
      try{reserved=await open(backupFile,'wx',0o600);}
      catch(err){
        if((err as NodeJS.ErrnoException).code==='EEXIST')throw new Error('BACKUP_ALREADY_EXISTS');
        throw err;
      }
      await reserved.close();
      try{
        await backup(db,backupFile);
        // A backup is usable only after its initialized BotStore state decodes.
        await new BotStore(backupFile,{engine:'sqlite'}).snapshot();
      }catch(err){
        await rm(backupFile,{force:true});
        throw err;
      }
    }finally{db.close();}
  }

  async claim(key: string, now: number, leaseMs = 30_000): Promise<'CLAIMED' | 'DUPLICATE' | 'UNKNOWN'> {
    return this.transaction(s => {
      const found = s.updates.find(x => x.key === key);
      if (!found) { s.updates.push({ key, status: 'CLAIMED', leaseUntil: now + leaseMs }); return 'CLAIMED'; }
      if (found.status === 'UNKNOWN') return 'UNKNOWN';
      if (found.status === 'DONE' || found.leaseUntil > now) return 'DUPLICATE';
      if (s.operations.some(o => o.updateKey === key && (o.status === 'STARTED' || o.status === 'UNKNOWN_OUTCOME'))) {
        found.status = 'UNKNOWN';
        for (const op of s.operations) if (op.updateKey === key && op.status === 'STARTED') op.status = 'UNKNOWN_OUTCOME';
        return 'UNKNOWN';
      }
      found.leaseUntil = now + leaseMs;
      return 'CLAIMED';
    });
  }
  async addIntent(key: string, kind: 'CHAT_LEAVE', chatId: string, policyVersion: number): Promise<string> {
    return this.transaction(s => {
      if (!s.updates.some(u => u.key === key && u.status === 'CLAIMED')) throw new Error('Unclaimed update');
      const existing = s.operations.find(o => o.updateKey === key && o.kind === kind && o.chatId === chatId);
      if (existing) return existing.id;
      const id = randomUUID();
      s.operations.push({ id, updateKey: key, kind, chatId, policyVersion, status: 'INTENT' });
      return id;
    });
  }
  async markStarted(id: string, now: number): Promise<void> {
    await this.transaction(s => {
      const op = s.operations.find(x => x.id === id);
      if (!op || op.status !== 'INTENT') throw new Error('Operation not pending');
      op.status = 'STARTED'; op.startedAt = now;
    });
  }
  async markOutcome(id: string, status: 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME'): Promise<void> {
    await this.transaction(s => {
      const op = s.operations.find(x => x.id === id);
      if (!op || op.status !== 'STARTED') throw new Error('Operation not started');
      op.status = status;
    });
  }
  async recordDecision(decision: AuditRecord): Promise<void> {
    await this.transaction(s => { if (!s.audit.some(a => a.updateKey === decision.updateKey)) s.audit.push(decision); });
  }
  async cancelIntent(id: string): Promise<void> {
    await this.transaction(s => { const op = s.operations.find(x => x.id === id); if (!op || op.status !== 'INTENT') throw new Error('Cannot cancel started operation'); op.status = 'CANCELLED'; });
  }
  async finish(key: string, decision: AuditRecord, reply?: TelegramReplyJob['plan'],
    groupQuestionAccess?:TelegramReplyJob['groupQuestionAccess'],
    groupMenuAccess?:TelegramReplyJob['groupMenuAccess'],
    privateGroupAccess?:TelegramReplyJob['privateGroupAccess']): Promise<void> {
    await this.transaction(s => {
      const update = s.updates.find(x => x.key === key);
      if (!update || update.status !== 'CLAIMED') throw new Error('Update not claimed');
      const statuses = s.operations.filter(o => o.updateKey === key).map(o => o.status);
      update.status = statuses.includes('UNKNOWN_OUTCOME') ? 'UNKNOWN' : 'DONE';
      if (!s.audit.some(a => a.updateKey === key)) s.audit.push(decision); // no tokens or raw inbound messages
      if(reply && update.status==='DONE') {
        s.telegramReplyJobs??=[];
        if(!s.telegramReplyJobs.some(j=>j.updateKey===key))
         s.telegramReplyJobs.push({updateKey:key,plan:structuredClone(reply),status:'QUEUED',queuedAt:decision.at,
          ...(reply.chatId.startsWith('-')
           ?{groupReplyKind:groupQuestionAccess?'REVIEWED_FAQ' as const:'GENERAL' as const}
           :{privateReplyKind:privateGroupAccess?'GROUP_SCOPED' as const:'LOCAL' as const}),
          ...(groupQuestionAccess?{groupQuestionAccess:structuredClone(groupQuestionAccess)}:{}),
          ...(groupMenuAccess?{groupMenuAccess:structuredClone(groupMenuAccess)}:{}),
          ...(privateGroupAccess?{privateGroupAccess:structuredClone(privateGroupAccess)}:{})});
      }
    });
  }
}
