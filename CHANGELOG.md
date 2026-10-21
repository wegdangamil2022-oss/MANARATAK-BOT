## 0.7.33 — 2026-10-22 — B5 optional read-only external preview on Telegram owner menu (OFFLINE / NOT CONNECTED)

- When (and only when) an explicitly injected `PlatformCatalogPreviewService` is configured, the owner Telegram panel offers a **read-only external Manaratak candidate preview** button; default installations without a reader hide the button and reject forged open and next-page labels.
- Owner-only private verified sender authorization is enforced for the panel and every stateless cursor page request. The preview service rechecks the owner dashboard switch before and after the asynchronous provider call; student/group/delegated actors cannot fetch external data through it.
- Preview rows show short HTML-safe escaped external title, university and source ID with an explicit **not locally verified** label. Every response and 10-row keyboard page is bounded; upstream exceptions, unknown fields, secrets, drafts, group data and suspicious cursors are rejected by the v0.7.32 contract.
- No approve/import/publish button is offered for external candidates; browsing writes only normal inbound Telegram replay/audit/reply-plan records, not educational resources, import runs, campaigns or deliveries.
- 10 additional offline JSON/SQLite and owner UI security tests cover reader absence, owner pagination, scope isolation, worst-case HTML expansion, malformed cursors, masked failures, mid-read feature revocation and content non-mutation. No connected live platform API or Telegram send/AI activation.

## 0.7.32 — 2026-10-22 — B5 owner-only read-only platform catalogue preview contract (NOT CONNECTED / NOT DEPLOYED)

- Introduce an opt-in `PlatformCatalogReader` port with a strictly bounded `private` 10-row page/cursor, and an offline `PlatformCatalogPreviewService` for **owner-only**, policy-gated previews. No unknown real website API, endpoints, tokens or credentials have been assumed.
- Reject entire external pages with unknown/extra fields, duplicate IDs, unpublished drafts, archived or group records, malformed cursors, control/bidi characters, oversized titles and invalid revisions. Preserve safe `UNAVAILABLE` errors without exposing upstream exceptions or secrets.
- Each candidate is marked `UNVERIFIED_EXTERNAL` even if its external service says `PUBLISHED`; preview fingerprints are deterministic **review references only** and never grants to publish. All paths are read-only: no BotStore publication, campaign, student display or Telegram sends.
- Owner dashboard authorization is checked before calling the external adapter and again after its await, so revocation in-flight denies the preview. Owner-only restriction also excludes delegated content publishers.
- 11 new offline JSON/SQLite and contract tests, with full typecheck and all demos passing. This stage delivers an adapter boundary, **not** a working connected platform API or owner Telegram button; real platform schema and credentials require separate verified integration.

## 0.7.31 — 2026-10-22 — Arabic-aware published scholarship and university search (NOT DEPLOYED)

- The existing private student `/search` command now finds currently published and visible scholarships by **resource title, university name, academic cycle and degree**, despite Arabic vowel marks, hamza/alef and alef-maqsura variants, tatweel, punctuation separators and Arabic-Indic/Persian numerals.
- Search uses the same pure discovery-only Unicode folding as reviewed private FAQ searches, avoiding inconsistent Arabic text matches between sections. Saved scholarship records and reviewed FAQ questions and answers are never rewritten by a query.
- Bounded `/search` and page-label parsers now permit Arabic combining marks in otherwise valid terms without enabling controls, bidi overrides, overly long commands or forged cursors.
- Normalization does **not** expand access: group-only sources, archived records, disabled categories and private navigation OFF still exclude results. Empty normalized terms return no matches instead of enumerating the whole catalogue. Existing current visible-item/ID selection and HTML rendering constraints remain.
- Eight JSON/SQLite and input-grammar integration tests guard these improvements. No live Telegram operation, AI/semantic search or content publication added.

## 0.7.30 — 2026-10-22 — Bounded Telegram student catalogue previews and UTF-8 buttons (NOT DEPLOYED)

- Private FAQ browse/search, resource/category listings, search results, and group educational catalogues now escape owner-supplied titles **before** limiting their displayed UTF-8 byte lengths. Long HTML-heavy and Arabic text can no longer exceed the 4096-byte Telegram reply plan budget just by filling a page of authorized rows.
- New `escapeTelegramListPreview` preserves complete HTML entities and Unicode codepoints, removes control/bidi override characters, clips only the presentation and appends an ellipsis when necessary. It never changes the underlying approved source, archived status, current authorization, FAQ answer, or row identity.
- Category/resource reply keyboard buttons now independently fit Telegram's **256 UTF-8 bytes** and **96 Unicode codepoints** with stable deterministic shortening; selections still match the exact currently visible title/ID under the current policy.
- 12 RED-first JSON/SQLite and pure unit tests cover worst-case HTML expansion, Arabic, four-byte emoji, 10-row pages, category paging, safe button clicks, stale renamed selections, malformed preview budgets and sanitization. All validation remains offline; no Telegram token, actual send or AI activation.

## 0.7.29 — 2026-10-22 — Arabic-friendly private FAQ discovery (NOT DEPLOYED)

- Student `/faqsearch` now matches currently approved private FAQ titles and **owner-reviewed aliases** despite ordinary Arabic search variation: harakat/diacritics, alif/hamza spelling, alef maqsurah, tatweel, punctuation, multiple spaces, Arabic-Indic numerals and Persian numerals. NFKC and case-insensitive Latin matching remain available.
- Search normalization is **read-only discovery only**. Original approved question titles remain unchanged in Telegram, aliases and administrative identifiers are hidden, answer buttons keep their existing opaque global ordinals and are re-authorized when opened, and exact `/faq` command semantics are deliberately unchanged.
- A term that normalizes to empty is treated as **no matches**, not a universal substring. The existing 48-byte/40-codepoint query limits and invalid-control-character policy remain in effect.
- Added RED-first JSON/SQLite and negative regression coverage for Arabic variants, aliases, Unicode digits, punctuation/spacing, empty after normalization, authorized answer clicks, immutable source records, no AI/authorization relaxation.
- Live Telegram, deployment, generative AI and channel publishing remain OFF / unverified.

## 0.7.28 — 2026-10-22 — Strict active-subscription evidence across group access paths (NOT DEPLOYED)

- Required channel membership can no longer be bypassed by a `NOT_REQUIRED` verification result for ordinary students. This status is accepted under an **active** mandatory-channel rule only for the explicit trusted owner identity; ordinary students require `MEMBER`. A paused or absent canonical rule remains an intentional exception.
- The common read-only subscription-rule inspector now treats malformed/duplicate records, invalid modes, invalid revisions and active rules whose group or required channel has lost local verification authorization as **INVALID**. These records are never mistaken for paused or unrestricted subscriptions.
- Apply the same fail-closed predicate independently to private `/resource` links, private `/categories <group>` and `/resources <group> <category>` browsing, group `/categories`, `/resources` and reviewed group FAQ eligibility, and the `SubscriptionGate.verify` facade.
- Group-message eligibility is re-read after the asynchronous subscription gateway completes: owner pause/reconfiguration, chat policy changes or duplicate rule injection invalidate the old evidence before creating a reply plan.
- RED-first JSON and SQLite regression tests cover injected `NOT_REQUIRED`, owner exception, malformed zero-channel rule, duplicated group requirements, in-flight pause, genuine provider behavior and orphaned active channel approval. No live Telegram, AI, enrollment or moderation operation is introduced.
- Production deployment, official Telegram acceptance, channel permissions provisioning and operator approval remain separate.

## 0.7.27 — 2026-10-21 — Mandatory-channel verification for group-scoped opaque resource links (NOT DEPLOYED)

