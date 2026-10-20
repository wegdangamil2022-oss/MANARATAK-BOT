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
