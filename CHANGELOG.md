## 0.5.5 — 2026-10-20 — Offline external retention-review CLI runner

- New `src/retention-review-cli.ts` with strict `--review-only --store <absolute-existing-private-state> --engine json|sqlite` contract and trusted `MANARATAK_OWNER_ID` service environment.
- Rejects unexpected/destructive/duplicate/relative arguments, absent and symlinked paths, group/world-readable state files, non-SQLite headers and invalid/corrupted bot state before executing a review checkpoint. File paths and owner IDs are never printed to stdout/stderr.
- Invokes ONLY the already permission-controlled, atomically persisted **read-only retention due checkpoint**; no compaction, purge, Telegram requests, auto scheduler or notification. Successful stdout is one concise aggregate-only JSON status; failures return nonzero with fixed sanitized error codes.
- Added `npm run retention:review` for explicitly invoked operators; no scheduled workflow configured.
- Added 10 tests (348/348 passing) including real independent Node SQLite subprocesses, concurrency idempotence, path permission hardening and malicious flag refusals, while preserving preexisting B0–B4 and B2 tests. Node 22 experimental SQLite warnings are isolated in the test harness.
- No production DB changes, provider credentials, actual Telegram deletion, deployed cron, or backup-retention automation.

## 0.5.4 — 2026-10-20 — Owner opt-in review checkpoints (offline, no automatic retention)

- Added backward-compatible optional `PurgeRetentionReviewControl` to existing `BotStore` v8. No schema migration or separate database; legacy saved states default disabled.
- Owner-only `configureRetentionReview` and `getRetentionReview`: bounded 1–30 day cadence, strict setting keys/types, durable next check and version, clearing old aggregate notice on reconfiguration or disable.
- Explicit `tickRetentionReview` computes only a privacy-minimized `PurgeRetentionPreview` when due, recording the next check and fixed-code audit without redacting data or reaching Telegram; disabled/not-due/reversed-clock invocations make no semantic state changes.
- SQLite-independent and concurrent JSON workers atomically claim one due tick; interruptions/long outages do not flood missed checks. A malformed saved control record is rejected rather than causing a background deletion or silent bypass.
- Review notices carry only counts/digest, expire in 10 minutes, and do not relax the separate owner approval and fingerprint checks of `compactRetention`.
- Added 18 mock regression tests across JSON and SQLite (338/338 total). No real job scheduler, external notification, production backup deletion, or live Telegram action.

## 0.5.3 — 2026-10-20 — Offline owner-reviewed retention with immutable purge safety tombstones

- Added read-only `previewRetention` and owner-confirmed `compactRetention` with 10-minute, state-digest-bound dry-run and atomic stale-plan rejection across JSON/SQLite.
- Locally prunes observed metadata older than 48 hours from sentAt. Redacts sender filters, freeform review reasons, evidence IDs and attempt-related fields only for fully terminal jobs at least 30 days beyond their last recorded action; unknown/in-flight/unresolved jobs are never redacted.
- Preserves each finalized job's chat/message reservation IDs, statuses, reviewer attribution and minimal coded audit history, keeping non-repeatability even after privacy cleanup.
- Replaces stored evidence IDs with domain-separated SHA-256 tombstones and checks both raw/historical hashed IDs to prevent reuse for another UNKNOWN attempt. Migrates legacy plaintext evidence in old audit keys; new reconciliation audit keys use hashes from the outset.
- Adds staged CI tests for review immutability, time-window expiration, late human decisions, cancelled UNKNOWN protection, legacy audit scrub, proof replay denial, dry-run information minimization and independent SQLite stale previews. No new schema number; optional v8 field only.
- This is NOT automated production retention or cleanup of old backups. No real Telegram calls, deletions or production DB access.

## 0.5.2 — 2026-10-20 — Explicit UNKNOWN purge outcome reconciliation (TESTED_MOCK)

