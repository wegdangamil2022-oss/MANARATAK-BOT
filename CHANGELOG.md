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
