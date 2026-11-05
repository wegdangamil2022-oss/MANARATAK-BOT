# مراجعة متطلبات المرحلة الثالثة

الحالة: مفتوحة. وجود ملف أو زر أو اختبار لا يثبت إغلاق المطلب الرسمي كاملًا. لا يعد تأجيل Telegram قبولًا للتشغيل.

السجل يحفظ جميع المتطلبات الـ703 دون إسقاط، ومنها 225 مرتبطة بالمرحلة الثالثة. بصمة الخطة: `3d4bbf54585a143d4cd3083484fbe83ef4c78ae7a97eac47833f9fdc111dc37d`.

الفحص الشامل: 3969 حالة؛ 3755 ناجحة، 214 فاشلة، 0 ملغاة، 0 متجاوزة. السجل: `artifacts/section-closure/full-review-readonly-causes-tests.log`.

نتيجة الفحص الشامل تخص الجولة المسجلة؛ يلزم تكراره عند تغيّر الشفرة، ولا يمثل قبولًا للتشغيل الفعلي. الفحوص المرتبطة أدناه لا تلغي إخفاقاته ولا تجمع أعدادها كاختبارات فريدة.
- artifacts/section-closure/rule-warning-policy-tests.log: 188 حالة، 188 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-review-tests.log: 143 حالة، 143 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-actions-tests.log: 173 حالة، 173 ناجحة و0 فاشلة.
- artifacts/section-closure/notice-receipt-after.log: 177 حالة، 177 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-disable-tests.log: 181 حالة، 181 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-languages-tests.log: 185 حالة، 185 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-explanation-tests.log: 213 حالة، 213 ناجحة و0 فاشلة.
- artifacts/section-closure/rule-warning-presentation-tests.log: 217 حالة، 217 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-health-tests.log: 183 حالة، 183 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-health-targeted.log: 7 حالة، 7 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-change-alert-tests.log: 229 حالة، 229 ناجحة و0 فاشلة.
- artifacts/section-closure/rights-monitor-focused-tests.log: 148 حالة، 148 ناجحة و0 فاشلة.
- artifacts/section-closure/rights-monitor-fairness-tests.log: 56 حالة، 56 ناجحة و0 فاشلة.
- artifacts/section-closure/rights-monitor-guards-tests.log: 60 حالة، 60 ناجحة و0 فاشلة.
- artifacts/section-closure/membership-bot-identity-tests.log: 7 حالة، 7 ناجحة و0 فاشلة.
- artifacts/section-closure/membership-identity-subscription-tests.log: 154 حالة، 154 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-activity-targeted-tests.log: 108 حالة، 108 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-delivery-metrics-tests.log: 182 حالة، 182 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-channel-incidents-tests.log: 70 حالة، 70 ناجحة و0 فاشلة.
- artifacts/section-closure/subscription-channel-unavailable-tests.log: 76 حالة، 76 ناجحة و0 فاشلة.
- artifacts/section-closure/manual-channel-unavailable-tests.log: 80 حالة، 80 ناجحة و0 فاشلة.

تفاصيل سقف إنذارات الفقرات وانتهاء مددها في [PHASE3_RULE_WARNING_POLICY_AR.md](PHASE3_RULE_WARNING_POLICY_AR.md).

تفاصيل إحالة فقرات القوانين للمراجعة وإغلاقها في [PHASE3_RULE_REVIEW_AR.md](PHASE3_RULE_REVIEW_AR.md).

استكمال التنبيه الأول وقائمة إجراءات الفقرة وترتيب الخيارات اليدوية في [PHASE3_RULE_ACTIONS_AR.md](PHASE3_RULE_ACTIONS_AR.md). حالة التنفيذ المحلي لا تعني قبول Telegram أو إغلاق بقية المرحلة.

توضيح القانون والاعتراض الخاص في [PHASE3_RULE_EXPLANATION_AR.md](PHASE3_RULE_EXPLANATION_AR.md).

فحص صلاحية قنوات الاشتراك وتنبيه تعديل القائمة في [PHASE3_SUBSCRIPTION_CHANNEL_HEALTH_AR.md](PHASE3_SUBSCRIPTION_CHANNEL_HEALTH_AR.md).

