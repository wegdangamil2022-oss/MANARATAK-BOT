# سجل قرارات B0/B1

تاريخ الفحص: 18 أكتوبر 2026، حساب GitHub `wegdangamil2022-oss`، مستودع `MANARATAK-BOT`.

1. **B0 baseline:** الفرع `main` كان يحوي `README.md` مختصرًا فقط. المواصفة MASTER وSTART_HERE v1.2.1 مثبتتان في الفرع `docs/bot-specs-v1.2.1`، وليستا مدمجتين في `main`. لم يوجد AGENTS.md في شجرة الفرعين المفحوصين. التعديلات هنا في مسار بوت مستقل فقط؛ لا تعديل لـ`MANARATAK-First-`.
2. **نطاق B1:** تنفيذ نواة TypeScript وعقود وخط معالجة وأزرار وأولويات وجلسات واختبارات محاكاة. لا Telegram فعلي، ولا مستورد، ولا نشر، ولا عقوبات، ولا AI متصل.
3. **التخزين:** اخترنا BotStore ملف JSON بعزل اختبارات وكتابة temp+rename وmutex ضمن العملية. هذا يُظهر حالات recovery/UNKNOWN لكنه **ليس مستودع إنتاج** ولا يدعم معاملات موزعة أو ضمان fsync/backup عبر عمليات مختلفة. شرط B2 قبل أي live: قاعدة معاملات موثوقة، migrations معزولة، locking/lease متعدد العمليات ونسخ احتياطي مجرب.
4. **الهوية:** ownerId محقون من التهيئة الموثوقة وليس من نص Telegram. لا تفويض ذاتي، لا تفويض مفوض إلى آخر في B1، ولا رفع صلاحيات Telegram من منح البوت.
5. **الـAI:** حتى إذا سمحت سياسة المنشن، يرجع `AI_NOT_CONFIGURED`. إعدادات الطالب والخاص ولوحة المالك والتحقق مستقلة.
6. **المغادرة:** نسجل قرار الرفض ثم intent، نتحقق مجددًا قبل الإرسال، ونسجل outcome. نتيجة UNKNOWN لا تصبح فشلًا يقود لتكرار. مغادرة أُرسلت بالفعل لا يمكن سحبها.
7. **لا أسرار:** لا token حقيقي أو ملفات `.env`، لا تخزين نصوص أسئلة/رسائل أو callback payload حساس أو محتوى ملفات في ledger. لم يستخدم أي اتصال بقاعدة إنتاج أو Telegram في الاختبارات.
8. **حدود إثبات الحقوق:** `botHasPermission` واجهة صورية اختُبرت بمحاكاة؛ صلاحيات Telegram الفعلية تحتاج adapter واختبارًا حيًا خاصًا لاحقًا.
9. **الفروع:** نرفع الشفرة إلى فرع مستقل للمراجعة، لا إلى `main` تلقائيًا؛ وثائق v1.2.1 مرجع قراءة ولا نستبدلها.

## قرارات B2-Core

10. **تحذيرات وعقوبات فردية فقط:** لا حذف جماعي ولا فلاتر سبام ولا أوامر نشر؛ المعرفات والحالات وهمية والآثار fake. معيار تجميع القيد BAN > MUTE > NONE، مع سجل أسباب مستقلة.
11. **الاشتراك غير الموثق:** UNKNOWN أو غياب صلاحيات قراءة القناة ليس إثبات عدم اشتراك. تخضع القنوات والمجموعات لقائمة سماح منفصلة، ولا يتم حظر عضو بسبب فشل تحقق.
12. **الحماية:** يمنع تنفيذ الأمر على المالك وعلى هوية محمية بحسب gateway، ويتطلب حق chat.manage داخليًا وإذن bot فعليًا في العقد. يتم التحقق عند أمر المشرف وقبل تنفيذ الأثر.
13. **الترحيل:** schemaVersion 1 يقرأ كـ2 بإضافة وحدات جديدة دون محو الحالة؛ JSON نفسه غير مناسب لتشغيل متعدد العمليات أو Telegram إنتاجي. نتيجة UNKNOWN تستلزم دليلًا أو قرار مراجعة يدويًا ولا تعاد تلقائيًا.
14. **حدود B2-Core:** لا نسمي رفع NONE استعادة دقيقة لصلاحيات عضو Telegram الأصلية؛ هذا يحتاج baseline rights ودمج قيود Telegram في التشغيل الحي. انحراف تطبيق القيود الخارجية عن الحالة المرغوبة يحتاج كشف انحراف ومصالحة آمنة قبل الإطلاق.
15. **الدفعة التالية:** B3 (التعليم والموارد والمستورد المحدد) بتفويض مستقل، دون AI أو نشر حي.

## قرارات B3 (تعليم + مستورد أولي)

16. **النطاق:** فئات تعليمية وعملية استيراد محددة فقط؛ رفع Telegram والويب الحي وماسح الفيروسات وتطبيع مصادر رسمية وAI وPDF ليست جاهزة. `origin` بيانات محاكاة، لا دليل وجود adapter.
17. **خصوصية المدخلات:** الحد الأقصى 256 KiB، 1000 سجل؛ لا حفظ للملف الخام في BotStore، ولا فتح روابط ضمن الملف. تحفظ مقتطفات دليل 180 حرفًا من سجلات وهمية؛ سياسة المسح والنسخ الاحتياطية ليست إنتاجية بعد.
18. **فصل المسؤوليات:** `content.upload` يتيح إنشاء سجلات مرشحة دون نشر؛ `content.publish` لاعتماد السجل ثم نشره محليًا؛ الطلبان منفصلان. الحالة الغامضة والمتكررة لا تنشر تلقائيًا؛ تصحيحها في شرائح لاحقة.
19. **العزل:** `private` منفصلة عن المجموعة المعتمدة. سحب التصريح أو تعطيل الفئة أو الأرشفة يحجب المورد وقت القراءة. المخزن JSON mutex ضمن عملية واحدة فقط، وليس مُعتمدًا لتنفيذ uploads متعددة العمليات.
20. **العد:** عدد الجامعات والفُرص المرشحة والمقاعد المصرح بها مقاييس مختلفة؛ لا نطلق عليها فرصًا موثقة من جهة رسمية ولا نعمم المقاعد الناقصة. التكرار يعرض للمراجعة ولا يعد فرصة ثانية.
21. **التسليم:** B3 في فرع وPR مستقلين متفرعين عن B2؛ لا تعديل أو دمج main ولا منصة منارتك. بقية B3 (FAQ وروابط موارد/واجهات تشغيل) PLANNED.

## قرارات B3 — شريحة FAQ والروابط والواجهات

22. **FAQ معتمد فقط:** لا استدعاء ذكاء اصطناعي ولا تطابق دلالي يوهم الطالب بصحة إجابة متشابهة. السؤال ومترادفاته محليًا مرتبطة بمصدر منشور. جوابان بنفس المطابقة ينتجان AMBIGUOUS، لا اختيارًا عشوائيًا. حق upload لا يسمح باعتماد جواب. النمط OWNER_MENTION/OFF الخاص بالمجموعة يظل حاكمًا لهذه الإجابة التلقائية، فيما تبقى الملاحة اليدوية مستقلة.
23. **الرابط ليس إذنًا:** روابط قصيرة عشوائية محفوظة على الخادم دون تضمين أسرار؛ قبل العرض لعضو من مجموعة، يلزم VERIFIED من adapter عضوية موثوق، ثم إعادة فحص التصريح والنسخة والأرشفة بعد await. لا نثق في callback status من العميل؛ لا توجد مصادقة Telegram حقيقية في هذه الدفعة.
24. **خصوصية العرض:** projection للطلاب لا تُظهر معرف الرفع أو معرف المشرف المراجع، حتى لو كان المورد عامًا في مجموعة معتمدة. إجابة FAQ المعتمدة مصدر نصي ثابت غير AI؛ عند الربط الفعلي يجب الهروب الآمن لتنسيق Telegram.
25. **حدود النقل:** EducationAdminFacade واجهة تطبيق محاكاة تتوقع Context موثقًا *من منفذ خارجي موثوق*. حقول `verified:true` في الاختبارات **ليست تحققًا حقيقيًا**؛ لا endpoint أو webhook حي، ولا تحميل مستند من Telegram ولا نشر قناة.
26. **ترحيل v4:** هياكل FAQ وروابط مستقلة مع مواصلة الحالة السابقة، JSON اختبار مع mutex محلي فقط؛ ينتظر الإنتاج قاعدة متعددة العمليات وضوابط الاحتفاظ والنسخ الاحتياطية.
27. **الدفعات:** لا نخلط B3 مع B4 أو B5/B6: FAQ محلي متحقق ليس AI، والرابط القصير ليس نشرًا تلقائيًا. يبقى PR مسودة ويبقى main دون تغيير حتى مراجعة الدمج.


## قرارات B3 — طبقة Telegram الواردة التجريبية (v0.3.2)

