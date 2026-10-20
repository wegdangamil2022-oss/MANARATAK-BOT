# مصفوفة التتبع / القبول

مرجع: MANARATAK_BOT_MASTER_v1.2.1_AR.md و START_HERE_MANARATAK_BOT_v1.2.1_AR.md على `docs/bot-specs-v1.2.1`.

| المتطلب أو الاختبار | التطبيق | الحالة | الإثبات |
|---|---|---|---|
| B0 جرد وفرع مستقل | docs/DECISIONS.md | IMPLEMENTED | جرد الفرعين وAGENTS |
| v0.1 النواة والمالك والسماح والتفويض | store.ts / policy.ts | TESTED_MOCK | اختبارات owner, grant, revoke, default-deny |
| S121-01؛ T121-01..04 | pipeline.ts / store.ts | TESTED_MOCK جزئيًا | تكرار/lease/restart/UNKNOWN ومنع قبل المحتوى والبوابة وحقوق وهمية |
| S121-02؛ T121-05 | callback.ts | TESTED_MOCK | actor/scope/version/TTL/one-shot/public/reference bytes |
| S121-03؛ T121-06 | outbound.ts | TESTED_MOCK | P0/P1/P2, retry-after, stale authorization, UNKNOWN exclusion |
| S121-04؛ T121-07 | wizard.ts | TESTED_MOCK | topic/flow isolation, CAS, cancel/back/restart/expire |
| ASKCFG-001؛ T12-01..03 | policy.ts / pipeline.ts | TESTED_MOCK سياسة فقط | owner/staff/all mention؛ لا AI متصل |
| ASKCFG-002/003؛ T12-05 | policy.ts | TESTED_MOCK سياسة فقط | private AI OFF مقابل dashboard/verify/education |
| ASKCFG-004؛ T12-06 | gateway boundary / policy reevaluation | IMPLEMENTED عقد جزئي | إعادة تحقق خروج؛ لا يوجد AI job حي لإثبات إلغاء أثناء التوليد |
| T12-07 | pipeline.ts | TESTED_MOCK | مجهول group لا تنزيل ولا AI، fake leave |
| B2-Core: MOD-003 إنذار | moderation.ts | TESTED_MOCK | منع المحمي وتدقيق الحالات والإلغاء بمراجع |
| B2-Core: MOD-004/005 قيود | moderation.ts | TESTED_MOCK | سبب يدوي/اشتراك متداخل، BAN>MUTE، outcome مجهول وتزامن وسحب التفويض |
| B2-Core: GATE-001..003/006/009 | subscription.ts + pipeline.ts | TESTED_MOCK جزئيًا | ALL/ANY، قناة غير مصرح بها، UNAVAILABLE، عدم الثقة بعلم حدث وارد |
| B2-Core التخزين | store.ts | TESTED_MOCK | ترحيل schemaVersion 1 إلى 2 بأمان وفحص الحالة السابقة |
| B3: HUBCFG-001/003؛ T12-17 جزئيًا | education.ts | TESTED_MOCK (شريحة) | شجرة فئات وتصفّح قائم على السماح وإبطال الظهور بعد التعطيل/السحب |
| B3: DOCFLOW-001/002؛ T12-09/10/12/16 جزئيًا | ingestion.ts / education.ts | TESTED_MOCK (شريحة) | ملفات CSV/JSON/MD/TXT وهمية؛ تقرير عد وتكرار/غموض؛ لا معالجة PDF ولا ذكاء اصطناعي |
| B3: DOCFLOW-004؛ T12-22 | education.ts | TESTED_MOCK (شريحة) | فصل الصلاحيتين ومرحلة الاعتماد عن النشر المحلي؛ منع نشر غامض/مكرر |
| B3: تخزين/إعادة تشغيل | store.ts + b3-education.test.ts | TESTED_MOCK | ترحيل v2→v3؛ hash dedupe؛ نشر متزامن واحد؛ 11 اختبار B3 جديد |
| B3: S121-10؛ T121-13 / QARCH | education-interactions.ts | TESTED_MOCK | FAQ بمصدر منشور ومراجعة ومطابقة محددة، يمنع عند OFF واللبس وأرشفة المصدر |
| B3: S121-11؛ T121-14 / HUBCFG-003/004 | education-interactions.ts | TESTED_MOCK | مراجع قصيرة، تحقق عضو موثوق، TTL، actor binding، سحب تصريح/restart، إعادة فحص بعد await |
| B3: واجهة الإدارة المحاكية | education-admin.ts | TESTED_MOCK عقد فقط | تحقق سياق سابقًا من adapter خارجي، وفصل upload عن publish؛ لا HTTP/Telegram فعلي |
| B3: الخصوصية | education.ts | TESTED_MOCK | خرج الطالب منقح ولا يحتوي بيانات المراجع أو import IDs |
| B3: schema v4 | store.ts | TESTED_MOCK | ترحيل 1→2→3→4 مع احتفاظ بالمنح والموارد، 110 اختبارًا |
| B3: غلاف Telegram الوارد / T12-07 | telegram-transport.ts + telegram-transport.test.ts | TESTED_MOCK (HTTP محلي) | سر webhook وهمي، مخطط update موثق، حد 64KiB، مخرجات reply-plans فقط بلا إرسال |
| B3: ضبط وصول الخاص لنطاق مجموعة / T12-21 | telegram-transport.ts | TESTED_MOCK | تحقق VERIFIED واشتراك إن لزم وإعادة تفويض بعد async؛ منع تسرب فئات/موارد |
| B3: بوابة اشتراك FAQ المعتمد / T121-13 | telegram-transport.test.ts | TESTED_MOCK | أمر /ask@Bot يخضع لشرط الاشتراك بالضبط مثل /categories |
| B3: تحميل مستندات Telegram / DOCFLOW-001، T12-09 جزئيًا | telegram-transport.ts + telegram-documents.test.ts | TESTED_MOCK | مرجع ملف تجريبي، فحص الحجم والصيغة وUTF-8 والمستخدم والتصريح قبل التنزيل وبعده؛ لا getFile فعلي أو مضاد فيروسات |
| B3: مصادقة Mini App / SEC-003 وSEC-004 جزئيًا | web-admin-auth.ts + web-admin-auth.test.ts | TESTED_MOCK (HTTP محلي) | تحقق HMAC وauth_date ومنع تزوير الهوية ورفض تكرار الحقول وHTTP مصرح؛ ليس Mini App منشورًا |
| B3: تكامل Telegram→Mini App→مكتبة مع سحب الإذن / DOCFLOW-004 جزئيًا | tests/b3-cross-transport.test.ts | TESTED_MOCK | HTTP محلي بتوكن مزيّف؛ لا نشر Telegram حقيقي؛ 91/110 اختبارًا ناجحًا |
| B3: اتصال Telegram/Web حي ومسح الملفات ومراجعة المصادر | — | PLANNED | لا webhook منشور أو إرسال، ولا تنزيل فعلي ولا فحص فيروسات أو لوحة ويب مستضافة |
| B4: DOCFLOW-003؛ S121-07/08 جزئيًا، T12-13/15، T121-10/11 جزئيًا | publishing.ts + tests/b4-publishing.test.ts | TESTED_MOCK (شريحة) | معاينة مؤرخة ومعتمدة، فصل المصدر والوجهة، ledger مانع تكرار، تسجيل SENDING قبل أثر وهمي، timeout UNKNOWN، استكمال/restart، receipt فريد، وقف عند تغيير الصلاحيات، 19 اختبارًا |
| B4: S121-09 ترحيل الصين، مُخرجات Telegram فعلية، منشورات صور/معاينات، جدولة ذات طابور DB دائم | — | PLANNED | لا نشر حي ولا استنتاج أن آخر منشور يثبت السابق |
| B2-Advanced / B5 / B6 / B7 | — | PLANNED | لا نشر حي أو AI أو ربط منصة إنتاج |

