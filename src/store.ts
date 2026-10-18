import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Capability = 'ai.ask' | 'ai.settings.manage' | 'content.publish' | 'content.upload' | 'chat.manage' | 'education.navigate' | 'owner.dashboard' | 'subscription.verify' | 'support.use';
export type GroupAIMode = 'OFF' | 'OWNER_MENTION' | 'STAFF_MENTION' | 'ALL_MENTION';
export type PrivateAIMode = 'OFF' | 'STAFF_ONLY' | 'ALL_OPT_IN';
export type OperationStatus = 'INTENT' | 'STARTED' | 'CONFIRMED' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'CANCELLED';
export interface Chat { id: string; approved: boolean; present: boolean; scopes: string[]; version: number; groupAI: GroupAIMode; }
export interface Grant { actor: string; capability: Capability; chatId: string; expiresAt: number; grantedBy: string; revoked: boolean; }
export interface CallbackRecord { ref: string; action: string; chatId: string; actorId?: string; policyVersion: number; expiresAt: number; oneShot: boolean; used: boolean; revoked: boolean; }
export interface Wizard { key: string; userId: string; chatId: string; topicId: string; flow: string; step: number; version: number; expiresAt: number; policyVersion: number; status: 'ACTIVE' | 'CANCELLED'; }
export interface ProcessedUpdate { key: string; status: 'CLAIMED' | 'DONE' | 'UNKNOWN'; leaseUntil: number; }
export interface Operation { id: string; updateKey: string; kind: 'CHAT_LEAVE'; chatId: string; policyVersion: number; status: OperationStatus; startedAt?: number; }
export interface AuditRecord { updateKey: string; decision: 'ALLOW' | 'DENY' | 'NOOP'; reason: string; policyVersion: number; at: number; }
import type { Candidate, ImportFormat, ImportReport } from './ingestion.js';
export interface EducationCategory { id: string; scope: string; parentId: string | null; title: string; order: number; enabled: boolean; }
export interface EducationResource { id: string; categoryId: string; scope: string; title: string; university: string; cycle: string; degree: string; seats: number | null; sourceImportId: string; sourceLocator: string; reviewedBy: string; status: 'PUBLISHED' | 'ARCHIVED'; }
export interface ImportRun { id: string; scope: string; uploadedBy: string; origin: 'TELEGRAM_ADMIN' | 'ADMIN_WEB'; format: ImportFormat; filename: string; digest: string; report: ImportReport; candidates: Candidate[]; createdAt: number; }
export type RestrictionKind = 'NONE' | 'MUTE' | 'BAN';
export interface ModerationReason { chatId: string; memberId: string; source: 'MANUAL' | 'SUBSCRIPTION'; reference: string; kind: 'MUTE' | 'BAN'; createdBy: string; active: boolean; }
export interface ModerationOperation { id: string; chatId: string; memberId: string; actorId: string; kind: RestrictionKind; reasonFingerprint: string; policyVersion: number; status: OperationStatus; createdAt: number; }
export interface Warning { chatId: string; memberId: string; reference: string; actorId: string; at: number; active: boolean; }
export interface SubscriptionRequirement { chatId: string; channelIds: string[]; mode: 'ALL' | 'ANY'; version: number; }
export interface FAQEntry { id: string; scope: string; question: string; aliases: string[]; answer: string; sourceResourceId: string; createdBy: string; approvedBy?: string; status: 'DRAFT' | 'APPROVED' | 'ARCHIVED'; createdAt: number; }
export interface ResourceLink { ref: string; scope: string; resourceId: string; resourceRevision: number; policyVersion: number; expiresAt: number; boundUserId?: string; issuedBy: string; revoked: boolean; }
/** B4 uses snapshots of reviewed content; never treat an item ID as proof of its current revision. */
export interface PublicationPreview { resourceId: string; revision: string; text: string; }
export type CampaignStatus = 'DRAFT' | 'APPROVED' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';
export interface PublicationCampaign {
  id: string; sourceScope: string; destination: string; createdBy: string; approvedBy?: string;
  status: CampaignStatus; scheduledAt: number; createdAt: number; sourcePolicyVersion: number; destinationPolicyVersion: number;
  previews: PublicationPreview[];
}
export type DeliveryStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED_CONFIRMED' | 'UNKNOWN_OUTCOME' | 'CANCELLED' | 'SKIPPED';
export interface PublicationDelivery {
  id: string; campaignId: string; resourceId: string; destination: string; revision: string;
  status: DeliveryStatus; attemptId?: string; startedAt?: number; messageId?: string;
  reviewReason?: string;
}
export interface BotState {
  schemaVersion: 5;
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
}
const empty = (): BotState => ({
  schemaVersion: 5, chats: [], grants: [], privateAI: 'OFF',
  privateFeatures: { 'owner.dashboard': true, 'education.navigate': true, 'subscription.verify': true, 'support.use': true, 'content.upload': false },
  updates: [], operations: [], callbacks: [], wizards: [], audit: [],
  moderationReasons: [], moderationOperations: [], subscriptionRequirements: [], warnings: [],
  educationCategories: [], educationResources: [], importRuns: [], faqEntries: [], resourceLinks: [], campaigns: [], deliveries: []
});

// A per-process serialized file transaction; atomic rename prevents torn JSON on a crash.
// Production B2 must replace this with a multi-process transactional store + backups.
const locks = new Map<string, Promise<void>>();
export class BotStore {
  constructor(readonly file: string) {}
  private async read(): Promise<BotState> {
    try {
      const state: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!state || typeof state !== 'object') throw new Error('Unsupported state schema');
      // B1 -> B2 migration is explicit and additive; never wipe B1 authorizations or ledgers.
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
      if (previous.schemaVersion !== 5 || !Array.isArray(previous.campaigns) || !Array.isArray(previous.deliveries) || !Array.isArray(previous.faqEntries) || !Array.isArray(previous.resourceLinks) || !Array.isArray(previous.moderationReasons) || !Array.isArray(previous.moderationOperations) || !Array.isArray(previous.subscriptionRequirements) || !Array.isArray(previous.warnings) || !Array.isArray(previous.educationCategories) || !Array.isArray(previous.educationResources) || !Array.isArray(previous.importRuns)) throw new Error('Unsupported state schema');
      return previous as unknown as BotState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw err; // NEVER silently reset corrupted production data.
    }
  }
  async snapshot(): Promise<BotState> { return structuredClone(await this.read()); }
  async transaction<T>(work: (state: BotState) => T | Promise<T>): Promise<T> {
    const previous = locks.get(this.file) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    locks.set(this.file, previous.then(() => next));
    await previous;
    try {
      const state = await this.read();
      const result = await work(state);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, this.file);
      return result;
    } finally { release(); }
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
  async finish(key: string, decision: AuditRecord): Promise<void> {
    await this.transaction(s => {
      const update = s.updates.find(x => x.key === key);
      if (!update || update.status !== 'CLAIMED') throw new Error('Update not claimed');
      const statuses = s.operations.filter(o => o.updateKey === key).map(o => o.status);
      update.status = statuses.includes('UNKNOWN_OUTCOME') ? 'UNKNOWN' : 'DONE';
      if (!s.audit.some(a => a.updateKey === key)) s.audit.push(decision); // no message bodies, tokens or URLs
    });
  }
}
