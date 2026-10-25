## B2 v0.7.67 — real approved educational catalogue in opt-in student Inline Keyboard

Send `/studentinline` in a private Telegram conversation to browse the *currently enabled, locally published* private educational categories and their published resources with Telegram Inline Keyboard buttons. Select a category, open a resource, or navigate back and through pages; the bot edits the original message rather than treating button labels as user commands. It displays only public fields and checks the latest local education permissions and visibility again on every tap. Empty sections, disabled features and archived resources are handled transparently. The existing Reply Keyboard remains compatible. This is **not** a live scholarship/university API integration and does not independently verify official application deadlines.

## B2 v0.7.66 — opt-in Inline Keyboard for delegated staff

Use `/staffinline` in a **private Telegram chat** to inspect the moderation groups that the actor is allowed to administer **inside Manaratak**. The view uses current, scoped, unexpired internal `chat.manage` grants and approved moderation scopes; staff can browse 8 entries per page and inspect only local aggregate warning/restriction counts. Owner privileges remain separate at `/ownerinline`. Every callback is re-authorized; old buttons fail after grant revocation, expiry or chat changes. No permissions or punishments are changed, and no external Telegram administration rights are implied. Live moderation awaits explicit gateway implementation and a controlled test group.

## B2 v0.7.65 — read-only owner delegation inventory

Use `/ownerinline` → `👑 المشرفون والصلاحيات` → `📋 قائمة المشرفين` to inspect the bot's saved **internal delegated capabilities** with paging, scoped details and status classification. The screen requires a verified private owner callback every time; changing or revoked records invalidate their old detail selectors. This is **not** the Telegram administrator roster, does not inspect live Telegram rights, and cannot change/grant/revoke any permission. Only deliberately authorized owner operations elsewhere can mutate policy. The older owner Reply Keyboard workflows remain available while the Inline Keyboard migration continues.

## B2 v0.7.64 — owner inline group actions: atomic local confirmations

The opt-in `/ownerinline` → `📋 مجموعاتي` → approved-group card now offers separate previews for pausing the group's local required-channel subscription rule and revoking its local approval, in addition to AI OFF and internal assistant/publishing restrictions. All previews require verified private owner context; confirmation uses a 120-second, actor+group+policy-bound one-shot token. **Token usage, current-policy revision checks and the local mutation are committed in one durable transaction.** Subscription suspension additionally rechecks the independent rule version. Stale, expired, copied, replayed or cross-user confirmations cannot change policy. Approval revocation also invalidates related stored subscription dependencies.

These are local policy controls: they do **not** claim to inspect live Telegram administration permissions, revoke external Telegram access, or lift previously imposed moderation sanctions. Production launch, rights testing and live moderation remain separate phases. No bot token is needed for the offline regressions.

## B2 v0.7.63 — explicit local-only owner group restrictions (opt-in inline UI)

After `/ownerinline` → `👥 المجموعات والشبكات` → `📋 مجموعاتي` → an approved group's card, the owner may preview a **local group AI OFF** or **internal assistant/publishing scope restriction**, then confirm with a one-shot short-lived callback token. Preview never mutates state. Confirmation is tied to the real verified owner, exact group and current policy version, is consumed once, and writes to the existing policy audit. Legacy owner actions remain available. **These controls do not call Telegram to ban, mute, leave groups, grant rights, or publish to channels.** They do not claim to know live bot permissions, and state and callback metadata remain subject to the project's storage and retention policy. No real bot or token is needed to run the offline tests.

## B2 v0.7.61 — Owner-only read-only Inline Keyboard navigation (offline)

- Added the explicit private `/ownerinline` command as a safe migration path without removing the existing owner/student Reply Keyboard menus. The new 2-page owner dashboard reproduces 16 approved sections and all 253 named subordinate items from `docs/أزرار_منارتك.md` in read-only catalogue form. Sections and items have bounded two-byte-ish ASCII callback tokens, not grants; all unported actions are conspicuously described as NOT operational.
- Added strict owner-only private `callback_query` parsing, per-click authorization, replay/idempotency through the existing durable update claim and reply outbox, `InlineKeyboardMarkup` validation, `answerCallbackQuery` and one-shot `editMessageText` of the verified bot message. Invalid, old-version, malformed, out-of-range, non-owner and group callbacks cannot execute an administrative action. No shared secrets or callback IDs are persisted as privileged credentials.
- Six catalogue items now load existing, freshly authorized local read-only reports: groups, subscription-rule health, reviewed FAQ, library inventory, aggregate Telegram reply outbox, and basic system settings. Deeper actions stay on the existing legacy owner menu while reviewed migrations proceed. Showing a catalogue item does NOT claim Telegram live bans, automated publishing, active AI providers, real-time membership health or installed production hosting.
- Tests added for section/label exactness, all navigation pages, bad/forged callback grammars, owner versus student and group isolation, JSON/SQLite idempotency, inline API validation and correct Bot API edit/ACK endpoints, and read-only links to existing services. Strict TypeScript, full test suite and five offline demos gate PR merge; no live Telegram deployment was requested or performed.

## B3 v0.7.60 — contextual navigation for reviewed private FAQ in Telegram

Students who browse the approved private FAQ catalogue or search it with `/faqsearch` can now return from a selected answer to the **current authorized page they were viewing**. Previously, FAQ answers only exposed the catalogue's first page, losing pagination and keyword context.

- **Browse answers:** A numbered FAQ selected from page N gains `↩️ صفحة الأسئلة · pf:N`, plus the original main `📖 تصفح الأسئلة المعتمدة` shortcut. On return, the bot re-reads approved, private-scope questions and published source/category status; stale or out-of-range pages are denied. This preserves original `📖 سؤال N · ~opaque` selectors for backward compatibility.
- **Keyword search answers:** Result selection carries a canonical bounded keyword, zero-based page, global visible ordinal and a non-secret opaque FAQ locator in the normal Telegram keyboard text. An opened answer gains `↩️ نتائج الأسئلة · fs:N:<canonical-keyword>` (keyword encoded as canonical base64url) and the catalogue shortcut. The return reruns the actual `searchPrivateReviewedFAQs` lookup and pages under current student privileges, not a persisted session.
- **Strict reauthorization:** Search-origin selections are checked against the *exact current rendered button*, their current authorized search result page, current global ordinal and the still-approved FAQ/source. Forged keyword/page/ordinal combinations, disabled navigation, archived questions or unpublished sources cannot authorize an answer. Search-only controls remain unavailable in group chats.
- **Keyboard limits:** Search-origin result labels fall back to existing numbered FAQ selectors if the whole label would exceed Telegram's 96-codepoint or 256-byte keyboard limits. Their answers still return to the reviewed browse page, but do not pretend to retain search context if no bounded keyword can fit. Canonical parsing also rejects malformed base64url, controls and oversized labels.

No searchable FAQ sessions, per-student cursor tables or externally generated answers are added. Plain button text is not an authorization credential; query text appears in keyboard labels available to the requesting user, not a persistent search-history record. Legacy FAQ/buttons remain supported. This is reviewed B3 content only; Phase17 generative AI and paid providers remain inactive.

16 JSON/SQLite regression tests cover exact FAQ browse page return, second-page keyword search return, current-approved revalidation, forged selectors, disabled education access, source archival, and strict private/group separation. TDD RED recorded 16 failing new cases against the old behavior; strict TypeScript, complete test suite and five offline demo gates are mandatory for merge.

## B3 v0.7.59 — return to the exact reviewed Telegram search results

Opening a scholarship/resource from `/search` previously showed its approved detail but dropped the original search query and page. The generic back-to-category breadcrumb introduced in v0.7.58 did not return the student to the search results. This version adds **stateless origin-bearing search result selections** to the existing private Telegram reply keyboard. A resource selected from, for example, page 3 of `/search Grant` offers `↩️ نتائج البحث · s:Grant:2`, which recomputes the current reviewed third page under the current actor's private-library authorization, as well as the existing category and all-categories breadcrumbs.

- Search result buttons carry the item's currently visible title, canonical resource ID, original bounded search query and 0-based page (never tokens or privilege grants). The click handler **re-runs** `education.searchPublishedResources` and `education.listResources`, verifies the resource still appears in that precise authorized search page, and checks that the exact rendered button still matches. Archived items, changed titles, removed matching categories or forged query/page pairings are denied, rather than opening stale resources.
- The return breadcrumb parses bounded Unicode search grammar and reruns current search authorization. Disabled private educational navigation, out-of-range pages and malformed or forged labels fail closed. It works for approved Arabic query terms, including existing Unicode normalization behavior; private-only search cannot be invoked in group chats.
- Every generated Telegram reply keyboard remains within 96 codepoints, 256 UTF-8 bytes per button and 12 keyboard rows. When a 64-character resource ID and long search query cannot fit safely alongside source context, the button automatically falls back to the **existing ordinary resource selection**; its detail still provides category and all-categories breadcrumbs, but cannot promise return to the original search page. No search session, student history, outbox identity map or persistent cursor is created.

Sixteen added JSON/SQLite end-to-end tests cover first/third-page search returns, currently reviewed source membership, archived/retitled/forged selections, disabled private navigation, Arabic search, invalid page markers, long button fallback and no student-session retention. TDD RED recorded 12 new failures with the old route; the final code, after updating one prior test to understand the new button suffix, passed **1,276/1,276** tests, strict TypeScript and five offline demos. Phase17 generative AI and real model provider connections remain disabled.

## B3 v0.7.58 — functional student navigation breadcrumbs in Telegram

Telegram's persistent student keyboard previously had working educational category and resource pages, but opening a resource detail left only the generic `↩️ رجوع` action, which returned to the home menu instead of the resource list. This release adds explicit, **working** navigation breadcrumbs to the actual approved private-library reply keyboards:

- On a reviewed published resource detail, `↩️ موارد القسم · <categoryId>` returns to the current, authorized first page of that resource's category; `↩️ جميع الأقسام` returns to the current, authorized private educational categories.
- Each category resource-list page (including an empty category and a paginated page of 10 resources) also offers `↩️ جميع الأقسام`, without sacrificing its previous/next pagination controls, `↩️ رجوع` or `🏠 الرئيسية`.
- Breadcrumbs are **untrusted Telegram message text**, not sessions, access grants or private data pointers. Each click reruns the existing B3 `education.listCategories` and `education.listResources` authorization, approval and publication checks; a deleted/disabled category, other-group category, altered ID or malformed button fails closed. Group chat inputs cannot use private navigation. No student identity or browsing history is stored to implement the feature.

Ten new JSON/SQLite end-to-end keyboard regressions test drill-down and return, all-categories navigation, 10/14-item pagination, disabled category, unapproved group content isolation and forged button texts. The RED branch failed all 10 cases while the existing 1,250 passed. The GREEN branch passed strict TypeScript, **1,260/1,260 tests** and five offline demos. The button route is local B3 approved educational content only: it does not imply a real AI answer or public platform/Phase17 integration.

## B6 v0.7.57 — owner-only aggregate Telegram outbox access-denial audit

Owners can already open **📊 حالة الرسائل** in the trusted, verified Telegram private owner dashboard. This release extends the existing view with an aggregate-only breakdown of **locally denied, never-sent** queued replies. The durable job now optionally stores exactly one `accessDenialCode` for a `FAILED_CONFIRMED` item rejected before any external Telegram call: `LEGACY_UNVERIFIABLE` (old group or private reply lacking origin proof), `ACCESS_RECHECK_FAILED` (membership, time-bound proof, subscription, group AI or approved content could not be established as current), or `GROUP_UNAVAILABLE` (group navigation authorization revoked). This field is from an exact finite enum, is not read from Telegram text or source content, and never contains actor/group IDs, tokens, reply bodies, timestamps or evidence IDs.

The summary calculates cumulative counts from the **current durable outbox ledger**: total failed-confirmed, legacy origin unverified, access recheck denied, unavailable group navigation and *other confirmed failures*. The latter includes old, unclassified failures and provider-confirmed send failures; the report does not reclassify historical errors or claim to know the provider's actual failure reason. These categories describe a **local authorization decision**, not definitive proof of the student's current membership or of any malicious activity. Previously queued/sent `UNKNOWN_OUTCOME` and `SENDING` remain separate statuses and never become auto-retry candidates.

The aggregate function is **read-only**, validates all outbox jobs before interpreting them and requires both a verified owner identity and the enabled `owner.dashboard` permission; the Telegram owner-menu route additionally requires `TELEGRAM_PRIVATE`, a verified context, and the exact owner-as-chat recipient. It returns no individual job metadata, message IDs, chat IDs, per-student lists, update IDs or content; even low-volume groups are not broken down separately. The view is available through the already-existing 📊 حالة الرسائل menu choice without an additional operational tool, public endpoint or scheduled notification.

Privacy boundaries: the ordinary outbox still stores limited receipt metadata, and this release **does not purge the existing ledger** or remove data already present in historical backups. It only adds a bounded categorical value to newly denied replies and aggregates counts. It neither automatically retries Telegram sends nor edits the source ACL, migration quarantine, source publication, or Phase 17 AI path.

TDD introduced 12 JSON/SQLite cases including legacy private/group quarantine, lost group membership, revoked navigation, provider failures, owner-only dashboard and rejection of invalid/coercible persisted denial reasons. The implementation passed **1,250/1,250** tests, strict TypeScript and five offline demos on the source branch. No real generative AI or paid provider is enabled.

## B6 v0.7.56 — fail-closed upgrade for unclassified legacy Telegram private replies

**Why:** Private Telegram replies from before v0.7.55 may contain group-scoped educational resources but were queued **without any durable record of the content's group of origin**. Their destination `chatId` and HTML text do not prove that they are safe `private`-scope content. The v0.7.55 dispatch membership recheck could not protect those older QUEUED jobs. Reconstructing membership or source provenance from a title or a current group catalogue is not reliable.

**Migration rule:** All newly queued private replies now carry a durable `privateReplyKind` set by the trusted inbound update pipeline: `LOCAL` for messages without group-scoped proof, `GROUP_SCOPED` only when `privateGroupAccess` is present. On each dispatch, **old private QUEUED replies with neither a `privateReplyKind` nor a v0.7.55 `privateGroupAccess` witness are denied locally** (`FAILED_CONFIRMED`) and have the plan erased. No `sendMessage` is invoked, no external attempt ID is created and no automatic retry occurs. This conservative quarantine may affect entirely benign pre-upgrade private menus as their origin cannot be attested; a student may reissue the command. It is a lazy transition when an old reply is dispatched, not a bulk cleanup.

**Backward compatibility:** Already queued v0.7.55 private group-scope replies with a valid, unexpired `privateGroupAccess` but no new `privateReplyKind` still pass the existing fresh group membership/required-channel and scoped publication checks. New `LOCAL` private-only replies continue normal delivery. New `GROUP_SCOPED` replies require the same scoped proof. Both JSON and SQLite persist the enum, reject malformed or contradictory origin/proof combinations, and strip the classification and transient actor/group witness before the irreversible Telegram send. `SENDING`/`UNKNOWN_OUTCOME` receipts never replay blindly. Existing authenticated group outbox behavior is unchanged.

**Limit:** Pre-upgrade messages already marked `SENDING` or `UNKNOWN_OUTCOME` may have been delivered and cannot be recalled; the rule stops only unstarted QUEUED legacy items. Telegram group membership and Bot API send are still separate remote actions, not an atomic provider transaction. No paid provider, Phase 17 real AI or generative student response is enabled.

18 added JSON/SQLite regression tests cover old unclassified private quarantine, newly marked `LOCAL` and `GROUP_SCOPED` private jobs, compatibility with existing group-scoped membership proofs, persisted enum consistency, plan redaction, and no replay of already-started/unknown sends. Full CI: strict TypeScript, complete tests and five offline demos.

## B6 v0.7.55 — last-mile group resource permissions in private Telegram chat

