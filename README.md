# بوت منارتك — MANARATAK BOT

**B0/B1 + B2-Core + B3 + B4 fenced worker/recovery simulations (v0.4.6). Offline/test-only — no live Telegram bot.**

An independent TypeScript/Node.js 22 project based on `docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md` and `docs/START_HERE_MANARATAK_BOT_v1.2.1_AR.md`. B0/B1 supply the secure baseline; B2-Core adds individual moderation and subscription policies; B3 adds the first locally tested education content flow.





## B4 v0.4.6 — fenced worker recovery and scoped multipart review (offline)

B4 stores a **120-second durable lease** alongside each single-send or multipart-part SENDING intent in the existing canonical delivery. See `src/publication-worker-lease.ts` and the new regression suite `tests/b4-fenced-recovery.test.ts`. The lease is only a recovery grace interval, **not permission to auto-retry or a guarantee of exactly-once Telegram sending**.

- A second worker (including an independent SQLite process) calling `recoverPending()` **does not touch actively leased attempts**. Expired attempts, and legacy SENDING records lacking a lease, become `UNKNOWN_OUTCOME`. This quarantine requires independent proof review and never permits automatic replay.
- If an in-flight worker returns after its lease has expired, the authorization check fences it **before** contacting the gateway; its attempt is recorded UNKNOWN. A worker that has already crossed the gateway boundary may still have an ambiguous result: the original UNKNOWN outcome rule remains authoritative, and no automatic resend is permitted.
- The same rule applies to regular one-message campaigns and all parts of multipart campaigns. An explicit confirmed failure can be retried only with the existing publisher authorization; retries clear the previous lease and attempt ID.
- Multipart `retryFailed` and `reconcileUnknown` now require the *acting editor* to possess `content.publish` in both the source and destination chats, not merely destination rights. Evidence review checks this both **before** and **after** awaiting an external verifier.
- Tests simulate pending `canPost` calls, live competing recovery and expiry, source-right revocation while verifying a receipt, orphaned legacy records, and an independent SQLite worker process. This only uses fake clocks, fake gateways and local files. No real bot token/channel is read.

**Operational limitation:** a lease is fixed at 120 seconds and is not automatically renewed. A delayed operation that exceeds the lease is intentionally quarantined and may require manual reconciliation. This is a conservative simulation policy, not a fully supervised worker or production outbox, nor does it certify active multi-host high availability. For production: deploy operational heartbeat/leases under database constraints, transaction outbox, documented operator recovery, real receipt verification, power-loss tests and authorization review.

## B4 v0.4.5 — optional transactional SQLite storage (offline)

The original `new BotStore(path)` remains the **per-process JSON simulation**, for backward compatibility. B4 now offers an **opt-in SQLite backing store of the exact same BotState and single campaign delivery ledger**, using Node.js 22's built-in `node:sqlite`:

```ts
const store = new BotStore('/private/offline-test/state.sqlite', {engine:'sqlite'});
// Existing PublicationService, CampaignMultipartService and policies use the SAME store.
// For a reviewed, deliberate migration from the old JSON test fixture:
await BotStore.importJsonToSqlite('/private/offline-test/state.json', '/private/offline-test/new.sqlite');
// Once populated, never import onto this same database again.
await BotStore.backupSqlite('/private/offline-test/new.sqlite','/private/offline-test/backup.sqlite');
```

SQLite transactions use `BEGIN IMMEDIATE`, WAL journaling and `synchronous=FULL`. Operations are serialized across independent Node processes by the SQLite database write lock and preserve the prior SENDING → UNKNOWN_OUTCOME crash-safety contract. The existing source, destination, historical, single-part and multipart data all remain in ONE BotState record; a new SQLite file **does not create another publishing queue or independent deduplication ledger**.

Safety controls tested with separate child processes: conflicting campaign approvals permit one reservation; approvals for distinct resources retain both reservations; simultaneous dispatch consumes a queued delivery once; a failed transaction rolls back; a reader never sees an uncommitted state; orphaned multipart attempts remain UNKNOWN after restart. The explicit JSON→SQLite import rejects invalid/missing sources and existing destination state; schema v5 records retain earlier B4 receipts and B3 resources. SQLite online backup uses `node:sqlite`'s actual backup operation (not copying a live WAL file), verifies the restorable snapshot and refuses to overwrite an existing backup.