- Implemented `PurgeEvidence` exact proof binding (evidence ID, approved chat ID, message ID, immutable attempt ID, ACKNOWLEDGED vs FAILED_CONFIRMED).
- Fake gateway now provides an independent asynchronous `verifyEvidence` contract, with a test-only evidence registry; no real Telegram verification. Rechecks authorization, proof status, uniqueness and identity after await inside one transaction, including SQLite.
- Owner-only `skipForReview` explicitly records a bounded reason as `SKIPPED_UNVERIFIED`, without ever converting absence of evidence into deletion success.
- Added access-restricted aggregate `reviewProgress` (accepted requests are not verified physical deletes; deletedConfirmed remains 0), preserving original receipts and cancellation status.
- Reconciliation remains permitted for uncertain attempts from already cancelled jobs to settle historical evidence, never permitting further sends; verified FAILED_CONFIRMED is not auto retried.
- Added 14 TDD tests (303/303 total) for JSON, SQLite, invalid/reused evidence, revoked reviewers, async racing decisions, report privacy and absence of network replay. Existing BotStore schema v8 retained with additive optional per-item reconciliation metadata.
- No live Telegram or production DB interaction; verified mock receipts must not be presented as actual deletion confirmation.

## 0.5.1 — 2026-10-20 — B2-Advanced fake 429 safety and per-chat purge sequencing

- Added strict structured fake gateway rate-limit outcome with valid retryAfterMs (1–3,600,000), preserving exact item after a confirmed rejected request.
- Persisted cooldown on the canonical purge job and enforced the maximum chat cooldown across all jobs, including after restart. No automatic retry; next explicit dispatcher call must revalidate rights, approved scope and observed-message fingerprint.
- Malformed rate-limit payloads, unrecognized gateway statuses and thrown exceptions mentioning 429 become UNKNOWN_OUTCOME and block replay.
- Count 50 UTC-day request attempts from immutable audit intents, not mutable per-item startedAt; confirmed-429 repeats still count and cannot bypass the daily quota.
- Serialized same-chat jobs whenever another job has a SENDING request; independent SQLite workers cannot issue overlapping deletes in the same chat during preflight.
- Added 11 offline tests (289 total) including JSON/SQLite confirmation, malformed responses, reset-safe daily accounting, same-chat contention, revocation, protection edits and cancellation.
- Mock-only with no Telegram tokens, chat history API, live deletes or production activation. Node 22 SQLite backend remains experimental.

## 0.5.0 — 2026-10-20 — First B2-Advanced rolling metadata and preview-first purge (mock only)

- Added metadata-only 48-hour rolling message index for explicitly moderation-approved chats, refusing message texts/media payloads and unknown-sender attribution.
- Added immutable, time-scoped purge previews, reviewed IDs and exclusion counts for pinned/linked-channel/admin logs/approved posts. Preview never causes deletion.
- Added explicitly confirmed, auditable jobs and a fake gateway with durable per-message attempts, permission recheck after awaits, unknown-result quarantine, lease-aware restart recovery, cancellation and duplicate-reservation guards.
- At most 25 selected IDs per preview; 10+ requires owner co-confirmation (strictly more than 10). Maximum 50 attempts per UTC day, checked at approval and at actual send time to stop cross-midnight overflow.
- Added additive BotState schema v8 preserving all B3/B4 records. Added JSON and SQLite tests including independent worker competition, revocation, expiry, old-state recovery, cancellation and double-confirmation.
- No Telegram Bot API mutations, no actual message deletion, no scraping or claim of complete chat history. This is TESTED_MOCK; other B2-Advanced modules remain PLANNED.

## 0.4.7 — 2026-10-20 — Cancellation-safe campaign parts, evidence and reviewer audit (mock-only)

- Fixed B4 campaign cancellation leaving queued multipart parts in a misleading pending state. Cancel unstarted/confirmed-failed tails while preserving previously SENT parts and real mock receipts.
- Keep active SENDING or unresolved UNKNOWN parts in the canonical delivery ledger until send returns or independent evidence arrives. Do not allow a late worker to requeue or send a part after cancellation while preflight was awaiting canPost.
- Settlement after verified receipt of a formerly UNKNOWN part closes the aggregate cancelled delivery without claiming that unsent parts were published.
- Terminal CANCELLED and SKIPPED deliveries cannot be relabelled or have their manual-review reason overwritten.
- Add an actor-specific, exactly-once cancellation audit record in BotState; individual manual-skip audit now includes the reviewer.
- Added JSON + SQLite test coverage for cancelled multi-part flows, preflight and in-flight races, timeouts, part-history retention and idempotence, retaining the same single B4 publishing ledger.
- **No real Telegram adapter, live platform interaction or production activation.** SQLite and offline gateways are still simulations requiring operational and security review.