Private Telegram chats can request group-scoped educational catalogs using `/categories <groupId>` or `/resources <groupId> <categoryId>`, or a group-scoped, owner-issued resource link via `/resource <ref>`. At admission, the bot already checked actual group membership and mandatory subscriptions. Previously, however, the returned **private** reply was queued without a link back to the group scope, so a subsequent membership loss, group revocation, added subscription, or source unpublication before `sendMessage` could not be detected by the dispatcher. This release attaches a bounded `privateGroupAccess` witness for **new** queued private replies derived from group-scoped sources.

The witness contains the numeric requesting actor ID (equal to the private reply recipient), the authorized group scope ID, a SHA-256 digest of the group policy/subscription/content epoch, and a 120-second expiration. No source document text is placed in the witness; **the actor/group IDs are briefly persisted, not anonymous**. The dispatch worker checks current read-only Telegram *group membership* independently of required-channel subscriptions (even when no subscription channels are configured). If active subscription rules exist, it also verifies mandatory channel membership. The same policy and content epoch is rechecked inside the one-shot queue claim after these external provider calls. Missing verification service, lost/unknown membership, source/category revocation, changed subscription rules, expired or malformed witness denies the send and erases the queued reply and witness. The webhook's live sender receives the existing Telegram membership gateway as a separate, read-only dependency.

Ordinary private-scope menu replies retain their existing dispatch behavior. Queued group replies and reviewed group FAQ are still guarded by their separate existing witnesses and are not changed by this private-scope feature. In-progress or UNKNOWN Telegram send attempts are never retried automatically. This is a last-local-claim proof; there is **no atomic operation across Telegram membership and sendMessage**, so remote membership can change after the final check. No generative AI, paid AI API or Phase17 production consumer contract is enabled.

**Upgrade limit:** Old private replies already stored before v0.7.55 have no group-scope provenance. They remain backward-compatible, which means this version **cannot retroactively certify or block all legacy private replies** containing group titles. Deployments requiring strict revocation of those old pending replies must first drain or quarantine them under owner review; never assume the new witness covers the old queue. This is intentionally recorded as a remaining migration item.

22 new JSON/SQLite and live-server tests cover unchanged/changed group membership, required-channel subscription, source/category revocation, invalid and expired evidence, policy changes while membership is awaited, ordinary private menu independence, and the expected new last-mile membership requests in the live transport. The release must pass strict TypeScript, the full test suite and all five offline demos before merge.

## B6 v0.7.54 — group content revocation fence at Telegram reply dispatch (reviewed FAQ and navigation only)

Group access and required-channel membership are not sufficient to authorize a **previously queued educational answer** once the owner archives a source resource, disables a category or revokes a reviewed FAQ. The prior B6 v0.7.53 group outbox epochs covered membership, group permissions and subscription rules, but not the current publication/approval state of the educational material itself. In v0.7.54, a single source-of-truth group authorization epoch additionally includes the local **group-scoped** education category, education resource and FAQ review snapshots, ordered deterministically by ID. Both group FAQ and group navigation witnesses carry a SHA-256 digest of this exact epoch, rather than sensitive raw source text.

The group outbox dispatcher compares that original epoch before and **inside** its exclusive send-claim transaction (including after awaited external Telegram membership verification), so changes in group content status, titles, visible categories, answer bodies and publication source metadata reject a queued reply without making a Bot API call. During slow B6 approved FAQ lookup, the existing planning fence now also rejects source changes after the initial read. Normal private-chat content edits do not affect an unrelated group epoch. This is conservative: changes to group drafts or metadata that did not appear in a visible reply can also invalidate queued replies.

**Upgrade behavior:** The queued FAQ and GENERAL epoch domains advance from `v1` to `v2`, deliberately failing closed for **existing v0.7.51–0.7.53 group plans** whose prior witnesses could not attest that content remained approved. Those queued plans will be denied and redacted on dispatch rather than blindly replayed or inferred safe from HTML. Reissue commands to see freshly reviewed content. Private replies and already started/UNKNOWN Telegram attempts are not retried; no automatic migration or destructive outbox reset is performed.

The digest is a local change detector, not a secret, a signature, or proof of Telegram membership. This check cannot roll back a message after Telegram has accepted it, and publication state can change after the final local claim. It is **not** a live Phase 17 AI connection; the generation/provider path remains disabled. The tests are offline JSON/SQLite behavior and include source archive, FAQ archive, category disable, changed approved answer, in-flight membership proof races, independent private content edits, and denied planning after concurrent source revocation.

Sixteen new JSON/SQLite regression tests were added (1,198 total expected); the TDD RED build recorded twelve failing source-revocation cases. GitHub Actions strict TypeScript, full test suite and five demos are mandatory before merge.

## B6 v0.7.53 — revalidate group navigation and resource menus at Telegram dispatch

Group `/categories` and `/resources` plans also contain approved but potentially restricted educational resource titles. In v0.7.52 an explicitly tagged `GENERAL` group reply was sent after checking only local group navigation approval, without rechecking the requesting student's mandatory-channel membership when the queued message was dispatched. This release applies a **scoped, short-lived authorization witness** to all new group GENERAL reply plans and a fresh subscription check at the last local send claim. It does not activate generative AI.

The optional `groupMenuAccess` has the original actor's Telegram numeric ID, a SHA-256 digest of the group/rule/required-channel approval epoch (a change detector, **not** a membership receipt), and a 120-second expiry. It is created only after initial group subscription admission and deleted along with the message body and group origin marker when the send is claimed or refused. Unlike unguarded GENERAL entries, new group menus can still be delivered when their local epoch and current membership remain valid. The private-chat outbox and previously guarded B6 FAQ remain unchanged.

An outbound GENERAL group job without `groupMenuAccess` is fail-closed even if it was explicitly tagged `GENERAL` in v0.7.52. Previously queued GENERAL responses may therefore be quarantined; the user can repeat their group navigation request. Both JSON/SQLite persistence and runtime validators reject malformed or contradictory group access metadata. The dispatcher checks group policy and membership **before** the exclusive queue claim, then compares the exact epoch again **inside the transaction**, fencing local changes during membership calls. Missing/unknown membership, changed required-channel rules and expired proofs cannot authorize the send.

**Limits:** A Telegram membership check and Telegram `sendMessage` cannot be one external atomic operation. A remote membership change after final verification remains possible. The queued Telegram actor ID is temporary personal data, not anonymous. No real Phase 17 API, model-generated response, payment, or privileged AI credentials are enabled. This behavior is verified in offline JSON/SQLite tests, not an external production end-to-end send.

Fourteen JSON/SQLite regressions cover group categories and resource listing, expired/legacy GENERAL queue rows, new/revoked membership, new mandatory subscriptions, absent/unknown verifier, rule races during membership lookup, valid deliveries and invalid persisted witnesses.

## B6 v0.7.52 — fail-closed pre-upgrade Telegram group outbox provenance

**Upgrade safety:** B6 v0.7.51 introduced a short-lived `groupQuestionAccess` witness for newly queued reviewed group FAQ replies. Older pending group replies can have **no witness and no trustworthy origin marker**, so one may be an authorized menu plan or an old reviewed FAQ answer that bypasses the new last-mile membership recheck. It is unsafe to infer the type from an HTML heading or question substring. On dispatch, an unclassified **group** `QUEUED` row without a prior guarded FAQ witness now fails closed with `FAILED_CONFIRMED`, **no Telegram network call**, no attempt ID and scrubbed plan. This is a lazy, one-way quarantine upon attempted dispatch; it does not bulk-send, resubmit or delete old outbox rows.

New group replies created through the trusted `BotStore.finish` route persist an explicit `groupReplyKind` discriminator: `GENERAL` for non-FAQ navigation and `REVIEWED_FAQ` when a validated B6 group question access witness accompanies an answer. The dispatcher only sends tagged `GENERAL` group replies subject to its previous group authorization checks; `REVIEWED_FAQ` still requires the scoped, expiring B6 witness and fresh membership check. The marker and any short-lived witness are removed when a reply leaves the queue. Contradictory/malformed classifications are rejected by shared JSON/SQLite state decoding and by the dispatcher.

**Compatibility:** Private queued messages with no group provenance marker continue their existing delivery path. Previously queued **v0.7.51** reviewed FAQ responses with a valid `groupQuestionAccess` but no newer discriminator remain eligible for the existing protected dispatch-time reauthorization. Old unclassified group navigation messages may also be quarantined: their purpose cannot be safely proven from past data and the user/owner can request the action again. No malformed state is automatically rewritten, no previously started send is retried, and `UNKNOWN_OUTCOME` remains unresolved until the owner review flow handles it.

14 added JSON and SQLite regression tests: pre-upgrade unclassified group quarantine, new generic group navigation, old private reply, invalid or contradictory origin tags, never replay started or unknown sends, and compatibility with older guarded v0.7.51 FAQ messages. No external AI calls, Phase 17 contract, production billing or generative student answer has been enabled.

## B6 v0.7.51 — queued approved-group FAQ dispatch authorization (not generative AI)

Previously the B6 group FAQ Telegram reply was reauthorized after awaited knowledge lookup only when its outbound plan was created. A Telegram reply may instead remain **QUEUED** before the real Bot API `sendMessage`. This release adds a dedicated, short-lived `groupQuestionAccess` witness **only** for reviewed group FAQ replies (including the legacy B3 approved FAQ fallback). The witness contains the original Telegram actor ID, a SHA-256 **change-detection digest** of the approval/subscription/group policy epoch, and an expiry after 120 seconds. It contains no student question text or generated model content and is deleted when the queued reply is claimed or rejected. The actor ID **is temporarily stored** in the queue until that claim; it is not an anonymous identifier. Existing non-FAQ group menu plans and private replies retain their prior dispatch behavior.

Immediately before claiming a queued FAQ response, `TelegramReplyDispatcher` compares the policy epoch, enforces the original actor's group ask permission, and where a required channel is active, re-verifies subscription membership using the supplied `SubscriptionGate`. Without a verifier, lost/unknown membership, changed rules, revoked group permission, AI mode OFF, malformed witness, or expired witness, it fails closed without sending and redacts the queued plan. A second epoch/policy comparison **inside the exclusive claim transaction** fences locally changed state during the external membership lookup. The live Telegram composition now supplies its existing read-only subscription gate to the reply dispatcher. The sender still never retries a possibly ambiguous external Telegram attempt.

**Important guarantee limit:** Telegram does not provide an atomic membership-check-plus-send operation. Membership can change after the last provider query or after the outbound claim, so this is a strict *pre-dispatch* freshness check and local transaction fence, not an absolute guarantee against all remote race windows. The JSON simulation has only a per-process mutex; SQLite stores use database transactions. A hashed epoch is not user anonymity or cryptographic proof of membership. The HTTP ingress still requires the Telegram webhook secret. Existing Phase 17 generative AI remains OFF; only previously reviewed FAQ replies are eligible.

18 new JSON/SQLite regressions cover valid send, changed membership, new/paused subscriptions, changed group AI policy, expired witness, unknown/no provider, subscription changes during verification, and tampered state. The release must pass strict TypeScript checks, **1,154** tests and five offline demos before merging.

## B6 v0.7.50 — end-of-planning Telegram group subscription evidence fence (approved FAQ only)

The optional B6 Telegram group `/ask@Bot` and explicit `@Bot` mention routes now carry a local subscription/group authorization epoch from the **initial** gate across the potentially slow reviewed FAQ/knowledge lookup. Immediately before planning a group answer, the handler rereads group approval and AI settings, required-channel rule versions, channel authorizations and subscription mode; any change denies the answer instead of trusting an outdated Telegram membership result. The fence is enforced for the legacy approved B3 group FAQ fallback too.

For an unchanged active required-channel rule, the handler makes a second fresh subscription verification after FAQ retrieval. Missing verifier, unknown/unverifiable membership and removal of membership all deny planning; a rule change or revoke/reapprove during this second external check is also rejected. The route permits an unchanged verified member; private FAQ is unaffected. The check does not authorize non-reviewed model text or substitute for a proper Phase 17 consumer API.

**Important boundary:** This is a *reply-plan* authorization check. It cannot guarantee membership remains current when a previously queued Telegram reply is eventually dispatched. The outbox/sender must separately guard actual delivery with a provider-time authorization/evidence model before claiming live last-mile protection; do not interpret this release as closing all delayed-send races. JSON simulation is single-process; SQLite tests exercise transactional local state. Fake AI remains OFF.

Sixteen added JSON/SQLite behavior tests cover new rules after the first check, rule pause/reconfiguration, lost membership while FAQ awaits, rule change during the second membership check, preservation of valid member answers and legacy FAQ fallback. GitHub Actions runs strict TypeScript, automated tests and five offline demos. No real AI model, external Phase 17 authorization, or automatic generated reply is connected.

## B6 v0.7.49 — owner-only reply to one student's current Telegram message (approved FAQ only)

When the verified bot owner **replies to an existing student message inside an approved group** with `@ManaratakBot أجب عن هذا السؤال` (using a real Telegram mention entity), or `/ask@ManaratakBot أجب عن هذا السؤال`, the bot now extracts the question **only** from that update's direct `reply_to_message.text`. There is no chat history retrieval, previous question cache, forwarding, quote concatenation or arbitrary model generation. If the replied-to message is missing, the owner receives a prompt to reply directly instead of guessing the question. Students cannot use this privileged reply-to shortcut.

The strict local `parseB6OwnerReplyTarget` validates the original message ID precedes the owner's, the source chat matches the current group, a known non-bot sender differs from the owner, text is 1–240 clean UTF-16 code units, and the target is neither forwarded nor nested nor from a channel/bot. Malformed, ambiguous, cross-group or future message references fail closed. The existing subscription and group permission checks, exact published FAQ source authority, revocation-after-await revalidation, and Telegram reply outbox are reused. The owner shortcut does not bypass a group AI policy set to OFF.

20 added JSON/SQLite and focused helper tests exercise valid mention/slash requests, absent targets, student impersonation, unsafe forwarded/nested/cross-chat targets, invalid questions, approval lookup misses, independent private FAQ and policy revocation. **1,120** automated checks expected. The operation plans *only an existing reviewed FAQ reply*, not AI model text; Telegram live AI and central Phase 17 consumer contract remain OFF.

## B6 v0.7.48 — real Telegram MessageEntity mentions for approved group FAQ (no generative AI)

Inside an approved group, a current message of the form `@ManaratakBot ما شروط المنحة؟` can now use the same reviewed, scope-restricted B3 FAQ and optional B6 `B6AnswerPreflight` as `/ask@ManaratakBot ما شروط المنحة؟`. The bot must be explicitly named as a Telegram `message.entities` record of `type=mention` starting at UTF-16 offset zero with exactly the bot username and a separated, non-empty question. This avoids treating ordinary pasted text, user display names, quoted text, forwards, `text_mention`, an unrelated bot or incomplete/split UTF-16 code units as consent for the assistant.

The existing group authorization, optional subscription proof with policy/version freshness, bot username identity from trusted configuration, scope isolation, approved source validation, retry/outbox handling and post-await revocation checks remain in force. Malformed or ambiguous entity metadata is rejected; non-prefix mentions are ignored. Only the question in the current message is used — no chat-history scraping, no reply-to or caption processing, and no model-generation fallback. Private `/faq`, `/ask` and the existing group `/ask@Bot` continue unchanged.

Both JSON and SQLite suites cover real mentions, casing, UTF-16 emoji, spoofed/absent entities, other bots, forwarded and quoted text, duplicate/conflicting entities, group AI OFF, legacy reviewed FAQ fallback, and revocation during retrieval; five isolated pure parser tests cover additional malformed boundaries. 21 additional tests in this release (1,100 total expected). The live webhook must still validate Telegram's shared secret at the HTTP boundary; the in-process test adapter alone does not authenticate a Telegram update. No real Phase 17 AI endpoint, student AI response, automated publication, paid provider call or billing is enabled.

## B6 v0.7.47 — persistent HMAC-key continuity for offline Telegram attempts

A new optional schema-8 `b6TelegramKeyBinding` stores a **keyed, domain-separated HMAC fingerprint** of the trusted Telegram fake-generation intent secret, not the secret itself. On the **first successful durable reservation** made with a Telegram-derived `b6tg1_` request key, the fingerprint is pinned atomically with the attempt. All subsequent Telegram reservations must use the same secret. A changed or incorrectly configured secret fails closed (`UNAVAILABLE`) before another model attempt; JSON single-process and SQLite transactional tests cover simultaneous different secrets, restarts and unchanged-key replay.