`TESTED_MOCK` لا يعني `TESTED_LIVE_PRIVATE` أو `ACTIVATED`. لا يُزعم إتمام 703 متطلبًا؛ الوثيقة أصل التتبع الكامل، وهذا الملف يختص بما تم تنفيذه جزئيًا من B0/B1/B2-Core وشريحة B3.

الدفعة B4 هنا شريحة اختبار محلي فقط، وليست تفعيلًا للحملات أو إثباتًا لأي رسالة Telegram فعلية.

| B4: S121-07؛ T121-10 (حدود العرض والمعاينة) | publication-preview-plan.ts + b4-preview-migration.test.ts | TESTED_MOCK (مخطط مستقل) | نص 4096/وصف صورة 1024/منع تقسيم URL وتجزئة سليمة/بديل لا يعمل إلا باعتماد صريح؛ لا عرض مرئي Telegram مثبت |
| B4: S121-09؛ T121-12 (ترحيل الصين) | legacy-publication-migration.ts + b4-preview-migration.test.ts | TESTED_MOCK (تقرير فقط) | لا إثبات تلقائي للمنشورات السابقة من آخر منشور، إثبات منفرد من verifier خارجي، UNKNOWN منفصل عن MANUALLY_SKIPPED ومراجعة التعارض؛ لا ترحيل DB إنتاجي |