## 0.4.8 — 2026-10-20 — Canonical message-part checks and receipt integrity (mock-only)

- Reconstruct canonical multipart text/parts from the current approved resource copy at every dispatch, including legacy campaigns without a retained render-plan object. Tampering the stored approved fingerprint or staged text cannot bypass review.
- Verify provider `messageId` input shape for single and multipart fake results and receipt reconciliation: malformed, control/BiDi, blank, whitespace-padded and oversized identifiers never become confirmed sends.
- Fail closed when a malformed or migrated state contains duplicate reservations or a matching historical review claim for the same resource revision and destination. Recheck after await, after simulated network completion, during explicit confirmed-failure retries and during UNKNOWN proof reconciliation.
- In-flight historical conflicts quarantine ambiguous replies as UNKNOWN_OUTCOME rather than claiming SENT, preserving attempts for independent review; no network resend is triggered.
- Added adversarial integration tests across JSON/SQLite and legacy/multipart/single senders. This remains TESTED_MOCK only; all real Telegram/outbound verification and normalized production DB work is still blocked.

## 0.4.6 — 2026-10-19 — Fenced dispatch recovery and tightened multipart permissions (mock-only)

- Added a per-attempt durable 120-second recovery lease to both single publication deliveries and multipart parts, stored in the original canonical BotStore ledger. SENDING intents are persisted before the mock gateway request.
- Recovery from a restarted or competing worker leaves active attempts alone. Expired leases and legacy unleased orphan attempts are quarantined UNKNOWN_OUTCOME, with no automatic resend. A delayed worker also checks expiry after asynchronous gateway-permission checks before initiating a send.
- Closed a scoped authorization gap in multipart retry and receipt reconciliation: the acting reviewer requires content.publish on BOTH source and destination, before and after provider verification.
- Kept existing no-automatic-retry, unique verified receipts and immutable B3 content approval. Confirmed retries clear old attempt and lease metadata.
- Added 15 tests spanning JSON and SQLite storage, independent SQLite recovery processes, forced expiry, crash-compatibility, and revocation during evidence verification. 214 total passing tests after build/typecheck and mock demos.
- TESTED_MOCK only; leases are conservative quarantine fences, not distributed worker heartbeats or authorization for real Telegram.

## 0.4.5 — 2026-10-19 — B4 transactional SQLite test backend

- Added opt-in `BotStore(file, {engine:'sqlite'})` while keeping existing JSON simulations unchanged. One canonical BotState and B4 reservation/receipt ledger, not a second publishing engine.
- Added Node 22 SQLite WAL / BEGIN IMMEDIATE / synchronous FULL transaction commits to serialize writes across separate Node.js processes; durable SENDING/UNKNOWN intent semantics unchanged.
- Added explicit lossless JSON-to-SQLite migration with strict no-overwrite behavior, including schema v5 legacy B3/B4 resources/campaign receipts/historical reviews.
- Added verified online SQLite backup using node:sqlite backup API; existing backups cannot be silently overwritten. Invalid states and sources fail closed.
- Added cross-process worker integration tests: competing approvals, distinct reservations, duplicate dispatch exclusion, transaction rollback/read isolation, multipart crash recovery, backup/restore and corrupt-state rejection.
- This is TESTED_MOCK only: experimental Node 22 sqlite API, one serialized state row, no production load / power-loss tests, no real Telegram or MANARATAK platform access.

## 0.4.4 — 2026-10-19 — Historic publication review guard and late reconciliation (mock-only)