**Deployment warning:** Node's `node:sqlite` API is experimental on Node 22; the implementation serializes the full BotState into one SQLite row, and has not been load-tested, durability-tested under power failure, tested on network filesystems, or independently security reviewed. It is a significant offline concurrency improvement, **NOT a certified production database**. Database atomicity cannot establish exactly-once Telegram delivery following an ambiguous HTTP outcome; the existing UNKNOWN quarantine remains mandatory. Before any live activation require schema-normalized tables/indexes, writer load tests, backup/restore drills, supervision, outbound adapters, verified Telegram receipts, observability and a deployment review. Do not expose either store to real Telegram until explicitly authorized.

## B4 v0.4.4 — historical publication review guard (offline)

The former China / historical publication planner in `src/legacy-publication-migration.ts` was a **read-only report** and did not reserve against B4 campaigns. The new `HistoricalPublicationReviewService` in `src/legacy-campaign-review.ts` makes a separately authorized, explicit import of its per-item results into `BotStore.historicalPublications`. This is a **review registry, not a second delivery ledger, worker or publishing gateway**. Only `BotStore.deliveries` performs outbound reservation and receipt tracking.

Example local workflow after importing and approving B3 resource IDs:

```ts
const review = new HistoricalPublicationReviewService(store, policy, trustedLegacyEvidenceVerifier, clock);
const report = await review.review(publisherActor, {
  sourceScope: approvedSourceChat,
  destination: approvedDestinationChat,
  resourceIds: [resourceId1, resourceId2],
  evidence: [itemSpecificEvidence], // actual independent verification required
  lastSeenOrdinal: 2, // UI hint ONLY, not proof of previous items
});
// The register preserves UNVERIFIED, REVIEW_REQUIRED, MANUALLY_SKIPPED and PUBLISHED_VERIFIED distinctly.
// Later, if independent evidence arrives:
// await review.reconcileEvidence(publisherActor, historicalRecordId, newlyVerifiedReceipt);
// Or an authorized reviewer can explicitly omit it:
// await review.markManuallySkipped(publisherActor, historicalRecordId, 'documented reason');
```

- Every historical item is matched to a **currently reviewed B3 resource's immutable revision and destination**. Imported or forwarded last-message IDs do not prove any earlier items. A caller must inject a genuinely trusted `VerifyLegacyEvidence` implementation; the fake verifier in tests is NOT a production verifier.
- The review operation checks scoped publication rights before and after awaiting verification. Existing B4 delivery reservations, duplicate historical registrations, reused evidence IDs and colliding message IDs are refused or marked `REVIEW_REQUIRED`.
- Any registered historical state (even `UNVERIFIED` or `MANUALLY_SKIPPED`) blocks approval of the exact same resource revision/destination in a new B4 campaign. It does not count an unverified or manually skipped item as a confirmed Telegram publication. Neither state silently expires or requeues for sending.
- Evidence can later settle an `UNVERIFIED` or `REVIEW_REQUIRED` record in-place after independent verification and renewed authorization. Explicit late manual skips never invent a `messageId` and cannot overwrite confirmed proofs. The original review ID and audit trail remain.
- Schema v6→v7 is additive. Earlier B4 campaigns, multipart receipts, and education records remain untouched. Never downgrade the JSON state file or use it for live multi-worker publishing.

Run `npm run check` to execute all mock tests. This capability is **TESTED_MOCK only**: no Telegram Bot API reads, no historical channel scraping, no automated mass import, no real verifier, and no production platform access. Long-term B4 completion still requires transactional multi-worker persistence, a real verified evidence adapter and deployment-safe operations.

## B4 v0.4.3 — approved long-form multipart campaign flow (offline only)

The normal B4 flow now accepts **reviewed** publication copy longer than one Telegram message, up to the preflight planner's 10 × 4096 UTF-16-unit upper bound. Importing an unreviewed file never automatically creates this copy:

1. Import a B3 scholarship record, explicitly approve its candidate and publish the source resource in an authorized education scope.
2. A holder of `content.publish` reviews optional long-form copy with `EducationService.setPublicationText(actor, resourceId, text)`. This does **not** send content or bypass B3 review.
3. `PublicationService.draft(actor, sourceScope, destination, [resourceId])` creates the exact deterministic text `renderPlan` with part boundaries and SHA-256 fingerprint; inspect the returned preview before approval.
4. `PublicationService.approve(actor, campaignId)` atomically reserves **one** canonical B4 delivery per resource and destination. Long text becomes `MULTIPART` with an immutable part snapshot inside `BotStore.deliveries`, not a separate store. Short text retains the original single-message path.
5. `PublicationService.dispatchNext(campaignId)` drives both one-part and multipart offline fake transports. Part intents (`SENDING` and unique `attemptId`) and audit entries persist before gateway calls. It rechecks approver authorization, source visibility and destination policy after async posting-permission checks.
6. After restart, `recoverPending()` converts orphaned single/part `SENDING` to `UNKNOWN_OUTCOME`. An uncertain part blocks remaining parts until `CampaignMultipartService.reconcileUnknown(..., providerVerifiedReceipt)` verifies exact destination/attempt/message ID. Text similarity and a repeated message ID never prove delivery. Only confirmed failures can be explicitly retried.

The older `MultipartTestStore` in `multipart-publishing.ts` is a **research-only isolated fixture**. Do not wire it into a worker: the campaign delivery ledger is the only operational reservation boundary. The backing JSON file serializes only within one Node.js process, so this release is NOT safe for concurrent workers, production databases, live Telegram sends, or private-group deployment. Production still needs transactional storage, leases, backup/migration rehearsal and a separately reviewed Telegram adapter.

## Commands

```sh
npm install
npm run check         # typecheck + all current node:test cases (including B4 long-form integration)
npm run demo          # previous B1 simulation
npm run demo:education # example document -> count -> manual approve -> visible resource
npm run demo:faq       # FAQ approvals, membership-gated resource links and admin facade
npm run demo:publishing # local reviewed campaign and fake delivery receipts
```

Node 22+, TypeScript; tests use synthetic identities and temporary JSON state only. No real Telegram token, live webhook deployment, outbound Telegram delivery, AI provider, real Bot API downloads, or production platform database access.

## B3 features built and tested

- Owner-managed, nested, ordered, enabled/disabled category tree with strictly scoped `private` or specifically approved group navigation. A disabled parent hides children.
- A deterministic importer for MD/TXT/CSV/JSON. Limits UTF-8 input to 256 KiB / 1,000 records. Rejects mislabeled files, invalid CSV/JSON and nested JSON data. Structured headings or key-value fields only; **this does not analyze arbitrary prose or scanned documents**.
- Import report distinguishes sections, unique universities, *candidate* scholarship opportunities, potential duplicates, ambiguous records and **only explicitly stated** seats. Counts are not official verification. Unstructured records remain `NEEDS_REVIEW`.
- Content hash deduplicates identical imports within the same approved scope, across renamed files and process restart. It does **not** deduplicate all similar scholarships across independent files or years.
- Upload permission (`content.upload`) does not confer content approval/publication (`content.publish`). Candidate review and local resource publication are two explicit actions; duplicates and ambiguous rows cannot auto-publish. Local resource metadata and audit are persisted without full raw document bodies.
- Navigation returns `PUBLISHED` resources only from permitted scope + enabled category. Revoking chat permission, disabling a category, or archiving a resource prevents further browsing. The internal JSON store is for local simulation, **not production or multi-process concurrency**.

Run `npm run demo:education` for a self-contained example. The upload `origin` values (`TELEGRAM_ADMIN` / `ADMIN_WEB`) are labels in tests, **not operational adapters**. No students receive messages in this phase. Display layers that may later render imported content MUST treat imported strings as untrusted and escape them.

## B3 FAQ, scoped resource links and mock admin application layer (v0.3.1)