28. **مدخل محدود دون تشغيل حي:** `telegramWebhookListener` يتحقق من سرّ HTTP في الترويسة قبل قراءة الحدث؛ لا يُنشر أو يُربط بخادم خارجي في هذه الدفعة. اختبارات HTTP تستخدم 127.0.0.1 مع سر وهمي فقط.
29. **لا إرسال دون سجل تسليم:** `TelegramUpdateApplication` يحسب خطة رد محلية منقحة، لكن المستمع لا يرسل `sendMessage` إلى Telegram ولا يدرج نصًا في رد webhook؛ ستحتاج مرحلة التشغيل إلى OutboundGateway وتصاريح وإيصالات ونتيجة `UNKNOWN_OUTCOME` قبل التفعيل.
30. **الهوية والتدقيق:** تُستخلص user_id وchat_id من بنية Telegram المرشحة بعد تحقق سر webhook، وتمنع الأحداث المجهولة/المعاد توجيهها والأحجام غير المسموحة. يحتوي سجل dedupe فقط على معرف البوت/update_id ولا يحفظ رسائل الطلاب.
31. **منع تسرب موارد المجموعة عبر الخاص:** السماح بقراءة موارد نطاق المجموعة من DM يحتاج `VERIFIED` من عقد عضوية موثوق، ثم سياسة اشتراك إن كانت مفعلة، وإعادة فحص تصريح المجموعة بعد أي انتظار غير متزامن. وجود المجموعة في قائمة السماح لا يعطي كل مستخدم خاص وصولًا لمكتبتها.
32. **اشتراك FAQ:** يشترك أمر `/ask@Bot` في بوابة اشتراك المجموعة نفسها مع الملاحة؛ أُضيفت اختبارات خاصة لهذا الحد ولو أن التنفيذ السابق احتوى الفحص بالفعل.
33. **التوثيق لا يعني التشغيل:** توجد واجهة HTTP تجريبية للاستقبال في التعليمات والتجارب، لا ربط HTTPS ولا BotFather أو مستندات Telegram حقيقية ولا صلاحيات منظومة الإنتاج أو تفعيل نشر حي. تخزين JSON ما زال اختبارًا محليًا فقط.

## قرارات B3 — بوابة ملفات Telegram وتوثيق Mini App (v0.3.3)

34. **بوابة ملفات قابلة للاختبار:** لا تُحمّل المرفقات من مجموعة، ولا من خاص مستخدم غير مخول، ولا تنفذ روابط أو أوامر داخل المحتوى. الرفع بصيغة نصية محدودة عبر `/upload <scope>`؛ `file_id` مرجع Telegram معتم، وليس URL، والـport وهمي بدون HTTP أو توكن. فحص الحجم والامتداد وMIME قبل التنزيل؛ وفحص البايت وUTF-8 بعده، وإعادة التحقق من الصلاحية داخل خدمة الاستيراد عند نهاية الانتظار.
35. **لا ادعاء فحص أمني شامل:** لم يطبق مضاد فيروسات أو تنزيل getFile فعلي أو حدّ تنزيل على خادم إنتاج أو رفع ويب حقيقي؛ هذه متطلبات معلّقة قبل تفعيل Telegram. ملف PDF وDOCX وXLSX وOCR مؤجلة.
36. **Mini App ذات HMAC:** نرفض `initDataUnsafe` وuser_id المنقول بجسم HTTP؛ الهوية تُستخرج من `initData` موقع بتوكن البوت وفق مستند Telegram، مع مهلة عشر دقائق وحدود للحجم والمفاتيح المكررة والمشوهة. التوكن الوهمي في الاختبارات لا يعمل على Telegram.
37. **واجهة إدارة JSON محلية فقط:** تم اختبار listener على `127.0.0.1` مع حواجز هوية مستقلة عن محتوى POST وسحب التصاريح. لم يُبن browser UI أو صفحة تسجيل دخول أو نشر HTTPS أو CORS أو جلسة إنتاج؛ متطلبات العزل والحدود ومحددات المعدل وCSRF ومخزن دائم تشغيلي مطلوبة قبل إطلاق عام.
38. **التسليم:** B3 v0.3.3 تطوير فوق PR #5 دون تعديل `main` أو تشغيل Telegram أو مساس بمنصة منارتك؛ المرحلة التالية يجب أن تراجع المعمارية والتشغيل الحقيقي وتستكمل B3 بأمان بدل القفز إلى حملات B4.
39. **اختبار عبور المدخلات:** يجمع اختبار B3 مستقل بين حدث Telegram وهمي لاستيراد مستند، واعتماد منشور عبر Mini App موقع بتوكن وهمي، ثم تصفح المجموعة؛ يعيد التحقق بعد سحب المجموعة ويهرب النص المستورد قبل العرض. ينتظر الإنتاج تنزيلًا حقيقيًا موثوقًا وسجل إيصالات إرسال وسياق مصادقة للخادم المنشور.
40. **حالة الدفعة:** اجتاز `npm run check` 91 اختبارًا مع محاكاة HTTP loopback؛ لا تُطلق ميزة إرسال تلقائية ولا تُمكّن الرمز الحقيقي لهذا الإصدار؛ تبقى اختبارات Telegram المباشرة وحماية لوحة الويب التشغيلية مخططًا لها.

## B4 v0.4.0 — قرار تنفيذ شريحة سجل الحملات (19 أكتوبر 2026)

- يُبنى أولًا دفتر معاينات ونوايا إرسال بمحاكاة محلية، لا شبكة Telegram ولا نشر حي. لا تعديل لمستودع منصة منارتك.
- صلاحية نشر المصدر ودردشة الوجهة منفصلتان؛ وجهة `publishing` لا تكفيها صلاحية `navigation` أو وجود البوت فيها.
- المعاينة نص عادي غير مفسر كـHTML أو Markdown، مقتطع من بيانات موارد معتمدة فقط. أي أرشفة أو تغيير مؤثر في المصدر أو نسخة تصريح المجموعة يجعل المعاينة غير صالحة حتى اعتماد جديد.
- هوية منع التكرار هي مورد + بصمة حقوله المعتمدة + وجهة؛ محاولة متعثرة لا تُرسل مرة ثانية تلقائيًا، ولا نستنتج نجاحًا من بصمة نص أو آخر منشور.
- سجل `SENDING` محفوظ قبل أي أثر عبر منفذ وهمي. انقطاع الاتصال بعد الأثر يبقي `UNKNOWN_OUTCOME` حتى دليل فريد يتحقق منه منفذ موثوق.
- `MANUALLY_SKIPPED` مستقل ولا يثبت النشر. أفعال `pause/resume/cancel/retry` مفوضة ولا تلغي اتصالًا غادر العملية بالفعل.
- تخزين JSON المحلي محاكاة وحيدة العملية؛ لا DB متعددة العمال، لا ضمان Exactly Once لشبكة Telegram، لا rate-limit إنتاجي، ولا خطة الصين أو صور معاينة. يجب تنفيذها واختبارها مستقلًا قبل أي تمكين.
- B4 لا تزال جزئية؛ لا بداية تلقائية B2-Advanced أو تكامل AI.

## ADR — B4 v0.4.1 formatting and legacy review are pure preflight

- Rendering is planned as bounded plain text/photo with approved fallback; it does not secretly send or change the B4 campaign delivery graph. Fragmented multi-part sends require their own per-part receipts before integration, otherwise they would break existing item-level idempotency.
- Legacy migration only computes a review report. Callers must authenticate reviewers and provide trusted evidence verification; an `evidenceId` or a forwarded message alone is not proof. No bulk ordinal cutoff, last post or year-based inference. No state is written to the active delivery ledger and no manual skip is a verified publication.
- No production readiness claims, live Telegram/MANARATAK platform operations or paid services. Default-deny on ambiguous evidence, media, or authority.


## B4 v0.4.2 WIP handoff

- Multipart staging for existing B4 campaigns uses `PublicationDelivery.multipart` in the main state (no second operational ledger). `MULTIPART` prevents the core single-send worker or manual skip from consuming an in-progress multipart delivery.
- `MultipartTestStore` and `MultipartPublicationService` are isolated **proof-of-concept only**; they must never run alongside the operational `BotStore` for the same destination. They were preserved to avoid losing local work and to supply behavioral examples.
- **Do not mark B4 complete**: ordinary B4 resource preview limits currently block >4000-code-point content, so integrated long campaigns require a redesign of preflight approval and part-based scheduling. Verify against live provider only after explicit owner authorization and a real durable multi-worker store; no real messages are sent in these tests.

## B4 v0.4.3 — reviewed multipart (19 October 2026)

- Chosen authority: the existing `BotStore.deliveries` is the **only** campaign reservation/receipt ledger. `MultipartTestStore` is a standalone research fixture and must not be instantiated in operational code.
- Long-form source text requires published B3 content and explicit `content.publish` editorial review. A draft snapshots deterministic render parts and fingerprint. Approval atomically reserves all parts in the original delivery; no independent post-approval stage can duplicate the delivery.
- A part attempt is persisted as `SENDING` with an opaque ID and audit entry **before** fake gateway calls. A crash or timeout is `UNKNOWN_OUTCOME`; only verified, unique provider receipt can settle it. A confirmed failure may be requeued by an authorized reviewer.
- Schema 5→6 does not rewrite or discard legacy publication history. Source text edits alter revision and invalidate earlier approvals.
- Remaining blocker: JSON transactions are safe only for mock single-process workflows; do not use for production/multiple workers. Neither live Telegram API nor MANARATAK platform production data is connected.

## B4 v0.4.4 — historic publication guard (19 October 2026)