معاينة إنذار الفقرة ورابط الإصدار في [PHASE3_RULE_WARNING_PRESENTATION_AR.md](PHASE3_RULE_WARNING_PRESENTATION_AR.md).

لغات القوانين الاختيارية والإصدارات والتعطيل في [PHASE3_RULE_LANGUAGES_AR.md](PHASE3_RULE_LANGUAGES_AR.md).

تفاصيل الإخفاقات وبصمات الملفات ومراجع الشفرة والواجهة والاختبارات في `artifacts/section-closure/requirements-review.json`؛ تصنيف «يحتاج فحصًا» لا ينسب الفشل تلقائيًا إلى Windows.

أسباب رفض القراءة الآمنة موثقة في [PHASE3_READONLY_FAILURE_CAUSES_AR.md](PHASE3_READONLY_FAILURE_CAUSES_AR.md). سبب الرفض المثبت لا يحول الاختبار الفاشل إلى ناجح.

| المطلب | سطر الخطة | الحالة | النقص أو حد القبول |
|---|---:|---|---|
| ASKCFG-001 | 509 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ASKCFG-002 | 510 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ASKCFG-004 | 512 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-001 | 568 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-002 | 569 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-003 | 570 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-004 | 571 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-005 | 572 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-006 | 573 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-007 | 574 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-008 | 575 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| IAM-009 | 576 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-001 | 582 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-002 | 583 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-003 | 584 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-004 | 585 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-005 | 586 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-006 | 587 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-007 | 588 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-008 | 589 | PARTIAL_LOCAL_REVIEW | Owner-consented original Telegram join/leave service message deletion now waits 60 seconds and rechecks bot delete rights and STOP, with terminal unknown outcomes and a one-day limit. Bot-owned CAPTCHA link notices also have distinct receipt-bound cleanup. Deletion of admin command messages and other service messages remains open; real Telegram acceptance is deferred. |
| MOD-009 | 590 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-010 | 591 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| MOD-011 | 592 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-001 | 598 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-002 | 599 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-003 | 600 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-004 | 601 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-005 | 602 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-006 | 603 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-007 | 604 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-008 | 605 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-009 | 606 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-010 | 607 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-011 | 608 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SPAM-012 | 609 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GATE-001 | 615 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| GATE-002 | 616 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| GATE-003 | 617 | PARTIAL_LOCAL_REVIEW | Human messages and observed joins enroll bounded candidates; no claim to enumerate unobserved historical Telegram members or complete join-request workflow. |
| GATE-004 | 618 | PARTIAL_LOCAL_REVIEW | Reviewed official restriction path exists; unverified delete metadata does not authorize deletion. |
| GATE-005 | 619 | PARTIAL_LOCAL_REVIEW | Ephemeral and temporary fallbacks plus cleanup exist; configurable fallback delay and complete capability acceptance remain open. |
| GATE-006 | 620 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| GATE-007 | 621 | PARTIAL_LOCAL_REVIEW | Observed candidates, active restrictions and verified grace records rotate; 1000 candidate capacity and 30-day retention are explicit limits. |
| GATE-008 | 622 | PARTIAL_LOCAL_REVIEW | No grace/hour/day reviewed policies and fresh expiry checks exist; no permanent automatic ban. |
| GATE-009 | 623 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| GATE-010 | 624 | PARTIAL_LOCAL_REVIEW | Manual and periodic rights checks distinguish explicit loss from unknown. Rights loss, channel list changes and verified primary public username changes on the same numeric channel queue guarded owner alerts. Numeric-ID migration and alternate-username coverage are not implemented. Real Telegram acceptance is deferred. |
| GATE-011 | 625 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| GATE-012 | 626 | PARTIAL_LOCAL_REVIEW | Owner-only aggregate verification outcomes, witnessed delivery confirmations, historical rights-loss notice states and separate anonymous bounded unavailable automatic/manual rights-check counts exist locally. Delivery does not prove page opening; other channel/API errors are not covered. The complete funnel remains open. |
| VERIFY-001 | 632 | PARTIAL_LOCAL_REVIEW | Local join challenge supports random question and accessible alternative; real-client verification deferred. |
| VERIFY-002 | 633 | PARTIAL_LOCAL_REVIEW | Separately approved CAPTCHA mute now supports an active subscription only with a second independently enabled owner consent and valid grace policy. Existing external restrictions and uncertain operations are never overwritten; real Telegram acceptance remains deferred. |
| VERIFY-003 | 634 | PARTIAL_LOCAL_REVIEW | Configurable challenge timeouts/attempts and bounded retries now offer separate owner-approved extended cooldown (3 and 10 minutes) followed by human review at round three. Extended sessions carry immutable evidence and persist across restart without retroactive policy changes. Additional Telegram punitive sanctions are not enabled; real client verification remains open. |
| VERIFY-004 | 635 | PARTIAL_LOCAL_REVIEW | The owner may require explicit acceptance of the current published rules after CAPTCHA; joined channel enforcement now checks all required proofs before lifting bot-owned restrictions. Current law changes invalidate stale acceptance; real Telegram acceptance remains deferred. |
| VERIFY-005 | 636 | PARTIAL_LOCAL_REVIEW | One-time private welcome remains bound to successful CAPTCHA, current rules and channel proof where required. Original join/leave service cleanup is separately approved. Public per-group welcome/farewell now supports owner-approved immutable saved text/HTTPS URL studio versions with bounded delivery and five-minute own-message cleanup; rich media and Telegram client acceptance are outstanding. |
| VERIFY-006 | 637 | PARTIAL_LOCAL_REVIEW | Owner-approved anonymous join-link notice is queued from trusted CAPTCHA joins and its bot-authored message is receipt-cleaned after 60 seconds. Original Telegram join/leave service message cleanup is separately implemented and independently consented; both retain STOP and unknown-outcome safeguards. Real Telegram testing is deferred. |
| VERIFY-007 | 638 | PARTIAL_LOCAL_REVIEW | Owner review with approval and rejection exists; Android, iOS and Desktop acceptance is deferred. |
| VERIFY-008 | 639 | PARTIAL_LOCAL_REVIEW | Joined local journey enforces CAPTCHA, current rules acceptance and independent channel membership before owned restriction settlement, without replaying CAPTCHA. Previously bot-owned subscription mutes are preserved until all gates pass. External and ambiguous restrictions require manual review; real Telegram acceptance is deferred. |
| VERIFY-009 | 640 | PARTIAL_LOCAL_REVIEW | Future AI Guardians and WebApp support has not been reviewed. |
| NETWORK-001 | 701 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-002 | 702 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-003 | 703 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-004 | 704 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-005 | 705 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-006 | 706 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NETWORK-007 | 707 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| AI-004 | 750 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| AI-006 | 752 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| AI-008 | 754 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-001 | 867 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-002 | 868 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-003 | 869 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-004 | 870 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-005 | 871 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-006 | 872 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-007 | 873 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-008 | 874 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-009 | 875 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-010 | 876 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-011 | 877 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LEX-012 | 878 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-001 | 884 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-002 | 885 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-003 | 886 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-004 | 887 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-005 | 888 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-006 | 889 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-007 | 890 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-008 | 891 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-009 | 892 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-010 | 893 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-011 | 894 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-012 | 895 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| NSFW-013 | 896 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-001 | 1036 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-002 | 1037 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-003 | 1038 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-004 | 1039 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-005 | 1040 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-006 | 1041 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-007 | 1042 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-008 | 1043 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-009 | 1044 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-010 | 1045 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-011 | 1046 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GROW-012 | 1047 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-001 | 1053 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-002 | 1054 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-003 | 1055 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-004 | 1056 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-005 | 1057 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-006 | 1058 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-007 | 1059 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-008 | 1060 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-009 | 1061 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-010 | 1062 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-011 | 1063 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ABUSE-012 | 1064 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TOPIC-001 | 1183 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TOPIC-002 | 1184 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TOPIC-003 | 1185 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TOPIC-004 | 1186 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TOPIC-005 | 1187 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| JOIN-001 | 1193 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| JOIN-002 | 1194 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| JOIN-003 | 1195 | PARTIAL_LOCAL_REVIEW | The local member screens are connected; combined enforcement and safe handling of existing restrictions remain open. |
| JOIN-004 | 1196 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| JOIN-005 | 1197 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| STUDENT-001 | 1203 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| STUDENT-002 | 1204 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| STUDENT-003 | 1205 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| STUDENT-004 | 1206 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| STUDENT-005 | 1207 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GOV-001 | 1223 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GOV-002 | 1224 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GOV-003 | 1225 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GOV-004 | 1226 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| GOV-005 | 1227 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-001 | 1331 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-002 | 1332 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-003 | 1333 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-004 | 1334 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-005 | 1335 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SHIFT-006 | 1336 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-001 | 1375 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-002 | 1376 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-003 | 1377 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-004 | 1378 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-005 | 1379 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-006 | 1380 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-007 | 1381 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-008 | 1382 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-009 | 1383 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMINLINK-010 | 1384 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-001 | 1390 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-002 | 1391 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-003 | 1392 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-004 | 1393 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-005 | 1394 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-006 | 1395 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-007 | 1396 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LINKED-008 | 1397 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-001 | 1403 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-002 | 1404 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-003 | 1405 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-004 | 1406 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-005 | 1407 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-006 | 1408 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-007 | 1409 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-008 | 1410 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-009 | 1411 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| EXCEPT-010 | 1412 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| RULELAW-001 | 1465 | IMPLEMENTED_LOCAL_TELEGRAM_DEFERRED | Local immutable numbered versions, approval dates, edits, disabling/reactivation and up to three manually reviewed optional languages preserve original violation history. Translation addition/removal requires private confirmation; published language replies reject stale source epochs. Real Telegram acceptance remains deferred; no full-stage closure. |
| RULELAW-002 | 1466 | IMPLEMENTED_LOCAL_TELEGRAM_DEFERRED | Local reply warning accepts Arabic and /warnrule syntax; private confirmation displays original paragraph, verified executor name or ID, and an authorized link to the exact historical law version. Real Telegram acceptance remains deferred. |
| RULELAW-003 | 1467 | IMPLEMENTED_LOCAL_TELEGRAM_DEFERRED | Local implementation: first private notice with durable attempt and bound receipt, warnings, timed restrictions, review, ordered configurable manual choices, warning ceilings and immutable expiry. Each action requires its own confirmation; no automatic escalation. Real Telegram acceptance is deferred by user; full-stage acceptance remains open. |
| RULELAW-004 | 1468 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| RULELAW-005 | 1469 | IMPLEMENTED_LOCAL_TELEGRAM_DEFERRED | Local private source-bound historical law explanation button and separately confirmed appeal window exist for the case owner. Warnings and manual paragraph mutes retain their original law text in owner and reviewer views; no automatic sanction reversal. Real Telegram acceptance is deferred. |
| RULELAW-006 | 1470 | PARTIAL_LOCAL_REVIEW | Timed version/paragraph exemptions protect warnings and new mutes; existing sanctions are not automatically released. |
| RULELAW-007 | 1471 | PARTIAL_LOCAL_REVIEW | Weekly warnings, linked restriction receipt aggregates and witnessed warning appeal revocations exist; restriction appeal reversals need acceptance. |
| RULELAW-008 | 1472 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| RULELAW-009 | 1473 | PARTIAL_LOCAL_REVIEW | Related local code and tests identified; full official requirement has not been independently accepted. |
| TYPELOCK-001 | 1479 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-002 | 1480 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-003 | 1481 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-004 | 1482 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-005 | 1483 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-006 | 1484 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-007 | 1485 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-008 | 1486 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| TYPELOCK-009 | 1487 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-001 | 1493 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-002 | 1494 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-003 | 1495 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-004 | 1496 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-005 | 1497 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-006 | 1498 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-007 | 1499 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-008 | 1500 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-009 | 1501 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| PURGE-010 | 1502 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-001 | 1508 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-002 | 1509 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-003 | 1510 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-004 | 1511 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-005 | 1512 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-006 | 1513 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-007 | 1514 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-008 | 1515 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-009 | 1516 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| ADMSET-010 | 1517 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-001 | 1538 | PARTIAL_LOCAL_REVIEW | CAPTCHA, rules and subscription screens have a partial local route; unified onboarding and Join Requests remain open. |
| LIFECYCLE-002 | 1539 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-003 | 1540 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-004 | 1541 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-005 | 1542 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-006 | 1543 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-007 | 1544 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| LIFECYCLE-008 | 1545 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-001 | 1551 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-002 | 1552 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-003 | 1553 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-004 | 1554 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-005 | 1555 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-006 | 1556 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-007 | 1557 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-008 | 1558 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-009 | 1559 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |
| SAFEAI-010 | 1560 | NOT_REVIEWED_IN_THIS_PASS | لم تكتمل مطابقته في هذه المراجعة. |