| B4 v0.4.2 multipart WIP | campaign-multipart.ts + b4-campaign-multipart.test.ts | TESTED_MOCK جزئيًا | تحفظ حالات أجزاء الرسالة وإيصالاتها عبر ملف تجريبي؛ تم منع dispatcher التقليدي من استهلاك MULTIPART، ولم يثبت المسار الكامل لمسودة B4 عادية أو إرسال Telegram حي |
| B4 experimental separate ledger | multipart-publishing.ts + b4-multipart-publishing.test.ts | EXPERIMENTAL_TEST_ONLY | نموذج موازٍ للاختبار فقط وغير مسموح ربطه بحملات الإنتاج |

| B4 v0.4.3 reviewed multipart flow; DOCFLOW-003, S121-07/08, T12-13/15, T121-10/11 (partial) | education.ts + publishing.ts + campaign-multipart.ts + tests/b4-reviewed-multipart-flow.test.ts | TESTED_MOCK (end-to-end local workflow) | B3 reviewed resource → explicit reviewed publication copy → canonical multi-part draft → approval binds immutable part plan in the **single** BotStore delivery → durable intents/receipts/restart/UNKNOWN; no live adapter |
| B4 storage v5→v6 | store.ts + B4/B3/B2 migration tests | TESTED_MOCK | Older delivery receipts, campaigns and education records preserved, no dropping ledgers |
| B4 multi-worker SQL transaction, Telegram outbound and deployed reconciliation | — | PLANNED / BLOCKED_LIVE | JSON single-process mutex is not distributed locking; no production execution authorization |

| B4 v0.4.4 S121-09 / T121-12 historical-to-campaign guard | legacy-campaign-review.ts + publishing.ts + campaign-multipart.ts + tests/b4-legacy-campaign-review.test.ts | TESTED_MOCK (review registry + campaign integration) | Per-item verified/unknown/skip/review states from approved resources; last forwarded ordinal is NOT bulk publication evidence; approvals fail closed on historical collisions; independently verified late reconciliation without resend |
| B4 v0.4.4 schema v6→v7 | store.ts + b4-legacy-campaign-review.test.ts | TESTED_MOCK | Additive historical registry with previous campaigns, receipts and resources preserved; malformed current state rejected |
| B4 production receipt verifier + multi-worker persistence + authorized real channel migration | — | PLANNED / BLOCKED_LIVE | No real Telegram verifier, database/outbox or production scheduler; history statuses cannot be claimed as TESTED_LIVE_PRIVATE |