- FAQ answers are curated, **not generated by AI**. Each question and up to 10 reviewed aliases is tied to an existing published resource in the same scope. A draft cannot answer; an authorized publisher must approve it. Ambiguous exact matches refuse to guess. A disabled group mention policy, revoked group, archived source or hidden category suppresses the answer. Private FAQ questions remain OFF by default; manual educational browsing is independent.
- Resource share references are opaque server-side `r_...` tokens, bounded by expiry and optional actor binding. For group resources, a trusted Telegram membership adapter **must** return `VERIFIED`; `UNKNOWN` and unverified user claims fail closed. Chat permission version and resource visibility are re-evaluated **after** the external membership check. A public short link is never a bypass to a private or revoked source.
- Student-facing resource projections exclude `reviewedBy`, internal import IDs and source locators. Renderers must escape user-provided strings, and no real Telegram messages are sent by this package.
- `EducationAdminFacade` provides a common application-level interface for uploading a UTF-8 text payload, showing upload/publish capability flags, approving records and local publication. An **authenticated adapter**, not the user's JSON body, must populate its `VerifiedAdminContext`. `verified=true` here is a *test fixture*, **not cryptographic Telegram authentication** or deployed web authentication. An inbound **localhost HTTP listener for tests** is now available in `src/telegram-transport.ts`; a separate locally tested signed Mini App admin JSON listener is also implemented in v0.3.3. There is still no deployed endpoint, live Bot API download, active callback button or outbound delivery.
- Schema v5 retains earlier B1/B2/B3 state and adds FAQ/link metadata. JSON remains a **single-process test store only**. Production needs transactional persistence, resource versioning, source policy review, retention, explicit Telegram delivery adapter, and hardened transport authentication.


## B3 offline Telegram inbound transport (v0.3.2)

`telegramWebhookListener(app, webhookSecret)` is an **inbound-only** Node.js `http` request listener, tested on loopback. It validates the `x-telegram-bot-api-secret-token` header with constant-time comparison, rejects duplicate header fields, wrong route/method/content type, malformed JSON and bodies over 64 KiB. Do not put the example secret in production; no real token or webhook URL is configured or used. A production-facing listener would require HTTPS, secure secret provisioning, abuse controls and deployment approval.

`TelegramUpdateApplication.handle(update)` validates safe Telegram `message` shapes, checks numeric sender/chat identities and update IDs, rejects anonymous-channel forwarding, and produces a **local** `TelegramReplyPlan` with escaped HTML for supported commands. It is not an outbound gateway: the HTTP response contains only `{ok:true,status:...}` and **does not send the plan to the student**. Importing text via `/import` is a deliberately constrained simulation; v0.3.3 also understands a Telegram `document` update and forwards an opaque file ID to a fake `TelegramDocumentPort`. No real attachment download, antivirus, OCR or deployed browser panel exists. Requests are de-duplicated through the local store, and audit logging does not persist message text.

Supported simulated commands: `/admin <scope>` (private only), `/import <scope> <format> <name>\n<text>` (private), `/approve <id> <index> <category>` and `/publish ...` (private), `/categories [scope]`, `/resources <category>` in approved groups or `/resources <scope> <category>` in private, `/resource <short-ref>` (private), and `/ask@ManaratakBot <question>` (approved group, curated FAQ only). Bot username comes from trusted configuration. Permission checks precede costly operations. Group content requested from a private chat requires **independently checked group membership**, plus subscription checks when configured; an approved group alone is not authorization for a stranger in a DM. The same subscription gate covers group FAQ and navigation.

**Never expose `app.handle` directly as an unauthenticated HTTP API.** Its test fixture expects the shared-secret-authenticated listener to be the external entrypoint. `verified:true` on the admin facade is minted by the bounded Telegram envelope parser; it is **not** proof of a deployed Telegram installation. Production must replace the single-process JSON test store with a transactional store, persist durable operation intents and outcomes, establish an outbound send path and verify bot identity/permissions and membership against real Telegram before calling this live.

## B3 document and Mini App admin integration (v0.3.3)

The inbound Telegram adapter now accepts synthetic `message.document` updates **in an authorized private chat only**, with a caption `/upload <scope>`. It accepts text-only MD/TXT/CSV/JSON within 256 KiB. Extension, MIME, safe opaque `file_id`, file size, strict UTF-8 and control characters are checked. `TelegramDocumentPort` is an **injected fake** in tests: there is no actual `getFile` call or Telegram Bot token. Upload permission is checked before download and inside the import transaction after the asynchronous operation; a Telegram upload cannot bypass review or locally publish content.