- Closed a private `/resource <opaque-ref>` authorization bypass: a student with verified membership in an authorized group could previously open a link even when that group required joining separately approved mandatory channels. Group resource links now require both verified group membership **and** a passing trusted `SubscriptionGate.verify` result whenever the saved group subscription rule is active.
- The `ResourceLinkService.resolve` internal API accepts an optional trusted subscription-verification function. If a group has active mandatory requirements and the adapter is unavailable, access is **DENIED**, never treated as not required. Inactive/empty requirements and private-scope resources continue to work as before.
- Subscriptions are checked after the external group membership request to catch a rule created during that wait, then re-checked after any awaited channel-subscription verification. A mode/list/version edit while awaiting evidence invalidates the response. Existing published-source, link revocation, bound user, policy-version and resource checks still run after provider awaits.
- The Telegram `/resource` route passes the same existing read-only `SubscriptionGate` used for group/category browsing; no new AI, live Telegram call, moderation, automatic unmute, enrollment or external data disclosure is introduced.
- RED-first JSON+SQLite integration tests include verified group member without required-channel membership, complete verified eligibility, missing verifier, UNAVAILABLE/UNKNOWN provider results, newly added rules during a pending check, rule changes during verification, archival, group revoke/reapprove, and provider exceptions.
- This is a MOCK-tested / OFF-by-default library and reply-plan implementation, not a live Telegram acceptance claim.

## 0.7.26 — 2026-10-21 — Approved FAQ keyword aliases in student-private search (NOT DEPLOYED)

- The existing private **💬 المساعد التعليمي → 🔎 ابحث في الأسئلة** and `/faqsearch` workflow now matches either an owner-reviewed question title or any of its saved reviewed alternate wordings (FAQ aliases), using the same Unicode NFKC case-insensitive normalization already applied to titles.
- Search runs inside the existing `ApprovedAnswerService` authorization boundary against a **single current snapshot** of approved private FAQs with still-published/visible source resources; group-scoped, draft, archived or otherwise inaccessible entries are not returned.
- Results only expose original public question titles and global authorized FAQ ordinals. Internal IDs, aliases, administrative provenance and query history are not emitted or persisted. Search result buttons reuse the existing SHA-based opaque locator and **revalidate** original item visibility and ordinal when the student taps.
- Retains ten results per page, canonical next/previous navigation, bounded query validation and no external AI/provider calls. Archived source after search cannot be reopened with an old result button.
- RED-first integration tests cover JSON+SQLite, normalized Unicode aliases, title matching, global ordinal selection, 12-result pagination, revoked visibility, scope isolation and disabled education. Real Telegram remains OFF.

## 0.7.25 — 2026-10-21 — Prevent outdated private-group membership from bypassing a newly required subscription (NOT DEPLOYED)

- Fixed a read-after-await authorization gap in private `/categories <group>` and `/resources <group> <category>`: a trusted external group membership result is now bound to the exact saved **group authorization revision**, current permitted navigation scopes, and current mandatory-channel rule revisions/modes/channel lists.
- New authorization and subscription snapshots are taken after the group membership check and after any mandatory-channel verification. A revoke-then-reapprove, scope reconfiguration, newly added mandatory channel, or changed subscription rule during provider latency invalidates stale membership evidence, even if a group ends up with identical permissions. The request fails closed without revealing group-scoped resources.
- Unchanged active authorized group members can still browse reviewed group library content; unknown or changed evidence does not become a success or a moderation punishment.
- RED-first tests cover JSON and SQLite, interleaved revoke/reapprove, identical-looking scope changes, new subscription gates during provider latency, and unchanged successful membership. All Telegram interactions are simulated; this does not prove live provider permissions.

## 0.7.24 — 2026-10-21 — Private student keyword search over reviewed FAQ titles (NOT DEPLOYED)

- The student-private **💬 المساعد التعليمي** ReplyKeyboard now includes **🔎 ابحث في الأسئلة**, which provides an actual explicit `/faqsearch <keywords>` workflow rather than a placeholder. Only owner-approved, private-scope FAQ questions with currently published, visible education sources are searched; no generative AI, third-party retrieval or group FAQ disclosure.
- Query input is bounded by code points and UTF-8 bytes and excludes control/bidi characters. Searches case-insensitively across NFKC-normalized currently visible private question titles, with ten results per page and stateless Next/Previous reply keyboard controls. Searches and their results are not persisted as a new query history.
- Each matching result uses the **global currently authorized FAQ row number plus the existing SHA-based opaque question fingerprint**. The student's subsequent tap is rechecked against the full refreshed visible private catalogue and the current approved source before opening the answer. Archived/hidden/reordered questions cannot turn stale search buttons into access to a different FAQ. Internal FAQ UUIDs and administrative data remain hidden.
- Pagination tokens encode only the bounded user-entered query and canonical page index (neither a permission grant nor a secret). Forged/noncanonical/out-of-range requests are denied and rendered titles are HTML-escaped. RED-first JSON+SQLite integration tests cover matching results, 12-item paging, current ordinal selection, revoked source visibility, forgery and group/private isolation.
- This is local Telegram ReplyKeyboard simulation only. **No hosted Telegram bot, external AI or automatic channel sends.**

## 0.7.23 — 2026-10-21 — Prevent outdated membership results from driving moderation (NOT DEPLOYED)

- Hardened the crucial handoff **after** SubscriptionGate membership verification to the moderation engine: captures a private before-verification snapshot of the group policy epoch, required-channel IDs, their individual policy epochs and the subscription rule version/mode.
- The moderation service accepts a trusted internal state predicate and rechecks the same evidence **inside the durable transaction** that activates/deactivates a `SUBSCRIPTION` mute reason. An old VERIFIED/MEMBER or NOT_MEMBER decision no longer wins if mandatory rules were paused, changed or revoked while moderation rights were being checked.
- The evidence is checked again while creating the moderation intent, and immediately before starting any effect; if policy changed during pre-dispatch, the prepared intent is safely marked CANCELLED rather than calling the fake Telegram moderation gateway. No user-supplied membership claims and no new live send path.
- Unrelated group changes leave valid checks working. Existing independent manual moderation reasons remain untouched. No automatic replay of unknown effects.
- Added RED-first JSON/SQLite deferred-rights and before-dispatch tests for post-verification pause, group/channel reapproval, replacing required channels, and preserving ordinary known-member mute/unmute behavior. These are offline fake-provider tests, **not live Telegram moderation proof**.

## 0.7.22 — 2026-10-21 — Numbered student FAQ question buttons bound to their current order (NOT DEPLOYED)

- Student-private reviewed FAQ browse results now display **numbered question buttons** (for example, `📖 سؤال 1`), matching the numbered question snippets above the keyboard. All pages retain global ordinals so page two starts at question 11 rather than repeating question 1.
- The owner-review and content authorization model remains unchanged: each student choice carries both its current ordinal and a short opaque question fingerprint. At selection time the bot recomputes the entire currently visible private FAQ catalogue and requires the exact saved ordinal+token to match before re-reading the source-backed answer. Old copies automatically fail when a question moves or disappears instead of opening an unintended answer.
- Both number and SHA-derived fingerprint are bounded and parsed canonically; leading-zero, negative, out-of-range, forged and outdated controls fail closed. Internal UUIDs and group-only FAQ content stay hidden.
- Added RED-first tests for exact label/question correspondence, page-two global numbering, mismatched ordinal denial, previous unnumbered-button denial and malformed labels. No external AI or Telegram channel sends were added.

## 0.7.21 — 2026-10-21 — Private student FAQ browser (NOT DEPLOYED)

- The private student assistant now provides an actual “📖 تصفح الأسئلة المعتمدة” ReplyKeyboard choice to browse owner-approved FAQs with currently published, category-visible private sources, ten per page with Next/Previous navigation.
- A question button carries only a 16-character SHA-256 fingerprint of an FAQ UUID, never the raw internal identifier. Each request re-evaluates allowed source/category visibility, current private navigation permissions, draft/approval/archive status and the currently authorized unique match before answering.
- An archived/disabled/stale question disappears immediately; group-only FAQs, drafts, unreviewed/hidden data, editor IDs and internal source references never appear. Question display HTML-escaped; no external AI, Telegram posting or automatic group interaction.
- Added RED-first JSON+SQLite paging, stale-button, group/private isolation and invalid-control integration tests.