**Legacy migration guard:** databases containing ANY previous B6 attempts but lacking the fingerprint cannot enroll an unverified new secret. Such Telegram requests return `UNAVAILABLE` until an independently reviewed migration verifies old intent evidence, rather than risking duplicated generation or lost reserved spending. No automatic key rotation or reset is performed. Unmodified historical JSON/SQLite stores can still be read; no destructive schema migration. The reserved units, unknown outcomes and request ledger remain intact.

Malformed, all-zero, wrong-case, non-string or extra-length persisted fingerprints are rejected by the shared JSON/SQLite schema decoder. Direct callers cannot reserve a `b6tg1_` namespace key without supplying an associated binding; non-Telegram fake reservations remain offline-only. Disabled or denied requests do not enroll a secret. The gate is **not connected** to the live Telegram update handler or Phase 17 API, and the fingerprint is NOT tamper-proof against an attacker already authorized to rewrite the database. Protect both the trusted secret and state backups.

Added 14 red/green JSON and SQLite tests; the project runs `npm run check` and offline demos in GitHub Actions. This does not turn on real AI, Telegram student delivery, production usage metering, billing, or Phase 17 integration.

## B6 v0.7.46 — stable HMAC keys for verified Telegram update intents (OFFLINE)

`B6TelegramIntentKeys` derives an opaque, deterministic URL-safe `b6tg1_…` request key from an already-verified Telegram **bot ID + update ID**, with a distinct HMAC-SHA256 domain label. It takes an explicit 32-byte hex-encoded secret from trusted caller configuration, rejects malformed/missing/zero secrets and malformed event tuples, and never stores the Telegram actor, chat ID, question, bot name or HMAC secret in the persistent budget ledger. Recreating the service with the same stable secret gives the same key; distinct bots/updates/secrets produce different keys.

`B6TelegramDraftEntrypoint` passes this key to a newly added `prepareDurableDraft` method on `B6GenerationDraftService`. This path fails closed with `UNAVAILABLE` when the local durable reservation ledger has not been provided, rather than silently using only the in-memory counter. Duplicate updates after JSON/SQLite restart return `DUPLICATE` without another fake model invocation. Unauthorized and disabled policies still deny access before any fake call. The pre-existing general `prepareDraft` remains available only for offline simulation/tests.

**Important:** The entrypoint is NOT wired into Telegram's live handler. An external caller must supply Telegram-verified event IDs, not student-supplied fields; constructing a similarly shaped object is not verification. Keep the HMAC secret stable and private across restarts and replicas; secret rotation changes derived request keys and requires separately reviewed replay/retention migration. No secret is generated at runtime or written in this repository. The 16 new tests exercise deterministic keys, scope isolation and privacy, malformed values and durable-only replay guards in JSON/SQLite; 1,065 tests pass on the code head. Phase 17 integration, provider receipts, live generation and Telegram student send remain OFF.

## B6 v0.7.45 — bounded fake-generation deadline and monotonic admission (OFFLINE)

The explicitly injected fake-only `B6GenerationDraftService` now applies a wall-clock maximum to each generation attempt (`B6DraftConfig.maxDurationMs`, default 30,000 ms; allowed 20–900,000). When the fake port hangs or rejects, the service returns `UNAVAILABLE`, releases its local concurrency slot, marks an active durable attempt `UNKNOWN_OUTCOME`, retains all conservatively reserved units and rejects a replay of the same stable request key. Late fake-provider text is discarded, not sent or published, and provider error strings are never exposed.

The in-memory `B6EphemeralCallBudget` also rejects backwards clock jumps as `CLOCK_ROLLBACK`, and treats invalid or throwing clocks as `UNAVAILABLE` instead of throwing from `begin()`. Its per-process high-water mark preserves earlier spent fake-call quota after a clock rollback; it is **not** a persistent provider billing mechanism. A read-only `summary()` signals clock errors by throwing. The existing JSON/SQLite durable budget and owner-only unknown-outcome dashboard are independent.

Seven new focused regression cases cover time rollback, broken clocks, bounded hangs, late responses, durable UNKNOWN persistence, fake-provider errors and malformed deadline settings. Full TypeScript/test/demo CI is the release gate; **1049 tests** expected. This does not connect real Phase 17 AI, bill a provider, activate student-facing generation or enable outbound sends.

## B6 v0.7.44 — owner Telegram fake-AI reservation monitoring (OFFLINE)

The optional local owner menu now includes **🧮 ميزانية المساعد التجريبية**. It displays an eight-attempts-per-page privacy-redacted report of daily attempt counts, reserved conservative units, active leases, expired leases and unknown outcomes. An expired lease is **only reported** on a read; the owner can separately choose **🧯 عزل المحاولات المنتهية** to quarantine it as `UNKNOWN_OUTCOME`. A distinct **⚠️ مراجعة محاولة** and **✅ إقرار المراجعة** workflow records that the owner saw the warning, without changing that unknown outcome, refunding units, reissuing the original request or proving anything about the upstream AI provider.

This remains an offline fake-model operation. Budget values are reservation simulation units, **not real model usage or payment amounts**, and the review is not provider receipt reconciliation. Access is limited to verified owner private Telegram interactions, with fresh permission checks and a durable audit note. Invalid, copied, replayed or revoked controls fail closed. The existing /faq, knowledge-only /ask and live Telegram deployment configuration remain unchanged.

## B6 v0.7.43 — persistent fake-generation reservations (OFFLINE; not a money budget)

`B6DurableBudget` adds conservative reservations to the bot's schema-8 JSON/SQLite storage: an opaque request key, unique attempt ID, UTC day, upper-bound reserved units, lease and final state. SQLite uses serialized write transactions, so two bot processes cannot independently admit over the same local SQLite budget. JSON is only a single-process simulation. A duplicate request key is rejected after restart; an expired in-flight attempt is quarantined `UNKNOWN_OUTCOME` and never retried/refunded automatically. Malformed stored state or a full bounded ledger fails closed without wiping past attempts.

When **explicitly injected** into `B6GenerationDraftService`, a stable request key gates the fake-only model call; absence, duplicates, exhausted quota or an expired lease cannot yield a draft. Source review and authorization still run before and after waiting for the fake provider. The service is OFF by default, generates no student-facing messages and does not enable Telegram live sending.

**Important:** the fixed 8192-unit fake attempt reservation is not verified token usage or monetary cost. This is not a replacement for the future central Phase 17 billing/receipt/reconciliation contract, authenticated provider, global budget, reviewed release decisions or deployment acceptance.

## B6 v0.7.42 — fake-only generation drafts, owner review required (OFFLINE)

A new `AnswerGenerationPort` interface and `B6GenerationDraftService` can prepare an **unpublished review draft** from a trusted approved FAQ after explicit injection of a **fake** provider and an enable flag. The source and permission policy are checked again after awaiting the fake response. A draft includes validated provenance, bounded token counters, and a separately escaped HTML preview; it is **not an approved answer** and is never displayed to a student or sent to Telegram. There are no API credentials, external AI requests, production model calls, or automatic fallback.

The `B6EphemeralCallBudget` can limit fake attempts within one running process and prevent concurrent over-subscription. It returns `durable:false`: it cannot enforce spending or usage quotas across restarts/replicas, and failures still consume an attempt. A **durable central Phase 17 budget, authenticated provider contract, output moderation/review and deployment acceptance** are prerequisites before production AI. All existing /faq and knowledge-only /ask simulation behavior is unchanged.

## B6 v0.7.41 — first knowledge-source answer preflight (offline; NO GENERATIVE AI)

The B6 `KnowledgeSourcePort` receives only a question and its scope, not the Telegram actor or prior conversation. The `B6AnswerPreflight` validates explicit private opt-in or an approved group mention and independently rechecks the existing B3 **approved FAQ** against the returned candidate after any asynchronous source read. Changed/archived material, revoked policy, ambiguous matches, fabricated hints and provider errors never produce an answer.

For explicitly injected offline test applications only, `/ask QUESTION` in an opted-in private chat and `/ask@BOT QUESTION` in an approved group may return an exact reviewed answer. Unconfigured apps behave as before, and `/faq` stays independently usable even when AI is off. The new path **does not generate text**, call any AI provider or send live Telegram messages. Phase 17 integration, budgets, credential management, secure prompt assembly and deployed Telegram delivery are separate future acceptance stages.

## B5 v0.7.40 — signed owner Mini App source preview and integrity (offline)

An administrator's optional Telegram Mini App web listener now has two **read-only**, owner-only B5 endpoints when configured with an independently verified `PlatformCatalogPreviewService`:

- `POST /admin/platform/preview` — strict optional JSON `{ "limit": 10, "cursor": null }`; authenticated owner sees a bounded `UNVERIFIED_EXTERNAL` preview and full-page fingerprint without writing any local import or resource.
- `POST /admin/platform/integrity` — strict JSON `{ "sourceId": "external-id", "expectedDigest": "<64 lowercase hex characters>" }` for a previously locally published B5 source; returns a read-only integrity status. `NOT_ON_PAGE` never proves that an offer closed.

Both reuse the authenticated Telegram Mini App `x-telegram-init-data` header, require current owner-dashboard permission and reject unknown or duplicated JSON properties. Neither is registered by default, because the production Manaratak API contract and trusted reader are not connected. No Telegram channel post, automatic archive/publish, platform write, AI generation or live server activation is introduced by this release.

## B5 v0.7.39 — Explicit local archival of reviewed external resources (offline)

The optional owner-only external source integrity report can display an archive preview and an independent final confirmation for a published local scholarship. A stale local resource fingerprint, copied student button, revoked owner dashboard or conflicting concurrent click is rejected. This action changes only the local student catalogue, never the upstream website, and does not claim the scholarship has closed. No Telegram channel announcement or production external API is enabled.

## B5 v0.7.38 — recheck an external source after a grant has been locally published

The optional owner-only **🔬 سلامة المصادر الخارجية** Telegram menu displays locally published external education records with bounded pagination and an explicit **🔬 فحص مصدر** option. This is an advisory **read-only** integrity check: it can say the current metadata matches, the source changed, the record is missing from the saved cursor page (not proof of closure), the provider is unavailable, or the local resource was archived or altered. It never updates or archives the student library automatically, sends channel messages, or claims a scholarship is definitively closed. The external API remains a mock adapter unless independently authenticated and verified. B5 approval/publication remain separate owner-confirmed operations.

## B5 v0.7.37 — owner Telegram mock approval and local publish confirmations

The optional **🔎 معاينة بيانات منارتك** owner workflow extends beyond unverified staging and metadata review: private category choice (with pages), explicit owner approval for that category, separate local publication preview, and an explicit final local publication confirmation. Only the last action can make the record visible in the bot's local private student catalogue, and it re-checks the external source freshness using the full saved digest. Telegram action buttons use bounded unique selectors, not authority tokens; unauthorized students/groups and revoked/stale category/source states remain denied. Channel announcements, campaigns, external AI and a real upstream Manaratak API are not activated by this release.

## B5 v0.7.36 — separate reviewed external category approval and local publication (offline)

The B5 backend now supports two separately authenticated owner decisions after metadata review: approve an unchanged source record for a currently active private educational category, then, in a distinct later call, freshly revalidate the source and explicitly publish **one local private educational resource**. Approval alone never makes a grant visible. Publication is local-only; it sends nothing to Telegram and marks unknown seats as unknown, without inventing source links or eligibility. Changed source data, archived resources, disabled or cross-scope categories and owner revocation are rejected. The backend is tested with mock readers in JSON/SQLite; a Telegram owner confirmation UI and real upstream provider adapter are not enabled by this release.

## B5 v0.7.35 — review external candidates from the owner's Telegram mock menu

In the optional owner-only **🔎 معاينة بيانات منارتك** workflow, each externally self-reported published row now offers **📥 تسجيل مرشح**. The source is freshly verified against its complete page fingerprint before durable staging, including on later cursor pages. After staging the owner receives a separate **✅ تدقيق بيانات** action which rechecks the exact saved source revision and metadata and records only a **reviewed-metadata** state. There is still no import/publish action, no verified live Manaratak platform API or credentials, no public/student catalogue access and no live Telegram send/AI execution. This feature is exercised only in offline JSON/SQLite mock integration tests.

## B5 v0.7.34 — quarantine queue for external grant records (offline)

An owner can stage one unverified platform candidate only from an unchanged, freshly re-read external page, preserving a SHA-256 digest of the source metadata. A second owner-only action may mark its metadata reviewed after independently re-fetching the same currently published external source and matching its revision and all fields. Both statuses remain **quarantined**: no student catalogue item, import, publication, campaign or Telegram outbound send is created. The optional schema-8 `platformReviewQueue` is bounded, JSON/SQLite validated, and has no platform tokens. The actual external API remains unconnected.

## B5 v0.7.33 — owner Telegram preview for an explicitly injected platform reader (offline)

The Telegram owner's administrative menu conditionally offers **🔎 معاينة بيانات منارتك** when the application has a B5 read-only reader adapter. It shows only bounded escaped titles, universities and source IDs that remain **externally unverified**, with an owner-only next-page control. No reader means **no preview button**; stale/forged, student and group requests are denied. This does not import or publish anything and does not connect to a real Manaratak production API. The normal Telegram webhook audit still records the inbound mock interactions.

## B5 v0.7.32 — proposed read-only Manaratak catalogue contract (offline only)

A provider-neutral, owner-only `PlatformCatalogReader` adapter and strict `PlatformCatalogPreviewService` can preview up to ten externally self-reported published private catalogue records without writing to local storage or exposing them to students. Every candidate remains **UNVERIFIED_EXTERNAL** and cannot become a local approved resource without a future explicit review workflow. The real platform's API, URL, credentials, schema and connectivity are **not** connected or inferred. Owner dashboard permissions are checked both before and after fetching; all tests use mocked providers.

## B3 v0.7.31 — improved Arabic search for published scholarships (offline)

The student `/search` route now uses the same Arabic-friendly keyword normalization as the approved FAQ search. For example, `/search منحة الصين 2027` can locate an authorized published title written `مِنْحَة الصِّين ٢٠٢٧`, and `/search جامعة اندونيسيا` can match a verified owner's university field containing `جَامِعَة إندونيسيا`. Academic cycle and degree metadata also participate. Search results remain confined to published private resources with currently enabled categories and current source checks on tapping; no group leakage, autonomous publishing, external AI or live Telegram activation.

## B3 v0.7.30 — Telegram-safe Arabic catalogue pages (offline)

Student FAQ, scholarship/resource search and category browsing now shorten only **displayed list snippets** so ten owner-reviewed HTML-heavy or Arabic titles cannot overrun a Telegram message. Resource/category buttons also fit Telegram's UTF-8 and codepoint limits. The saved source is unchanged, and a button still requires a freshly authorized published item on every selection. Tested on the JSON/SQLite offline adapters with Node 22; no live Telegram send, publishing, AI, or data migration is enabled.

## B3 reviewed Arabic FAQ keyword search — v0.7.29 (OFFLINE ONLY)

Private students may use `/faqsearch <terms>` to discover approved questions by original title or reviewed aliases. Search now tolerates common Arabic differences such as tashkeel, alef variants, maqsurah, tatweel, Arabic/Persian digits and punctuation/space separators. The owner's original reviewed title and source remain unchanged, and results still require the current approved private publication and enabled education navigation. Normalization never produces answers by itself, is not AI, and does not relax the exact `/faq` operation or existing query input limits.

Example: `/faqsearch منحة الصين 2027` can find a reviewed question titled `مِنْحَةُ الصِّينِ ٢٠٢٧`; selecting its current opaque button opens the same source-backed reviewed answer. A query consisting only of stripped punctuation/diacritics returns no results, not the entire FAQ catalogue. No live Telegram activation, messaging or student search history is added.