The separate `TelegramMiniAppAuth` validates signed `Telegram.WebApp.initData` using the official HMAC mechanism, a 10-minute authentication window and a signed Telegram user ID. It rejects duplicate keys and untrusted identifiers in the HTTP request body. A local-only JSON listener exposes `/admin/panel`, `/admin/import`, `/admin/approve` and `/admin/publish`, each with permission checks. There is **no live web deployment, browser UX, real bot token, or outbound Telegram gateway**. Tests use a deliberately fake token and loopback HTTP only.

The B3 suite includes a combined cross-transport scenario: fake Telegram document upload → owner approval through a signed local Mini App request → group library browse with HTML-escaped source text → group revocation blocks browsing. No real students, channels, Bot API calls or AI model are involved.

**Before deployment:** secure actual Telegram file-download/retention and malware scanning; HTTPS/origin/CSRF and rate limiting; durable transactional storage; authenticated browser UI; bot rights validation; outbound receipts, explicit owner activation and private Telegram integration testing. This stage remains **TESTED_MOCK**, not `TESTED_LIVE_PRIVATE` or `ACTIVATED`.

## B4 controlled campaign preview + delivery ledger (v0.4.0, TESTED_MOCK slice)

`PublicationService` adds a **reviewed campaign** path that is deliberately separate from B3's local resource visibility. The owner/publisher must explicitly approve a **snapshot preview** containing the exact plain-text content and an authorized destination. A Telegram channel requires its own `publishing` scope and publisher grant; bot presence or `navigation` rights are not enough. Campaigns may be scheduled, paused, resumed or cancelled.

A durable **local mock ledger** reserves `(resourceId, content revision, destination)` across campaigns. For each item the worker saves `SENDING` and a unique attempt ID **before** touching the injected gateway. Confirmed outcomes store the message ID. Timeouts and post-send exceptions become `UNKNOWN_OUTCOME`: they block later campaign items and **must never be retried automatically**. Restart turns an orphaned `SENDING` into an unresolved outcome. A verified receipt from a trusted provider-specific port can reconcile one specific attempt (not similar text or the last post in a channel). `FAILED_CONFIRMED` needs an explicit authorized retry. Manual skip is recorded separately from successful publication, and cannot disguise ambiguous delivery as a success.

Re-authorization and current resource/parent-category status are checked at dispatch time; owner/publisher privileges, exact approved content revision and destination permission are not inferred from a button or an earlier approval. An offline fake gateway supplies mock receipts and no network calls. Tests cover two competing workers in one process, interruption/restart, revocation, stale previews, approval separation, and cross-campaign duplicates. **There is no live Telegram send adapter, rate-limited durable production queue, real channel posting, content template editor, Chinese campaign reconciliation, or automated provider receipt verification yet**. The one-process JSON store cannot ensure transactional uniqueness across machines. This slice is **not full B4**; follow-up implementation is required before activation.

Run `npm run demo:publishing` for a harmless example using an invented scholarship and mock destination. Never describe `mock-message-*` as a Telegram receipt. The existing B3 source/FAQ and B2 moderation remain independent of this work.

## Project structure

- `src/store.ts`, `src/policy.ts`, `src/pipeline.ts`, `src/callback.ts`, `src/outbound.ts`, `src/wizard.ts` — B1 core.
- `src/moderation.ts`, `src/subscription.ts` — B2-Core simulations.
- `src/ingestion.ts` — deterministic text-file extraction / counts.
- `src/education.ts` — category hierarchy, permissions, approval, local resource catalog.
- `src/education-demo.ts`, `src/faq-demo.ts` — safe B3 walkthroughs with synthetic data.
- `src/education-interactions.ts` — approved FAQ and opaque resource reference authorization.
- `src/education-admin.ts` — transport-agnostic owner/staff admin operations (no live adapter).
- `src/telegram-transport.ts` — bounded webhook and synthetic text/document intake; injected fake downloader; reply plans only, **never sends Telegram messages**.
- `src/publishing.ts`, `src/publishing-demo.ts` — B4 preview/approval, scoped queue ledger, fake gateway, receipt reconciliation; mock only.
- `tests/b4-publishing.test.ts` — 19 offline ledger, authorization, crash and reconciliation tests.
- `src/web-admin-auth.ts` — validates Mini App signed `initData` and exposes locally tested authenticated JSON operations; no deployed UI.
- `tests/telegram-documents.test.ts`, `tests/web-admin-auth.test.ts`, `tests/b3-cross-transport.test.ts` — file safety, signed identity, grant revocation, and end-to-end fake upload→web approval→group browse.
- `tests/telegram-transport.test.ts` — localhost webhook and authorization tests for the inbound adapter.
- `tests/*.test.ts` — 110 tests covering B1/B2/B3 including authentication, document guards, cross-transport approvals, revocation, restart and concurrency.
- `docs/DECISIONS.md`, `docs/TRACEABILITY.md`, `CHANGELOG.md` — stage boundaries, evidence, decisions.