- An old forwarded final announcement is never proof of all earlier posts. Review is linked item-by-item to a currently approved B3 resource revision and destination. The only proof path is a trusted external `VerifyLegacyEvidence`, which is a simulation dependency until an operational adapter is explicitly approved.
- `historicalPublications` is a persistent **review-only registry**, not an outbound sender, queue or competing reservation manager. `PublicationService.approve` consults both this guard and the canonical `deliveries` ledger in the same transaction; a recorded unknown / manual skip does not silently permit republishing.
- Existing single and multipart mock senders reject a receipt already verified as historical for the same destination. A colliding receipt remains `UNKNOWN_OUTCOME` until separately resolved; no text-hash-based deduplication is treated as proof.
- Late historical reconciliation can only settle a previously uncertain/review-required item after independently verified, unique evidence and renewed scoped permissions. Explicit manually skipped items never gain a message ID or count as successful sends.
- Schema 6→7 appends history metadata without rewriting B4 delivery states or receipts. Single-process JSON is still **not** a production store; add a transactional multi-worker backend, backups and real gateway verification before activation.

## B4 v0.4.5 — SQLite persistence experiment (19 October 2026)

- Opt-in storage engine: the established BotStore API and its canonical campaigns/deliveries/part attempts/historical registry are retained; when specified, SQLite WAL + BEGIN IMMEDIATE provides cross-process atomic state updates. The default JSON store continues for mock fixtures only.
- A durable intent must commit before an outbound fake gateway call. A database transaction cannot make Telegram network sends exactly once; timeout and process death preserve UNKNOWN_OUTCOME and require external evidence.
- Database state is temporarily stored as a single versioned serialized BotState row for compatibility and regression confidence; normalized tables, constraints and production operational validation remain future work.
- Import from a legacy JSON state is explicit, refuses missing/corrupt sources and initialized destinations, and preserves earlier publication history. Online backup is non-overwriting and verifies a restorable snapshot.
- Node 22 built-in sqlite is experimental. The new backend is for offline B4 concurrency and backup contract tests; never interpret this slice as authorization for real Telegram, multi-host distributed leases, or direct production database use.

## B4 v0.4.6 — durable attempt leases and reviewer permission fixes (19 October 2026)

- A recoverPending sweep MUST NOT mark a different worker's **active** SENDING intent as UNKNOWN. All new single or multipart attempts persist a fixed 120-second lease in the same BotStore delivery record before the outbound boundary, including the existing optional SQLite transaction engine.
- Missing legacy lease or expired lease is treated as UNKNOWN_OUTCOME and never as a confirmed failure or new queued send. Late workers are fenced before network sending if an attempt is already expired. The lease cannot turn an ambiguous HTTP response into a guarantee of non-delivery, nor is it a background renewal mechanism.
- A human editor acting on a multipart retry or provider-evidence reconciliation must hold **both** source and destination content.publish rights. Reevaluate after async provider verification: an authorized campaign approver's rights never substitute for those of the reviewer invoking the operation.
- No live gateway, channel operations, platform DB access or auto-merges are permitted in this phase. Production operational heartbeat, schema-normalized outbox and externally verified receipts remain outstanding.

## B4 v0.4.7 — immutable approved content and provider evidence (19 October 2026)

- A stored `renderPlan` or fingerprint does not supersede approved B3 text. Every multipart send reconstructs the canonical plan from the approved copy, including historic v5 campaigns that lack renderPlan. Mismatches are BLOCKED, without an outbound request.
- The receipt input validator rejects dangerous printable/control/BiDi shapes and oversized IDs; this is a bounded format check **not** a claim that a Telegram message exists. An actual future gateway must attest chat ID, message ID, sender, attempt linkage and uniqueness.
- Campaigns never assume an imported historical review is a successful send. A matching historical registry entry or a duplicate canonical delivery reservation blocks sending and explicit retries. Conflicts discovered after network contact become UNKNOWN_OUTCOME to avoid falsely concluding the channel was updated or automatically posting again.
- The v0.4.7 slice changes no persisted schema; schema v7 is retained and deliberately contains the same one canonical B4 delivery/receipt ledger. A damaged or inconsistent state requires operator review, not silent deduplication or deletion.

## B4 v0.4.7 — preserving partial publish receipts during cancellation (20 October 2026)

- A campaign cancellation is a durable **decision to stop future outbound attempts**, not proof that any in-flight Telegram request was successfully withdrawn. The canonical delivery record preserves each `SENT` part, `UNKNOWN_OUTCOME` attempt and reviewed text part identity.
- `QUEUED` and `FAILED_CONFIRMED` multipart tails become `CANCELLED` rather than remaining in a misleading pending state. Aggregate multipart status becomes `CANCELLED` only when no pending send/unknown attempt survives (even if earlier parts are already SENT). Verified receipts after a cancellation may resolve uncertainty without reopening delivery.
- Cancellation during async gateway permission probing must not requeue an item into a cancelled campaign or perform a network call. A result from an already-issued remote request may still arrive and be recorded.
- Idempotent cancellations have one immutable audit event with `actorId`; manual skip cannot overwrite terminal cancelled/skipped review status. Additive optional actor field requires no schema version change.
- No automatic retry of unknown external outcomes, no direct Telegram posts or production activation; all examples are simulation behavior, not an assertion of Telegram exactly-once delivery.

## B2-Advanced v0.5.0 — rolling metadata and safe purge consent (20 October 2026)

- Follow `S121-06`: no Telegram `getChatHistory`, no retrospective index, and no claims about messages missed while offline. Only already-observed metadata in explicitly approved moderation chats. No body text, caption, media payload or constructed sender IDs; index entries prune after 48h. Schema v8 is additive over v7.
- A preview is a separate, durable actor/chat/version/fingerprint-bound decision expiring after ten minutes. It is **never** an outbound action. Up to 25 IDs are selected, at most 50 daily attempts, and >10 selected IDs requires a trusted owner confirmation. Protected pinned/linked-channel/admin-log/approved-announcement messages are not candidates.
- A confirmed job is an intent, **not** permission to delete arbitrarily. Check source metadata, effective staff/owner authorization, scope version and fake gateway privileges before and after awaiting remote preflight. Persist attempt ID before fake delete. An acknowledged API request is not independent proof of physical deletion; ambiguous outcomes remain UNKNOWN and cannot auto-retry.
- Count attempts by the UTC day they actually begin, not solely the day a plan was confirmed; cross-day plans cannot silently evade a rate cap. Cancellation keeps records of previously attempted or unknown work.
- The experimental JSON/SQLite stores retain only metadata and audit IDs; production TTL, backup purge, Bot API rank validation, batch429 handling and a real authorized deletion adapter must be separately designed, tested and explicitly activated. This work makes no live Telegram calls.

## B2-Advanced v0.5.1 — confirmed rate-limit rejection versus ambiguous result (20 October 2026)

- A gateway rate-limit response is **confirmed no-effect** only if the adapter returns the documented structured RATE_LIMITED object with strict retryAfterMs bounds. Parsing an exception text containing `429` is not evidence that Telegram rejected the call. Unknown or malformed responses remain UNKNOWN_OUTCOME and prohibit replay.
- Cooldown is stored in the original purge job and applied to the whole chat, protecting against independent jobs and worker restarts. No automatic scheduled retrier, only a new explicit dispatch after the barrier; validate current authorization and stored message fingerprint again.
- Even a confirmed rejection consumed a transport attempt. The immutable purge audit records are the source of truth for the 50-attempt UTC-day cap, including 429 retries. Do not rely on mutable `startedAt` after resetting QUEUED.
- No other job may start a delete request in the same chat while a current SENDING attempt exists. Recovery cannot infer remote failure after a timeout and never auto-replays an unknown request.
- This slice is TESTED_MOCK, not real Telegram behavior validation; actual API contract, provider rights/rate limits and production retention must be independently verified before any activation.

## B2-Advanced v0.5.2 — evidence-bound review of ambiguous deletion requests (20 October 2026)

- A purge timeout or expired sending lease always remains `UNKNOWN_OUTCOME` until a trusted independently verified evidence artifact identifies **the exact chat, message, attempt and outcome**. A message ID by itself and a human guess are insufficient. Evidence ID is globally one-use across purge jobs.
- `ACKNOWLEDGED` from a mocked gateway is a record of request acceptance, not proof of physical Telegram deletion. `FAILED_CONFIRMED` is verified no-effect and remains blocked without a separate human decision; automatic replay of ambiguous effects remains prohibited. A cancelled job may record its outstanding proof without restarting its cancelled queue.
- `PurgeGateway.verifyEvidence()` is **an injected test-only contract**; the Fake gateway's proof registry is not a production receipt verifier. Recheck all source authorization and immutable attempt/evidence conditions **after await within one durable transaction**.
- Owner-only `SKIPPED_UNVERIFIED` records an explicit bounded review reason in existing state and a minimal audit reason code. It means stop investigating, **not** delete confirmed or retry authorized. An immutable terminal decision cannot be rewritten with another review.
- Aggregate `reviewProgress` is limited to authorized moderators in the approved chat and never claims a physical deleted count. No Telegram API client or production retention policy is activated.

## B2-Advanced v0.5.3 — bounded privacy retention without destroying replay evidence (20 October 2026)