## Current B3 security slice — v0.7.28 (offline; NOT DEPLOYED)

Mandatory-channel requirements now share one conservative authorization model across private group resource links, group commands and private browsing of group catalogs:

- Students require `MEMBER` when a verified group has an active mandatory-channel rule. `NOT_REQUIRED` never grants student access under an active rule; only the trusted bot owner may use that explicit exemption.
- A group rule is not silently paused if its saved mode/version/channel IDs are malformed, its group has multiple conflicting rules, or any active required channel/group has lost its local verification scope. All such states block protected access.
- Final group authorization is checked again after any pending subscription provider result. An owner changing or pausing the requirement while verification is in progress wins over stale evidence.
- The JSON and SQLite offline integration suite covers authorized/unverified membership, corrupted rules, duplicates, owner exemption, and changed local approvals. No live Telegram token, real enforcement, moderation, AI provider, channel publication, or user-data migration is enabled.

To validate locally with Node 22+: `npm install --no-audit --no-fund && npm run check`. See `docs/TRACEABILITY.md` and `CHANGELOG.md` for scope and outstanding live deployment blockers.

# بوت منارتك — MANARATAK BOT

**B0/B1 + B2-Core + B3 + B3 privacy-safe Telegram reply outbox and opt-in authenticated owner review and deployment preflight and ingress hardening and outbox monitoring and emergency STOP and offline acceptance and restore rehearsal (v0.7.0). Transport implemented but OFF by default — no live deployment verified.**

An independent TypeScript/Node.js 22 project based on `docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md` and `docs/START_HERE_MANARATAK_BOT_v1.2.1_AR.md`. B0/B1 supply the secure baseline; B2-Core adds individual moderation and subscription policies; B3 adds the first locally tested education content flow.








## B2-Core v0.7.12 — fail closed when mandatory-channel membership evidence is incomplete

The existing `SubscriptionGate` now treats an exception from `canVerifyChannel` as `UNAVAILABLE` for an attempted student check, not an unhandled crash or confirmation of non-subscription. An owner attempting to configure a required channel while verification is unavailable gets the static `CHANNEL_UNVERIFIABLE` outcome, with no saved configuration update or leaked provider error.

For `ALL` subscriptions, an unknown channel result makes the decision `UNAVAILABLE` **even if another channel is confirmed NOT_MEMBER**: incomplete provider evidence must not produce a new restriction. For `ANY`, a confirmed MEMBER is sufficient, but absent a confirmed MEMBER, an UNKNOWN result prevents a false NOT_MEMBER decision. Unexpected membership values also become UNKNOWN. The existing `syncSubscriptionRestriction` continues to leave moderation reasons untouched on UNAVAILABLE and keeps revalidating rule versions after asynchronous checks.

This fixes **mock-tested provider failure behavior only**. It does not imply that real bot administrator rights, Telegram permissions or membership checks have been accepted or deployed.

## B3 v0.7.27 — prevent mandatory-channel subscription bypass via resource links (OFFLINE)

An opaque `/resource r_...` link to a reviewed **group-scoped** resource is not a bypass around group subscription policies. The existing trusted membership check must show the student belongs to that group. When the group additionally requires mandatory-channel subscriptions, the link now calls the configured `SubscriptionGate` and requires verified compliance; a missing/unavailable verifier, a confirmed nonmember or unknown membership yields a private denial without exposing the group's content. This step remains read-only and **does not automatically mute or unmute**.

The source, authorization revision, link validity, subscription mode/channel list/version and current group rights are checked after awaited provider calls, so changing the requirement during verification cannot turn an outdated result into access. Group links without active mandatory-channel requirements remain usable by eligible verified members. The live Bot API adapter and deployment are still OFF pending separate acceptance.

## B3 v0.7.26 — FAQ keyword search includes reviewed aliases (OFFLINE)

Students can search the private approved FAQ library with `/faqsearch WORDS` or **💬 المساعد التعليمي → 🔎 ابحث في الأسئلة**. Results now include questions whose **owner-reviewed alternate wording** contains the requested word, even when the original displayed question title does not. The original title—not aliases, raw UUIDs or a synthesized answer—is displayed. A selected numbered result is checked again against the fresh currently visible approved private FAQ and its published source before its approved answer is revealed. Pagination remains 10 items/page and all results stay local, without new search logs or AI calls.

For example, a reviewed FAQ titled «كيف أقدم على المنحة؟» with the alternate wording «اختبار CSCA» can be found using `/faqsearch CSCA`. Its answer is still the owner's reviewed answer, and archiving its educational source immediately removes it from all search and browse paths.

## B3 v0.7.25 — in-flight private group browsing cannot bypass new requirements (OFFLINE)

The `/categories -100…` and `/resources -100… CATEGORY` private-chat group-scoped flows require live **verified membership evidence** and saved authorization. The membership request is now bound to the current group authorization version and all currently saved subscription rule revisions/modes/channels. If the group is revoked and re-approved, scopes change, or a mandatory-channel rule is newly configured while the external provider call is pending, the in-flight request cannot reuse its stale proof. A fresh request is needed. Member identities, tokens and group content are never exposed on denial.

This is an offline/mock hardening of existing Telegram transport and is **not** a real hosted bot or live Telegram membership proof.

## B3 v0.7.24 — find reviewed private FAQ answers by keyword (OFFLINE)

In the private student chat, open **💬 المساعد التعليمي → 🔎 ابحث في الأسئلة**, then type `/faqsearch منحة`. The bot searches currently approved FAQ **question titles** backed by the private published education catalogue, shows up to 10 matching questions per page, and lets the student select the numbered matching question to read its reviewed answer. Page controls re-run the search on the latest currently authorized FAQ list rather than granting visibility to an old page.

Each answer-selection button retains its **true global question number** and hashed locator; stale/forged/hidden/reordered selections are rejected against the full current catalogue. Search is explicitly requested, byte-bounded, normalized and private only. **Neither this search nor `/faq` invokes external generative AI or performs Telegram channel posting.** Real Telegram deployment remains separate.

## B2-Core v0.7.23 — membership proof remains current through moderation (OFFLINE)

`SubscriptionGate.syncSubscriptionRestriction` now binds each confirmed subscriber / non-subscriber result to the initial saved group authorization revision, channel authorization revisions, mandatory rule version, mode and ordered channel list. These conditions are rechecked inside the moderation transaction that stores/removes a subscription-specific MUTE reason, while planning a moderation operation, and just before starting the external effect.

This prevents delayed moderation checks from applying a punishment or clearing a saved subscription reason after a channel/group was revoked/reapproved, a mandatory rule was paused, or the required channels were changed. Old prepared intents are cancelled before fake provider dispatch. The rule is intentionally narrow: unrelated policy updates do not invalidate otherwise current evidence; manual reasons remain independent. The system remains offline-only, and this is **not a live Telegram restrict/unrestrict integration**.

## B3 v0.7.22 — number-matched student FAQ answers (OFFLINE)

Private FAQ browsing now shows **📖 سؤال 1**, **📖 سؤال 2**, etc. matching the question numbers in the message; page two continues at question 11. Buttons still carry only an opaque fingerprint rather than internal UUIDs. Their **exact currently authorized row number and fingerprint** must match the saved ordered catalogue at the next tap. A reordered/archived/disabled FAQ makes its stale button unusable, not an accidental response to a different question. Existing explicit `/faq` text lookup is unchanged and external AI remains OFF.

## B3 v0.7.21 — browse reviewed questions from the private student menu (OFFLINE)

In private Telegram open **💬 المساعد التعليمي → 📖 تصفح الأسئلة المعتمدة**. Reviewed local private FAQs with currently published sources appear ten at a time with Next/Previous and question-answer selection. The bot displays sanitized question summaries and opaque question buttons, not internal FAQ UUIDs. Opening an old button revalidates the FAQ and private navigation permission, returning no answer if the question was archived, category hidden or source unpublished.

This browser never exposes group/channel FAQ content, owner/admin metadata, drafts or orphaned sources. Answers come from approved local resources, not generative AI. Nothing sends a Telegram channel post or enables the live bot. Students may also use `/faq <question>`.

## B3 v0.7.20 — student private reviewed FAQs without generative AI (OFFLINE)

A student can now open **💬 المساعد التعليمي** and explicitly ask **`/faq ما شروط المنحة؟`** in the bot's private Telegram chat. The command matches an exact reviewed FAQ question/alias against **private**-scope, currently published and category-visible education resources only. The owner must first review and approve a draft FAQ: unpublished drafts or archived/disabled sources never contribute answers. Two competing approved FAQ matches give an ambiguity message instead of silently choosing one. Responses escape HTML and hide internal resource/admin identifiers.

This feature is independent of the external AI/privateAI mode (still OFF by default), does not parse ordinary messages as implicit questions, and honors the private `education.navigate` feature toggle on each request. This is NOT a cross-group search, nor live Telegram/AI acceptance; real hosting remains separately gated.

## B3 v0.7.19 — source-bound FAQ moderation from private Telegram (OFFLINE)

The verified **🔐 لوحة المالك → 🧠 الأسئلة الشائعة** ReplyKeyboard lists reviewed FAQ records in ten-item pages. Open a **❓ سؤال** to inspect a sanitized question, answer, status, scope and saved source availability. A draft can be explicitly **reviewed then approved** only while its linked educational resource is still locally PUBLISHED in an enabled, authorized category hierarchy. An already APPROVED FAQ can be **reviewed then archived** to stop its future approved FAQ responses; its linked scholarship/course resource remains untouched.

Confirmations are checked again at the durable store transaction boundary: configured owner, verified private actor, current group policy epoch, FAQ status, exact FAQ copy, underlying linked resource and ancestor category revisions must remain unchanged. Forged, old, copied and non-owner buttons never confer authority; neither approval nor archive sends messages to Telegram or invokes an AI provider.

## B3 v0.7.18 — owner-controlled category order in Telegram (OFFLINE)

In **🔐 لوحة المالك → 🗂️ إدارة الأقسام → القسم** a private verified owner can review **⬆️ مراجعة الرفع** or **⬇️ مراجعة الخفض** when an adjacent sibling exists. Each preview identifies the neighboring category; **✅ تأكيد** performs a single sibling-order move within that category's existing `scope` and `parentId`. No user may reparent a section, enable a disabled section or make an archived resource public by sorting.

The transaction checks the owner's trusted identity, current group approval and policy version, selected category revision and a fingerprint of all currently saved sibling names/order/visibility/revisions. It normalizes tied legacy order ranks and increments sibling revisions. Saved menu buttons are untrusted text, never authority; old, forged or copied confirmations cannot override subsequent edits. Read-only public resource browsing re-sorts using the updated local ranks. These controls never send Telegram messages or modify external channel posts.

## B3 v0.7.17 — owner-only educational section visibility controls (OFFLINE)

In a verified private Telegram chat, the configured owner may open **🔐 لوحة المالك → 🗂️ إدارة الأقسام** to browse existing education categories in pages, review their local scope, status and directly assigned published resource count, and separately confirm **enabling** or **disabling** visibility. Disabling a parent hides its child categories from student navigation; enabling a child while its parent is still disabled is blocked.

Every confirmation uses a short category choice token resolved against freshly authorized categories, an opaque fingerprint of its exact saved metadata, a backwards-compatible monotonic category revision, and the current group authorization policy revision. These conditions are all rechecked during the atomic write; stale Telegram button texts never become privileges. Existing direct `setCategoryEnabled` calls also invalidate prior confirmation tokens by advancing the category revision.

Enabling a category does **not** re-publish archived resources or send material to Telegram channels. No production Telegram webhook or AI is started here; deployment still requires separate explicit controlled acceptance.

## B3 v0.7.16 — owner-reviewed Telegram library archival (OFFLINE)

The private, verified owner may choose **📚 إدارة المكتبة** to page through currently published, locally authorized education resources (10 per page). Choosing **📚 المورد** opens a sanitized description. To hide a published item from the local student catalog, choose **🗃️ معاينة الأرشفة** and separately **⛔ تأكيد الأرشفة**.

Unlike a blind archive command, the confirmation captures an opaque fingerprint of the precise published education resource, plus its group authorization policy revision; the existing EducationService performs all owner, scope, current-resource and revision checks **inside a durable storage transaction**. A copied, outdated, changed or replayed button cannot archive a different revision. Archived records stay in the local store with their audit history and are excluded from published views.

This operation **does not delete or edit any Telegram channel message**, automatically retry publication, activate an external account or create a production webhook. The operational deployment gate and real Telegram acceptance remain separate.

## B3 v0.7.15 — student search in the published private educational library (OFFLINE)

Private students now have **🔍 البحث في الموارد** in Telegram's real ReplyKeyboard. Tap it to learn the command, then send `/search Grant` or `/search منحة الصين` for a paginated list of **only** published approved educational resources. Ten results are shown per page, with Next/Previous controls and resource detail buttons. Unicode Arabic and Latin terms (2–32 characters) are accepted; malformed controls, markup injection and unsafe page claims are denied.

The search works independently of AI and queries **only the approved private student library**. It respects the `education.navigate` private feature switch, category visibility, archival and source-scope checks on every page. There is no search over unpublished import candidates, messages, student personal data, group-only content or administrator state. Results contain safe public resource projections, and any saved/copied result button is separately revalidated at opening time.

No Telegram group subscription bypass, external API fetch, student message broadcast or live deployment is implied.

## B2-Core v0.7.14 — malformed rules fail closed without punishment (OFFLINE)

Subscription membership enforcement now shares the strict structural rule validator used by the owner/operator audit. A malformed mode (`ALL` vs `ANY`), invalid revision, wrong channel ID format, duplicate required channel or oversized rule produces `UNAVAILABLE`, not `NOT_MEMBER`, and will never trigger a moderation action from that evidence. Normal approved rules and valid paused requirements retain their established behavior.

Paused rules do not bypass the integrity audit: a paused empty-channel rule is valid only when its group ID, mode and revision remain well formed, and two rules for the same group cannot hide behind active/paused status. The report still contains only aggregate redacted codes, and offline acceptance blocks corrupted local state. The feature never enables live Telegram, bypasses permissions, changes student records or automatically unmutes users.

## B2-Core v0.7.13 — policy-version validation for external membership checks (OFFLINE)

The subscription gate now treats each external channel verification result as valid only for the **specific saved approval policy revision** under which the call began. Revoking and reapproving a channel or group while a provider request is pending invalidates that request, even if the final permission scopes match the old ones. The gate also compares mandatory-channel rule revisions and contents before interpreting a membership result.

Owner configuration is guarded similarly: an older slow pre-check cannot overwrite a newer confirmed rule or rely on a revoked-then-reapproved channel. Failed checks produce `UNAVAILABLE` (verification) or a deterministic configuration rejection, not a user penalty. These protections are tested using fake delayed providers in JSON and SQLite; they do **not** substitute for real Telegram bot admin-right checks.

## B3 v0.7.11 — owner-private view of locally saved subscription policy health (OFFLINE)

Inside **🔐 لوحة المالك → 🛡 سلامة الاشتراكات**, the configured owner can inspect the same local subscription integrity summary that the offline trial acceptance uses. Each button press loads a fresh BotStore snapshot and reports PASS/BLOCKED, active/paused/invalid requirement counts, invalid group/channel authorization totals, duplicate/oversize requirements and static warning codes. This screen never exposes group/channel/student IDs, chat messages or provider tokens and never tries to repair state automatically.

This is deliberately **OFFLINE_ONLY**, NOT a live Telegram membership/admin-rights check. A PASS means local saved data satisfies the bounded invariants, not approval for production. The user cannot change the emergency STOP switch, add channels, automatically unmute or start real Telegram operation from the report.

## B3 v0.7.10 — mandatory-channel integrity blocks offline acceptance

The existing local `telegram:acceptance` safety/rollback rehearsal now includes subscription-configuration health. If an active mandatory-channel rule references a revoked group or unverifiable channel, has malformed version/mode/IDs, duplicates channels or violates the configured maximum, the offline acceptance result is `BLOCKED` with the **static** `INVALID_SUBSCRIPTION_REQUIREMENTS` reason. A matching backup and STOP switch cannot hide this defect. Paused rules with zero required channels are not treated as active obligations.