- Added an explicitly authorized, item-specific historical review import that uses the existing B4 reservation boundary, never a second outbound sender. A last forwarded Telegram post/ordinal is not evidence of prior publications.
- Stored distinct PUBLISHED_VERIFIED, UNVERIFIED, REVIEW_REQUIRED and MANUALLY_SKIPPED historical statuses in additive schema v7. A historical claim for the same resource revision/destination prevents a duplicate B4 campaign approval.
- Verified receipt uniqueness across historical items and normal/multipart dispatch; conflicting message IDs are quarantined rather than counted as successful sends.
- Added late provider-verified reconciliation and documented explicit manual skip for unresolved historic records; both recheck scoped authorization, preserve audit history and never auto-resend.
- Preservation tested across schema v6→v7 and prior version migrations; protected earlier B3 resources, B4 campaigns and receipts.
- New integration tests for historical review, concurrency, policy revocation during verification, receipt conflicts, restart, and evidence/skip resolution. No Telegram or platform production calls.
- B4 remains TESTED_MOCK; transactional multi-worker storage and hardened real verification/outbound adapters are pending before live activation.

## 0.4.3 — 2026-10-19 — Reviewed multipart campaign integration (mock-only)

- Reproduced the gap with a RED GitHub Actions integration test first, then implemented a reviewed long-form copy workflow on published B3 resources.
- Ordinary B4 draft now attaches the canonical UTF-16-safe multipart render plan; campaign approval stores its exact part fingerprint and reserves each part **inside the original delivery ledger** before any external fake send.
- Unified ordinary dispatch for short and multipart campaigns; each multipart attempt is durable and audited before gateway calls. Crash recovery, ambiguous outcomes, permission revocation after awaits, archived/stale resources and duplicate reservations are guarded by integration tests.
- Schema v5→v6 is additive and retains existing B3 resources, historic campaigns, deliveries and receipts; legacy v1→v5 migrations continue to work.
- Kept MultipartTestStore strictly experimental/test-only; no second operational publishing ledger or live Telegram adapter.
- Production readiness remains **BLOCKED** by single-process JSON storage and lack of a hardened real delivery adapter. Draft PR only; no main merge.

## 0.4.2 — 2026-10-19 — B4 multipart WIP handed off for continued review

- Preserved two previously local-only multipart experiments and their focused offline tests.
- Added CampaignMultipartService staging into the existing approved B4 campaign delivery ledger; part-level receipts and UNKNOWN_OUTCOME per attempt.
- Extended B4 local store types with MULTIPART and immutable part snapshot. Core dispatcher blocks a staged multipart item; manual skip cannot silently erase its partial history.
- The stand-alone MultipartTestStore module is **experimental** and MUST NOT be wired into operational publishing: its duplicate ledger is not integrated with existing reservations.
- **Not yet complete**: no live Telegram sending; historical content preview length caps, real campaign creation with long content, single-worker DB migration/receipts and production safety still need an explicit end-to-end review.
- CI will run merged cumulative tests on GitHub; earlier 144 local-only tests were run on older B3-era workspace and cannot prove compatibility with B4.

## 0.4.1 — 2026-10-19 — B4 offline review-only preview and migration planning

- Deterministic Telegram text/photo/link-preview planning; conservative UTF-16 length boundaries, explicit text fallback, no URL splitting or rendering guarantee.
- Historical publication review preview: item-specific trustworthy evidence required, duplicate receipt conflicts require review, last-forwarded/ordinal cutoff never verifies earlier items, manual skip is a separate non-published state.
- 25 new offline tests plus sample preview/migration report; no Telegram sends and no production migration.

## 0.4.0 — 2026-10-19 — B4 campaign/receipt ledger (mock-only, initial slice)

- Versioned plain-text publication previews based on locally approved education resources, destination `publishing` authorizations and explicit campaign approval.
- Durable local test campaign + per-item delivery state, cross-campaign duplicate reservation and restart-safe `UNKNOWN_OUTCOME` on orphaned `SENDING`.
- Pre-send validation of approver grant, source/destination policy revisions, category status, approved text, and fake bot posting rights.
- Confirmation vs confirmed failure vs ambiguous delivery, trusted receipt reconciliation, explicit retry of confirmed failure, manual skip recorded distinctly.
- Scheduled/paused/cancelled flows and ordered delivery (a pending uncertainty blocks later items); no real Telegram API, worker queue or production multi-process storage.
- 19 new tests (110/110 total), local publishing demo, `schemaVersion 4→5` migration; B0–B3 tests retained.
- All B4 functions are `TESTED_MOCK`, **not real sends, real campaign publication, B4 completion or production readiness**.