- Since the Telegram Bot API cannot enumerate complete chat history, retained `RollingMessageMeta` must be treated as partial, observed-only data with a 48-hour `sentAt` index horizon. Removing old observed metadata does **not** prove Telegram deleted that message. Offline owner-reviewed compaction is only a maintenance primitive, not continuous enforcement.
- Owner must explicitly preview the requested cleanup. The digest covers full eligible job and expired metadata candidates; the plan expires after 10 minutes, and its contents and latest eligibility are rechecked in the same DB transaction before any field is redacted. This prevents stale previews and simultaneous SQLite editors from processing newer data.
- Redact freeform manual reviewer notes, sender filters, raw evidence references and status-obsolete attempt metadata only for fully terminal COMPLETED/CANCELLED purge jobs >=30 days after the **last** action. Leave still-unresolved UNKNOWN, FAILED_CONFIRMED, in-flight and paused jobs intact, including their attempt IDs and metadata fingerprints.
- Retain a safety tombstone of reviewed job/chat/message IDs, status and actor audit instead of deleting all jobs: otherwise an old forgotten reservation or proof ID might inadvertently permit repeated deletion after restore/import. Store a domain-separated SHA-256 of redeemed evidence IDs to preserve one-use verification without indefinite raw proof identifiers; scrub legacy audit references as well.
- Local canonical-state cleanup cannot expire offsite backups, exports or existing snapshots. Such retention and privacy policy, GDPR/data-subject obligations if applicable, backup deletion, and scheduled maintenance remain separate deployment tasks requiring owner approval and real tests. No live Telegram mutation is authorized by this work.

## B2-Advanced v0.5.4 — optional read-only retention review cadence (20 October 2026)

- An automatic compaction would undermine the explicit owner approval in v0.5.3. Instead allow the owner to opt into **periodic inspection only**. `tickRetentionReview` is an interface for a future trusted task runner, not a currently wired-up timer or an outbound Telegram message.
- The optional control record is additive to schema v8, persists enablement, cadence, version, due clock and last privacy-minimized summary; disabled by default and only owner configurable/readable. Strict bounds 24h–30d and fail-closed invalid saved configuration.
- Checkpoint computations and due advancement occur atomically in `BotStore.transaction`, ensuring at-most-one summary per due interval across independent SQLite processes. A late checkpoint catches up only once and a backward clock cannot induce additional notices.
- A review notice is a ten-minute, digest-bound, aggregate-only dry-run and never permits actual compaction alone. The owner must separately approve a still-current `compactRetention` request; no automatic deletion, Telegram action, offsite backup cleanup or production retention SLA is enabled by this code.

## B2-Advanced v0.5.5 — trusted local entry point for periodic privacy review (20 October 2026)

- Added an actual one-shot Node CLI instead of claiming an internal tick method is a running scheduler. The runner accepts only an explicit absolute path, state engine and `--once`, and requires an existing private regular file. No default state path, owner-ID argument as proof of authority, Telegram token or live API is allowed.
- The only permitted runtime action is the preexisting `tickRetentionReview()`; the gateway is a deliberately outbound-disabled boundary. Neither local compaction, Telegram message deletion nor owner schedule configuration is accessible from the CLI.
- Diagnostics contain no user-supplied argument, secret or raw metadata values. Returned output is strictly status and aggregate counts. Node 22's own SQLite ExperimentalWarning may be printed independently.
- The owner-enabled policy in v0.5.4 remains opt-in and persistent; a local trusted cron/systemd job could later invoke this command, but that job is NOT installed in this release. Existing JSON per-process locking and SQLite transactional claiming govern repeat and parallel operations.
- OS permissions, process ownership, symlink races, backups/exports, owner notification routing and continuous data-retention SLA need deployment-specific independent review; the file check does not provide full operating-system isolation.

## B2-Advanced v0.5.6 — canonical local file before SQLite open (20 October 2026)

- The version 0.5.5 runner is the sole approved offline review entry point. Its lstat() guard for the filename did not preclude symlinked parent directories; add a full canonical realpath equality check, and reject lexical dot-segment aliases at argument parsing.
- SQLite's CREATE TABLE can **write into an empty, pre-existing state file**. The runner must reject files smaller than 16 bytes, and verify the exact `SQLite format 3\\0` signature using read-only file operations **before** any BotStore SQLite instance opens it. A mislabeled or corrupted file fails with a fixed error code.
- This is only a local safety hardening. A highly privileged host adversary can still race replacement after path inspection; use protected service directories, file ACLs and process privilege isolation in any production design. No cron, backup erasure, provider delete or live token is enabled.

## B4 v0.5.7 — refuse backup from uninitialized or aliased SQLite (20 October 2026)

- Existing `BotStore.backupSqlite` previously called an opening routine that may create `bot_state` and PRAGMA WAL on a zero-byte or uninitialized file. This could produce a misleading valid-looking backup of an empty state. Backup now validates existing regular/canonical source, full SQLite magic, read-only integrity and initialized supported `bot_state` **before any destination write**.
- A symlinked source or source-parent directory, noncanonical filename, and symlinked output directory are rejected. Output uses exclusive reservation with 0600 mode; existing backup is immutable. SQLite's point-in-time backup API still ensures WAL-safe snapshots and recovery checks still decode schema.
- Valid source backups preserve the existing publication and moderation records exactly. The backup itself may contain personal metadata and must be governed by private ACLs and an expiration/recovery policy. Deleting or pruning the current state does NOT erase its previous snapshots.
- Host-controlled filesystem races, backed-up keys/encryption, alternate devices, scheduled backup rotation and production activation are outside this mock-stage unit and remain blocked pending a trusted operator and live acceptance testing.

## B4 v0.5.8 — backup inventory is advisory, never a delete command (20 October 2026)

- S12-31/S12-32 call for verified recovery and explicit retention. Initial step: a **read-only** private directory inventory, NOT a data-erasure API. Classify only verified SQLite bot snapshots as expired review candidates using an operator-supplied threshold; unsafe, corrupt, unsupported or future-dated files can never be treated as valid deletion targets.
- The existing `BotStore` decoder remains the authority on compatible schemas; the new `BotStore.verifySqliteBackupReadOnly` opens SQLite in readonly mode and validates a proper initialized bot state without creating tables. It does not repair or modify backups.
- A backup report must not disclose potentially user-identifying file names, local absolute paths, messages or raw reviewer notes. It returns local SHA-256 name references and aggregate status counters to aid a trusted operator. Even hashed names might be guessable; keep audit output private.
- No automatic deletion, backup rotation, scheduler, new Telegram gateway, restore guarantee, or offsite data-subject erasure is activated. mtime is not a legally sufficient retention clock, and all filesystem checks remain vulnerable to host-level replacement races without external OS controls.

## B4 v0.5.9 — isolated restore must not become a production replay (20 October 2026)

- Introduce a narrow `runSqliteRestoreDrill` interface that takes only a verified private SQLite backup path and a separate, pre-existing private sandbox directory. Never expose a general-purpose `restoreTo` pathname because it could overwrite the bot's production state. No Telegram adapter or outbound action belongs in this workflow.
- Use SQLite online point-in-time backup to an exclusive random temporary scratch file, validate readonly backup/scratch integrity and schema, then compare **all** persisted state fields (not just counts). Preserve owner approvals/grants, publication/historical receipts, UNKNOWN purge/publication attempts and review metadata exactly; failure should not silently repair them.
- On verification completion or failure remove the newly reserved scratch file AND its SQLite WAL/SHM sidecars, never delete any preexisting backup, live state or sandbox marker. Source and target must have canonical private paths and be under trusted filesystem ACLs; TOCTOU races remain outside mock-stage guarantees.
- This drill is a local code-level recovery rehearsal, not an external disaster-recovery RTO/RPO test, legal retention validation, offsite restores or a proof of Telegram production readiness.

## B3 v0.6.0 — first opt-in live reply channel (20 October 2026)

- B3 inbound webhook formerly returned only planned HTML and persisted DONE with no network delivery. Real outbound requires an intent recorded together with the final inbound decision to avoid an untraceable missed reply. Add optional `telegramReplyJobs` to BotStore schema v8 without rewriting old snapshots; forbid duplicate reply rows for the same update key.
- Sending has no generally supported Telegram idempotency token: commit SENDING attempt before the provider call; never retry a failed network response or a stuck started attempt without operator evidence. Confirm only when Telegram returns `ok:true` with matching chat ID and positive message ID; 4xx explicit refusals are terminal, all ambiguous results UNKNOWN. The old mock-only listener remains functional without an outbound port.
- Runtime must require owner and bot identifiers, explicit `production` and `TELEGRAM_ENABLED=true` and separate `TELEGRAM_REPLY_DELIVERY_ENABLED=true`, no token defaults, local-only HTTP listener, verified initialized private SQLite store and HTTPS termination at an independently configured reverse proxy.
- No impersonated chat membership check: group-scoped catalogs in private chats remain unavailable until a trusted real `getChatMember` adapter exists. No automatic permissions approval, group joins, AI calls or moderation gateway activation.
- Remaining production blockers: mandatory outbound reply retention/redaction, rate limits and explicit unknown reconciliation, trusted membership, real Bot API end-to-end smoke, webhook HTTPS deployment controls, monitoring, secure secret rotation and timeouts/host OS audit.