## 0.7.20 — 2026-10-21 — Real private student questions against reviewed local FAQs (NOT DEPLOYED)

- The student **💬 المساعد التعليمي** private reply keyboard now explains a working, explicit **`/faq <question>`** command and distinguishes it from external generative AI, which stays OFF/unconnected.
- Added a bounded Unicode private FAQ query parser and a source-backed `ApprovedAnswerService.answerPrivateApprovedFAQ` lookup. A student receives an exact matching, currently APPROVED answer only from `private` scope whose cited education resource remains PUBLISHED under a currently enabled category/ancestor hierarchy. Group-only FAQs, drafts, stale sources and archived FAQ entries cannot cross into the student's private chat.
- Private FAQ lookup is intentionally **independent of the generative `privateAI` feature setting**, but still checks `education.navigate` on every request. It requires an explicit user-sent command; arbitrary chat messages never activate FAQ or AI. Student replies are HTML-escaped, do not reveal resource IDs or admin metadata, and return neutral no-match/ambiguous messages rather than picking an unreviewed or duplicate answer.
- Added RED-first JSON+SQLite transport integration tests for approved/draft answers, archived FAQ and hidden categories, group-scope isolation, duplicate matches, student feature-off denial, malformed commands, no accidental AI startup and no Telegram group command bypass.
- This is still a locally tested planned reply; Telegram live deployment and AI provider connection remain separately blocked.

## 0.7.19 — 2026-10-21 — Real owner FAQ queue and reviewed source-bound decisions (NOT DEPLOYED)

- Added **🧠 الأسئلة الشائعة** to the verified Telegram private owner dashboard, listing currently authorized FAQ records with at most ten per page, Next/Previous paging, draft/approved/archived status counts and sanitized question/answer previews. Student/delegate/group senders have no access even when copying owner labels.
- Added explicit **review and confirm** for promoting a DRAFT FAQ to APPROVED or archiving an APPROVED FAQ locally. Decisions use the existing FAQ library and immediately affect subsequent authorized FAQ answers; archiving a FAQ does not archive its educational source and approval never publishes to Telegram channels.
- Every confirmed write checks configured owner identity, current approved group navigation epoch (or private scope), current FAQ DRAFT/APPROVED status, exact question/aliases/answer fingerprint, source resource revision/status and ancestor category visibility/revisions **inside a single BotStore transaction**. Disabled/archived/missing sources prevent approval and stale/replayed/forged confirmations fail closed.
- The UI has no external AI call, Telegram channel delivery or automatic action on old response messages. New RED-first JSON+SQLite integration tests cover staged approvals, live local FAQ answers, local archival, source removal/hide, group revoke/reapprove, HTML escaping, 13-record navigation, malformed buttons, and student/delegate isolation.

## 0.7.18 — 2026-10-21 — Owner-reviewed ordering of educational categories (NOT DEPLOYED)

- Verified private Telegram owner can now open a category and explicitly review/confirm **⬆️ رفع خطوة / ⬇️ خفض خطوة**. Only sibling categories sharing exactly the same scope and parent may swap; parent/child and private/group content are never cross-moved.
- Both screens reveal the currently selected and neighboring category names and require separate confirmation. All labels remain bounded valid Telegram ReplyKeyboard text; forged, stale, student/delegate/group-origin actions fail closed.
- The confirmed write executes in a single durable store transaction: require configured owner, currently approved navigation scope, exact group policy epoch, target category revision and hash of the **entire saved sibling set**. Reordering after category edits, sibling additions, group revocation/reapproval, or a previous confirmation is rejected.
- Adjacent peer swaps normalize legacy tied order values to consecutive integer ranks and bump siblings' monotonic revisions so old confirmations cannot be replayed. Changing display order does not re-enable disabled categories, republish archived content, change category scope, create campaigns or call Telegram.
- RED-first JSON+SQLite integration tests cover public browse ordering, two-step UX, boundaries, independent scope/parent, tied legacy rows, stale/replayed actions, owner actor checks and 64-character category tokens. Not deployed or live-tested.

## 0.7.17 — 2026-10-21 — Owner-reviewed educational section visibility (NOT DEPLOYED)

- Added a true **🗂️ إدارة الأقسام** entry to the verified private Telegram owner dashboard. Owner can browse all saved, currently authorized educational sections in 10-item pages, open sanitized details and explicitly review/confirm disabling or enabling their local visibility.
- The enable/disable action checks the configured owner, current approved group-navigation policy revision, exact current category metadata/fingerprint and **monotonically increasing per-category optional revision inside a durable BotStore transaction**. Existing categories migrate naturally from revision zero; direct category visibility edits increment revision to invalidate stale confirmations even after a disable/re-enable flip-flop.
- Disabled parents also hide their descendants. Attempting to enable a child while its parent is disabled is denied, while enabling a parent only exposes its currently approved/published descendants. Archived resources remain archived; Telegram channel posts are untouched.
- Introduced short stable owner category ID tokens for up to 64-character IDs, uniquely resolved against freshly authorized categories; ambiguous, malformed, forged, stale, group-actor and staff/student buttons fail closed.
- RED-first JSON/SQLite tests cover review-read-only, exact confirmation, branch visibility, stale revisions, parent guard, long IDs, 13-category navigation and owner-only authorization. No Telegram send, upload or third-party AI activity.

## 0.7.16 — 2026-10-21 — Owner library review and safeguarded local resource archival (NOT DEPLOYED)

- Private verified Telegram owner now has **functional library navigation**, not only a status placeholder: see currently authorized local published resources, 10/page Next/Previous, open sanitized resource details and review/archive with separate confirmation.
- Archive is owner-only and compares the **opaque fingerprint of the exact currently reviewed publication** plus its current group-policy revision **inside the atomic BotStore transaction** before writing ARCHIVED. A changed publication copy, revoked/reapproved group, previously archived resource, copied label, or stale button fails closed. The old direct admin archiver remains available to existing authorized API callers.
- Archived resources disappear from the student's currently published lists/search results. No deletion or edit of Telegram channel posts is requested, and no pending sender is automatically retried. Audit records capture one local archival transition without private content.
- New RED-first JSON and SQLite integration tests cover list/detail, escaping, two-stage confirmation, 13-item pagination, students/staff/group context denial, changed content/group policy, unauthorized direct mutations and malformed button rejection. Test fixtures use only local stores and mocked Telegram events.
- Telegram activation, external publishing, AI and live group acceptance remain separately blocked.

## 0.7.15 — 2026-10-21 — Search published, approved educational resources from student Telegram buttons (NOT DEPLOYED)

- Added an actual **🔍 البحث في الموارد** Telegram ReplyKeyboard entry for students and owner. The button introduces a bounded text search: `/search منحة الصين` or `/search Grant`. No AI is required or invoked.
- Added stateless Next/Previous search result pages (ten entries per page) and clickable existing resource-detail buttons. Query labels are deliberately short, canonical and validated in Arabic/Latin Unicode; every page is recomputed from currently accessible material and has no bearer/callback authority.
- Added one-snapshot `EducationService.searchPublishedResources` that returns only safe public projections of **currently published private-scope** resources in enabled categories, respecting private education navigation permission. Archived/disabled/category-hidden and group/channel-only resources are never included. Searches match title, university, cycle and degree.
- Preserved current exact resource-button authorization: a resource archived or hidden after search cannot be opened with an old button. HTML content is escaped in response text. Invalid query/page markers fail closed; `/search` inside groups never becomes a bypass around membership verification.
- RED-first JSON+SQLite tests cover 23 result entries over three pages, scope isolation, non-public resources, feature switch revocation, stale buttons, malformed search pages, UI keyboard validity and escaped HTML. Telegram remains **offline**; no live student chat or web API requests occurred.

