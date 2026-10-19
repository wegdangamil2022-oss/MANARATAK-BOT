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