## B3 v0.6.1 — membership requires Telegram administrator proof (20 October 2026)

- Group IDs or asserted membership from the inbound user payload do not prove the sender belongs to an approved group, especially for private requests. Use Telegram's documented `getChatMember` HTTP API and require a **fresh** bot administrator/creator preflight before checking any user; that API is not guaranteed to work for others unless the bot is admin.
- Implement conservative `restricted.is_member` semantics: only explicit `true` counts; known left/kicked/nonmember are negative; missing/unknown/ambiguous/HTTP failures are UNKNOWN. Reject mismatched provider-returned user IDs, malformed identifiers and bot users.
- Keep authorized-chat policy rechecks before and after HTTP requests. Reuse the same gateway for read-only `SubscriptionGate.verify` when the configured channel itself is locally approved. The existing FakeModerationGateway remains mock-only: **this is not live subscription restriction enforcement**.
- Live deployment, bot admin rights, private SQLite provisioning, HTTPS termination, message retention/unknown-send reconciliation and external acceptance remain outstanding. No secrets are installed by this source-only change.

## B3 v0.6.2 — outbox privacy minimization before Telegram send (20 October 2026)

- A QUEUED Telegram reply needs its full send plan; once a dispatcher commits SENDING, that body need not remain durable because Telegram sendMessage has no reliable idempotency key for repeating uncertain attempts. Capture a local clone and remove the stored plan atomically with the SENDING/attemptId marker **before** contacting Telegram. A crash can leave an unresolved SENDING record, but cannot produce a blind replay from persisted text.
- Retain only updateKey, status, attemptId, redactedAt, startedAt and provider receipt when available. Add creation time to newly queued plans. Preserve old terminal job objects and unchanged BotState schema v8 by making plan optional only for non-QUEUED statuses.
- Provide a separate count-only read-only backlog review and **explicit** bounded/paged legacy terminal-body scrub. Scrub never changes QUEUED or any evidence-bearing status and never infers external send success. Validation of the entire ledger precedes mutation, so malformed records cannot trigger partial redactions.
- Deliberately avoid promising secure physical deletion: WAL/free SQLite pages, backup files, monitoring records and disk copies can retain old plaintext. Real data-retention enforcement, storage-encryption lifecycle, stuck-send evidence reconciliation and operator-approved cancellations must be independently engineered before production certification.

## B3 v0.7.28 — explicit owner-only subscription exemption and corrupt-policy denial (22 October 2026)

- A mandatory-channel rule is ACTIVE only when it is the **one** canonical rule for its group and its group and every required channel still have local `verification` authorization. A valid zero-channel rule means explicitly paused. Malformed or duplicated records are a blocked policy, not evidence that subscription is unnecessary.
- A `NOT_REQUIRED` result produced by a trusted subscription adapter may legitimately represent the immutable bot owner exemption. With an active group requirement, students cannot use that result as `MEMBER` evidence. The checks use the trusted actor ID from inbound Telegram parsing, never user-supplied claims in the message body.
- Check the same invariants for group resource-link opening, group messages, and private browsing of a group. Final checks follow external awaits to avoid accepting a stale rule after an owner pause or edit. No moderation action is coupled to educational content access.
- These checks are additional local safety guards, **not** a substitute for administrator permissions in Telegram, independent provider verification, live deployment review or real bot integration tests.

## B3 v0.7.29 — Arabic-friendly FAQ search is discovery only (22 October 2026)

- Apply tolerant Arabic text normalization to **keyword discovery over already owner-reviewed** private FAQ titles and aliases, never to the saved answer payload or the exact `/faq` question-answer matching contract. This preserves editorial review and avoids merging distinct authoritative answers.
- Fold well-understood Arabic writing variations (diacritics, alef spelling, maqsurah, kashida/tatweel, space/punctuation separators and Arabic/Persian decimal digits) after Unicode NFKC. If canonical search text is empty, return no results to avoid enumerating all approved questions.
- Preserve the original reviewed title for display and the existing global ordinal/opaque answer selection authorization; don't display alternative terms or store student searches. Query length and Unicode control/bidi checks stay unchanged.
- Unicode normalization is an aid to discovery, not a linguistic guarantee, semantic/AI search, new publishing workflow, or change to source verification.

## B3 v0.7.30 — Telegram list display budget is not content or authority (22 October 2026)

- Preserve approved data and the existing opaque/ID-based current-source access checks. Restrict **only visible list excerpt** lengths after escaping, so Unicode characters and HTML entities remain intact. The Telegram reply renderer's existing 4096-byte hard limit remains an independent defense.
- Restrict every owner-supplied category/resource reply-keyboard label to both 256 UTF-8 bytes and 96 codepoints; compute the same deterministic button string when the student taps it. Renamed, hidden, archived or revoked entities still fail closed.
- Do not silently truncate full authoritative FAQ answers, attempt multipart delivery, or send Telegram messages in this slice. A separate reviewed delivery design would be necessary for unusually long encoded answer bodies.

## B3 v0.7.31 — share bounded Arabic discovery normalization (22 October 2026)

- Resource discovery and owner-reviewed private FAQ search use one pure Unicode fold function for common orthographic variants. It is for *matching* only; approved source records, FAQ exact-answer contract and external publish permissions remain untouched.
- Allow Arabic combining marks in bounded typed `/search` terms and stateless copied page labels; retain strict length, bidi/control and source ACL constraints. Strings normalized to empty must not enumerate all items.
- Search only currently published resources in enabled private categories, never automatic cross-group search. Store no extra per-student search history or AI data. Live operation remains explicitly disabled.

## B5 v0.7.32 — external platform candidate preview has no publication authority (22 October 2026)

- The read-only `PlatformCatalogReader` interface accepts a precise private-scoped bounded cursor request and yields unknown upstream data. The preview boundary must reject unexpected fields, drafts, group-only records, ambiguous IDs, invalid UTF-8 display text and unauthorized owner requests before exposure.
- External `PUBLISHED` status means only source-reported publication; map it to `UNVERIFIED_EXTERNAL` for owner inspection. Fingerprint cannot authorize imported/public student content or replace existing B3 review/publish procedures.
- No implicit real Manaratak URL, network fetch, bot-to-platform token, production credentials, database copy or write operations in this slice. Scope and permission checks happen before and after the upstream await to deny revoked access.
- Any real production connection requires explicit external API/schema verification, staging and a separately reviewed owner configuration path. No live Telegram/AI deployment follows.

## B5 v0.7.33 — optional owner projection of external candidates (22 October 2026)

- Only display the B5 read-only catalogue preview action when a provider has been **explicitly injected** into the application; otherwise hide and reject even forged old preview selectors. Every request still needs a verified owner in Telegram private chat. A copied page label is not authorization, simply a validated cursor request.
- Render only source candidate identifiers and escaped bounded metadata with a visible `UNVERIFIED_EXTERNAL` interpretation. Do not add local approval/import/publish actions, and do not modify the B3 content workflow because an external source claims publication.
- Keep the normal webhook audit/outbound-plan persistence for inbound Telegram updates, but assert no changes to local educational resources, imports, campaigns or deliveries. Unavailable external service gives a safe explanation without leaking transport exception details.
- Mock adapter validation is not a deployed Manaratak platform integration; never silently enable remote endpoints, credentials or real Telegram send on a test pass.

## B5 v0.7.34 — external review does not grant publication authority (22 October 2026)

- Store external reviewed-source candidates only in `platformReviewQueue`, not in B3 import, educational resource, FAQ or campaign collections. Both `UNVERIFIED_EXTERNAL` and `REVIEWED_METADATA_ONLY` are quarantine states, NEVER authorization to publish, reply to student or advertise an offer.
- Require the owner dashboard gate before any external fetch and at the storage commit. Pin a stage to the current validated full-page fingerprint; a metadata-only review re-fetches and compares record revision and all approved display fields to the saved SHA-256 digest. Reject stale records and do not silently replace an earlier staged source ID.
- Cap persisted source records at 200; enforce strict queue validation in both SQLite and JSON transactions without migrating schema 8. Any later approval-to-publication action needs a separate explicitly reviewed design with independent fresh source and owner confirmation.

## B5 v0.7.35 — external owner review Telegram buttons have no B3 publication authority (22 October 2026)

- Allow `📥 تسجيل مرشح` only for candidates currently present in the exact full-page verified external read (source ID, bounded cursor and page fingerprint). Every click must refetch and compare; a copied Telegram text button is a request, not an authenticated grant.
- The separate `✅ تدقيق بيانات` action re-fetches the originally staged cursor page and checks source revision/metadata digest before storing `REVIEWED_METADATA_ONLY`. Neither button calls `approveCandidate`, `publishCandidate`, creates a campaign, or exposes records to students.
- Preserve the source cursor in an optional, validated schema-8 field. Keep old first-page entries compatible, and fail closed when provider cursor/contents change. No production Manaratak API, live Telegram or AI execution has been activated.

## B5 v0.7.36 — explicit owner category approval is distinct from local publication (22 October 2026)

