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
| B3 FAQ وروابط موارد متقدمة؛ B4 / B2-Advanced / B5 / B6 / B7 | — | PLANNED | لا وصل حي أو AI أو نشر Telegram |

`TESTED_MOCK` لا يعني `TESTED_LIVE_PRIVATE` أو `ACTIVATED`. لا يُزعم إتمام 703 متطلبًا؛ الوثيقة أصل التتبع الكامل، وهذا الملف يختص بما تم تنفيذه جزئيًا من B0/B1/B2-Core وشريحة B3.