| B4 v0.4.5 cross-process transactions / DOCFLOW-003, S121-07/08 (partial) | store.ts (optional sqlite), tests/b4-sqlite-store.test.ts + b4-sqlite-worker.ts | TESTED_MOCK_SQLITE | BEGIN IMMEDIATE / WAL serializes competing approvals and dispatch in independent Node processes; one canonical BotState ledger and pending attempts remain UNKNOWN after restart |
| B4 v0.4.5 JSON-to-SQLite import and verified backup | BotStore.importJsonToSqlite / backupSqlite | TESTED_MOCK_SQLITE | Existing B3/B4 v5-v7 data preserved, corrupted and duplicate migrations refused, backup is online and non-overwriting; snapshot read isolation and rollback tested |
| B4 normalized production schema, operational restore drills, monitoring, Telegram proof verification | — | PLANNED / BLOCKED_LIVE | SQLite full-state-row prototype and experimental runtime not production-certified; no actual Telegram delivery or multi-worker deployment |

| B4 v0.4.6 S121-07/08/T121-10/11 lease-aware recovery (partial) | publication-worker-lease.ts + publishing.ts + campaign-multipart.ts + tests/b4-fenced-recovery.test.ts | TESTED_MOCK_SQLITE (incl. real child process) | 120-second per-attempt lease persists in single canonical ledger; recovery skips active attempts, expired/legacy attempts become UNKNOWN; late workers cannot send after expiry |
| B4 v0.4.6 T12-13/15 scoped multipart review (partial) | campaign-multipart.ts + tests/b4-fenced-recovery.test.ts | TESTED_MOCK | Both source and destination editor publication permissions checked before and after external receipt verification and before explicit FAILED_CONFIRMED retry |
| B4 production worker supervision / real Telegram proof / distributed heartbeat | — | PLANNED / BLOCKED_LIVE | Leases are fixed, not renewable distributed ownership; do not mistake quarantine/fencing mock for Telegram exactly-once delivery |

| B4 v0.4.7 DOCFLOW-003 / S12-21, S12-22, S12-23 / T121-10/11 | publishing.ts, campaign-multipart.ts, publication-receipts.ts, publication-reservation-integrity.ts, tests/b4-immutable-parts-receipts.test.ts | TESTED_MOCK (CI verification required) | Historic v5 approved content cannot have its message parts silently replaced; invalid receipt IDs are UNKNOWN rather than SENT; duplicate delivery/history reservations block approval/send/retry/reconcile before and after async boundaries |
| B4 v0.4.7 deployed Telegram provenance verification and schema-normalized durable queue | — | PLANNED / BLOCKED_LIVE | Mock receipt shape cannot prove Telegram origin; BotStore JSON/SQLite remain offline-only and do not authorize production posting |

| B4 v0.4.7 S121-07/08, PUB-006/008 cancellation and receipt safety (partial) | publishing.ts + campaign-multipart.ts + publication-cancellation.ts + tests/b4-campaign-cancellation.test.ts | TESTED_MOCK (JSON + SQLite) | Atomic campaign cancellation of unattempted part tails, preserving confirmed/unknown attempts; blocked preflight after cancellation; late in-flight receipt settles without mislabeling partial publication |
| B4 v0.4.7 immutable manual-review outcomes/audit | publishing.ts + BotState AuditRecord.actorId | TESTED_MOCK | Exactly-once cancellation audit with actor, idempotent cancel, terminal CANCELLED/SKIPPED not relabelled; no false Telegram receipt |
| B4 remote cancellation, lossless multi-node workers, provider evidence verification | — | BLOCKED_LIVE | Cancellation cannot retract an already submitted Telegram request; UNKNOWN requires trusted external proof, not automatic retry |