The check consumes the same read-only source snapshot already captured by acceptance, and runs no new database write or Telegram call. Result strings contain no student, group, or channel IDs. A PASS is **only** an offline local consistency result; real Telegram permissions, bot deployment, HTTPS and subscriber access still require separately authorized live acceptance.

## B3 v0.7.9 — one-shot mandatory-channel rule integrity audit (OFFLINE)

From an authorized host with a preexisting canonical private SQLite state file, operators can use:

```bash
npm run telegram:subscriptions -- --offline-only --state /absolute/private/state.sqlite
```

The command opens a **strict read-only SQLite snapshot** and summarizes saved mandatory-channel subscription consistency. It counts active/paused rules and flags unauthorized/revoked group and channel dependencies, malformed rules, duplicate required channels and requirements exceeding the configured ten-channel cap. Output is JSON with only counts and static codes; it intentionally omits student IDs, chat/channel IDs, raw state, path, secrets and Telegram credentials. Exit 0 means locally consistent saved configuration, exit 2 means operator review needed, exit 1 means unsafe input/state. No network, deletion, rule update or moderation action occurs.

This is **not a real Telegram getChatMember check**. PASS does not verify current Telegram bot admin rights, membership verification success, delivery or approved HTTPS deployment. Production operation still requires explicit host, backup, webhook and consented live acceptance in the separate readiness stages.

## B3 v0.7.8 — review removal of one mandatory subscription channel (OFFLINE)

The private owner now may open a saved group's **📋 تفاصيل الاشتراك** and see a bounded **🧹 مراجعة إزالة قناة** button for each of its configured mandatory channels. The review page shows the selected channel and number of channels remaining. A separate **✅ تأكيد إزالة قناة** button changes the saved rule: only that channel is removed, preserving `ALL`/`ANY` and all other configured channels. Removing the final channel deactivates the rule (the student is not required to join any channel by that rule).

Buttons never grant authority; the policy requires the configured owner plus current approved verification scope and compares both the group's policy version and subscription rule version in a durable transaction. An old confirmation after a concurrent edit or chat revoke fails closed. The subscription verifier consults the updated remaining list. This UI **never adds or verifies a mandatory channel**, raises existing privileges, or releases already recorded subscription moderation reasons: those require separate authorized review. There are **no live Telegram calls** from this operation.

## B3 v0.7.7 — owner review and suspension of group subscription rules (OFFLINE)

In **🔐 لوحة المالك → 👥 المجموعات المعتمدة → محادثة**, a configured, approved group now shows stored mandatory-channel subscription status and a private **تفاصيل الاشتراك** screen with locally saved `ALL` or `ANY` policy and channel IDs. This is not a Telegram `getChatMember` check, an estimate of subscription-compliance or proof that the bot has current channel administrator rights.

An owner may review and then confirm **تعليق الاشتراك**. The atomic transaction compares owner identity, current chat approval/verification scope, chat-policy revision and subscription-rule revision, and clears the requirement. The UI does not configure or activate new mandatory channels, change a global policy or call Telegram. Unknown or replayed actions fail closed.

Revoking a group, revoking a required channel, or removing verification permission clears any related requirements and increments their versions: reapproval is not a hidden restart. **Previously recorded subscription-mute reasons are NOT automatically removed**: after an operator reviews affected members and verifies current permissions, remediation must take the separate authorized moderation path. This prevents accidental mass unmute or a fabricated successful Telegram action. No live bot has been deployed.

## B3 v0.7.6 — owner-only chat and group policy review (OFFLINE)

Within the private Telegram **🔐 لوحة المالك → 👥 المجموعات المعتمدة** reply keyboard, the owner can browse saved group/channel authorizations across pages and inspect a saved chat's policy, scope names, group AI status and locally stored presence flag. Presence is **not** a live Telegram membership check.

Only the configured owner in a verified Telegram private chat can use group management buttons. Privileged actions are explicitly restrictive: *review and confirm removal of one previously granted scope*, *review and confirm AI OFF*, or *review and confirm revoking local chat authorization*. Each confirmed change compares the currently saved policy revision **inside the durable BotStore transaction**, rejecting stale and replayed buttons. Revoking a chat or removing the assistant scope also forces its locally stored group-AI mode OFF. Individual restrictions append an owner-only audit event. **No action enables a chat, adds a role, switches AI on, triggers group leave, contacts Telegram or delivers a campaign.**

The buttons are plain texts sent back to the bot, not signed credentials; user identity, authorized group scope and the versioned state always govern. Two-step UI screens are a deliberate confirmation flow, not cryptographic proof the earlier screen was seen. All controls remain local/offline until the separate production deployment, webhook verification, host firewall and real provider tests are explicitly completed.

## B3 v0.7.5 — owner category selection now spans the whole reviewed scope (OFFLINE)

The candidate approval screen in the private owner Telegram dashboard now lists authorized categories in **nine-item pages**, with Next/Previous when needed. The page marker binds the exact imported run and candidate index, is never treated as permission, and is re-checked against current actor ownership, source chat approval, candidate READY status and available categories on every tap.

An owner can select a category at the end of a long list, then still **explicitly confirm approval**, separately preview local publication and confirm that publication. This does not send a Telegram channel post or authorize a new production deployment. Old or forged page markers are refused after revocation, archiving or changed status.

## B3 v0.7.4 — owner import and candidate review pagination (OFFLINE)

The private owner-only Telegram dashboard now provides **التالي / السابق** for imported document batches and their candidates, including indexes beyond ten. The owner sees the current approved-scope rows only: the server revalidates sender ownership, source-chat approval and the underlying import contents on each button tap. A stale or forged page cannot access data or grant publishing permission.

Category IDs can be as long as 64 characters. Where the raw ID would exceed Telegram reply button limits, the menu derives a small **display-only fingerprint** and resolves it against exactly one currently authorized category. It never trusts the fingerprint as an access credential and refuses invalid or ambiguous matches. Approval and library-only publication continue to require explicit owner actions, reviewed records, current category authorization and separate confirmation. The bot **does not automatically publish to channels** or start live Telegram.

## B3 v0.7.3 — Telegram owner dashboard with review and local publication (NOT DEPLOYED)

The configured verified owner, and **only** that user ID in a private Telegram chat, now has functional keyboard screens beneath **🔐 لوحة المالك**: **🧾 مراجعة الوارد**, **📚 إدارة المكتبة**, **👥 المجموعات المعتمدة**, **📊 حالة الرسائل**, and **⚙️ إعدادات التشغيل**. Delegated administrators and students cannot execute those owner-only buttons by typing the same text; button labels are not a credential. No owner menu is accepted in a group.

The owner's import review opens persisted batches from still-authorized scopes, then shows individual candidate details. A READY, unambiguous reviewed candidate may be assigned to a visible category using **📂 اعتماد في**; the next screen requires explicit **✅ تأكيد الاعتماد** before any state change. The separate **📝 معاينة النشر** screen then requires explicit **📤 تأكيد النشر المحلي**. This invokes the existing atomic EducationAdminFacade approval/publication boundary; publication makes the resource visible in the local reviewed education library **only**, never to Telegram channels and without a live network request. Duplicate/NEEDS_REVIEW items stay blocked, and approvals/publishing re-evaluate capabilities and scope.

The dashboard also reports private counts of groups, library records, saved send statuses and AI configuration, without message content or user/attempt IDs. It never changes the physical STOP/RUN safety file or resolves UNKNOWN send outcomes. Long lists currently show a bounded first page in the owner review panel; next-page owner workflows and PDF/AI features remain separate milestones. This code is mock-tested; Telegram production remains OFF.

## B3 v0.7.2 — paginated Telegram private library (NOT DEPLOYED)

Reply keyboards now offer **التالي / السابق** controls whenever a filtered private section or a published resource category contains more than ten items. The selected menu page is encoded as bounded plain Telegram text and **never serves as a permission grant**; every page transition re-reads the same current viewer authorization, category visibility and approved resource list. Outdated or malformed pages return a denial rather than disclosing private or archived material. Home and Back continue working. Telegram groups remain free from private reply keyboards.

This update extends navigation only. The bot is still disabled for real users, and AI, Mini App, public groups, actual exams and all external student services must be implemented and accepted independently.

## B3 v0.7.1 — real Telegram private reply keyboard (NOT DEPLOYED)

The offline-tested Telegram application now builds a **Telegram ReplyKeyboardMarkup** for `/start` and `/help` in a private chat. The nine student menu sections are scholarships, courses, universities/majors, exams, education/resources, files/forms, educational assistant, communities and help. The current verified bot owner alone sees an extra **لوحة المالك** button. The keyboard is transported with the same one-shot durable outbound reply plan using `sendMessage.reply_markup`; this is not an inline callback or a publicly deployed Mini App.

A student may tap a section to see accessible, approved private library categories, tap a category to see currently published resources, tap a resource to see its reviewed details, or use the Back/Home buttons. Category/resource selections are text sent by Telegram, not security grants: server logic re-verifies the exact current label, category visibility, resource status and user permissions. Group messages do not receive the private keyboard. Ten category/resource entries are shown per page, with Next/Previous available on additional pages; existing text commands remain supported.

Sections not yet supported by real external services explicitly say so: AI model calls are not wired, a public group/channel directory is not published, and a live ticket/helpdesk is unavailable. A menu button does **not** mean a paid course, scholarship, exam registration or Telegram bot subscription is available. Owner commands retain their existing independent authentication and review restrictions; no action may be performed solely by naming the owner button. Live Telegram credentials, webhook HTTPS deployment and production acceptance remain OFF.

## B3 v0.7.0 — sandbox-only rollback rehearsal (OFFLINE, NEVER THE LIVE DB)

The previous `telegram:acceptance` command is read-only and checks whether a stopped backup is a credible rollback anchor. An additional command now performs an **isolated full-state restore rehearsal** on an automatically named scratch SQLite file inside an existing, protected directory that is distinct from every primary and backup path:

```sh
npm run telegram:rehearse -- --offline-only --state /private/manaratak/state.sqlite --backup /private/manaratak/backup.sqlite --safety /private/manaratak/emergency.flag --sandbox /private/restore-sandbox --stale-ms 900000
```

The sandbox must already exist with private permissions (0700 or stricter), must be canonical and not a symlink or the directory containing the source/backup. The command requires `STOP\n`, a valid independently stored (not hard-linked) SQLite backup matching the stopped source, and no pending/unknown operations. It invokes the already-tested SQLite restore-drill helper, checks field-for-field equality of scratch and backup state, and removes only its own scratch artifacts. The source, original backup and STOP file are untouched.

It returns sanitized JSON with `ISOLATED_RESTORE_REHEARSAL`: `PASS` (exit 0), `BLOCKED` (exit 2) or a static invalid error (exit 1). **No live Telegram traffic, webhook setup, production restore, automatic queue processing or host-level recovery is performed.** The additional hard-link check also protects the earlier `telegram:acceptance` command.

Operator constraints remain: first stop every live writer, preserve the STOP file, protect backups and private directory, separately test a new-host recovery plan, inspect actual TLS/HTTPS and proxy, and obtain authorization before any real Telegram test group is used. An isolated PASS is not certification of backup redundancy or exactly-once delivery.

## B3 v0.6.9 — offline trial acceptance, backup matching and rollback drill gate (OFF)

The local operator can check a *stopped* candidate SQLite database against a separately provisioned **private, independently validated matching SQLite backup**. The gate does not register a webhook, initiate an HTTP listener, restore anything or grant permission to turn on Telegram.

```sh
npm run telegram:acceptance -- --offline-only --state /private/manaratak/state.sqlite --backup /private/manaratak/snapshot.sqlite --safety /private/manaratak/emergency.flag --stale-ms 900000
```

Only explicitly named flags are accepted. The source, backup and safety files must be three distinct canonical private absolute paths. The emergency switch must read exactly `STOP\n`; the backup must match the decoded logical BotStore state; there must be no QUEUED or SENDING/UNKNOWN Telegram reply, unresolved update/operation, uncompleted B4 publication delivery/part or ready/pending purge. Even an acknowledged UNKNOWN remains an unresolved block.

The tool produces **static, identifier-free JSON**, `stage: OFFLINE_ONLY` and a PASS (exit 0) or BLOCKED with reason codes (exit 2). Invalid files/options fail with a sanitized diagnostic (exit 1). It never creates a backup, changes STOP to RUN, promotes an attempt to SENT, erases records, automatically retries delivery or restores a live database.

**Rollback operator runbook:** stop the ingress proxy/webhook before a test; retain the STOP switch; allow any in-flight work to drain and quarantine UNKNOWN; produce a protected SQLite snapshot through an authorized offline backup procedure; verify the backup matches the stopped state with the command above; perform any actual restore rehearsal **only on a separately isolated copy using the existing explicit restore-drill utilities**, with authorized supervision and evidence of data integrity. Never copy a raw live WAL file in place of a SQLite-consistent backup. On uncertainty, keep STOP. For a future deployment, separately inspect DNS/TLS, request ingress restrictions, allowlisted test chat, secrets, operator approval, independent provider evidence and observability.

**Limitations:** this command does not prove the backup is at a different physical failure domain, that a real restore works on a new host, that no concurrent writer changes state after the check, or that Telegram has exactly-once sends. Passing these local checks is not production certification.

## B3 v0.6.8 — durable operator emergency STOP for Telegram (STILL OFF)

A manually enabled live server now requires an **additional independently provisioned local safety file**:

- `TELEGRAM_SAFETY_FILE=/absolute/private/manaratak/emergency.flag` must name an existing canonical private regular file, with permissions 0600 or stricter, owned/protected by the trusted host operator and not the same path as the BotStore SQLite database.
- Valid file bytes are **exactly** `STOP\n` or `RUN\n` (ASCII, trailing newline). Provision `STOP\n` first, then carefully validate monitoring and deployment outside this repository before considering `RUN\n`. Use an atomic same-directory rename and retain strict permissions to change the switch, not a user-facing HTTP/TG command.
- The local webhook verifies this file **after Telegram secret validation but before parsing or claiming a new update**, returning HTTP 503 if paused or untrusted. The dispatcher separately verifies it inside the exclusive QUEUED-to-SENDING claim so changing the file during a request can stop a *not-yet-claimed* attempt.
- When STOP is active, new updates are **not recorded**. Already-QUEUED replies remain unsent and must not be automatically replayed when RUN resumes. A send already submitted to Telegram cannot be atomically cancelled by the switch; unknown delivery remains quarantined and may require reviewed evidence.
- When the file is absent, world-accessible, a symlink, corrupt or unreadable, the server **fails closed**. Startup and `telegram:preflight` require a valid file. The preflight returns `MANARATAK_TELEGRAM_PREFLIGHT_PAUSED` for STOP and `...PREFLIGHT_OK` for RUN; both mean only that local prerequisites passed, **not** successful public TLS, Telegram webhook registration, live delivery or production launch.

This project does **not** install the safety file, a service account, rate-limited HTTPS reverse proxy, live Telegram credentials, or a cron/systemd worker. Filesystem checks do not solve privileged-host compromise, race conditions between checks and writes, or in-flight Bot API delivery uncertainty.

## B3 v0.6.7 — private SQLite outbox monitor (OFFLINE; NO TELEGRAM NETWORK)

After creating and protecting a legitimate pre-existing BotStore SQLite state file, an authorized **local OS user** can run:

```sh
npm run telegram:outbox -- --state /absolute/private/manaratak/state.sqlite --stale-ms 900000
```

The command checks that the state file is initialized, valid, private and canonical. It then uses **SQLite read-only connections** and emits one aggregate JSON status: `OK` (exit 0), `ATTENTION_REQUIRED` (exit 2), or an application-only invalid-request/invalid-state error (exit 1). Aggregate counters include queued, sent, UNKNOWN, stale QUEUED/SENDING, and unresolved/manual-review counts. Manual acknowledgement alone never suppresses an UNKNOWN alert. No chat/user/update IDs, reviewer, message text, token or path is reported.