- A provider-reported PUBLISHED offer and even `REVIEWED_METADATA_ONLY` do **not** authorize local publication. The immutable owner must independently approve a currently enabled private category under the reviewed candidate's exact saved source digest. This yields only `APPROVED_FOR_LOCAL`, invisible to students.
- A later, separate owner call may publish to the local private education library only after another provider re-read and digest match, fresh category parent-chain and owner permission check within the JSON/SQLite transaction. A successful local resource has unknown seats, owner-reviewed metadata and a stable B5 source identifier; it is not evidence that an offer remains open or has official university endorsement.
- Never revive an archived resource; idempotent owner repeats cannot duplicate. Queue state validation is additive and supports the existing schema-8 stored B5 entries without destructive migration. No Telegram broadcast, AI, real upstream API connection or owner action button yet in this slice.

## B5 v0.7.37 — distinct owner approvals before student-library visibility (22 October 2026)

- Avoid a single-click import: the Telegram mock owner menu must offer a category selection, then a separate owner approval, then a local publication preview, followed by a separate publication confirmation. None grants an outbound channel send or starts a campaign.
- Reply-keyboard labels must satisfy BOTH 96 Unicode codepoints and 256 UTF-8 bytes. Use short deterministic selectors only as untrusted UI references, resolve a unique saved full digest and category/source ID, and revalidate source, owner and category inside the transaction. Any ambiguous or stale selector is rejected.
- This capability remains opt-in behind an independently supplied B5 read-only platform reader; it is not a verified production platform API, real Telegram deployment, or external AI integration.

## B5 v0.7.38 — source integrity reports never justify automatic deletion (22 October 2026)

- External provider pages and pagination are untrusted. A missing item from its original cursor page may reflect pagination reordering or timeout, not grant withdrawal. Surface `NOT_ON_PAGE` as uncertainty, and provider errors as `UNAVAILABLE`, not a negative fact.
- The immutable owner alone may view the published-source integrity inventory in the optional B5 Telegram menu; no staff/student delegated access, stale or ambiguous button replay, student content mutation or outbound channel sends. Locally linked education resource metadata and review provenance must be internally consistent before comparison, with a second check after remote I/O.
- Changing external source revision does not silently overwrite an owner-published resource or auto-archive it. A future explicit owner archival decision requires separate authorization and a reviewed local resource fingerprint. This version remains mock/read-only without a verified production Manaratak API contract.

## B5 v0.7.39 — Archival requires a separate verified human choice

A changed, missing or unavailable external source is never proof of scholarship closure and never archives local resources automatically. A verified Telegram-private owner must preview and confirm local archival, and the transaction must recheck owner dashboard rights, B5 source association and the exact current resource fingerprint. The source review queue retains historical provenance, while the archived local resource is hidden from student search. No Telegram outbound send or live API integration is added.

## B5 v0.7.40 — Optional owner-read web routes must not imply production integration (2026-10-22)

- Keep the Telegram Mini App's existing signed `initData` verifier as the only web identity source. The client may not select the owner identity, turn on `owner.dashboard`, add credentials, or discover group-scoped source content through a preview payload.
- Register platform preview and post-publication source-integrity endpoints **only when** an independently provided B5 reader service is explicitly injected. Both operations are owner-only and read-only; use bounded JSON with no extra or duplicate top-level keys, including Unicode-escaped duplicates.
- Owner permissions are checked again after external I/O. Source self-reported `PUBLISHED` remains `UNVERIFIED_EXTERNAL` at preview time. Missing records on a stored cursor page are uncertain, not evidence that a grant has closed. All mutations require separate reviewed owner workflows outside these routes.
- This implementation does not supply or validate a real Manaratak public/private API URL, authentication credential, production ACL, uptime, or live Telegram Mini App deployment.

## B6 v0.7.41 — approved knowledge first; generation remains unconnected (2026-10-22)

- B6 cannot interpret source text as an instruction or an authorization. The injected knowledge port sees only `scope` and a bounded explicit `question`; never send Telegram actor IDs, session tokens, full chat history, conversation logs or moderation secrets to a knowledge adapter. Scope and opt-in/mention policy must be approved before lookup.
- Even an apparently valid answer from a trusted local adapter is a *hint*. Revalidate B3's current published reviewed FAQ, its source resource and category ancestry, and the current Telegram group policy epoch after await. Exact answer and source ID must agree; no match, multiple matches, policy revocation and content change must not turn into generated text or cross-scope output.
- Integrate the planner into mock Telegram only through optional explicit construction; normal group /ask and private /faq retain existing behavior without B6. The private /ask command is enabled only with B6 injected and the opt-in AI policy configured. This slice does not invoke a provider/model or enable Phase 17 AI; true generation requires a separately approved central owner/provider contract, budgets, credential handling and response security review.

## B6 v0.7.42 — A fake generation draft is not an approved answer (22 October 2026)

- `AnswerGenerationPort` remains a proposed central Phase 17 interface; no production endpoint, provider or credential is known. The caller supplies ONLY a bounded source-backed approved answer, question and scope, never a Telegram user ID, chat history, API key or authorization proof. Treat model text as untrusted data, reject malformed/oversized/bidi-spoofed responses and render it escaped in any future owner-only preview.
- Require an explicit offline fake adapter and enable flag. Run trusted reviewed-FAQ checks on both sides of the awaited fake call; source edits and policy revocation win. A structurally valid draft must remain `OWNER_REVIEW_REQUIRED`; neither students nor channels may see it without a separately designed owner publication review workflow.
- The local UTC-day attempt/concurrency gate never refunds an unknown-outcome call or retries it. It does not survive process restarts, synchronize bot replicas, meter actual vendor spend or enforce a central money budget; thus it MUST NOT authorize paid/production generative models. Live activation remains blocked until a durable central-budget/reservation contract, verified provider identity, authenticated operation, cost accounting, data-retention policy, and secure output release approvals exist.

## B6 v0.7.43 — request reservation evidence must survive restarts (22 October 2026)

- Keep opaque B6 fake-generation reservation records in the BotStore schema-8 state without retaining student prompts, Telegram identities, platform credentials, generated text or provider secrets. Validate all ledger fields on JSON and SQLite load, cap count to 2000 and never silently discard replay evidence on exhaustion. SQLite BEGIN IMMEDIATE is an atomic local-process and multi-process primitive; JSON is NOT protected from concurrent external processes.
- A single request key is a retry identity, not an authorization token. Any recorded key permanently blocks another call, including after a UTC date rollover. Each admitted attempt conservatively reserves its maximum allowed units and is not refunded for provider failures, timeouts or unknown outcomes. Lease expiration becomes UNKNOWN_OUTCOME and never causes an automatic retry. A clock rollback must not open a fresh budget window.
- B6 fake generation remains explicitly OFF by default. Only an explicitly injected durable budget combined with a stable request key can gate the fake adapter. A model result after an expired/missing reservation is suppressed, and trusted reviewed-FAQ permission checks still run after generation. The 8192 internal reservation units are a deliberately coarse upper limit for offline simulation, NOT actual token billing or money-spend accounting.
- Activation of paid/production Phase17 AI remains blocked on verified upstream contracts, an authoritative central durable spend ledger, token/currency pricing, provider receipts, strict request-key ownership, reconciliation of UNKNOWN outcomes, and human-approved output release. None is implied by this mock-local implementation.

## B6 v0.7.44 — owner review cannot resolve a provider's unknown outcome (22 October 2026)

- An owner may read conservative fake-model reservation counts from current saved state, but a READ screen must not silently mutate expired attempts or claim that a provider did not charge. Only an explicit owner step can mark expired leases `UNKNOWN_OUTCOME`; no model call or token refund follows.
- An owner may separately inspect and acknowledge **awareness** of a quarantined attempt through Telegram private-owner buttons. Each confirmation must recheck owner identity, active dashboard and exact attempt status inside a persistent transaction. The status and full reserved units remain unchanged; acknowledgment is historical evidence and cannot authorize a replay, new reservation, free retry or provider success claim.
- Budget reports are limited to the owner and display only attempt identifiers (shortened on read-only summary). They never display the opaque request key, student content, identity, raw prompts, model output or service credentials. Strong strict decoder validation prevents forged saved review records. The flow is offline/mock, not an actual provider receipt reconciliation or monetary cost ledger.

## قرار B6 v0.7.45 — حدود انتظار التوليد التجريبي وساعة الميزانية

- كل استدعاء مولد تجريبي يحتاج مهلة جدارية بين 20 و900000 مللي ثانية (الافتراضي 30000). انتهاؤها لا يثبت إيقاف عمل المنفذ الخارجي؛ لذلك لا إعادة محاولة ولا استرداد وحدات الحجز، والنص المتأخر لا يعود إلى المستدعي ولا ينشر.
- تبقى محاولات `UNKNOWN_OUTCOME` محجوزة بالكامل ويمنع تكرار مفتاحها الثابت. إقرار المالك لا يثبت فاتورة مزود خارجي.
- ساعة ميزانية المحاكاة داخل العملية لا تعيد تصفير العدادات إذا تراجعت، والخطأ أو الرمي من الساعة يمنع قبول الاستدعاء. هذا ليس ضمانًا موزعًا؛ محاسبة Phase 17 الحقيقية منفصلة.
- سبعة اختبارات انحدار مضافة، بمحاكاة JSON وSQLite وقبول محلي؛ لا توصيل AI فعلي ولا إرسال إجابات طلابية.

## قرار B6 v0.7.46 — هوية محاولة Telegram التجريبية الدائمة