لا تُغلق المرحلة الثالثة أو هذه الحزم من هذا التقرير؛ يلزم تنفيذ النواقص الصريحة ومعالجة الإخفاقات وفحص الضوابط التفصيلية المرتبطة بالخطة.

## متابعة تنفيذ رحلة الانضمام المشتركة — 2026-11-04

وُصل إنفاذ CAPTCHA مع الاشتراك الإجباري وموافقة إصدار القوانين في مسار تحكم محلي واحد على فرع المراجعة #184: لا رفع لقيد CAPTCHA المملوك قبل اجتياز التحدي/قبول المالك، وموافقة القوانين الحالية (عند طلبها)، وإثبات الاشتراك في القنوات. يستمر سبب الاشتراك المملوك القائم مسبقًا حتى تستوفي الرحلة كل متطلباتها. لا تُستنتج العضوية من نجاح CAPTCHA، ولا تتكرر عقوبة الاشتراك فوق قيد CAPTCHA مؤكد ومملوك للبوت، ولا يُمس قيد خارجي أو غامض.

اجتازت نسخة `6a07ceee` [Ubuntu 41909901843](https://github.com/wegdangamil2022-oss/MANARATAK-BOT/actions/runs/41909901843) بعد **4139 اختبارًا ناجحًا / 4139**، دون فشل أو تخط، مع التدقيقات والمحاكاة. أضيف بعدها حارس صلاحية قبل التسوية والتوثيق؛ قبول آخر نسخة مشروط بنتيجة CI مستقلة. التفاصيل في [PHASE3_JOINED_ONBOARDING_AR.md](PHASE3_JOINED_ONBOARDING_AR.md).

لا يحل ذلك نواقص الإنذار عند الانضمام، والتدرج العقابي، ولا يلغي الإخفاقات الـ214 المثبتة في المراجعة المستقلة القديمة، ولا يثبت التشغيل الحقيقي. حالة المرحلة الثالثة الكاملة: **مفتوحة**.

## إضافة محلية محدودة — أزرار 09:02 و09:03

توسع ربط قسم «👋 التفاعل والترحيب» بإعدادين مستقلين في لوحة المالك: **«🧭 دليل العضو الجديد» (09:02)** و**«📜 القوانين والرسائل الثابتة» (09:03)**. يختار المالك المجموعة والإصدار المحفوظ من استوديو القوالب، ويعاين ثم يؤكد، وتبقى الخاصيتان متوقفتين افتراضيًا. يستطيع الطالب طلب رسالة عامة فقط عبر `/guide` أو `/rules` أو بإلحاق اسم البوت الصحيح. تُرفض رسائل التوجيه والتعديل والأوامر لبوت آخر، مع حد رسالة من كل نوع في الدقيقة، وتوثيق نتائج إرسال Telegram وتنظيف رسالة البوت فقط بعد خمس دقائق.

هذه هي **الشريحة النصية الآمنة من WELCOME-004**، وليست إتمام متطلبات الرد على كلمات حرة أو ربط مصادر القوانين الرسمية المتغيرة أو قبول انضمام الطالب. تتطلب الصور والوسائط والأزرار غير الروابط ومسارات Telegram الحية مراجعة مستقلة، ولا تُغيّر هذه الإضافة حالة المرحلة الثالثة من «مفتوحة». التفاصيل في `PHASE3_WELCOME_FAREWELL_TEMPLATES_AR.md`.