It does not create or repair an absent database, update job metadata, send Telegram messages, register a webhook, erase backups or schedule itself. SQLite read-only access is **not a guarantee of zero filesystem sidecar activity** (e.g., WAL/SHM); host directory and backup permissions remain necessary. The server is OFF and no monitoring daemon is installed. Operator automation may evaluate the exit code from a trusted local cron/systemd setup later, but no schedule, alert channel or elevated privilege is configured here.

## B3 v0.6.6 — incoming request pressure and non-forcing shutdown (STILL OFF)

- The authenticated Telegram webhook and optional signed Mini App owner listener now share a small local ingress guard. At most **16 authenticated in-flight requests per listener** are admitted by default (test overrides may be 1–64); further valid requests return a content-free HTTP 503 **before** any durable Telegram update claim or content handling. Unauthorized requests do not reserve slots.
- Request body processing is bounded by a 15-second inactivity window, with strict UTF-8 JSON and no UTF-8 BOM, as well as the existing 64KiB webhook and 260KiB local-admin limits (2KiB on optional owner-reply routes). Compressed Content-Encoding is not accepted. Socket timeouts are restored on release.
- In the opt-in local Telegram server, timeouts/limits are set to: 10-second headers, 15-second request and socket idle, 2-second keep-alive, 32 HTTP headers, 50 requests per socket and 128 connections. **These are local process limits, not IP reputation, distributed rate limiting, DoS-proof ingress or TLS controls.** A trusted HTTPS proxy still needs its own request body/header and per-source limits.
- `stopLiveTelegramServer(server,graceMs)` stops accepting new connections while waiting for already accepted operations. A timeout reports **DRAINING**, not STOPPED, and the service does not force-close unresolved Telegram sender HTTP requests. Signals SIGTERM/SIGINT use graceful drain; the process stays alive if necessary until pending work ends. This protects against automatic resend but cannot guarantee Telegram exactly-once semantics or cancel external sends.
- This milestone was locally tested using mock Telegram and JSON/SQLite state. No public routes, live Telegram credentials, production scheduler or Telegram webhook registration are activated.

## B3 v0.6.5 — Telegram deployment preflight (STILL OFF)

Production startup now requires `TELEGRAM_WEBHOOK_PUBLIC_URL=https://your-real-domain.tld/telegram/webhook`, in addition to existing `BOT_ENV=production`, `TELEGRAM_ENABLED=true`, `TELEGRAM_REPLY_DELIVERY_ENABLED=true`, bot token, webhook secret, absolute existing private SQLite state, bot/owner IDs and localhost port.

The URL parser accepts only an exact canonical `https://` DNS hostname and exact `/telegram/webhook` path; it rejects IP literals, localhost/private or reserved host suffixes, nonstandard ports, userinfo, queries, fragments, alternate paths and normalization tricks. It does **not** resolve DNS, test certificates, verify reverse proxy reachability, validate trust of forwarding headers, register a Telegram webhook or guarantee that a DNS name will never point to a private address. A trusted infrastructure operator must verify those separately.

**Read-only preflight:** after provisioning a valid environment and an already initialized SQLite BotStore state file owned privately (0600), run:

```sh
npm run telegram:preflight
```

On success the application prints only `MANARATAK_TELEGRAM_PREFLIGHT_OK`. On failure it exits nonzero and prints a fixed `...CONFIG_REJECTED` or `...STATE_REJECTED` marker, never any token, webhook URL, owner ID, chat IDs, database path or application text. Node.js 22 may separately print its built-in experimental SQLite warning on stderr; that warning is not an application status. This is strictly an offline local check; it does **not** listen, send messages, create files, update Telegram, start a daemon, or authorize going live. The same existing-state check and same URL gate are used by the opt-in live runtime itself.

**Mandatory external controls before go-live:** real DNS+TLS certificate validation; private reverse proxy with documented webhook route and header preservation; IP allow-list or equally strong controlled ingress where appropriate, anti-abuse limits/timeouts, no public owner-admin routes, bot ID and secret verification, owner-authorized approval, isolated private backup/restore and state-file access, error alerts, Telegram test-group acceptance and safe disable/rollback. None are provisioned by this version. Even successful preflight must never be described as production activation or Telegram delivery evidence.


## B3 v0.6.4 — opt-in, signed owner HTTP review adapter (NOT DEPLOYED)

This release **does not** activate a web panel or the live Telegram server. It adds two optional operations to the existing Telegram Mini App HMAC-authenticated **local-only** web listener, suitable for *isolated mock integration* before a separately approved, hardened operator deployment.

Pass `{store,policy,clock?}` as the optional **third** parameter to `telegramAdminWebListener(auth,educationAdmin,replyOps)`. With no third argument, both new routes return 404 and the old education-admin functionality is unchanged:

- POST `/admin/replies/summary`: body `{}`; signed owner identity required; returns a content-free aggregate of queued, stale SENDING, UNKNOWN, reviewed and awaiting-first-review counts.
- POST `/admin/replies/review`: exact body `{"updateKey":"b3-webhook:bot-id:123","attemptId":"trusted-existing-attempt","decision":"ESCALATED"}` (or `ACKNOWLEDGED_UNRESOLVED`). Actor identity is derived only from Telegram-signed `x-telegram-init-data`. Server supplies timestamp and 15-minute staleness threshold; client cannot override them.
- Both routes require a valid, fresh Mini App HMAC signature, owner-only authorization, exact POST path, JSON content type, strict UTF-8 body limited to 2 KiB, and reject extra fields, arbitrary notes or links. No CORS opt-in, cookies, new Telegram commands, public HTTP listener, or automatic retry.
- Owner acknowledgement **does not prove Telegram delivery**, change SENDING/UNKNOWN_OUTCOME, create a message receipt or authorize resending. Repeated identical reviews are idempotent, conflicting decisions are rejected with immutable audit metadata.
- No sensitive message text, chat IDs, update keys, attempt IDs, tokens or reviewer identities appear in summary responses or HTTP errors. Any operator frontend that exposes raw stored selectors must have its own authenticated restricted access and data-minimization review.

**Important:** `createLiveTelegramServer` still mounts only the Telegram webhook and DOES NOT enable these admin routes. The owner web listener is a library used in local tests; deploying an actual operator UI behind HTTPS, trusted host permissions, request-rate limits, authentication session policy, receipt verification, logging and secret management are separate milestones.


## B3 v0.6.3 — owner-only explicit review of uncertain Telegram replies (OFF BY DEFAULT)

This milestone provides an internal, testable **operator acknowledgement**, not automatic delivery reconciliation. Telegram sendMessage has no reliable idempotency key. A stale SENDING or UNKNOWN_OUTCOME receipt must never be blindly resent or converted to SENT merely because someone acknowledged it.

- recordTelegramReplyManualReview(store,policy,options) requires policy.isOwner(options.actorId). The actor ID MUST come from a separate trusted operator authentication boundary. Do not accept it from user HTTP fields or untrusted chat messages.
- The operator supplies the precise persisted updateKey and attemptId, a bounded integer now, a staleAfterMs threshold between 60 seconds and 30 days, and either ACKNOWLEDGED_UNRESOLVED or ESCALATED.
- UNKNOWN_OUTCOME may be acknowledged; SENDING may be reviewed only after it is stale. Both **remain unresolved** with unchanged status, message receipt, attempt identity and queue eligibility. There is NO automatic retry.
- The first decision persists immutably across JSON or SQLite restarts; repeating that exact decision is idempotent. Changing the decision, mismatching the attempt, duplicate keys, extra fields, text, or URLs fail closed.
- Read-only reviewTelegramReplyOutbox returns reviewedUnresolved and awaitingFirstReview aggregate counts in addition to manualReviewRequired. Acknowledgements do not reduce the latter, because manual review is not proof of delivery.
- No new public HTTP API, CLI accepting untrusted identities, Telegram callback, scheduled job, or outbound network request has been enabled. The existing live transport remains OFF.

Trusted internal usage example:

~~~ts
import {recordTelegramReplyManualReview} from './src/telegram-reply-maintenance.js';
const result=await recordTelegramReplyManualReview(privateStore,policy,{
 actorId:authenticatedOperatorTelegramId, // verified by caller, never user supplied
 updateKey:operatorVerifiedUpdateKey,
 attemptId:operatorVerifiedStoredAttemptId,
 decision:'ESCALATED',now:Date.now(),staleAfterMs:15*60_000
}); // result is RECORDED, but delivery is STILL UNKNOWN
~~~

**Production boundary:** No authenticated operator interface, independent proof of a delivered message, live Telegram acceptance, public HTTPS proxy, bot rights verification, physical SQLite WAL/backup erasure or production alerting is shipped. Operator acknowledgement is only an immutable audit entry; do NOT infer successful delivery or enable the service from offline tests alone.

## B3 v0.6.2 — minimal persisted Telegram replies and unresolved-send audit (OFF BY DEFAULT)

**Aim:** A permitted inbound webhook stores a durable outbound reply plan to prevent duplicate sends across crashes. Storing a full student-facing reply in SQLite forever is unnecessary once a send attempt begins, so this release minimizes *logical* retention without losing immutable attempt evidence. There is **no** automatic retry, auto-redaction cron, deletion of backup files, or production Telegram deployment.

- The `TelegramReplyDispatcher` now takes an in-memory clone of a QUEUED reply inside the same exclusive store transaction that sets `SENDING` and fences its `attemptId`. It removes the durable `job.plan` and writes `redactedAt` **before** calling the external Bot API. A confirmed send still records `SENT` and `messageId`, a definite failure `FAILED_CONFIRMED`, and an ambiguous response `UNKNOWN_OUTCOME`. Redacted terminal/SENDING jobs remain non-replayable. In a group authorization revocation, an unsent QUEUED reply is marked FAILED_CONFIRMED and its text is also cleared.
- New queued plans get `queuedAt` from the persisted update decision timestamp. Older schemas (including v0.6.1) remain supported with optional `plan`, `queuedAt`, `redactedAt`; no destructive migration.
- `reviewTelegramReplyOutbox(store,{now,staleAfterMs})` is a read-only aggregate inventory reporting queued, sending, sent, failed, UNKNOWN, number of reply bodies still stored, stale queued, stale SENDING and potential manual-review cases. It **never returns message text, chat IDs, update IDs, attempt IDs, provider token or file paths**, and does not authorize retries.
- `redactFinishedTelegramReplies(store,{now,maxEntries?,startAt?})` is a **separate, explicit one-shot operator action**, not automatic. It clears legacy full-text `plan` only for SENDING, SENT, FAILED_CONFIRMED and UNKNOWN_OUTCOME rows. QUEUED plans stay untouched because they are the only ones eligible for an initial send. Status, receipt, attempt ID and timestamps remain unchanged; malformed ledgers fail closed, results are counts-only, and transactions are atomic. Supports safe fixed-index paging (`startAt` default 0, up to 500 scanned per call).

```ts
import {reviewTelegramReplyOutbox,redactFinishedTelegramReplies}
 from './src/telegram-reply-maintenance.js';

// Use your trusted private BotStore instance, never an unverified remote path.
const report=await reviewTelegramReplyOutbox(store,{now:Date.now(),staleAfterMs:900_000});
console.log(report); // aggregate counts, no student identifiers
// A separately authorized operator may run explicit cleanup, if required:
const cleanup=await redactFinishedTelegramReplies(store,{now:Date.now(),maxEntries:500,startAt:0});
```

**Important limitations:** SQL writes and SQLite WAL, free pages and old `backupSqlite` files may still contain historical reply plaintext. Removing a `plan` from current serialized BotState is **not** secure physical erasure; storage/backup lifecycle, disk encryption, database compaction and secure decommissioning require separately designed and tested operator controls. Queue bodies remain until a send is claimed (or explicitly cancelled in a future workflow). Active SENDING after crash and UNKNOWN_OUTCOME **must never be automatically resent**; these require independent trusted evidence/manual reconciliation, which is not implemented in this release. The source implementation has mock-tested security behavior, not a live production deployment.

## B3 v0.6.1 — trusted read-only Telegram group membership checks (OFF BY DEFAULT)

**What changed:** `TelegramBotApiMembershipGateway` implements the existing `MembershipGateway` / `MembershipPort` interfaces using the **official Telegram Bot API `getChatMember`** HTTPS endpoint. The manually gated localhost webhook runtime now calls this adapter instead of always returning UNKNOWN for private-chat requests to browse approved group-scoped catalogs. `SubscriptionGate.verify` is also wired to the same real, read-only membership gateway for approved subscription channels. The other moderation/ban/mute flows are not connected to live Telegram, and the runtime does **not** approve any group or membership automatically.

- **Bot must be administrator:** `verifyMembership(chatId,userId)` makes a fresh `getChatMember` request for the bot's own ID (taken from its validated token ID prefix). Only `administrator` or `creator` permits a second student lookup. This is required because Telegram guarantees getChatMember for other users only if the bot is an administrator.
- **Status mapping:** `creator`, `administrator`, `member` and `restricted` with `is_member:true` count as members; `left`, `kicked`, and `restricted` with `is_member:false` mean not a member. Absent or malformed fields, unknown status, mismatched `user.id`, bot users, bad tokens/IDs, 403/429/5xx, timeouts or network errors are `UNKNOWN` and fail closed.
- **Request limits:** Only canonical negative Telegram chat IDs and positive safe-integer user IDs; fixed HTTPS host, HTTP POST with bounded JSON, eight-second timeout, no redirects, no retries and no Telegram response details or token logged/returned. Membership proofs are **not cached**. Local group approvals and grants continue to be checked before AND after Telegram's asynchronous calls.
- **Runtime:** `createLiveTelegramServer(config,request?)` accepts an optional HTTP transport dependency for mock testing and creates the same local-only listener. Without an injected dependency it uses Node's `fetch` for actual Bot API queries, but performs **no network activity until authorized inbound messages arrive**. The `telegram:serve` command and production configuration flags remain unchanged, and the server stays OFF until the owner provisions a private SQLite state, secret token, and trusted public HTTPS reverse proxy.
- **Subscription checking:** A group with approved channel subscriptions must pass each configured channel's bot-admin preflight and the student's membership lookup; unknown results never become a positive membership or a live automatic ban. The moderation dependency is a **fake/no-network gateway** and must not be confused with activated moderation enforcement.

**Validation:** 8 new offline TDD tests include administrative preflight, 9 Telegram member statuses, forged users, malformed/oversized responses, explicit 403/429/API unavailability, private catalog's real webhook path and no duplicate sending, unauthorized student, and policy revocation while asynchronous membership verification is in progress. **414 tests passing** in GitHub Actions.

**Production blockers retained:** No live Telegram account/token has been installed or tested; no HTTPS deployment/webhook registration, bot-admin configuration or external group permissions have been verified. Outbound reply text retention/compaction, ambiguous-send reconciliation, Telegram rate-limit handling, host hardening, live alerting and end-to-end operator acceptance remain uncompleted. This is transport integration **implemented but not deployed**.

## B3 v0.6.0 — Telegram Bot API reply delivery, durable outbox, gated local webhook server

**This is the first explicitly configurable live Telegram transport boundary, NOT a production deployment.** Real `sendMessage` HTTP support and a runnable local webhook server have been implemented and tested with a fake HTTP provider; NO real token, Telegram account, public HTTPS endpoint, webhook registration or customer data has been provisioned. The new runtime is **OFF by default**. Prior mock-mode commands and tests remain available.