# Changelog

## 0.3.3 — 2026-10-19 — B3 file intake and Mini App authorization (offline)

- Simulated Telegram document intake with pre-download authorization, file ID/type/size checks, strict UTF-8 and reauthorization after asynchronous fake download.
- Telegram Mini App server-side HMAC verification, signed identity and freshness; bounded localhost-only JSON admin actions.
- End-to-end cross-transport test: fake Telegram document → web approval and local publication → safe group browsing and revocation.
- 21 additional tests since v0.3.2, **91/91 successful locally**; GitHub CI checked on the new branch.
- Fixed a Node.js `node:events` test import incompatibility found by the clean GitHub Actions typechecker (static named `once` import).
- No real Bot API download, live group messages, browser UI, campaigns or AI; no production connection.


## 0.3.2 — 2026-10-19 — B3 inbound Telegram transport, test-only

- Inbound localhost-only webhook listener with Telegram shared-secret validation, JSON/size/type/route checks and no outbound delivery.
- Offline Telegram message parser and safe reply-plan renderer for admin, import, review, catalog and curated FAQ commands.
- Fixed private-chat enumeration of group resources: require fresh trusted group membership before listing; recheck chat permission after async lookup.
- Regression tests for subscription-gated FAQ (including denied/unavailable), private group membership and revocation during verification.
- 13 new tests over v0.3.1, 70 total tests; all mock/local only; GitHub CI pending until uploaded.
- No live Telegram token, real document download, web admin auth, outbound send, AI or channel publication.

## 0.3.1 — 2026-10-19 — B3 approved FAQ, links and admin facade (mock only)

- Curated FAQ drafts, publisher approval, bounded aliases, explicit ambiguity and source visibility gates.
- Short server-side share references with TTL, group membership verification port and post-check revocation enforcement.
- Minimal transport-independent admin facade with guarded Telegram-private and web admin contexts.
- Privacy-safe resource projections for student views; v3→v4 additive migration.
- 16 focused new security and flow tests, 57 total; typecheck and offline demos.
- No Telegram/Web connectivity, webhook, AI provider, paid service, live publication or production migration.

## 0.3.0 — 2026-10-19 — B3 education/import simulation

- Education category tree scoped by approved chats/private feature, sort order, visibility and archive.
- Deterministic importer for MD, TXT, CSV, JSON with input bounds and source evidence.
- Separate university, potential scholarship, duplicate, ambiguity and explicit-seat counts.
- Independent upload/approve/publish actions; no AI or Telegram publishing.
- Content-hash replay protection, state schema v3 additive migration, B3 offline demo.
- 11 new B3 tests, 41 total tests, documented remaining gaps.

## 0.2.0 — 2026-10-18 — B2-Core mock moderation and subscription

- Simulated member warning ledger, manual/subscription restrictions, ban vs mute precedence, safe reconciliation.
- Approved-channel subscription checks ALL/ANY, unknown verification is not a confirmed violation.
- Migration from B1 to B2 storage. No real Telegram actions.

## 0.1.0 — 2026-10-18 — B0/B1 simulated core

- تأسيس مشروع TypeScript مستقل بدون token أو اتصال Telegram.
- نواة التحقق والمالك/القائمة البيضاء/التفويض ومنع التصعيد.
- UpdatePipeline وتسجيل نية الأثر والنتائج مع lease/restart وUNKNOWN.
- CallbackActionCodec بمرجع خادمي قصير محمي بالفاعل/النطاق/النسخة/TTL.
- OutboundPriorityPolicy مع fairness وretry_after والتحقق عند dequeue.
- WizardSessionStore مع عزل الموضوع/CAS وانتهاء وإلغاء واستعادة.
- سياسات AI للمجموعات/الخاص مستقلة؛ تظل AI غير مهيأة.
- 15 اختبارًا بمحاكاة ومثال تجربة وقرار B0 ومصفوفة تتبع.

**غير متاح:** تشغيل Telegram والذكاء الاصطناعي وحظر/نشر أو استيراد ملفات أو الربط المباشر بمنارتك. لا انتشار تلقائي.