## Boundaries and next slices

**TESTED_MOCK only.** No live Telegram rights or upload/download, HTML/Markdown sanitizing renderer, production transactional DB or backups, verified official scholarship source, user-facing resource UI, AI-generated question answering, real file retention erasure, real content moderation, PDF/XLSX/DOCX/OCR or AI provider. Those require separate tested work; B3 currently covers its first acceptance slice, **not every B3 enhancement or any of 703 requirements**.

Further B3 work must add outbound Telegram delivery with reliable receipts, **actual Telegram document download with security scanning**, a production-hardened web admin interface (the signed local JSON adapter is mock-tested), and source retention/approval review. The implemented interfaces do **not** authorize a live rollout. B4 advanced campaign reconciliation, queueing, formatting and real delivery, B2-Advanced moderation, B5 platform APIs, and B6 AI remain PLANNED. Do not run live services or merge PR chains without distinct review and authorization.


## B4 v0.4.1 — معاينة عرض Telegram وترحيل المنشورات التاريخية (محاكاة فقط)

- `src/publication-preview-plan.ts`: خطة ثابتة للنصوص الطويلة (4096 حرف UTF-16 بحد محافظ؛ حتى 10 رسائل)، صور مع caption بحد 1024، معرف صورة داخلي فقط، وعرض رابط HTTPS بقرار صريح. لا يقسم URL طويلًا ولا ينشر صورة تلقائيًا إذا تجاوز وصفها الحد؛ التحويل للنص يحتاج اعتماد fallback.
- `src/legacy-publication-migration.ts`: تقرير مراجعة لعناصر سجل منشورات سابقة؛ كل عنصر **UNVERIFIED** حتى يصل دليل مطابق منفرد ويتحقق عبر مصدر موثوق. لا يعتمد ترتيب الجامعة أو آخر منشور لإثبات السابق. `MANUALLY_SKIPPED` لا يساوي `PUBLISHED_VERIFIED`، وتعارض الأدلة يعيد العنصر لمراجعة بشرية.
- `npm run demo:preview-migration` ينتج تقريرًا ببيانات وهمية فقط، و`npm run check` يفحص حدود Telegram والسحب والتعارض والازدواجية.
- **هذه واجهات تخطيط ومراجعة مستقلة غير موصولة بعد بمرحلة إرسال حملات `PublicationService` أو قاعدة تخزين تشغيلية، ولا تستدعي Telegram أو توثّق منشورات الصين الحقيقية.** اعتماد خطة العرض/ترحيل السجل والإرسال الفعلي قضايا لاحقة.


## B4 v0.4.2 — Multipart handoff (unfinished, mock only)

These **previously unpushed local changes** are retained in `src/campaign-multipart.ts` and `tests/b4-campaign-multipart.test.ts`. They stage deterministic text parts into the **existing** B4 campaign's delivery record with separate attempt IDs, guard against unauthorized sending, preserve receipt evidence and stop after UNKNOWN_OUTCOME. The legacy core dispatcher refuses to handle staged `MULTIPART` deliveries; manual skip is prohibited while parts may have been sent. `src/multipart-publishing.ts` and its test file are an **experimental isolated proof-of-concept**, with a second JSON ledger; do not connect it to the production flow.

This is **not B4 completion**. In particular: the core B4 preview limit still rejects content over 4000 Unicode code points during ordinary campaign drafting; the integration tests construct a synthetic approved campaign, not one made through the full B4 draft API. Do **not** raise that limit or enable direct sends without adding proper authorization/preview and per-part retry semantics. The B4 JSON store is single-process-only, and nothing has been published to Telegram. Next task: merge approval/render planning into one atomic and auditable campaign preflight, add migration and safe orchestration, then test full draft→approval→multipart→restart→receipts against a transactional fake.