- `TelegramUpdateApplication.handle` now saves a **one-shot Telegram reply intent and its inbound update acknowledgement atomically** in the same existing `BotStore.transaction`. This is optional `telegramReplyJobs` state compatible with prior schema v8: old stores have no jobs. Denied/ignored updates create no replies.
- `TelegramReplyDispatcher` atomically claims queued replies (across separate SQLite connections and cooperating local JSON instances), rechecks group navigation approval before sending and fences outbound attempts. It marks confirmed sends `SENT` with a message ID, explicit Bot API denials as `FAILED_CONFIRMED`, and ambiguous/timeout/5xx/malformed responses as `UNKNOWN_OUTCOME`. It **never blindly retries ambiguous attempts**; interrupted `SENDING` remains blocked pending explicit operator reconciliation. Telegram's sendMessage API does not provide a general idempotency key.
- `TelegramBotApiTextSender` performs POST to the fixed official HTTPS Bot API endpoint `sendMessage`, with mandatory validated chat ID and bounded HTML reply, disabled link previews, protected content, no automatic redirects, finite timeout and no retry. It checks the returned chat/message receipt and does not log token or provider error descriptions. Token is loaded from private environment, never committed.
- `telegramWebhookListener(app,secret,dispatcher?)` retains its strict secret-token, payload-size and trusted chat checks. Omitting the dispatcher still produces plans only (tests/mocks). The **optional** third argument dispatches saved plans; replay of the same inbound update does not send again.
- `src/telegram-live-server.ts` exposes a gated, runnable local HTTP listener bound **only to 127.0.0.1**. Requires explicit production environment, Telegram enable flags, owner/bot ID, bot username, bot token, webhook secret, port, existing canonical private initialized SQLite store. Refuses missing or permissive state before opening a listener. Connect a trusted HTTPS reverse proxy and register its `/telegram/webhook` URL through Telegram `setWebhook` with the same `secret_token`.
- Private `/start` and `/help` now provide Arabic onboarding. Private `/categories private` and approved public catalog read paths may generate delivered replies; *private access to group-scoped resources continues fail-closed* because no trusted live membership provider is configured yet. Group chat authorization is never automatic.

**Example operator configuration (do not commit real secrets):**

```dotenv
BOT_ENV=production
BOT_OWNER_ID=123456789
BOT_ID=manaratak-bot-live
BOT_USERNAME=ManaratakBot
BOT_STATE_FILE=/absolute/private/manaratak/state.sqlite
TELEGRAM_ENABLED=true
TELEGRAM_REPLY_DELIVERY_ENABLED=true
TELEGRAM_BOT_TOKEN=<set-in-private-deployment-secret-store>
TELEGRAM_WEBHOOK_SECRET=<random-32-plus-alphanumeric-secret>
TELEGRAM_LISTEN_PORT=8787
```

After a separate trusted operator has provisioned a **private initialized SQLite state**, set the variables securely and run `npm run telegram:serve`. No `.env` loader is bundled: export the environment through your process manager or protected secrets configuration. A reverse proxy must terminate HTTPS, forward the Telegram secret header unchanged and route only to localhost `/telegram/webhook`. The bot token must never be shared in chat, committed to GitHub or logged. The initial state must be provisioned separately; this service deliberately cannot initialize a missing database or approve groups implicitly.

**Remaining blockers to production:** No actual Bot API acceptance test, no trusted live group membership checks, no automatic reconciliation of ambiguous/started sends, no delivery queue cleanup/retention (reply texts are retained in the private state), no finished deployment/firewall/HTTPS service guide, no external security audit, no production monitoring/recovery or rate-limit scheduler. Other B0–B4 features remain mock-only where documented. Before enabling for real students, complete these gates, provision a trusted private host and run a limited operator-owned Telegram smoke test.

## B4 v0.5.9 — isolated backup restore rehearsal (OFFLINE, TESTED_MOCK)

The new `runSqliteRestoreDrill({backupFile,sandboxDir})` explicitly tests whether an existing verified SQLite backup can be restored into a **new, private temporary database in a pre-existing isolated directory**. It does not replace an application database, restore permissions to a live Telegram bot, modify published messages, or replay queued, UNKNOWN or failed moderation/publication attempts. No timer or production API is provided.

```ts
import {runSqliteRestoreDrill} from './src/backup-restore-drill.js';
const report=await runSqliteRestoreDrill({
 backupFile:'/absolute/private/backups/verified.sqlite',
 sandboxDir:'/absolute/private/restore-sandbox'
});
console.log(report.status, report.counts); // VERIFIED and aggregate receipt counts
```

- The backup and sandbox must be canonical absolute paths without symlinks or redirected ancestor directories. Both must already exist with private `0600` file / `0700` directory permissions or tighter. The sandbox cannot be the backup file's own directory. The method does not create missing directories.
- Calls `BotStore.verifySqliteBackupReadOnly`, opens the backup with `DatabaseSync(...,{readOnly:true})`, checks SQLite integrity, and reads the initialized bot state. No missing or invalid backup is silently treated as an empty new database.
- Generates a unique and exclusive `0600` scratch path **only inside the designated sandbox**, copies with SQLite's point-in-time `backup` API, verifies the restored SQLite schema and integrity, and compares **all fields in the original vs recovered JSON state**, not just table counts. This includes owner chat grants, publication receipts/history, metadata, retention controls and purge jobs and their immutable `UNKNOWN_OUTCOME` attempt IDs.
- Scratch SQLite database and its possible `-wal` / `-shm` sidecars are removed in a `finally` path **only for the freshly reserved random basename**. Existing sandbox files and the backup source are untouched. Two concurrent drills receive separate filenames.
- Returns only `VERIFIED` and aggregate counts of chats, grants, delivery/history rows, purge jobs and UNKNOWN publication/deletion items. No owner IDs, message IDs, local paths, reviewer notes, evidence IDs, or hidden private content leave the function. This is a technical recovery test, not a proof that the full production Telegram system or offsite data are recoverable.

**Explicit boundary:** This is not an interactive production restore, and does not install scheduling, backup erasure, retention enforcement or network access. A trusted host operator must ensure actual sandbox isolation, exclusive filesystem ownership and path-safe deployment; symlink race (TOCTOU), disk errors, external WAL processes, ransomware and disaster recovery exercises on live infrastructure require separate independent controls. The tests operate on a local mock SQLite state only.

## B4 v0.5.8 — read-only SQLite backup inventory and expiration review

`reviewSqliteBackups({directory,retentionDays,now})` is an explicit, **offline, local-only advisory review** for backup directories. It does **not** expire, delete, move, compact or restore any backup. It does not send Telegram messages, schedule jobs or open an administrative API. A trusted operator supplies an **absolute, canonical, private existing directory**, an age threshold of **1–365 days**, and an integer timestamp. Invalid options are rejected; unknown contents are not silently treated as valid backups.

```ts
import {reviewSqliteBackups} from './src/backup-retention-review.js';
const report=await reviewSqliteBackups({
  directory:'/absolute/private/backup-directory',retentionDays:30,now:Date.now()
});
console.log(report.expiredCandidates, report.invalid, report.unsafe);
```

The function lists regular `.sqlite` files only, with a maximum of 500 directory entries by default and configurable lower limit. Symlinks, unsafe permissions (files readable/writable by other users), invalid SQLite databases, missing `bot_state` records, unsupported schemas and future file timestamps never qualify as expirable validated backups.

**Read-only verification:** `BotStore.verifySqliteBackupReadOnly` checks a 16-byte SQLite signature, readonly `PRAGMA quick_check` and current/recognized historic BotStore state decoding. It **never** calls `openSqlite()` (which can create tables), attempts repair or invokes backup/deletion APIs. Unrelated files, WAL sidecars and nested directories are skipped, not traversed. The inventory reports aggregate counts and per-file **opaque SHA-256 local references plus status**, never raw names, full paths, sender IDs, credentials or message payloads.

A verified `EXPIRED_CANDIDATE` is only an **operator review candidate**, based on the filesystem modification date. File timestamps are not proof of creation date, validity of recovery policy, retention compliance, legal authority to erase, uniqueness or whether another copy exists elsewhere. A valid, old backup may still be the **only restorable recovery point** or contain unresolved audit/deletion records. No automatic expiration, backup pruning, offsite inventory, encryption, immutable archive, trusted cross-device storage or tested production restore is claimed.

**Filesystem boundary:** Canonical directory and symlink/permission checks fail closed for ordinary local use; a privileged hostile process may still replace files between lstat and readonly open (TOCTOU). OS isolation/private directory ACLs and independent production backup lifecycle review are required before activation. This component remains **TESTED_MOCK**, not `ACTIVATED` and not live Telegram.

## B4 v0.5.7 — read-only validation before a SQLite backup is created

A preexisting empty, malformed or uninitialized SQLite source must **never** become a new apparently valid database while making a recovery copy. This release strengthens the **existing** `BotStore.backupSqlite(sourceFile,backupFile)` method, retaining its SQLite online backup implementation. It does not add a second backup API or enable automatic backup jobs or deletion.

- **Canonical paths only:** use absolute, normalized source and target filenames. Reject `.`, `..`, direct file symlinks, symlinked source ancestor paths, and a symlinked destination directory. Reject attempts to copy a database to itself.
- **Source first:** before creating any destination directory or reserving a file, check that the source already exists as a regular file with a full 16-byte SQLite magic header. Open it **read-only** (not via `BotStore.openSqlite()`) and verify SQLite `PRAGMA quick_check`, the existing `bot_state` row and a supported decoded bot schema. Missing/invalid/empty sources cannot trigger `CREATE TABLE`, substitute a fabricated empty state, or create a backup destination.
- **Failure and repeat safety:** reserve the new output using exclusive `wx` with private `0600` mode and never overwrite an existing backup. Use SQLite's official backup API against the validated read-only database handle, not a raw `-wal` file copy; re-open the destination and decode state as a recovery check. Remove an incomplete *new* backup if that copy or verification fails.
- **Keep immutable history:** an approved-chat configuration, observed message metadata, publication receipts and purge safety tombstones survive the snapshot; copying is never a reason to prune or redact the source.

**Operational limits:** Validating a source/target path does not defeat a malicious privileged process that changes filesystem links between checks and use (TOCTOU). The deployment operator must enforce exclusive ownership, private directory ACLs, device isolation and a separately tested restore procedure. This is still an **offline mock** BotStore path; no production retention SLA, encryption, backup expiration, scheduled jobs or Telegram network operations are activated. Existing backups are not deleted by this code. A backup can continue to contain sensitive metadata that was present at its point-in-time snapshot; expiry and data-subject deletion in offsite copies remain separate policy gates.

## B2-Advanced v0.5.6 — reject empty/redirected SQLite before the offline review runner opens it

The already merged `v0.5.5` one-shot offline retention-review runner remains the **only** entry point, using `npm run retention:tick -- --state ABSOLUTE_PATH --engine json|sqlite`; this release does **not** add another CLI, mode, background task or Telegram transport.

Four fail-closed improvements to `src/retention-review-runner.ts`:

- Require the caller to give a **canonical absolute path** without `.` or `..` components. The runner no longer silently rewrites alternate paths into a target database name.
- Check the **real path**, rejecting symbolic links in **ancestor directories** as well as the state filename. A symlinked parent that points to a different private database is not considered a trusted canonical path.
- Refuse a **zero-length existing SQLite database before BotStore is opened**. The earlier SQLite backend could have auto-created tables in a previously empty file, contrary to the runner's "existing initialized store only" contract.
- Read the **16-byte SQLite magic signature** in read-only mode before allowing the persistent state backend to open it. Malformed or mislabeled SQLite paths fail with the existing fixed error code `RETENTION_STATE_FILE_INVALID` rather than reaching a CREATE TABLE operation. The original 0600 file permission check remains.

These guards apply to the **local offline review-only runner** and do not promise protection from a hostile privileged host process racing to replace files between validation and use. The runner continues to generate only aggregate due-review status, not delete/compact data or contact Telegram. No installed cron, production activation or backup deletion is included.

## B2-Advanced v0.5.5 — local one-shot retention review CLI (offline, no Telegram deletion)

**Delivery:** A real Node 22 command-line entry point `src/retention-review-cli.ts` plus an independently testable module `src/retention-review-runner.ts`. This executes the **existing v0.5.4 review tick**, not a delete job or automatic compaction.

```bash
# The bot state must already exist and be private; this command cannot initialize it.
# A separate approved owner configuration must already have opted into review checkpoints.
npm run retention:tick -- --state /absolute/private/bot-state.sqlite --engine sqlite
# Or:
npm run retention:tick -- --state /absolute/private/bot-state.json --engine json
```

For direct Node execution after `npm run build`: `node dist/src/retention-review-cli.js --once --state /absolute/private/bot-state.sqlite --engine sqlite`.

The command requires **all** of `--once`, `--state` with an absolute path, and `--engine` `json` or `sqlite`; no defaults, aliases, user ID, owner credentials, tokens, media, Telegram flags or arbitrary arguments. A missing file is an error, never a fabricated empty BotStore. It refuses symbolic links, non-regular paths and files readable or writable by group/other users (**mode 0600 is recommended**). Run it with a trusted local service account and appropriate directory/backup permissions; CLI flags are not authentication and pre-run file checks do not replace OS sandboxing or symlink-race protections.

**Minimal stdout:** one line of JSON with `status` (`DISABLED`, `NOT_DUE`, `CLOCK_ROLLBACK`, or `READY`). A `READY` result includes only aggregate `expiredObserved` and `eligibleJobs` counts; not sender IDs, message IDs, review notes, Telegram tokens, proof identifiers or even the candidate digest. Failures write only a fixed diagnostic code to stderr and return a nonzero exit code. Node 22 may also emit its standard `node:sqlite` experimental warning on stderr.

**Safety:** The runner injects a no-network gateway where all deletion attempts would be rejected; it invokes `tickRetentionReview()` only. It never invokes `compactRetention()` or `dispatchNext()`, never enables the retention policy, never schedules itself, never sends Telegram messages and never deletes snapshots/backups. A `READY` status is a reminder for a separate **owner-approved** review and explicit compaction. Repeated invocation is idempotent per stored checkpoint. Independent SQLite processes are exercised in tests to prove only one gets `READY` for the same due interval.

**Deployment status:** The command can be triggered manually or integrated later into a trusted local cron/systemd service, but **no cron job, worker or production scheduler has been installed or activated**. No live Bot API integration or real deletion is implemented. Backups and exports still require separate retention enforcement and owner authorization. Existing schema v8 state/metadata/receipts are unchanged. **350/350 mock and local subprocess tests passed**.

## B2-Advanced v0.5.4 — owner opt-in retention review cadence, **without automatic deletion**

The reviewed purge data-retention workflow now has a durable **review reminder/checkpoint** stored in the same mock `BotStore` state; no Telegram API action and **no external cron/scheduler is wired up**. An external trusted operator must explicitly call `tickRetentionReview()` to perform a check. This tick NEVER performs a purge, compaction, file deletion, database backup deletion, or Telegram outbound action.

- `configureRetentionReview(ownerId,{enabled:true,cadenceMs:86_400_000})` opts in to a cadence from **1 day to 30 days**. Disabled by default. Only the configured owner can enable/disable or call `getRetentionReview(ownerId)`. Invalid, unexpected, or corrupt schedule fields cause fail-closed errors. Disabling clears the old notice.
- `tickRetentionReview()` returns `DISABLED`, `NOT_DUE`, `CLOCK_ROLLBACK`, or `READY`. Only a `READY` tick writes an aggregate `PurgeRetentionPreview` and advances its durable `nextCheckAt`. It uses the existing privacy-limited `retentionCandidates` evaluator, so messages still use the **48h from sentAt** window and fully terminal jobs use their **30d since last action** retention policy.
- The summary includes only counts, a SHA-256 candidate digest, and ten-minute expiration. No message text, sender ID, user notes or proof identifiers are returned or stored in the notice. The database's existing raw content, active UNKNOWN attempt, irreversible safety tombstone and approval boundaries stay unchanged.
- Ticks run in one JSON or SQLite transaction: two instances cannot both produce the same due notice. Late external invocation catches up once (does not flood accumulated notices); a backward-moving clock is rejected for an already checked schedule; optional stored configuration is backward-compatible with existing **schema v8**.
- **Separate approval is still mandatory**: an authorized owner must explicitly call `compactRetention(ownerId, freshPreview)`. If a stored notice is more than ten minutes old or its state changed, the existing validation rejects it; the scheduler can never bypass this rule.

