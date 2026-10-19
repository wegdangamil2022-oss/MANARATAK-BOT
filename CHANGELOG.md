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