## 0.7.14 — 2026-10-21 — Malformed mandatory subscription rules cannot punish students (NOT DEPLOYED)

- Introduced one strict, reusable, pure `isCanonicalSubscriptionRule` validator for **runtime membership enforcement** and the **offline subscription health audit**. It accepts valid paused zero-channel rules but requires canonical group/channel IDs, ALL/ANY mode, positive integer rule revisions, at most ten unique mandatory channels and an array shape.
- `SubscriptionGate.verify` now returns **UNAVAILABLE** immediately for any malformed stored rule. A malformed mode can no longer accidentally fall into ANY logic and turn a known `NOT_MEMBER` into a moderation decision; duplicate, over-limit, or unrecognized channel entries never trigger provider calls.
- The offline aggregate audit now checks structure and duplicate group-rule identity **before** treating a zero-channel rule as harmlessly paused. A malformed or duplicate paused rule triggers redacted `INVALID_RULE_SHAPE` and blocks offline acceptance rather than silently passing.
- Added RED-first JSON/SQLite tests covering malformed ALL/ANY, zero/negative revisions, duplicate and oversized channel lists, invalid IDs, malformed paused and duplicate-group rules, unchanged legitimate paused behavior, and no accidental moderation/API effects.
- These tests use isolated fake adapters; real Telegram connection, live user punishment and provider admin checks remain OFF.

## 0.7.13 — 2026-10-21 — Avoid stale mandatory-subscription verification after reapproval (NOT DEPLOYED)

- Closed a time-of-check/time-of-use gap in `SubscriptionGate.configure`: owner configuration can await third-party channel verification while group/channel approvals change. Configuration now compares the **exact saved policy revision** of the group and every required channel in the same transaction as the rule update. A revoke/reapprove cannot legitimize stale verification, even when the final scopes look identical.
- Captured and compared the pre-check mandatory-subscription rule version, so a slow earlier external verification cannot overwrite a more recent owner configuration.
- Hardened `verify`: membership results obtained during provider latency are discarded as `UNAVAILABLE` when the group or required channel policy epochs, mandatory-channel sequence or ALL/ANY rule changed. An externally reported MEMBER or NOT_MEMBER under an obsolete authorization is **not** treated as current evidence or justification for moderation.
- Retained successful known MEMBER/NOT_MEMBER outcomes where both policy and rules remained unchanged, and isolated unrelated group policy edits.
- Added RED-first JSON+SQLite delayed-promise tests for group/channel revoke+reapprove, concurrent owner changes, stale external membership checks, unchanged success and unrelated scope updates. No live Telegram calls were performed.

## 0.7.12 — 2026-10-21 — Fail-closed mandatory-channel verification on provider errors (NOT DEPLOYED)

- Hardened the core mandatory-channel `SubscriptionGate` against Telegram membership verification provider timeouts/rejections. A failed `canVerifyChannel` call yields `UNAVAILABLE` for student checks, and a static `CHANNEL_UNVERIFIABLE` error during owner configuration; provider exception details are never propagated into stored audit or user replies.
- Invalid/unknown `getMember` provider results are normalized to `UNKNOWN`. For `ALL`, even a known `NOT_MEMBER` accompanied by an unknown channel now produces `UNAVAILABLE`, avoiding punitive decisions on incomplete verification. For `ANY`, one confirmed `MEMBER` remains sufficient; without a confirmed `MEMBER`, unknown results are never treated as a definitive violation.
- `syncSubscriptionRestriction` retains the existing policy of **no mutation or punishment** for `UNAVAILABLE` and continues to revalidate saved rule/chats after asynchronous membership checks.
- Eleven RED-first tests cover JSON/SQLite provider exceptions, incomplete ALL/ANY evidence, invalid provider enum results, owner configuration error redaction, stale chat approval while external checks are pending and no calls to moderation gateways for unavailable results. No live Telegram calls are enabled by this release.

## 0.7.11 — 2026-10-21 — Owner-only subscription health button in Telegram (NOT DEPLOYED)

- The real private **لوحة المالك** now includes an **🛡 سلامة الاشتراكات** reply keyboard button. It recomputes the same saved mandatory-channel subscription audit used by the offline operator CLI and acceptance gate whenever the verified owner taps it.
- Displays only aggregate active/inactive/invalid rule and group/channel counts, static PASS/BLOCKED and limited reason codes. No raw group/channel ID, student identity, chat content, API secrets, storage paths, provider calls, additional permissions, automated repairs or moderation changes are available from this surface.
- The screen prominently marks its result OFFLINE_ONLY and explicitly disclaims realtime Telegram membership/administrator verification. It links back to the existing approved-groups and settings sections, without a RUN/STOP or force-override operation.
- RED-first tests cover JSON and SQLite, owner keyboard presence and valid markup, fresh state on each tap, blocked revoked channel, unauthorized student/staff access, no dangerous controls and harmless paused rules retaining independent moderation state.
- A clean local status does NOT enable Telegram or certify host deployment.

## 0.7.10 — 2026-10-21 — Mandatory subscription rule integrity as an offline Telegram acceptance gate

- Incorporated the existing strict, privacy-limited `summarizeSubscriptionIntegrity` check into the **offline-only Telegram trial acceptance** procedure. Even with an exact matching rollback backup and STOP safety switch, malformed or orphaned mandatory-channel requirements now produce a static `INVALID_SUBSCRIPTION_REQUIREMENTS` blocker, preventing a false clean report from local trial rehearsal.
- Revoked source groups, lost required channel verification rights, malformed ALL/ANY, duplicate or excess required channels are caught without Telegram calls, student/channel ID disclosure, mutation or automatic moderation release.
- Paused empty subscription rules remain valid. Reasons are cumulative with STOP/backup/outbox blockers and are evaluated against the same already loaded state snapshot, retaining the existing race-aware re-read.
- Six RED-first JSON/SQLite-integrated and explicit STOP/rollback tests prove fail-closed behavior. **This is not real Telegram approval or proof of live admin permissions.**

## 0.7.9 — 2026-10-21 — Offline subscription configuration integrity audit (NOT DEPLOYED)

- Added a production-file **read-only local operator audit** for mandatory channel subscription rules. Checks the canonical private SQLite snapshot for configuration shape, valid ALL/ANY policy and versions, group and channel authorization for verification, duplicate required channels and the ten-channel maximum. Active and paused rules are reported separately.
- Added `npm run telegram:subscriptions -- --offline-only --state /absolute/private/state.sqlite` for a one-shot, **privacy-limited** `OFFLINE_ONLY` status report. Exit 0 = PASS; 2 = BLOCKED; 1 = invalid invocation/state. Only counts and constant reason codes are returned: never IDs, usernames, student content, paths, token or individual moderation decisions. Input cannot express Telegram activation or policy changes.
- Reused `BotStore.snapshotSqliteReadOnly` to reject absent, relative, malformed, symlinked, permissively owned or otherwise unsafe state sources without opening them read/write. No mutation, webhook, API call, rate-limit bypass, automatic punishment or auto-unmute.
- RED-first integration tests use a local canonical SQLite file and child-process CLI, including injected legacy orphaned group/channel approvals, duplicates, malformed policy, permissive filesystem paths, bad flags, redaction, bytes-preserving reads and explicit PASS/BLOCKED semantics.
- A passing local report is **not** evidence of Telegram's current channel membership/admin rights, real live policy safety, TLS or a deployment approval. Live acceptance remains separately blocked.

## 0.7.8 — 2026-10-21 — Owner-safe per-channel removal from mandatory subscription rules (NOT DEPLOYED)