```ts
await purge.configureRetentionReview(ownerId, { enabled: true, cadenceMs: 86_400_000 });
// A future trusted caller may invoke this; the bot itself does not schedule it:
const {status,notice} = await purge.tickRetentionReview();
if (status === 'READY') {
  // Present the counts to the owner; do not compact or delete automatically.
  console.log(notice?.expiredObserved, notice?.eligibleJobs);
}
```

**Deployment boundaries:** This is **TESTED_MOCK** only. A real external timer, secure owner notification delivery, production ACLs and backup TTL/erasure policies remain to be designed and explicitly enabled. No proof of end-to-end retention or any live Telegram integration is implied. Tests cover JSON and SQLite restarts, owner-only config, due/idempotent cross-worker ticks, long outages, cooldown, clock reversal, malformed configs and expiration of review notices.

## B2-Advanced v0.5.3 — owner-reviewed privacy retention and evidence tombstones (offline)

**Scope:** `S121-06` and `PURGE-008` / `S12-32` (partial). The approved group index must not claim history coverage and may hold rolling message metadata only for **48 hours from the actual send date**, not 48 hours from last observation. The new, explicit maintenance service lets an authorized **owner** preview and execute local privacy minimization; there is **no background timer or live Telegram request**.

Two-step maintenance:

```ts
const preview = await moderationPurge.previewRetention(ownerId); // no writes
console.log(preview.expiredObserved, preview.eligibleJobs, preview.reasonsToRedact);
const result = await moderationPurge.compactRetention(ownerId, preview); // explicit owner approval
```

- The owner-only **dry-run** reports counts and a SHA-256 plan digest. It excludes raw message text, sender IDs, proof IDs, freeform reviewer comments, and message-ID lists. The plan expires after **10 minutes** and is checked again inside the single atomic JSON/SQLite state transaction against the entire raw candidate set. A stale plan fails closed rather than wiping more recently changed records; two SQLite workers cannot reuse one plan after the first commits.
- Apply first prunes expired `rollingMessageMeta` entries (48-hour sentAt window), including metadata belonging to unfinished jobs. **Unfinished attempts retain their durable status, attempt identity, and review proof requirements**, even if the temporary observed-message index has expired. No re-send or auto replay is authorized.
- Only `COMPLETED` and `CANCELLED` purge jobs whose **every item is terminal**, and whose **most recent job activity is at least 30 days old**, are eligible for field-level redaction. Latest activity includes audit and reviewer decisions; a recent review cannot be wiped based on an old preview date. `UNKNOWN_OUTCOME` and unresolved confirmed failures remain untouched.
- The compactor removes the job's sender filter, freeform manual-review reasons, old attempt IDs/timestamps and review evidence IDs, and overwrites historical `metaDigest` fingerprints with a non-personal sentinel. The job, chat and targeted message IDs, item statuses, reviewed-by IDs and coded audit history remain as immutable **safety and accountability tombstones**; they do not become candidates for a second purge.
- Verified review evidence is replaced by a **domain-separated SHA-256 digest** (`evidenceDigest`) rather than forgetting its global one-use constraint. `reconcileUnknown` checks both current raw IDs and older stored hashes, so an ID cannot be reused with another unknown attempt after retention. Existing v0.5.2 plaintext evidence references in relevant audit keys are also scrubbed and replaced with digests. New receipts use hashed evidence IDs in audit keys immediately.
- The existing **BotStore v8** structure is extended by one optional, backwards-compatible reconciliation digest field. No new database, no automatic deletion, no production retention promises. The maintenance audit stores only actor ID, a generated operation key, timestamp and a fixed reason code—not body text.

**Critical operational limitations:** The compactor only changes the **currently opened** canonical JSON/SQLite state. It does **not** delete old SQLite snapshots/backups, GitHub logs, exported copies, or any other external retention system, and does not automatically enforce a 48-hour data-retention guarantee during periods of bot inactivity. Production must separately enforce scheduled maintenance, backup expiry, ACLs, legal deletion requirements, data-subject workflows and independent end-to-end private Telegram verification. All evidence here is `TESTED_MOCK`, not `ACTIVATED`.

## B2-Advanced v0.5.2 — UNKNOWN deletion reviews with trusted evidence (offline)

**Scope:** Purge outcomes can be ambiguous after a fake network timeout, worker crash or lease expiry. No automatic retry may be inferred from an absent response; `UNKNOWN_OUTCOME` means the outbound effect cannot be proven either way. This version adds a **manual reconciliation** path, rather than changing request scheduling or enabling live Telegram deletion.

`ModerationPurgeService.reconcileUnknown(actor,jobId,messageId,evidence)` accepts one **mock-verifiable** `PurgeEvidence` consisting of `evidenceId`, `chatId`, `messageId`, the exact durable `attemptId`, and a verified outcome `ACKNOWLEDGED` or `FAILED_CONFIRMED`. It requires effective approved-chat `chat.manage` authority and the original job actor or owner. **Independent injected verifier** `PurgeGateway.verifyEvidence()` must return `true` for exact bound evidence. All authorization, attempt status and global evidence-ID uniqueness are rechecked **after** asynchronous verification in the same state transaction. Untrusted, malformed, reused, mismatched, stale, or ambiguous proofs cannot silently close an UNKNOWN.

Verified **ACKNOWLEDGED** is evidence that a test provider *accepted a request*, **not evidence of physical deletion**. Verified **FAILED_CONFIRMED** is a definitive no-effect outcome but remains blocked; **no automatic replay**. A previously cancelled job may still reconcile an attempted item without enabling any subsequent send.

`skipForReview(owner,jobId,messageId,reason)` permits the owner alone to mark an UNKNOWN or confirmed failed attempt as `SKIPPED_UNVERIFIED` with a bounded explicit reason, without guessing what happened remotely. This stops investigating the item but does not claim it was deleted or retry it. Decisions are irreversible via the ordinary methods and have actor-specific audit entries; an owner may then proceed with other already reviewed items in an active job.

`reviewProgress(actor,jobId)` returns **access-controlled counts** for total, remaining, accepted requests, confirmed failures, UNKNOWN, cancellations and unverified manual skips. It deliberately reports `deletedConfirmed: 0`: offline receipt acceptance and a manual decision never prove a Telegram message was physically deleted.

`FakePurgeGateway.acceptEvidence` registers **test-only** proof artifacts for an independently injected fake verifier. It is not a trusted Telegram credential, API signature validation, a message-history scraper or an activated network adapter. Data continues in the **single BotStore v8 ledger** with additive optional item review metadata; no new schema/versioned DB rewrite. Both JSON and SQLite backends have async permission-revocation, cancellation, racing reviewer and evidence-reuse tests. **303/303 tests passed**, including the preexisting B0–B4 mock suite.

**Remaining gate:** production evidence provenance/issuer verification, reliable Telegram API response mapping, privacy review for retained audit proofs, actual bot permissions, live private test and owner approval. None are claimed here.

## B2-Advanced v0.5.1 — durable confirmed 429 cooldown (offline, fake gateway only)

This stage extends **v0.5.0's reviewed metadata-only purge**, it does **not** enable Telegram deletion or automatic background execution. The gateway contract now differentiates a **structured, explicitly rejected** request (`{status:'RATE_LIMITED',retryAfterMs:...}`) from an ambiguous request outcome. A mere thrown HTTP/429-looking exception is **UNKNOWN_OUTCOME**, not a reason to resend.

- Verified mock rate-limit responses must have exactly `status: 'RATE_LIMITED'` and an integer `retryAfterMs` from **1 to 3,600,000 ms**. A malformed value or unexpected gateway status is quarantined as UNKNOWN, never silently treated as confirmed deletion or safe retry.
- A confirmed 429 leaves the exact reviewed item `QUEUED`, records the attempt and persists a `rateLimitedUntil` barrier inside the original versioned purge ledger. The barrier applies to **every purge job in that chat**, including after SQLite restart or another worker. Calls before expiry return `RATE_LIMITED` **without contacting the gateway**. No automatic timer or retry occurs; an explicitly invoked `dispatchNext` may resume only after expiry with fresh authorization, metadata fingerprint and protection checks.
- Concurrent jobs **in the same chat** are serialized while any job's fake request is SENDING, preventing a second independent worker from racing another request's permission preflight or a future 429. An orphaned SENDING attempt remains subject to lease recovery and UNKNOWN quarantine, not inferred failure.
- The hard limit of **50 attempts per UTC day** now counts immutable `PURGE_ATTEMPT_DURABLY_RECORDED` audit events. This includes retries after confirmed 429 and aborted preflights; resetting a mutable item's attempt ID cannot reset the daily quota. The prior preview/confirmation limit still applies.
- Existing B3/B4 data and B2 purge schema **v8** are retained, with only an additive optional field on `PurgeJob`; no new or parallel deletion ledger. Full suite: **289 local mock tests**, including JSON and cross-process SQLite, fake 429, malformed response/exception quarantine, revocation, protected messages, daily quota and cancellation.

**Production boundaries:** A real Telegram adapter would need to prove that a 429 actually represents *provider rejection before an effect*, including error shapes and rate-limit scope, and must enforce bot rights, API limits, privacy TTL and operational observability. None of this establishes exactly-once remote deletions; no token or real deletion is used.

## B2-Advanced v0.5.0 — preview-first moderation purge (offline, NO Telegram deletion)

`src/moderation-purge.ts` introduces the **first bounded, tested B2-Advanced slice** for `S121-06`, `MOD-002` and `PURGE-001/002/003/004/005/006/008/009/010`. No call to Telegram API is implemented.

**What is actually indexed:** `ModerationPurgeService.observe(meta)` accepts *trusted adapter-supplied* metadata for **messages already observed by the bot in an explicitly moderation-approved group**. It stores an opaque positive message ID, chat ID, sender kind/ID where known, content type, links flag, sent time, observation time, and protection flags. It **refuses** any raw text, caption, media content or extra fields; unknown senders are never fabricated. Messages older than 48 hours are pruned automatically when ingesting or creating a preview. An edited observation can update type/links, but it cannot silently clear pinned, linked-channel, admin-log or approved-announcement protection. There is **no** Telegram `getChatHistory` API, and the index never claims to cover messages sent before bot presence or while it was offline.

**Workflow (mock only):**

```ts
const service = new ModerationPurgeService(store,policy,fakePurgeGateway,clock);
await service.observe(trustedMetadataWithoutMessageBody);
const review = await service.preview(editorId,approvedModerationChatId,{
  senderId: '300', linksOnly: true, limit: 10
});
console.log(review.items.map(({messageId})=>messageId),review.excluded);
// No deletion has happened. The item IDs and metadata digests are immutable once previewed.
await service.confirm(editorId,review.id); // second explicit step, preview expires in 10 minutes
await service.dispatchNext(review.id); // only a FAKE deletion gateway; one item per call
```

- `preview` selects **at most 25** recently observed, eligible IDs; excludes pinned/linked-channel/admin-log/approved announcement messages. It never stores the message body, executes a deletion or promises to know how many historical messages exist.
- `confirm` binds the plan to exact message IDs, their metadata fingerprints, the actor, approved-chat policy version and a 10-minute expiry. A plan of more than **10** items requires owner confirmation; any editor's effective `chat.manage` authorization must still be valid at execution. Conflicting reservations for the same message/chat are rejected even across simultaneous confirmations.
- Up to **50** item attempts per UTC day can be reserved; an additional hard daily cap is checked at each attempt start, so a plan approved yesterday cannot overflow today's delete limit.
- Each attempt is recorded in the existing versioned `BotStore` **before** contacting a fake gateway, and is reauthorized after `canDelete()` awaits. `ACKNOWLEDGED` means only that the **mock API accepted the request**, not independent proof that the message existed or was removed. `UNKNOWN_OUTCOME` is quarantined and never automatically retried; the next item stays blocked. Expired worker leases remain UNKNOWN after recovery while active leases are left alone.
- `cancel` closes queued items and retains accepted, in-flight and unknown attempts. Group or staff permission revocation blocks further mock deletion. JSON and the optional SQLite engine share the same model; SQLite tests include truly independent worker processes.
- Schema **v7→v8** adds `rollingMessageMeta` and `purgeJobs` without altering B3/B4 campaign or receipt histories. No real Telegram deletions, no live monitoring/scheduler, no database production migration, and no text-bearing audit logs.

**Still pending:** actual trusted Telegram update intake, identity/rank checks from the real API, API-specific deletion restrictions and rate limits, post-request evidence reconciliation, data-retention/backups policy, optional large-activity second-person co-sign, and production-grade normalized persistence. Status: **TESTED_MOCK**, not `TESTED_LIVE_PRIVATE` or `ACTIVATED`.

## B4 v0.4.8 — immutable multipart plans and receipt-boundary integrity (offline)

Campaign dispatch now rederives the **entire canonical part plan from the approved resource text at send time**, even for older approved campaigns that predate `PublicationPreview.renderPlan`. A fingerprint printed in a mutable stored record cannot authorize modified copy or swapped parts. A mismatch returns BLOCKED without contacting the outbound fake gateway.

`src/publication-receipts.ts` validates the **shape** of mock/provider message IDs before they can count as proof. Empty, whitespace-padded, newline/control, Unicode directional-control, and oversized IDs are quarantined as `UNKNOWN_OUTCOME`; they cannot settle an UNKNOWN receipt via a permissive fake verifier. The simulated gateway's printable opaque IDs remain supported. This is **only an input-format guard**: a real Telegram adapter still must verify the actual chat/message provenance and bot credentials through a separately approved receipt-verification design.

`src/publication-reservation-integrity.ts` checks the existing **single** `BotStore.deliveries` ledger and the historical-review guard for every exact destination + resource ID + immutable revision. Duplicate entries or a newly imported historical reservation fail closed before the send, after the asynchronous `canPost` check, when the network result returns, and during confirmed-failure retry or provider-receipt reconciliation. An actual attempt that already crossed the fake network and then encounters a collision becomes UNKNOWN, not silently SENT or eligible for another send. Import history is never treated as proof of a new send.

Offline coverage includes JSON and the optional SQLite engine, current and legacy campaigns, malformed provider outcomes, hostile metadata inserted during asynchronous gateway calls, conflicting historical records, and safe preservation of the previous receipt/attempt history. No migrations are needed for this patch; schema remains v7.

**Not ready for production**: the SQLite BotState is still a full serialized row using experimental Node 22 APIs, the Telegram gateway and independently trusted evidence verifier remain unimplemented, and no real channel posts, credentials, production platform DB writes, or merges to `main` are authorized.


## B4 v0.4.7 — cancellation-safe multipart campaigns (offline)

An explicit `PublicationService.cancel(actor, campaignId)` now settles the **entire approved campaign** without discarding item-specific delivery evidence:

- An unsent single delivery becomes `CANCELLED`. A multipart delivery cancels all `QUEUED` and confirmed-failed parts atomically in the canonical `BotStore.deliveries` record (no second queue).
- Any `SENT` part keeps its original verified mock message ID. If no `SENDING` or `UNKNOWN_OUTCOME` parts remain, the aggregate delivery becomes `CANCELLED` even when it contains some confirmed parts. It does **not** pretend the entire document was published.
- Already `SENDING` or `UNKNOWN_OUTCOME` parts are never erased or falsely declared cancelled. They preserve the durable attempt for later evidence reconciliation. A late successful fake gateway response still records an actual receipt; a confirmed failure closes safely, while an unknown response remains unresolved.
- If cancellation happens during the async `canPost` check **before** the outbound call, the in-flight intent becomes `CANCELLED`; the paused worker cannot turn it back into `QUEUED` or issue a send.
- Source/destination publisher authorization is still mandatory. A second cancellation is idempotent, with one `CAMPAIGN_CANCELLED` audit entry including the acting reviewer ID. Previously cancelled or manually skipped items cannot be relabelled by the manual-skip API.

This offline behavior is verified with separate JSON and SQLite fixtures, before/after mock send races, timeout-UNKNOWN reconciliation and audit-history tests. It is **not** an external Telegram cancellation operation: network requests already sent cannot be withdrawn, and no real bot, platform database, scheduled job or channel operation is enabled. An `UNKNOWN_OUTCOME` remains unresolved until independently proven; never automatically retry it.

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