| B2-Advanced v0.5.0 S121-06 / T121-09 / MOD-002 (first slice) | moderation-purge.ts + b2-advanced-purge.test.ts | TESTED_MOCK | 48h observed-only metadata (no text/caption), unknown sender preserved, edited flags update, protected messages excluded, no historical coverage promise |
| B2-Advanced v0.5.0 PURGE-001/002/003/004/005/006/008/009/010 (partial) | ModerationPurgeService preview/confirm/dispatch/recover/cancel + b2-purge-worker.ts | TESTED_MOCK | Exact IDs reviewed separately; owner signoff for >10; 50/day at approval and attempt; protected channel/pinned/admin/announcement messages excluded; revocation, cancellation, unknown quarantine and independent SQLite dispatch tested |
| B2-Advanced v0.5.0 schema v7→v8 | store.ts + preexisting migration tests | TESTED_MOCK | Additive message index and jobs preserving old B3/B4 campaigns/receipts; explicit privacy boundary |
| B2-Advanced real deleteMessage/deleteMessages, provider receipt verification, TTL backups, 429 throttle | — | PLANNED / BLOCKED_LIVE | Not connected to Telegram; API restrictions, linked-channel protection and actual admin rights not yet verified with Telegram; no background indexing |

| B2-Advanced v0.5.1 PURGE-007 / S121-06 (partial) | moderation-purge.ts + b2-advanced-purge.test.ts | TESTED_MOCK | Fake structured 429 creates durable per-chat retry barrier; malformed or thrown 429-style responses remain UNKNOWN; no automatic retry or Telegram network call |
| B2-Advanced v0.5.1 PURGE-005/006/007 attempt quota and sequencing | ModerationPurgeService.dispatchNext + immutable audit | TESTED_MOCK | Daily count from all recorded attempts (including confirmed 429), same-chat SENDING serialize, scope and fingerprint rechecked after cooldown; JSON+SQLite tests |
| B2-Advanced verified Telegram 429 scopes, rate scheduler, delete permissions, privacy retention | — | PLANNED / BLOCKED_LIVE | Mock-only strict response adapter; 429 does not prove exactly-once deletion or authorize production deployment |

| B2-Advanced v0.5.2 PURGE-006/007/008, S121-06 review handling (partial) | moderation-purge.ts, store.ts, tests/b2-purge-evidence.test.ts | TESTED_MOCK | Explicit exact evidence binding + injected asynchronous mock verifier, role revocation/recheck after await, no duplicate evidence ID, UNKNOWN never auto-replayed |
| B2-Advanced v0.5.2 terminal manual skip and privacy-scoped progress | ModerationPurgeService.skipForReview/reviewProgress | TESTED_MOCK | Owner-only SKIPPED_UNVERIFIED with auditable bounded reason, counts of request acceptance/UNKNOWN/confirmed failure/cancellation; deletedConfirmed stays zero |
| B2-Advanced verified Telegram deletion status/provenance, retention and real lifecycle | — | PLANNED / BLOCKED_LIVE | Mock proof registry provides no physical delete proof, true issuer authenticity, Telegram integration, or production approval |

| B2-Advanced v0.5.3 S121-06 / PURGE-008 / S12-32 (retention partial) | moderation-purge.ts + tests/b2-purge-retention.test.ts | TESTED_MOCK | Owner-only dry-run and digest-bound explicit compaction; 48-hour observed metadata expiration, completed/cancelled 30-day redaction, immutable evidence and reservation tombstones |
| B2-Advanced v0.5.3 retention consistency / T121-09 safeguards | BotStore v8 optional evidenceDigest + SHA-256 evidence guard | TESTED_MOCK | Legacy audit proof scrub; no reuse of proof IDs after redaction; UNKNOWN/in-flight preservation, stale-preview rejection and SQLite competing writers |
| B2-Advanced live retention service, offsite backup expiration, real Telegram message proof | — | PLANNED / BLOCKED_LIVE | No automatic maintenance, backup expiry or live proof, so neither production privacy SLA nor deletion activation is claimed |