- Each group subscription details panel now offers an owner-only **review removal** button for each currently required channel. The owner sees the exact channel to be removed, the remaining required-channel count and a separate **confirm removal** action.
- New atomic `Policy.removeSubscriptionChannelAtRevision` checks configured owner identity, currently approved group with verification scope, required-channel membership, and exact group+rule revisions in a single durable BotStore transaction. `SubscriptionGate.removeRequiredChannelAtRevision` delegates to that same policy implementation. No stale Telegram button can add a channel, reenable a group, or overwrite more recent subscription changes.
- A removal adjusts only the selected channel, preserves the remaining order and ALL/ANY mode, increments both revisions and appends a sanitized audit reason. Removing the last required channel makes the rule inactive. An independent `SubscriptionGate.verify` test confirms it consults **only remaining channels** after authorized changes.
- Existing reasons and moderation operations are not lifted, retried or sent; no `getChatMember` or real Telegram send/moderation call is made by these buttons. Real verification, approval and new mandatory-channel configuration remain separate provider-gated operations.
- RED-first tests exercise JSON+SQLite, multiple and last-channel removal, no unintended moderation, current runtime gate interpretation, old-button invalidation, forged channel IDs and non-owner rejection. Telegram integration stays OFF.

## 0.7.7 — 2026-10-21 — Owner subscription overview, controlled pause, and revocation cleanup (NOT DEPLOYED)

- Added **owner-only Telegram group subscription inspection** for approved chats: saved ALL/ANY mode, count of mandatory channels and exact pre-approved channel IDs, explicitly labelled as local state, not live Telegram membership verification.
- Added explicit two-step private owner review and confirmation for **pausing a stored mandatory-channel subscription**. Both chat-policy and subscription-configuration revisions, actor ownership and current verification scope are compared inside one BotStore transaction before clearing required channels. Confirmation is one-shot with stale-action rejection.
- Hardened revocation: revoking a group/channel or removing the `verification` scope now atomically clears dependent mandatory-channel subscriptions (with incremented configuration revisions). Re-approving an old channel/group cannot silently restore legacy gate obligations. Full owner group revocation still remains a separately reviewed local operation.
- **Never lift existing member restrictions automatically** when pausing or invalidating subscription requirements; moderation reasons and sent/unknown Telegram operations are independent and require separate review. No Telegram calls or live subscription checks occur inside owner UI.
- New RED-first JSON/SQLite tests exercise two-channel configuration, local detail and actor isolation, pause CAS, stale concurrent config edits, revoke/reapprove behavior, malformed actions and preservation of independent moderation reasons.
- Existing FAQ/membership behavior of direct `Policy.revokeChat` is retained while clearing dependent subscription rules. The bot remains OFF for public Telegram users.

## 0.7.6 — 2026-10-21 — Private owner-only group/channel policy restrictions (NOT DEPLOYED)

- The private owner dashboard's approved-groups section now lists every saved group/channel authorization in bounded Next/Previous pages. Each chat opens a detail panel with **local** approval, stored membership flag, allowed scopes, group-AI mode and policy version; it explicitly disclaims live Telegram membership verification.
- Added owner-only reviewed **restrictive** controls: remove one existing group scope, force stored group AI to OFF, or revoke the local group authorization. Each change has a separate preview/confirmation screen; button text provides no authority, and policy revision/owner/current authorization checks happen atomically in the BotStore transaction. A stale/replayed confirmation cannot silently override newer policy.
- Revoking local authorization also sets stored AI mode to OFF; removing the assistant scope turns it OFF as well. These controls never add a scope, enable AI, reauthorize a chat, leave/delete Telegram groups, post to channels, retry UNKNOWN replies or call Telegram Bot API.
- Added RED-first JSON+SQLite tests for group details, pagination, actor isolation, preview-is-read-only, revocation, AI OFF and scope restriction, stale-version denial and malformed button inputs.
- The bot remains **OFF by default**, not hosted. No public group invite-directory, real webhook acceptance, automatic moderation rollout, provider admin-right verification or live external interaction was added.

## 0.7.5 — 2026-10-21 — Fully paginated owner category picker during candidate review (NOT DEPLOYED)

- Added nine-item Next/Previous pages for all currently authorized source categories when the owner selects a READY imported candidate; previously the chooser displayed only the first nine categories. Buttons bind the run, candidate index and requested page and are revalidated by the existing owner-only private handler against the live approved scope.
- Handles a candidate beyond the first ten imported records without resetting its index, never applies approval or local publish merely by moving between pages, and denies stale pages after a candidate becomes APPROVED or NEEDS_REVIEW, group access is revoked or sections are disabled.
- Canonical, bounded page text rejects forged IDs, out-of-range page requests and navigation in the wrong direction. Optional long-category IDs retain the safe selector introduced in v0.7.4.
- RED-first JSON and SQLite integration tests cover 21 categories across three pages, last-page approval and separately confirmed library-only publication, late-index candidates and blocked unauthorized navigation.
- Real Telegram deployment, AI calls and channel publication remain OFF.

## 0.7.4 — 2026-10-21 — Owner review navigation and long category selectors (NOT DEPLOYED)

- Added actual Next/Previous buttons for **all accessible import batches and individual candidates**, ten per page, rather than only the first ten. Page requests are bounded canonical Telegram texts; they never confer owner authority, and updated owner verification plus current group approval are rechecked on every page.
- Fixed oversized review/approve/publish buttons when an approved category has a long (up to 64-character) ID. The UI now uses a fixed-length SHA-256-derived category selector only for long IDs and re-resolves it against currently visible categories, refusing unknown or ambiguous aliases. The selected full original category ID is passed to the existing transactional authorization/review service; no hash is used as proof of permission.
- Eliminated shared mutable owner-ID state from the owner dashboard handler; actor identity is supplied directly to the scope-checked education service.
- Added RED-first JSON+SQLite tests covering 14 batches, 23 candidates, exact pagination, stale group denial, malformed and forged page markers, 64-character categories, published resource preservation and disabled-category failure.
- Only the already-reviewed local library is affected. No auto-approve, channel send, AI call or real Telegram operation. Actual Telegram deployment remains OFF.

## 0.7.3 — 2026-10-21 — Interactive owner-only Telegram dashboard and reviewed local publication (NOT DEPLOYED)

- The existing **🔐 لوحة المالك** now opens a real multi-button private Telegram dashboard for authorized import review, library statistics, approved-group summaries, delivery/outbox aggregate status, and configuration boundaries. It never presents owner controls to students or delegates.
- An owner may select an authorized imported content batch, inspect each candidate's reviewed title/university/cycle/degree/status, select a currently enabled category, see a confirmation screen, then **explicitly approve** through the existing EducationAdminFacade transactional policy checks. No approval occurs on mere preview.
- Once approved, a second **independent local publication preview and confirmation** can add the resource only to the internal education library. It does not post a Telegram channel message, create a campaign or touch Telegram Bot API credentials. Publishing remains idempotent and existing candidate status rules deny ambiguous/duplicate records.
- Imported group content is only listed while the scope is currently authorized. Owner action text is untrusted, statically parsed and checked against the verified private actor, current import run, candidate state, enabled category, and group scope on every tap. No actions are honored from group chat or impersonating staff.
- Delivery and group panels report limited locally persisted counts only. They do not claim live Telegram health, run recovery, disclose student messages or reset UNKNOWN outcomes. Safety STOP/RUN is never changed from Telegram.
- New TDD JSON/SQLite and permission regression tests check real button-driven approval and publication, forged actions, revoked categories/chats, privacy and no outbound channel publishing.
- **Remaining:** full reviewed PDF ingestion, live Telegram download proxy, richer owner wizard/pagination, Mini App UI, actual support, AI integration, production TLS/webhook and authorized live acceptance.