- مفتاح requestKey مشتق فقط من هوية البوت ومعرّف Telegram update_id الموثق عند الدخول، باستخدام HMAC-SHA256 ومجال فصل محدد. لا يُقبل مفتاح يغيّره المبرمج عند كل retry؛ ولا نخزن معرّفات الطلاب أو نصوصهم في ledger.
- المفتاح السري 32 بايت عالية العشوائية من تهيئة موثوقة (64 حرف hex)، لا من توكن Telegram ولا من تاريخ التشغيل؛ لا يُولد تلقائيًا. تغييره يكسر تطابق طلب قديم ويحتاج إجراءات ترحيل ومراجعة مستقلة.
- الواجهة التجريبية `B6TelegramDraftEntrypoint` لا تعمل باستدعاء حقيقي ولا تتصل بمعالج Telegram الحي. لا يكفي إرسال JSON يشبه حدث Telegram لإثبات المصدر؛ هوية الحدث يجب أن تأتي من حدود webhook الموثوقة في مرحلة الدمج اللاحقة.
- المسار الجديد يُلزم وجود `B6DurableBudget`؛ عدم وجوده يمنع التوليد الوهمي بدل الاعتماد على الحصة المؤقتة. لا يعتبر هذا احتسابًا ماليًا أو تكاملًا مع Phase17.
- 16 اختبارًا جديدًا عبر JSON وSQLite وثبات المفاتيح والعزل والخصوصية؛ لا نشر تلقائي ولا AI للمستخدمين.

## قرار B6 v0.7.47 — منع تغيير سر الطلبات بلا إثبات تاريخي

- تُحفظ بصمة HMAC ذات مجال منفصل، وليس السر، في حالة schema-8 الاختيارية عند أول حجز ناجح بمفتاح `b6tg1_` وبشكل ذري مع سجل المحاولة. أي Secret مختلف يرفض الحجز ولا يعاد الطلب التوليدي.
- إذا وجدت محاولات أقدم ولم تحفظ بصمتها فلا يمكن إثبات أنها اشتقت من السر الحالي. يمنع التسجيل دون عملية هجرة ومراجعة منفصلة؛ الاحتفاظ بتاريخ الـUNKNOWN والرصيد أولى من إمكانية إعادة الطلب.
- لا يمكن حجز مفاتيح Telegram في `B6DurableBudget` دون بصمة سليمة؛ البيانات المحفوظة غير صالحة الشكل تُرفض على JSON وSQLite دون إسقاط السجل.
- الفحص هو استمرارية السر ضمن حالة التخزين المحلية، وليس حماية ضد تعديل خبيث لمن يستطيع استبدال قاعدة البيانات. لا يتم تشغيل AI الإنتاجي أو ارسال رداً إلى Telegram في هذا الإصدار.
- 14 اختبارًا جديدًا على JSON وSQLite، وإثبات RED مسجل قبل GREEN، وقبول GitHub Actions شرط الدمج.

## قرار B6 v0.7.48 — المنشن الحالي الموثق بـ MessageEntity

- نمط `@BotUsername السؤال` يحتاج Telegram `MessageEntity` من نوع mention، يطابق اسم البوت الموثوق من الإعداد، عند بداية الرسالة فقط، مع مسافة وسؤال محدد؛ البحث النصي وحده ليس إثبات منشن.
- تحسب offsets وlength بوحدات UTF-16 كما يفعل Telegram؛ يمنع انقسام surrogate pairs، والتنسيقات الملتبسة، والمنشن المكرر، والتوابع غير المعتمدة.
- يعتمد المسار على بوابة صلاحية المجموعة والتحقق الإضافي من الاشتراك (إن فعّل) قبل جواب FAQ المعتمد. تعاد مراجعة سياسة المجموعة ومصدر FAQ بعد await؛ ألغِ الجواب عند سحب الإذن.
- لا يفسّر اسم العرض أو منشن بوت آخر، ولا يقرأ forward أو history أو reply-to كنص للسؤال. المنشن المتأخر أو المنقول داخل اقتباس لا يفتح مسار المساعد.
- لا اشتراك مزود Phase17 ولا AI توليدي ولا إرسال توليدي؛ هذه قدرة FAQ معتمدة ضمن Telegram. 21 اختباراً جديداً مع سجل اختبارات RED ثم GREEN.

## قرار B6 v0.7.49 — الرد على سؤال من رسالة واحدة فقط

- طلب المالك «@البوت أجب عن هذا السؤال» يفسر فقط إذا كان منشنًا فعليًا أو أمر `/ask@Bot` في المجموعة المعتمدة. لا يحق لأي طالب استخدام هذا الاختصار مهما كانت سياسة ALL_MENTION.
- تؤخذ صيغة السؤال من `reply_to_message.text` المباشر داخل نفس تحديث Telegram؛ لا طلب لسجل قديم ولا تأليف سؤال عند اختفاء الرسالة المرجعية. في حالة النقص يطلب من المالك الرد مباشرة مجددًا.
- يفحص المعالج `message_id` قبل رسالة المالك، ومطابقة `chat.id`, هوية `from.id` غير الروبوت، وخلو المحتوى من forward/via_bot/sender_chat/رد متداخل، وصحة النص الطولي والتحكم. عند الفشل DENIED دون أثر ذكاء اصطناعي.
- تظل صلاحيات الاشتراك وسياسة سؤال المجموعة وموافقة FAQ وإعادة فحص السماح عند انتهاء await هي المرجع الوحيد. الرد الناتج خطة FAQ فقط؛ لا توليد أو قاعدة تاريخ سريّة أو Phase17.
- 20 اختباراً جديداً في JSON وSQLite وparser مع TDD وCI قبل أي دمج.

## قرار B6 v0.7.50 — صلاحية إثبات الاشتراك بعد انتظار جواب معتمد

- يحفظ مسار سؤال المجموعة بصمة حالة التصريح والنسخ والمتطلبات والقنوات من أول بوابة معالجة، ثم يعيد مقارنتها بعد await البحث عن FAQ المعتمد. إنشاء اشتراك إلزامي جديد خلال الانتظار، أو تغييره/إيقافه، يبطل الإثبات القديم ولو بقي السؤال المعتمد كما هو.
- مع قاعدة ACTIVE غير متغيرة، يعاد التحقق الخارجي من عضوية الطالب مباشرة قبل تخطيط الجواب، ثم تُفحص نسخة القاعدة والمجموعة والقنوات مرة ثانية بعد انتهاء التأخير الخارجي. UNKNOWN أو فشل الاتصال يرفض التخطيط؛ لا يُعد رفض العضوية قرار عقوبة.
- تبقى إجابات المجموعة من مصدر B3 المعتمد، ويشمل الفحص مسار B3 الاحتياطي عند عدم حقن B6. الخاص وFAQ اليدوي مستقلان، ولا دخول مباشر للمزود أو API منارتك الداخلي.
- حد الضمان: الفحص في آخر خطوة **تخطيط للرد** لا يغلق فترة الانتظار في outbox حتى الإرسال الحقيقي. حماية هذه النافذة تتطلب تصميمًا منفصلًا ومعالجة idempotency والمراجعة قبل Telegram send؛ لا ادعاء ضمان مستمر دون ذلك.
- اختبارات JSON/SQLite عددها 16 إضافية؛ RED أثبت 8 حالات فشل، وCI النهائي شرط الدمج.

## قرار B6 v0.7.51 — صلاحية طلب FAQ الجماعي وقت تسليم Telegram

- حفظ إثبات قصير العمر (120 ثانية) في outbox لجواب FAQ الجماعي المعتمد فقط، يتضمن هوية طالب Telegram مؤقتًا وبصمة SHA-256 لحالة السياسة والاشتراك ووقت انتهاء. هوية الطالب محفوظة مؤقتاً **كنص معرف** حتى حسم الطلب؛ لا ادعاء إخفاء الهوية. لا نسخ نص السؤال أو بيانات AI إلى هذا الإثبات.
- يراجع المرسل صلاحية المجموعة وAI للمستخدم ونسخة قاعدة الاشتراك وعضويته الإلزامية مجددًا قبل claim. ويعيد مقارنة حقائق السياسة بصورة ذرية داخل معاملة الحجز بعد انتظارات التحقق الخارجي. إذا تعذر الإثبات يمنع الإرسال ويحذف النص والإثبات المؤقت.
- المرسل الحقيقي يحصل على خدمة SubscriptionGate للقراءة فقط. لا تغيير لبوابة سلامة الطوارئ أو تاريخ إقرارات UNKNOWN أو عدم إعادة المحاولة بعد نتيجة Telegram غير محسومة.
- لا يمكن دمج تحقق عضوية Telegram مع `sendMessage` في معاملة خارجية واحدة؛ من الممكن تغير العضوية عقب التحقق وقبل الأثر. لا ضمان بإلغاء رسالة أُرسلت؛ يجب عدم تسمية هذا إثباتاً مطلقاً للنقل الآمن.
- عدد الاختبارات الجديدة 18، شاملاً JSON وSQLite وحالات تزامن وفشل إثبات وحذف البيانات المؤقتة؛ Phase17 وAI الحقيقي غير مفعّلين.

## قرار B6 v0.7.52 — سلامة ترقية رسائل المجموعة العالقة في outbox