| B2-Advanced v0.5.4 S121-06 / PURGE-008 / S12-32 review cadence (partial) | ModerationPurgeService.configureRetentionReview/getRetentionReview/tickRetentionReview; tests/b2-retention-review-watch.test.ts | TESTED_MOCK | Owner opt-in 24h–30d, durable due/checkpoint, aggregate-only dry-run, disable default, clock rollback/long outage safeguards |
| B2-Advanced v0.5.4 multi-worker due idempotence | BotStore v8 optional PurgeRetentionReviewControl + atomic transaction | TESTED_MOCK | Two parallel instances produce only one due notice, stale 10-minute preview never authorizes compaction, invalid schedule fails closed |
| B2-Advanced actual scheduler, private owner notification channel, deletion/backup lifecycle | — | PLANNED / BLOCKED_LIVE | No live timer configured; no backup purging, Telegram outbound action or automatic owner-approved compaction |

| B2-Advanced v0.5.5 S121-06 / PURGE-008 local review driver (partial) | retention-review-runner.ts / retention-review-cli.ts / tests/b2-retention-runner.test.ts | TESTED_MOCK + LOCAL_CLI | Explicit one-shot command with no live token or deletion path, private existing state, strict args, aggregate-only output and independent SQLite process idempotence |
| B2-Advanced scheduling and secure operator integration | retention:tick script + README | PARTIAL / NOT_ACTIVATED | Working local command only; no cron/systemd setup, owner alerting, remote Telegram actions, backups erasure or autonomous compaction |

| B2-Advanced v0.5.6 retention runner state identity hardening | retention-review-runner.ts + tests/b2-retention-runner.test.ts | TESTED_MOCK | Empty SQLite/forged SQLite header cannot initialize tables; parent symlinks and lexical path aliases fail closed before creating review checkpoint |
| B2-Advanced production host ACLs and atomic trusted-file opening | — | PLANNED / BLOCKED_LIVE | Canonical path checks are not a complete defense against privileged host TOCTOU; secure production service file ownership and isolation remain out of scope |

| B4 v0.5.7 S12-31 SQLite backup validity and restore safety | BotStore.backupSqlite / tests/b4-backup-guard.test.ts | TESTED_MOCK | Read-only source preflight, no accidental SQLite initialization, canonical/symlink checks, WAL-safe backup, private output and existing-destination preservation |
| B4 v0.5.7 S12-32 personal data in backups | README + docs/DECISIONS.md | PARTIAL / BLOCKED_LIVE | Backup retains original snapshot history; no automatic encryption, deletion, backup TTL, or offsite GDPR/data-subject erasure |

| B4 v0.5.8 S12-31 backup recovery health and S12-32 retention inventory (partial) | backup-retention-review.ts + BotStore.verifySqliteBackupReadOnly + tests/b4-backup-retention-review.test.ts | TESTED_MOCK | 12 regression tests; private path / file rights / symlinks, readonly integrity + schema checks; 1–365 day advisory age, bounded listing, no automatic delete |
| B4 v0.5.8 actual backup expiry, restore drills, offsite archive & GDPR policy | — | PLANNED / BLOCKED_LIVE | Candidate age is advisory only; no erasure authority, production SLA, offsite inventory or scheduler |

| B4 v0.5.9 S12-31 private restore drill and state round-trip validation | backup-restore-drill.ts / tests/b4-isolated-restore-drill.test.ts | TESTED_MOCK | 12 TDD tests, isolated SQLite scratch, full BotState equality, unknown purge/publication attempt preservation, concurrent files, private path/ACL checks, scratch/WAL/SHM cleanup |
| B4 v0.5.9 live disaster recovery / S12-32 offsite retention | — | PLANNED / BLOCKED_LIVE | No restoration into production, network Telegram replay, backup lifecycle deletion, offsite RPO/RTO SLA or filesystem-race adversarial proof |

| B3 v0.6.0 first live Telegram reply boundary | telegram-replies.ts / telegram-transport.ts / telegram-live-server.ts / tests/telegram-reply-delivery.test.ts | IMPLEMENTED_OFF_BY_DEFAULT | 17 mocked end-to-end tests, durable intent and fencing, real POST shape and webhook adapter with explicit enable gates |
| B3 v0.6.0 production Telegram webhook and secure state operations | — | BLOCKED_LIVE | No public deployment or real Bot API acceptance; group membership check, runtime secret provisioning, reply content retention and sent-attempt reconciliation remain pending |