## 0.7.2 — 2026-10-21 — Authenticated full-library next/previous Telegram browsing (NOT DEPLOYED)

- Extended the real Telegram reply keyboard with next/previous page controls for private scholarship, courses, universities, exams, forms and all-resource category listings, and for published resource lists within a category.
- Page navigation uses canonical, bounded plain-text tokens (never trusted as permissions); page, current category, current publication visibility and private actor access are revalidated afresh before every reply. Forged, malformed, inaccessible and stale pages are denied with no private data.
- Dynamic keyboard rows remain limited to ten items per page and a bounded number of navigation buttons, preserving Telegram payload-size and HTML escaping controls, unchanged durable one-shot outbound semantics and no group keyboard.
- RED-first tests cover 13 categories, 23 resources, next and previous, both JSON and SQLite, revoked categories, nonexistent resources, bad page grammar and invalid section claims.
- No new AI, Mini App, live courses/exams or production Telegram deployment is activated.

## 0.7.1 — 2026-10-21 — Telegram reply keyboard interface and private library browsing (NOT DEPLOYED)

- Introduced an actual **Telegram reply keyboard** in private /start and /help with scholarship, courses, universities, exams, educational library, student files, assistant, communities and help menu entries. The separate owner entry is displayed only for the verified owner user ID.
- Private interactive section buttons list current published/authorized content categories; category buttons drill into filtered and approved resources; resource buttons show current reviewed details. All selection IDs and labels are checked against freshly authorized BotStore/EducationService results before disclosure, rather than trusting an old screenshot or text. Stale/forged buttons and archived resources are denied.
- Added Home/Back flows, explicit per-section empty-library guidance and honest messages for disconnected AI, unshipped public group directory and unshipped live support/ticket system.
- Extended durable Telegram reply plans and sender with tightly validated optional `reply_markup.keyboard`. Persist markup through JSON/SQLite, then send it once with the exact existing privacy-preserving HTML `sendMessage` attempt. Reject forged button payloads such as contact/location requests and callback data. No reply keyboard is added in groups.
- New RED-first tests cover menu visibility and permissions, approved-category/resource navigation, stale and forged actions, content escaping, safe Bot API payload and restart/delivery deduplication in both stores.
- **Scope:** This is a first functional Telegram reply-keyboard slice, not yet a full Mini App, inline callback router, complete course/quiz platform, deployed live Telegram bot or global data integration. The app remains disabled for students.

## 0.7.0 — 2026-10-21 — Gated isolated SQLite rollback rehearsal (NOT DEPLOYED)

- Extended the existing offline STOP+backup acceptance with a second explicit read-only gate to ensure that backup and primary SQLite database are not *hard links to the same inode*. Distinct path strings alone are not sufficient rollback evidence.
- Added `rehearseTelegramTrialRollback`: first checks the private STOP file, separate validated matching SQLite backup and absence of unresolved queues/update/operations; only then invokes the pre-existing `runSqliteRestoreDrill` to perform an **actual SQLite point-in-time scratch restore** inside a separate pre-existing, canonical 0700 private sandbox. It compares all restored state and removes its own temporary files.
- The sandbox cannot be a live database/backup directory, overlap the actual source, backup or safety file, be a symlink or world-accessible. Invalid or missing directories are not created; blocked preflight does not attempt a restore; the original database, backup, and emergency STOP file are not mutated.
- The tool rechecks acceptance after the scratch drill and rejects a changed live state/safety switch. This reduces false PASS outcomes but cannot replace suspending all writers and host-level isolation against races.
- Added `npm run telegram:rehearse -- --offline-only --state <absolute> --backup <absolute> --safety <absolute> --sandbox <private-directory> --stale-ms 900000` with static safe JSON, PASS=0, BLOCKED=2 and invalid=1. No Telegram network, token, command, production database overwrite, automatic recovery or send.
- New local TDD tests prove sandbox restoration cleanup, unchanged live source/backup/safety, private-data-free output, blocked unknown queues, alias rejection and fail-closed CLI args.
- Passing both gates is not production readiness; DNS/TLS, isolated host backup retention, test-group acceptance, operator approvals and real Telegram evidence remain outstanding.

## 0.6.9 — 2026-10-21 — Offline trial acceptance and rollback anchor assessment (NOT DEPLOYED)

- Added `inspectTelegramTrialAcceptanceReadOnly` to verify an existing private initialized original SQLite state, a separately protected SQLite backup and the existing STOP/RUN safety file. Source and backup must match at the decoded logical BotState level for the rollback anchor to pass. Both are opened read-only and never created or restored.
- A clean offline result requires the emergency switch to remain STOP; mismatched backups or any QUEUED/SENDING/UNKNOWN Telegram reply, unresolved inbound update, unresolved moderation/leave operation, pending/unknown B4 delivery part or ready/in-flight purge block the rehearsal. Manual review cannot establish Telegram delivery success or suppress a blocker.
- The checker double-reads the source and safety file and fails closed if it observes a change during verification. This is advisory, not a concurrency barrier or replacement for shutting down every real writer.
- Added `npm run telegram:acceptance -- --offline-only --state <absolute> --backup <absolute> --safety <absolute> --stale-ms 900000`. It prints only `OFFLINE_ONLY` and static PASS/BLOCKED reasons, with exit 0/2/1. No chats, student texts, tokens, paths, update keys, attempts or other identifiers appear.
- RED-first local SQLite and CLI tests enforce private file permissions, symlink and missing-path denial, backup-mismatch rejection, STOP requirement, blocked unresolved delivery and no-database-creation behavior.
- PASS is **not** an instruction to switch to RUN and does not validate actual Telegram webhook registration, DNS, TLS, provider delivery, host firewall, live recovery or actual restore capacity. No live enablement or network access.

## 0.6.8 — 2026-10-21 — Persistent fail-closed local Telegram emergency STOP (NOT DEPLOYED)

- Added a privileged operator-controlled durable safety file (RUN or STOP, newline required) to opt-in Telegram production configuration. It must be a private, canonical, regular existing file (mode 0600 or stricter), not a symlink, with a separate path from SQLite. The bot has no command or endpoint to rewrite it.
- The webhook checks the safety file before accepting any new inbound update; STOP, missing, forged, unreadable, malformed or wrong-permission file blocks admission with sanitized HTTP 503 and no update claim.
- The reply dispatcher re-checks this switch **inside the exclusive database claim** before starting a QUEUED send. A stopped/invalid switch returns PAUSED, keeps QUEUED intact and causes no outbound Bot API call or receipt. Existing SENT/UNKNOWN outcomes are never automatically replayed.
- Existing in-flight Telegram calls cannot be unsent or atomically cancelled by filesystem changes. Safe drains, UNKNOWN quarantine and operator review remain in force. Switching back to RUN is not an automatic queue replay; any unsent attempt requires separate explicit operator handling.
- Offline readiness checks verify the switch and distinguish RUN from STOP in aggregate outputs; no token, student data or operator path is printed. The switch and its directory must be managed by host ACLs and atomic replacement; it is not a protection against a compromised host or filesystem races.
- New TDD tests of live mocked HTTP, disabled sender claims, restored RUN, invalid/missing/symlinked/mode-unsafe switch and state preservation. No real Telegram connection or public deployment was activated.

## 0.6.7 — 2026-10-21 — Offline read-only Telegram reply inventory and alert exit code (NOT DEPLOYED)