- لا يمكن استعادة تصنيف موثوق لرسالة قديمة من HTML أو اسم الزر بعد انتهاء أصل التحديث؛ والرسائل QUEUED قبل v0.7.51 قد لا تحمل إثباتاً صالحاً لإعادة فحص عضوية الطالب.
- كل محاولة إرسال لرسالة جماعية محفوظة بلا `groupReplyKind` وبلا `groupQuestionAccess` ترفض بشكل نهائي `FAILED_CONFIRMED` محليًا دون اتصال Telegram، ويُحذف نصها دون إعادة إرسال أو إنشاء attemptId. لا تغيير في السجلات التي بدأت الإرسال بالفعل أو النتيجة المجهولة.
- عند إنشاء رسالة جماعية جديدة تحفظ فئة واضحة `GENERAL` أو `REVIEWED_FAQ` ضمن المعاملة نفسها. الأخيرة لا تقبل دون دليل سؤال معتمد صالح؛ يُحذف التصنيف مع بيانات التحقق المؤقتة عند claim أو الرفض.
- تُقبل رسالة FAQ جماعية أُنشئت في v0.7.51 بلا التصنيف الجديد **فقط إذا** بقي `groupQuestionAccess` صالحاً بعد فحص سياسة المجموعة واشتراك الطالب من جديد. والرسائل الخاصة القديمة لا تتأثر.
- هذه سياسة fail-closed قد تمنع إرسال رسائل تنقل جماعية قديمة سليمة المحتوى؛ تعاد كتابة الأمر بإذن جديد بدلاً من المجازفة بتجاوز صلاحيات. الاختبارات الجديدة 14 على JSON وSQLite.

## قرار B6 v0.7.53 — إعادة فحص وصول قوائم المجموعة عند الإرسال

- ثبتت فجوة بين إنشاء ردود `/categories` أو `/resources` داخل المجموعة وإرسالها من outbox. فحص صلاحية التنقل المحلي فقط لا يكفي لإثبات استمرار اشتراك الطالب بقنوات المجموعة الإلزامية.
- تحفظ الرسائل العامة الجديدة للمجموعة حقلاً مؤقتاً `groupMenuAccess` يتضمن هوية الطالب الرقمية وبصمة SHA-256 لحالة المجموعة والاشتراك وصلاحيات القنوات ووقت صلاحية 120 ثانية. ليس التشفير إخفاءً لهوية الطالب أو بديلاً لإثبات عضوية Telegram.
- قبل الإرسال تُعاد مقارنة الحقوق المحلية والتحقق من الاشتراك الإلزامي، ثم تراجع النسخة مرة أخرى داخل معاملة queue claim بعد أي await. تُرفض الرسائل التي تغيرت سياستها أو فُقد مدققها، ويُحذف النص ومعرف الطالب عند حسم الإرسال.
- رسائل GENERAL القديمة من v0.7.52 التي لا تحمل الدليل الجديد تُحجر عند محاولة الإرسال؛ لا يُفترض أنها آمنة من مجرد النوع أو نص HTML. وردود FAQ المحمية سابقاً والخاصة تستمر بضوابطها المستقلة.
- لا يمكن ضمان أن عضوية Telegram لا تتغير بعد آخر فحص وقبل sendMessage الخارجي؛ لا AI حقيقي ولا Phase17 في هذا الإصدار. أضفنا 14 اختبارًا JSON/SQLite.

## قرار B6 v0.7.54 — إدراج حالة نشر المحتوى في إثبات إرسال Telegram

- إثبات اشتراك الطالب وصلاحية المجموعة لا يثبت استمرار اعتماد المورد أو جواب FAQ عند تسليم رسالة أُعدت قبل إلغاء النشر. تضم البصمة الحالية قائمة الأقسام والموارد والأسئلة المعتمدة ونسخها ضمن نطاق المجموعة وحدها، بترتيب معرفات ثابت، دون تخزين النص الخام داخل دليل outbox.
- تستخدم إجابات FAQ والقوائم الجماعية نطاق HMAC/هاش جديداً من v1 إلى v2، لتُرفض أدلة قائمة الانتظار القديمة التي لا تحتوي حالة نشر المحتوى؛ تُرفض عند dispatch وتُحذف خطة الرد دون إرسال أو محاولة تلقائية جديدة. يجوز للمستخدم إعادة طلب القائمة المحدثة.
- يعاد فحص بصمة المحتوى أثناء مراجعة جواب FAQ وبعد الاستعلام عن عضوية Telegram مباشرة قبل claim وبصورة ذرية داخله. يتغير القرار عند أرشفة المورد، تعطيل القسم أو أرشفة/تعديل جواب FAQ. لا يؤثر تعديل نطاق `private` على مجموعة أخرى.
- حد الضمان: لا يمكن إعادة رسالة أرسلت فعلاً، ولا توجد معاملة مشتركة مع Telegram sendMessage. لا يُعد هذا تشغيلًا للذكاء الاصطناعي الحقيقي أو API Phase17.
- أضيف 16 اختبارًا جديدًا لـ JSON وSQLite، منها حالات انتظار عضوية متزامنة، وقد ثبتت 12 حالات فشل قبل الحل.

## قرار B6 v0.7.55 — حماية عرض موارد مجموعة داخل الخاص قبل إرسال الرد

- مدخل `/categories group` أو `/resources group category` أو رابط مورد معتمد لمجموعة في الخاص يحتاج عضوية الطالب الفعلية في المجموعة واشتراكها الإلزامي، ولا يكفي تحقق الطلب الأول إن بقي الرد مؤجلاً في outbox.
- تحفظ الردود الخاصة ذات المصدر الجماعي الجديدة حقلاً `privateGroupAccess` يتضمن معرف طالب Telegram الذي يجب أن يساوي مستلم الرسالة الخاصة، معرف نطاق المجموعة وبصمة SHA-256 مفصولة المجال لحالة الصلاحيات/الاشتراك/المحتوى ومدة 120 ثانية. المعرفات بيانات شخصية مؤقتة وليست مجهولة.
- قبل إرسال الرد تُعاد مراجعة العضوية الحقيقية للمجموعة حتى عند عدم وجود قنوات إلزامية. إذا كانت القنوات مطلوبة يُعاد فحصها، ثم تراجع السياسة والمحتوى داخل معاملة CLAIM بعد await. الفشل يحذف النص والإثبات دون طلب sendMessage. التجديد لا يعيد إرسال محاولة Telegram مجهولة النتيجة.
- تمرر بيئة التشغيل خدمة العضوية المقروءة فقط إلى المرسل؛ ليس لـ AI أو المشرف صلاحية جديدة على مجموعات الطلاب.
- حدود الترقية: الرسائل الخاصة القديمة الموجودة في قائمة الانتظار قبل هذا الحقل لا تحمل Provenance المجموعة، وتظل قابلة للإرسال وفق السياسة السابقة. يحتاج نشر يطلب منعاً رجعياً صارماً مراجعة/حجر الصف القديم؛ لا يجوز ادعاء أن v0.7.55 أمّن ما قبلها بأثر رجعي.
- لا يمكن جعل استعلام Telegram والتحويل الخارجي معاملة ذرية؛ تبقى نافذة صغيرة لتغير العضوية بعد آخر تحقق. AI Phase17 الحقيقي غير مفعل.

## قرار B6 v0.7.56 — حجر ردود الخاص القديمة مجهولة مصدر المحتوى

- لا يمكن استعادة مصدر رد Telegram خاص أُعد قبل v0.7.55 من نص HTML أو مستلم الرسالة فقط؛ قد يكون الرد قائماً على موارد مجموعة أُزيل الطالب منها في وقت لاحق.
- تُرفق الردود الخاصة الجديدة عند إنهاء التحديث بقيمة `privateReplyKind=LOCAL` عندما لا تحتوي دليلاً جماعياً، و`GROUP_SCOPED` عندما يكون `privateGroupAccess` موثوقاً ومحدداً بنطاق مجموعة. ترفض قاعدة البيانات التخزين غير المتسق أو القيم المخالفة.
- إذا وُجد رد خاص قديم بحالة QUEUED لا يحمل التصنيف ولا دليل `privateGroupAccess`، يمنع الإرسال بتأكيد محلي ويحذف النص دون محاولة Telegram؛ لا تُعاد كتابة التاريخ اعتماداً على تخمين محتوى النص. قد يتأثر رد خاص قديم سليم، ويجب إعادة طلبه من الطالب.
- إذا وُجد رد خاص من v0.7.55 مع دليل مجموعة أصلي صالح لكن دون التصنيف الجديد، يبقى مساره متاحاً بشرط الفحص الجديد للعضوية والاشتراك والمصدر والمهلة. يتم حذف النص والتصنيف والدليل عند حسم المحاولة.
- الصفوف التي بدأت الإرسال `SENDING` أو `UNKNOWN_OUTCOME` لا تتكرر تلقائياً؛ قرار الحجر لا يمكن أن يسحب رسائل سبق أن قبلها Telegram. هذا ضبط محلي قبل الإرسال لا ضمان ذري لعضوية Telegram الخارجية.
- أضيف 18 اختبارًا جديدًا بمحركَي JSON وSQLite. هذا لا يفعل نموذج AI حقيقياً أو API Phase17.