- Added `BotStore.snapshotSqliteReadOnly` for canonical, privately owned pre-existing SQLite state using native `node:sqlite` read-only handles and an independent integrity/decoding preflight. Never initializes tables, runs production schema migrations or opens a writable BotStore.
- Added `inspectTelegramOutboxReadOnly`, a sanitized aggregate that considers both UNKNOWN_OUTCOME and stale SENDING unresolved, stale QUEUED needs attention, and acknowledges manual review without marking delivery resolved. It never exposes per-student message text, actor/chat IDs, update keys, attempt IDs, tokens or filenames.
- Added one-shot `npm run telegram:outbox -- --state /absolute/private/state.sqlite --stale-ms 900000`: stdout is aggregate JSON only. Exit 0 for no alerts, 2 for attention required, 1 for invalid configuration/state. No Telegram token is required, no network traffic, no mutations, no automatic retry, no scheduler installed.
- State inspection rejects missing, symlinked, forged/corrupt, non-canonical and world-accessible files; object inputs and stale thresholds are bounded. Local operator privileges and directory safety still must be managed by the host.
- New RED-first integration tests cover read-only output, unknown and reviewed outcomes, stale QUEUED/SENDING, invalid paths, no database creation, aggregate CLI results and privacy across processes.
- This offline tool does NOT prove public webhook reachability, successful Telegram delivery, host backup security, independent evidence, rate limits or live readiness. No production deployment/activation occurred.

## 0.6.6 — 2026-10-21 — Shared authenticated HTTP ingress limits and safe shutdown (NOT DEPLOYED)

- Added shared `BoundedIngress` for the Telegram webhook and HMAC-signed local admin HTTP adapter. Accepted post-auth requests use a bounded in-flight budget (16 per listener, override for tests), with 503 **before** reading body or claiming an update when saturated. Admission lasts until processing and any external sender call have settled, not only until JSON parsing finishes.
- Configurable, bounded 250ms–30s inactivity cutoff destroys a stalled request; rejected and accepted requests never authorize Telegram replay. Ingress counters release on exceptions as well as successful completion, with original socket timeout restored.
- Strict byte-level UTF-8 JSON decoding rejects invalid UTF-8 and BOM, rather than silently interpreting replacement characters. Both HTTP boundaries reject unexpected Content-Encoding and keep existing authentication, content-type and body size restrictions.
- Production loopback Telegram server has explicit headers/request/idle/keepalive timeouts, maximum headers, requests per socket and concurrent TCP connections. This is process-level backpressure, not public ingress throttling or an IP rate limiter.
- Added `stopLiveTelegramServer`: idempotent close/drain with a bounded waiting status; DRAINING is not reported as STOPPED. SIGTERM/SIGINT initiates graceful drain, never force-closes an in-flight Telegram send on timeout, and does not automatically replay UNKNOWN outcomes.
- Added RED-first simulated HTTP, malformed byte, SQLite/JSON concurrency, pressure, socket timeout, signed admin and drain tests. No live Telegram setup, live receipt verifier, hosted HTTPS proxy, production monitoring or student activation.

## 0.6.5 — 2026-10-20 — Fail-closed HTTPS webhook startup gate and offline preflight (NOT DEPLOYED)

- Production Telegram runtime now requires `TELEGRAM_WEBHOOK_PUBLIC_URL` to be an exact canonical HTTPS DNS URL on the existing `/telegram/webhook` route. Localhost/private and IP targets, normalization, userinfo, nonstandard ports, query strings and fragments are rejected before runtime creation.
- Owner Telegram ID is now constrained to a positive safe integer in canonical decimal form.
- Added read-only `preflightLiveTelegram(env)` that checks the very same config and private, initialized SQLite state validity as the runtime without changing files, opening sockets or contacting Telegram.
- Added one-shot `npm run telegram:preflight` with deterministic status-only exit markers; does not leak credentials, IDs or file paths.
- Added RED-first local unit/CLI tests for invalid HTTPS and owner identity, malformed or missing/symlinked/permissive SQLite, nonactivation and sanitization, plus existing runtime regression updates. Existing Telegram sender behavior is unchanged.
- HTTPS URL syntax is NOT proof of public DNS, actual TLS, reverse proxy readiness, Telegram webhook registration or independent delivery receipts. Live Telegram activation and operational deployment remain blocked.

## 0.6.4 — 2026-10-20 — Opt-in authenticated local owner reply review interface (NOT DEPLOYED)

- Extends the existing `telegramAdminWebListener` with optional `OwnerReplyReviewWebOptions`; the two reply routes do not exist unless the caller explicitly injects a private BotStore and owner Policy. The live Telegram webhook server does not mount or activate them.
- Signed Telegram Mini App HMAC identity is verified before any owner-only action, with auth_date freshness, duplicate-init-header detection, fixed POST paths, no CORS/session cookies, no-store JSON responses and fail-closed error codes. Caller-supplied actorId, timestamp, stale threshold, notes, links and extra fields are rejected.
- `/admin/replies/summary` returns only aggregate counts from the preexisting audited outbox; `/admin/replies/review` records only one immutable owner acknowledgement for an exact attempt. The server supplies the clock and the fixed 15-minute SENDING staleness threshold.
- Explicit 2 KiB maximum body, strict UTF-8 JSON, fixed content type, 401/403/409/422 for specific classes without exposing private message content, identifiers or errors. Contradictory concurrent owner reviews cannot both commit.
- New JSON and SQLite local HTTP integration tests with fake HMAC signatures, role forgery, expired credentials, concurrency, unchanged payloads/status and replay protection. No Telegram network requests, production host, HTTPS proxy, UI publishing, actual external receipt verifier, or student activation.
- Note: HMAC verification authenticates the Telegram Mini App user but is not proof of any Telegram message delivery. This interface is still a localhost test adapter and remains OFF by default.

## 0.6.3 — 2026-10-20 — Owner-only immutable Telegram send review (NOT DEPLOYED)

- Added internal recordTelegramReplyManualReview for trusted, authenticated owners. Stores only bounded decisions (ACKNOWLEDGED_UNRESOLVED or ESCALATED), reviewer ID, review time and the exact attempt ID.
- Accepts only UNKNOWN_OUTCOME or stale SENDING. Attempt binding, bounded stale thresholds, duplicate detection, immutable decisions and idempotent identical calls prevent mistaken or conflicting review.
- Does not mark delivery as SENT or FAILED, retry, call Telegram, expose an HTTP/CLI entry point, or store notes/URLs/student messages.
- Adds aggregate reviewedUnresolved and awaitingFirstReview counters. The manualReviewRequired total remains unchanged by acknowledgements; operator review never proves delivery.
- New JSON/SQLite regression tests for permissions, attempts, concurrency, stale gates, unchanged receipts, no resend and privacy.
- Live Telegram/HTTPS activation, verified external evidence reconciliation, secure owner UI, full backup lifecycle and production acceptance remain open.

## 0.6.2 — 2026-10-20 — Durable Telegram reply privacy and operator review (NOT DEPLOYED)

- Removed unnecessary persisted reply body **at the beginning of each exclusive outbound send claim**, not after the HTTP result. Keeps only status, attempt ID, timestamps and optional confirmed Telegram message ID. This blocks blind replay after a crash without retaining user-facing text in current serialized state.
- Adds creation timestamp to new QUEUED replies, optional body/redaction timestamps to old BotStore v8 snapshots, and zero-content fail-closed validation for already redacted historical statuses.
- Added read-only, sanitized aggregate `reviewTelegramReplyOutbox` with stale QUEUED/SENDING counts and UNKNOWN/manual-review counts; no identifiers or message text.
- Added separate, bounded, index-paged `redactFinishedTelegramReplies` for legacy SENDING/SENT/FAILED_CONFIRMED/UNKNOWN_OUTCOME rows. Does not touch QUEUED, update receipts or fire Telegram requests. All changes are transactional; invalid metadata blocks the whole operation.
- Added 14 RED-first offline tests for JSON and SQLite, crash-safe pre-send redaction, unknown replay prevention, inventory privacy, bounded paging, corrupt input and concurrent workers; **428/428** tests passing including previous B0–B4 tests.
- No physical secure erase of SQLite WAL/backups, no automatic lifecycle scheduler, no manual outcome reconciliation, no real Telegram deployment.

## 0.6.1 — 2026-10-20 — Fail-closed live group membership verification (NOT DEPLOYED)

- Implemented `TelegramBotApiMembershipGateway` over the official `getChatMember` HTTP POST, with strict Telegram ID checks, bot-admin `creator`/`administrator` preflight, user ID matching, and explicit `restricted.is_member` semantics.
- The opt-in local webhook runtime now wires fresh admin-checked membership for private browsing of approved groups and the existing `SubscriptionGate.verify` for approved channel requirements. No cached proof, inferred membership, automated approval, bans or outbound enforcement.
- Fail-closed on 403/429, untrusted bot/user identity, malformed statuses/body, server/network timeouts; fixed HTTPS Bot API endpoint, no redirects/retries or token/error logging. Runtime remains disabled by default.
- Added 8 TDD tests, including mock HTTP/live webhook end-to-end and policy changes during asynchronous verification. All 414 historical + new tests pass.
- Not tested with real Telegram account, public HTTPS webhook, group admin privileges or production data; outbound retention and reconciliation work remains.

## 0.6.0 — 2026-10-20 — Telegram reply outbox and first gated live HTTP sender (NOT DEPLOYED)

- Added optional durable `telegramReplyJobs` to BotStore v8 and committed reply intents with inbound dedup decisions in a single state transaction.
- Added `TelegramReplyDispatcher` one-shot fenced send attempts with multi-instance JSON/SQLite coordination, group-revocation recheck, confirmed/failed/unknown outcomes and no blind retries after uncertain external sends.
- Added `TelegramBotApiTextSender` with strict token/chat/plan validation, fixed HTTPS sendMessage POST, bounded responses, protected HTML content, no redirects or retries, and provider receipt verification.
- Existing authenticated webhook optionally accepts a live dispatcher; no dispatcher means old mock plan-only behavior. Private `/start` and `/help` are supported.
- Added `telegram-live-server.ts` local-only opt-in HTTP entry point, requiring explicit production flags, private initialized SQLite and out-of-repo secrets. Added `npm run telegram:serve` and environment examples, but no public deployment or real Telegram token.
- Added 17 new tests (406 total) checking persisted replies, dedup after restart, two concurrent worker claims, group revocation, simulated Telegram success/403/429/5xx/timeouts, sanitized HTTP responses, local server config fail-closed and no implicit group access. All mock transport tests remain green.
- **Privacy/safety limitations:** persisted reply body retention not yet bounded, no actual Bot API / HTTPS webhook production E2E, no safe recovery of stuck SENDING yet; not Production Ready.

## 0.5.9 — 2026-10-20 — Private, isolated SQLite backup restoration drill (TESTED_MOCK)

- Added `runSqliteRestoreDrill`, strictly limited to a verified SQLite backup and an existing private canonical restore sandbox; no arbitrary restore destination, production database overwrite, Telegram/network/compaction or auto-run scheduler.
- Requires private file/directory ACL, no relative/dot-segment/symlink aliases, source backup validity and read-only `PRAGMA quick_check`.
- Uses SQLite point-in-time backup API to create a unique, exclusively reserved, private scratch database. Verifies it is valid and deeply compares every serialized BotState field with the backup. Aggregate results reveal no paths, actor IDs, message IDs or sensitive proof data.
- Preserves immutable publication and purge UNKNOWN_OUTCOME attempts without dispatch; removes only invocation-owned scratch db and `-wal`/`-shm` sidecars, even on failure. Concurrent independent drills and preexisting sandbox files are protected.
- Added 12 RED-first regression tests; all **389/389** existing B0–B4 and B2-Advanced offline tests passed after cleanup corrections. No new state schema, service or production deployment.

## 0.5.8 — 2026-10-20 — Read-only backup inventory and expiration review (TESTED_MOCK)

- Added `reviewSqliteBackups({directory,retentionDays,now,maxEntries?})` for a private canonical local backup directory; age threshold 1–365 days, bounded listing, no file deletion, restore, mutation, background runner or Telegram gateway.
- Added `BotStore.verifySqliteBackupReadOnly` that checks SQLite signature, read-only integrity, initialized `bot_state` row and supported schema without creating tables or writing to the source.
- Classifies backups as VALID_RECENT, EXPIRED_CANDIDATE, INVALID, UNSAFE_LINK, UNSAFE_PERMISSIONS, or FUTURE_TIMESTAMP; rejects symlinked/insecure/noncanonical directories, skips other file types without traversing.
- Returns aggregate counts plus deterministic SHA-256 local references and status, not raw names, paths, sender information or full content. Filesystem mtime is only advisory and cannot authorize a deletion.
- Added 12 TDD regression tests. All 377 tests passed in Actions, including JSON/SQLite/B0–B4 historical mock suite. No new state schema, no offsite backup expiration, no actual cron or production configuration.

## 0.5.7 — 2026-10-20 — Fail-closed validation before SQLite backups (TESTED_MOCK)

- Hardened the existing `BotStore.backupSqlite`: refuses noncanonical/aliased paths, symlinked file/ancestor/target-parent paths, zero-byte/forged/non-SQLite source and SQLite lacking a populated `bot_state` row before it reserves any backup.
- Validates source without writing: checks full 16-byte SQLite header, readonly `PRAGMA quick_check`, and decoded BotStore state. Does not initialize a missing `bot_state` during backup.
- Source validation happens before any backup directory creation. An existing destination cannot be overwritten. Output reserved privately (0600), point-in-time copied through SQLite online backup API, and verified as a usable BotStore snapshot; incomplete new backups are cleaned up.
- Added 11 TDD regression tests for corruption, symlink redirects, destination ACLs, canonical paths, preserving unmodified invalid sources and original WAL/current data. 365/365 tests passing with existing B0–B4 and B2-Advanced suites.
- Not automatic backup/restore, filesystem sandboxing, offsite retention enforcement, data erasure, or production Telegram integration.

## 0.5.6 — 2026-10-20 — Guard canonical state identity before local review tick

- Strengthened the existing **v0.5.5** offline `retention:tick` runner; no second runner and no new Telegram/compaction capability.
- Strict canonical absolute state path; reject `/../` or alias paths rather than silently normalizing to another database.
- Refuse symlinked ancestor directories via full `realpath` check, not only file symlinks.
- Validate nonempty state and 16-byte SQLite file signature before `BotStore.snapshot()`, preventing previously empty SQLite files from being initialized by Node sqlite CREATE TABLE.
- Added 4 focused RED/green regression tests for empty SQLite, forged signature, symlinked parent and noncanonical argument; previous B0–B4 and B2-Advanced suites unchanged. `TESTED_MOCK`, no live Telegram or production writes.

## 0.5.5 — 2026-10-20 — Local one-shot retention review command (offline)

- Added `src/retention-review-runner.ts` with strict `--once --state ABSOLUTE_PATH --engine json|sqlite` parser and `runRetentionReviewOnce`; no token or owner parameter is treated as authentication.
- Added compiled `src/retention-review-cli.ts` and `npm run retention:tick -- --state ... --engine ...`, a working local-only invocation of the owner-enabled review checkpoint, never compaction or Telegram deletion.
- Refuses missing/nonregular/symlinked/wide-permission state files before opening; validates BotStore schema, disallows accidental state creation, returns only status and aggregate counts; fixed failure codes avoid echoing arguments/secret values.
- Includes dedicated outbound-disabled gateway, no network or Telegram tokens. No cron, service manager, background run or production DB activation is installed.
- Added 12 tests (350 total) running the real CLI in Node subprocesses for JSON and SQLite, including read-only disabled run, strict flags, missing-state fail-closed, aggregate-only due notice, replay idempotence, concurrent independent SQLite processes and error-output secrecy.
- Keeps canonical BotStore v8 and all historical v0.5.4 features/receipts unchanged. Manual owner compaction is still a separate, explicit action.

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
