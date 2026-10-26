## 0.7.88 — 2026-10-26 — offline moderation crash/restart recovery inventory

- Introduced `src/moderation-recovery-monitor.ts` with an immutable, aggregate-only inventory of durable moderation operations: `INTENT`, `STARTED`, `UNKNOWN_OUTCOME`, stale pending attempts, bad/future timestamps, deduplicated affected member counts, and unreviewed versus owner-annotated unknown outcomes. No actor, member, group, operation ID, reason fingerprint or Telegram token is included in the report.
- An unresolved `INTENT` is **not** asserted to be a confirmed no-send after a crash. `STARTED` indicates that a provider write **could** have happened, not that delivery is confirmed. `UNKNOWN_OUTCOME` remains attention-worthy **even after** the owner records acknowledgment or escalation. All states remain unchanged.
- Added `inspectModerationRecoveryReadOnly`, which uses the existing private, integrity-checked, absolute-path, symlink-rejecting SQLite snapshot reader. It never opens a mutating BotStore, calls the Telegram API, retries sanctions or advances operation state. JSON and SQLite states use the same pure `summarizeModerationRecovery` projection.
- Added the one-shot command `npm run telegram:moderation-recovery -- --state /absolute/private/bot.sqlite --stale-ms 900000` with `--once` supplied by the script. Exit 0 means no aged/unknown evidence requiring operator attention; exit 2 means attention required; exit 1 means invalid request/state. A clean report is not proof that active pending operations can be retried or that remote Telegram state is safe.
- Added 14 tests exercising classification, age and clock anomalies, multiple group/member deduplication, review counts, invalid/malformed state, read-only file integrity, output privacy and CLI behavior.
- The owner-private UNKNOWN_OUTCOME review UI remains a distinct existing feature; this local inventory is for a trusted machine operator with filesystem access, **not** a new remotely accessible owner API. Live moderation still uses `FakeModerationGateway` and stays disabled.

## 0.7.87 — 2026-10-26 — distinguish confirmed pre-STARTED no-send from uncertain post-STARTED delivery

- Fixed a stranded moderation `INTENT`: errors from an awaited test-only `beforeDispatch` hook, `canRestrict` or `isProtected` preflight, or local policy verification during the STARTED reservation transaction previously propagated and could leave an unresolved INTENT indefinitely, even though the mutating `setRestriction` gateway had never been called.
- The service now catches those strictly **pre-STARTED** failures and atomically confirms the original INTENT identity. An unchanged INTENT becomes `CANCELLED` with `DENIED / PREFLIGHT_ABORTED_NO_SEND`; no outbound request, retry, new attempt, or simulated confirmation occurs. Existing active local reasons remain as recorded and are not silently discarded.
- If another writer removed the row or changed its immutable identity/status, the service does **not** certify a no-send. It restores/quarantines the original operation as `UNKNOWN_OUTCOME` and returns `BLOCKED_UNKNOWN`; this conservative state may require owner review even when the local test itself made no send.
- Errors **after STARTED** remain `UNKNOWN_OUTCOME`, never converted to `FAILED_CONFIRMED` or automatically retried. Token strings, provider errors and internal exception details never appear in the public result.
- Added **18 regression tests** for JSON/SQLite covering prestart hook failures, bot-rights and target lookups, throwing reservation-time policy checks, immutable-vs-raced INTENT, erased/terminalized records, persistence after restart, and contrast with an ambiguous after-STARTED outbound throw.
- **Boundary:** “no send” is proven only within the service's pre-STARTED execution boundary while the original row is unchanged. It is not a Telegram receipt or a general statement about other workers. A crashed process with a stranded STARTED record remains unresolved and must not be retried blindly. Production still uses `FakeModerationGateway`; no live moderation has been enabled.

## 0.7.86 — 2026-10-26 — quarantine moderation state drift during awaited Telegram responses

- Fixed a durable state conflict: `ModerationService.reconcile` could send a sanction with a mutated `kind` if someone changed the persisted `INTENT` after authorization; an out-of-order response could overwrite `CANCELLED`, `CONFIRMED` or `UNKNOWN_OUTCOME` with a fresh success, or throw instead of preserving a safe unknown outcome.
- The service now binds the remote dispatch to an immutable original `INTENT` receipt (including group/target, actor, kind, policy version, reason fingerprint and creation time). It refuses dispatch if this identity changes before STARTED. If the initial status was overwritten or the intent vanished, it restores a quarantined `UNKNOWN_OUTCOME` record instead of trusting a forged terminal status.
- After the network dispatch, it uses one durable transaction to verify that the **same** STARTED attempt remains present. A changed or missing status, member identity, sanction kind or other immutable attempt field is quarantined as `UNKNOWN_OUTCOME` against the **original** target. No late API result may overwrite contrary ledger evidence. The caller receives `BLOCKED_UNKNOWN` and normal retry paths remain locked.
- Runtime gateway returns outside `CONFIRMED`, `FAILED_CONFIRMED` and `UNKNOWN_OUTCOME` are coerced to `UNKNOWN_OUTCOME`, never stored as invented terminal statuses.
- Added **20 new tests** in isolated JSON and SQLite covering race changes in STARTED and INTENT, forged success strings, missing and reassigned operation records, no sends before STARTED, and no replay on conflicts. Initial RED run proved the first 14 cases failed while the existing 1,593 tests passed.
- **Limits:** these are fail-closed local ledger safety controls, not proof of remote Telegram delivery. A committed request followed by a crash may still be ambiguous; quarantine does not undo a sanction or authorize retry. `createLiveTelegramServer` continues to use `FakeModerationGateway` with no live sanction enabled.

## 0.7.85 — 2026-10-26 — no reason mutations or Bot API reads while a sanction is unresolved

- Fixed a state-consistency hazard: `ModerationService.addManualReason`, `removeManualReason` and `setSubscriptionReason` previously performed remote rights checks and could change durable local moderation reasons even though the same target already had a `STARTED`, `INTENT` or `UNKNOWN_OUTCOME` sanction record. `reconcile` could obscure an existing ambiguous outcome behind an unrelated remote permission failure.
- Added an early *authorization-scoped* durable pending check before **any** remote Telegram membership query and repeated the pending check inside each reason-edit transaction. A matched record returns `BLOCKED_UNKNOWN` or `BLOCKED_PENDING` without writes, Telegram queries, retries, unbans, unmutes or silently changing reason evidence. Unauthorized actors receive only `DENIED`, not sensitive ledger status.
- Kept the existing atomic checks for `reconcile` itself and the conservative no-replay handling after restart. There is no automatic reconciliation or evidence overwrite.
- Added **22 tests** across JSON and SQLite: all three unresolved states, add/remove/subscription evidence immutability, no extraneous provider queries, unauthorized non-disclosure, and persistence after reopening the store. RED CI initially found 20 failing cases while the prior 1,571 tests passed.
- **Boundary:** these are offline mock/durable-ledger safeguards. The production server stays on `FakeModerationGateway` with no live Telegram moderation. Ambiguous sanctions still require a separate owner review and must never be blindly retried.

## 0.7.84 — 2026-10-26 — strict offline moderation trial single-chat isolation

- Tightened `inspectOfflineModerationTrialScope` to require the trial chat to be the **only approved local chat**, regardless of navigation, publishing or other scope. A previously accepted second navigation-only group now returns the redacted blocker `OTHER_APPROVED_CHAT_PRESENT` (the existing `OTHER_MODERATION_GROUP_APPROVED` remains for a second moderation-enabled chat).
- Fail closed if **any historical moderation operation, moderation reason, or warning** remains in the trial group OR any other chat (including revoked groups, inactive reasons and inactive warnings). Reasons remain generic and never contain user IDs, chat IDs or record references.
- Require an owner-only clean local rehearsal: non-revoked `chat.manage` grants in the trial chat or elsewhere cause `TRIAL_GROUP_HAS_MODERATION_GRANTS`/`OTHER_MODERATION_GRANTS`. Even expired but unrevoked delegated configurations must be explicitly revoked. Previously revoked grants do not block.
- Expanded TDD tests with eleven cases including a clean revoked-other-chat PASS, old staff/history rejection, unchanged Telegram zero-call guarantee on any local scope blocker, and revised old navigation-only test. Existing independent fresh SQLite backup, STOP and no unresolved jobs remain mandatory.
- **Scope and limitations:** this is a conservative *offline-only advisory* for an otherwise empty isolated rehearsal database. It never disables other groups, removes grants/warnings or modifies production data, and never calls Telegram. It does not certify remote Telegram group identity, actual admin permissions or permission to turn on live sanctions. The production server continues using `FakeModerationGateway`.

## 0.7.83 — 2026-10-26 — preserve other administrators' Telegram member restrictions

- Closed a Telegram moderation safety gap: the official Bot API adapter previously considered a Telegram `restricted` member eligible for BAN or MUTE if `is_member: true`. Telegram's `getChatMember` does not say which administrator imposed the original restriction. An additional sanction could silently overwrite the other administrator's action.
- The `isProtected` gate now allows **only** a verified ordinary human Telegram `member` as a sanction target. All `restricted` statuses remain protected (both `is_member: true` and false, including missing membership evidence), as do bots, owners, admins, missing and ambiguous evidence. A refused mutation returns `FAILED_CONFIRMED` without sending `banChatMember` or `restrictChatMember`.
- This protection is checked at the initial authorization phase, immediately before the durable STARTED transition, and again after the awaited local-authorization check in the official Telegram adapter (the double-check introduced by v0.7.82). A remote restriction appearing after STARTED is therefore blocked without Telegram mutation and recorded as `FAILED_CONFIRMED` in both JSON and SQLite ledgers.
- Kept `observeRestriction` **read-only**: detecting an existing complete mute is informational and **never** proves the local bot imposed it, never unlocks automatic unmute/unban or grants permission to retry.
- Added **15 tests** covering BAN/MUTE over full, partial, absent-member and unspecified-member restrictions, new restrictions during local authority awaits, preserved read-only observation, and durable JSON/SQLite late restrictions. Updated one preexisting assertion that had treated active restricted members as unprotected.
- The production Telegram server still uses `FakeModerationGateway`; tests use injected fake HTTP, not a live Telegram account. There remains an unavoidable interval after the final remote check in which a role or restriction may change. No claim of atomic remote authorization or live sanction delivery is made.

## 0.7.82 — 2026-10-26 — protect promoted Telegram admins and locally delegated staff until sanction dispatch

- Fixed a stale Telegram safety preflight: the official `TelegramBotApiModerationGateway` previously checked bot restriction rights and target protections **before** an awaited durable authorization callback. A human target could be promoted to admin/owner, or the bot could lose rights, while that callback awaited I/O, and an earlier safe snapshot would still authorize the BAN/MUTE request. After an affirmative callback, the adapter now re-reads bot rights and target status using `getChatMember`, and then rechecks durable local authority **again**, before the existing final operator STOP check and mutating request. Every unknown, promoted or revoked state returns `FAILED_CONFIRMED` with zero mutating requests.
- Protected the platform's active locally delegated `chat.manage` holders against sanction and warning decisions, even if Telegram reports them as ordinary members. This control is checked when recording reasons, before `STARTED`, and during the final durable-authority callback. An expired or revoked delegation is not treated as permanent immunity.
- Added 26 unit/integration tests: BAN/MUTE role drift for administrator, creator, bot identity, lost bot rights and unknown status; proof recheck after remote preflight; durable STARTED races on JSON/SQLite; delegated staff protection, promotion during INTENT/STARTED and expiration handling. The first 18 failed on the original implementation while the previous 1,519 tests passed (test-first RED).
- **Limits:** This is a last-mile best-effort check, not an atomic Telegram permission transaction. A role may still change after the final remote check; Telegram's own authorization remains the final arbiter. Fake HTTP tests do not prove a real Telegram sanction occurred. The production server still injects `FakeModerationGateway` and does NOT activate live bans, mutes, kicks or reversals.

## 0.7.81 — 2026-10-26 — read-only Telegram moderation rights preflight for isolated group

- Added `TelegramBotApiModerationGateway.inspectBotModerationRights(chatId)`: it sends **only** `getChatMember` for the bot's own ID, without arming the safety switch or reaching any mutating Bot API method. `GRANTED` requires verified bot identity and either owner status or an explicit administrator `can_restrict_members: true`; verified demotion/revocation is `DENIED`. Malformed/mismatched identity, unknown status, invalid selector and failed HTTP remain `UNKNOWN` (fail closed).
- Added `inspectIsolatedModerationRightsReadOnly(options,gateway)`. The existing local one-group moderation scope, STOP, independent fresh matching backup, no unresolved attempts, and no prior local sanctions must pass **before** the first Telegram read. The function performs two separate rights reads with repeated local acceptance checks between and after them; a grant-to-deny or deny-to-grant transition returns `BOT_MODERATION_RIGHTS_CHANGED`, not an authorization. If local authority or STOP changes, all subsequent rights reads are refused. Results contain generic codes, not tokens/member IDs or group IDs.
- Added sixteen new unit/integration tests using fake HTTP and temporary isolated SQLite for safe rights, known denial, remote drift, malformed identity and unexpected fields, network failure, invalid selectors, STOP/scope refusal with zero remote reads, and concurrent local revocation.
- **Boundaries:** the library does not supply a live CLI or connect to `createLiveTelegramServer`, and all tests use synthetic Telegram responses. A read-only moment-in-time PASS is **not** evidence of true trial isolation or a grant to ban, mute, kick, unban or unmute; the independent operator must still approve any controlled Telegram trial. The production server remains on `FakeModerationGateway`.

## 0.7.80 — 2026-10-26 — offline single-group moderation trial scope verification

- Added `inspectOfflineModerationTrialScope`, a read-only isolated trial-group checklist that **cannot bypass** the earlier STOP/independent fresh backup checks. It accepts exactly one operator-provided, valid negative Telegram group ID, requires a locally approved and present group with the `moderation` scope, and rejects any second approved moderation-enabled group. It also rejects **any** historical moderation operation or reason in the chosen trial group; even prior simulated confirmations are not safe cleanliness proof.
- Added strict `npm run telegram:moderation-trial -- --offline-only --state <absolute sqlite> --backup <absolute sqlite backup> --safety <private STOP file> --stale-ms 900000 --trial-chat <negative chat ID>`. The output contains only `PASS`/`BLOCKED`, the STOP/rollback statuses and generic blocker codes. Invalid selector/flag combinations fail before filesystem reads; no group/member/operator IDs or secrets are printed.
- After the group scope read, acceptance prerequisites and source snapshot are rechecked. Changed state fails closed; no configuration, Telegram API call, ban, mute, unban or unmute is performed.
- Nine new tests cover a clean local group, approval/presence/scope revocation, a second approved moderation group, safe unrelated navigation groups, old simulated history/reasons, STOP/stale backup inheritance, strict CLI selector validation and redaction. Full strict TypeScript suite and five offline demos gate merging.
- **Important:** local `present` and `approved` flags do not prove remote Telegram isolation. A PASS is an *offline planning signal only*, not go-live authorization. The live server still uses `FakeModerationGateway`.

## 0.7.79 — 2026-10-26 — offline trial backup age and time consistency

- Repaired the offline trial acceptance's previously unused `now` / `staleAfterMs` inputs: a logically identical but **stale SQLite rollback anchor** now produces the redacted `BACKUP_TOO_OLD` blocker instead of a false PASS. A filesystem modification time more than one minute in the future produces `BACKUP_TIMESTAMP_IN_FUTURE`. Small clock skew is tolerated.
- The existing isolated rollback rehearsal shares this acceptance check and therefore refuses to start or create scratch files when the backup is stale or future-dated. The status-only CLI exits with code 2 on blocked readiness; secrets, file paths, students and moderator identities are not included.
- After the asynchronous checks, the acceptance inspector also rechecks source/backup device and inode, backup size and modification time. A replaced or retimestamped rollback anchor during inspection fails closed with `TRIAL_ACCEPTANCE_STATE_CHANGED`.
- Added eight tests for fresh/matched, stale, future-dated, threshold/skew boundaries, isolated scratch prevention and sanitized CLI reporting. Existing offline acceptance/rehearsal test fixtures now use the actual current clock for filesystem age checks.
- **Scope:** mtime is a conservative local freshness signal, not cryptographic proof of when the SQLite backup was created; an operator must still ensure the snapshot is trustworthy and all writers are stopped. The review remains offline-only with mandatory STOP; a PASS never authorizes live moderation or release actions.

## 0.7.78 — 2026-10-26 — verify internal moderation adapter integrity before tagging an attempted Bot API dispatch

- Further restricted the locally recorded `TELEGRAM_API` classification: besides the private instance brand and original public dispatch/preflight methods, the adapter must now use the exact audited prototype and unchanged TypeScript-private `call`, `getMember` and `allowed` implementations. Replaced helpers and inherited subclass instances are classified `UNSPECIFIED`, not given the official adapter origin hint. This removes a local provenance false-positive where a patched helper could forge a successful call without changing public methods.
- Seven TDD tests cover the genuine adapter, subclass inheritance, replacement of three private helpers, and durable JSON/SQLite recording. Six failed on the earlier implementation (RED) while the untampered control passed, then the new checks were added.
- **Security limits:** This is a conservative process-local classifier, not attestation of a remote Telegram sanction, a cryptographic receipt or authorization for unban/unmute. A fully compromised process or modified trusted prototype cannot be made trustworthy by this check. Live sanctions are still disabled, and no real Telegram network action is part of tests.

## 0.7.77 — 2026-10-26 — emergency STOP gate checked after awaited authority

- Closed a last-mile race introduced by the v0.7.76 asynchronous durable-authority callback: the official `TelegramBotApiModerationGateway` now evaluates the independent emergency gate **again after** that callback and immediately before any `banChatMember` or `restrictChatMember` request. A STOP transition during the callback, an invalid/missing switch, or an exception in the final check returns `FAILED_CONFIRMED` with **zero mutating API requests**. No automatic retry or release action was added.
- Added six fake-HTTP regression tests: STOP flipped during BAN/MUTE last-mile callback; refusal by final safety check for BAN/MUTE; exception on the final check; and a stable RUN/authorized single-dispatch control. All six failed on v0.7.76 (RED) while the original 1,473 tests passed, demonstrating the previous gap.
- This is a best-effort final check, **not an atomic transaction with Telegram**: a switch can still change after the final check but before/during the outbound request. Live production server still uses `FakeModerationGateway`; no live Telegram sanctions are enabled.

## 0.7.76 — 2026-10-26 — last-mile durable policy recheck before Telegram sanction write

- The `ModerationService` now supplies the official Bot API adapter with a **service-owned, read-only, fail-closed dispatch authority callback**. After async Telegram bot rights and protected-target queries, just before a BAN/MUTE HTTP request, the adapter rechecks current durable chat approval and moderation scope, staff `chat.manage` entitlement/expiry, the original operation's `STARTED` status and policy version, the active reason fingerprint and any trusted subscription evidence guard.
- Revocation or a changed moderation reason **while Telegram preflight is awaiting a response** now produces `FAILED_CONFIRMED` without making a mutating Telegram call. No new retry, unban, unmute or release path was added, and `UNKNOWN_OUTCOME` remains quarantined. This extra gate narrows but cannot eliminate the unavoidable race between the final local check and a remote network write.
- Added six JSON/SQLite tests for group approval revocation, staff grant revocation and reason-fingerprint changes exactly after STARTED. All six were first verified failing against previous behavior (RED) before implementation. Existing bot rights, target-protection, independent STOP switch and owner scopes remain in place.
- The live server still uses `FakeModerationGateway`; these tests run against an injected fake HTTP responder. No real Telegram mutation, production access or token is needed.

## 0.7.75 — 2026-10-26 — authenticated moderation adapter origin, never self-certified

- Hardened durable moderation origin recording: a third-party or overwritten gateway cannot assign itself `TELEGRAM_API` merely by advertising an `attemptGateway` string. A genuine `TelegramBotApiModerationGateway` now carries a private runtime brand, and only an instance retaining its original enforcement and permission-check implementations can receive this *local adapter* origin hint. Other custom/modified gateways are `UNSPECIFIED`; the normal local fake is still `SIMULATION`.
- Added 4 regression tests covering forged third-party gateway labels and overridden Telegram adapter behavior in both JSON and SQLite, including evidence quarantine before any external read. The new tests were confirmed failing on the previous behavior (RED), then fixed (GREEN).
- **Not an enforcement receipt:** a trusted adapter identity does not prove that Telegram accepted or still enforces a restriction or establish authorship. The existing `OBSERVED_NOT_ATTRIBUTABLE` verdict and no-release/no-retry safeguards remain unchanged. No real Telegram moderation is wired into the live server.

## 0.7.74 — 2026-10-25 — distinguish simulated moderation from Bot API adapter attempts

- Added a conservative optional `ModerationOperation.attemptGateway` classifier to the existing durable JSON/SQLite ledger. Every **new attempt that actually enters STARTED** records its locally injected gateway category: `SIMULATION` (the live server's currently used `FakeModerationGateway`), `TELEGRAM_API` (an explicitly wired `TelegramBotApiModerationGateway`), or `UNSPECIFIED` for any other adapter. Operations cancelled before STARTED are not falsely tagged as attempted. Existing legacy rows remain untagged; they are not silently rewritten or declared real.
- Tightened `inspectLocalReversal` and `ModerationReversalPreflight`: a locally `CONFIRMED` BAN/MUTE from `SIMULATION`, `UNSPECIFIED` or absent/legacy origin is classified `BLOCKED_UNPROVEN` **before requesting any live Telegram read**. The private owner rollback-blocker summary shares this same classification, so fake successes cannot count as candidates for remote verification.
- `TELEGRAM_API` denotes only the **local adapter selected at STARTED**, not conclusive evidence that the sanction is still active or who imposed it. Even after a read-only observed match, the existing result remains `OBSERVED_NOT_ATTRIBUTABLE`; no `SAFE_TO_RELEASE` verdict, ban/unban command, mute/unmute command, retry or remote-write action is added.
- Added 9 JSON/SQLite and legacy regression tests for restart persistence, fake-success quarantine, unknown implementations, cancellation without a tag, Bot API request simulation with a later read-only check, and missing origin on historical records. Updated earlier positive *simulation tests* to explicitly label their fake HTTP Bot API adapter where the test intentionally exercises the read-only Telegram-preflight path. Strict TypeScript, all tests and five offline demos gate merge.
- **Live Telegram moderation remains disarmed and continues to use the fake gateway**. This label is a developer-controlled source hint, not a cryptographic receipt. Verified exclusive authorship and safe undo remain future, separately audited work.

## 0.7.73 — 2026-10-25 — persistent moderation rate fuses and real owner status screen

- Implemented **MOD-010** rolling anti-abuse ceilings before *new local* BAN/MUTE dispatch intents, counting the existing durable `moderationOperations` ledger rather than volatile process memory. Conservative non-configurable initial limits: **5** sanction attempts per actor/group/10 minutes, **12** attempts for the entire group/10 minutes and **30** per actor across groups/24 hours. Relevant pending, failed, confirmed and UNKNOWN_OUTCOME intents all consume a budget reservation; CANCELLED and NONE releases do not. Clock regressions cannot discard future-dated reservations.
- Checks are made in the **same JSON/SQLite transaction** that creates the moderation INTENT, preventing concurrent authorized users from exceeding the limits. Early checks also decline rate-exhausted manual reasons and new active subscription reasons without sending Telegram mutations. These rate caps never override scope/identity checks, never clear or retry UNKNOWN_OUTCOME, and do not block local release operations in the existing offline fake gateway. When an in-flight race saturates a limit after a new reason was stored, dispatch still fails closed; that stored reason must be reviewed, not assumed applied.
- Linked the approved owner Inline Keyboard `🛡️ الحماية والعقوبات → ⚙️ سياسات العقوبات والاختبار` to a **working read-only owner-only** status panel. It displays limits and anonymized, current LOCAL counts (recent 10-minute and 24-hour sanction attempts, pending and unknown) across locally approved moderation groups. It exposes no student/member IDs, moderator identities, case fingerprints or private reasons and cannot change rate limits or Telegram rights.
- Added 19 JSON/SQLite and read-only owner integration tests for limits and rolling resets, group cross-actor budgets, cross-group daily ceiling, unknown/pending reservations, release behavior, competing simultaneous requests, reopening persisted stores, subscription enforcement and student/staff/group-chat isolation. Strict TypeScript, full tests and all five offline demos must pass before merging.
- **Production live Telegram ban/mute/unban remains disabled.** These are internal safety guards around existing simulation/integration code, not a claim that Telegram punishment operations have been enabled or that a confirmed local status proves who imposed a Telegram sanction.

## 0.7.72 — 2026-10-25 — current-state owner Inline Keyboard reversal blockers summary

- The owner private Inline Keyboard's `👥 المجموعات والشبكات → 📋 مجموعاتي → بطاقة المجموعة` now includes a **🧭 عوائق التراجع المحلية** read-only button for locally approved moderation-enabled groups. The new screen counts distinct target cases without printing their Telegram IDs, operator IDs, member identities, reasons, source references, evidence or UUIDs.
- Local outcome buckets are derived from **the exact same `inspectLocalReversal` classification used by the v0.7.71 preflight**: unknown, pending, active reasons, unproven history, stale group-policy revision and cases that may be worth a subsequent real Telegram read. Even the latter does NOT authorize unbanning/unmuting, prove attribution or claim live Telegram status.
- Each callback is bound to the current group ID, exact chat-policy revision and actual approved-list page, plus a 12-hex SHA-256 digest over current group moderation reasons and operations. A change to the ledger, page position, scope or policy invalidates the old button. The digest is a freshness selector only, never an access token; every click still requires verified private owner identity.
- Added 9 JSON/SQLite tests for six mixed blocker categories, no member/evidence disclosure, no live network call, immutable moderation domain state, stale reason/operation changes, forged selectors, foreign-user/group rejection, moderation-scope loss and empty ledgers. The full strict TypeScript/test suite and five offline demos gate merging.
- No live Telegram sanction, release or rollback operation is activated. The preflight's matching state remains `OBSERVED_NOT_ATTRIBUTABLE` and must never be confused with permission to reverse another administrator's action.

## 0.7.71 — 2026-10-25 — read-only Telegram sanction reversal preflight (never executes release)

- Added `ModerationReversalPreflight` to evaluate an owner-scoped, current locally approved moderation group and target before **considering** future BAN/MUTE reversal. It requires the latest local operation to be a matching `CONFIRMED` BAN/MUTE at the current policy revision, no active reasons, and no `UNKNOWN_OUTCOME` or pending operation for that target. All uncertainties or revoked scopes fail closed **before a Telegram query**.
- Added `TelegramBotApiModerationGateway.observeRestriction`, a **getChatMember-only** read path that requires the bot to retain administrator restriction rights. It differentiates a currently kicked member, an exact all-denied present-member mute, a normal member, protected administrator/bot, unknown/incomplete data, and insufficient rights. No `unbanChatMember`, permission restoration, or any Bot API write is called by this observer.
- After awaiting the remote read, the preflight **re-reads durable group/reasons/operations** and rejects stale local decisions. Even an exact observed match returns `OBSERVED_NOT_ATTRIBUTABLE`, *never* `SAFE_TO_RELEASE`: Telegram getChatMember does not reveal which administrator originally imposed the sanction, and a more recent independent admin restriction must not be erased.
- JSON+SQLite and fake HTTP tests cover owner-only access, group-policy revocation, active reasons, pending/unknown-outcome replay locks, conflicting histories, mid-request policy change, bot admin rights, protected users, incomplete mute flags, different observed states and immutable data. The live server still uses `FakeModerationGateway`; this new preflight is an offline-reviewed building block, **not wired to production actions and not live Telegram tested**.

## 0.7.70 — 2026-10-25 — owner-only UNKNOWN_OUTCOME triage (review NEVER authorizes replay)

- The opted-in `/ownerinline` owner panel now links **🛡️ الحماية والعقوبات → 🛡️ حالة الحماية** to a REAL, read-only review listing of `UNKNOWN_OUTCOME` moderation operations in currently approved, moderation-enabled local groups. It shows up to 8 cases per page, action kind and a status; member identities, sensitive fingerprints and operation identifiers are never displayed.
- The owner can inspect a case and **preview then separately confirm** either `ACKNOWLEDGED_UNRESOLVED` or `ESCALATED`. The short-lived 120-second one-shot confirmation token is unpredictable, owner-bound, group/version/operation/digest-bound; its consumption and immutable review annotation plus audit record are committed in a single durable JSON/SQLite transaction. A stale, copied, changed, revoked, expired or competing confirmation cannot annotate or consume the token.
- A human triage annotation **NEVER changes the underlying moderation operation.status**; in particular `UNKNOWN_OUTCOME` remains `UNKNOWN_OUTCOME`, so the existing `ModerationService.reconcile` still returns `BLOCKED_UNKNOWN`. No automatic retry, Telegram API call, unban, unmute, sanction or remote-right change is introduced. The disarmed v0.7.68 moderation gateway remains separate and unconnected to live dispatch.
- Added tests for JSON and SQLite navigation, canonical and stale selectors, owner-only private access, no identity leakage, preview immutability, one-shot success and replay, clock expiry, concurrent nonces, revoked groups, changed statuses, 19-case pagination, and durable no-retry behavior. CI continues to gate strict TypeScript, all tests and five offline demos. Live Telegram behavior remains untested.

## 0.7.69 — 2026-10-25 — privacy-scoped moderation outcome audit for staff

- In the opt-in private `/staffinline` panel, an approved group's card now includes **📊 سجل حالات العقوبات**. Authorized locally delegated staff and the owner can inspect bounded, paginated (8 records/page) *aggregate local operation outcomes*: pending intent, started/uncertain, provider-confirmed, confirmed-failed, unknown, and cancelled. It expressly warns against blindly retrying an UNKNOWN outcome.
- **No member IDs, actor IDs, report text, detailed moderation reasons, operation UUIDs or evidence fingerprints** are shown; the staff view displays only case ordinals, action types and status labels. It is informational, not an execution or retry interface, and it does not claim to know actual current Telegram sanctions.
- Every click rechecks the actual Telegram sender in a private chat, current active unexpired internal `chat.manage` grant, approved group moderation scope, exact group policy revision and page membership. The operation history selector includes a bounded digest of the current private operation ledger; appended or changed operations invalidate old buttons, and out-of-range or malformed selectors fail closed.
- Added 11 JSON/SQLite tests for status distributions, zero identity disclosure, 19-operation pagination, stale-operation hashes, revocation/isolation, empty ledger, owner/staff keyboard boundaries and no outbound sanctions. Entire CI suite, strict TypeScript and five offline demos gate merge.

## 0.7.68 — 2026-10-25 — fail-closed Telegram Bot API moderation gateway, NOT activated

- Added `src/telegram-moderation-gateway.ts`: a **real Bot API request adapter** implementing `ModerationGateway` for BAN (`banChatMember`) and MUTE (`restrictChatMember`). It uses canonical numerical Telegram IDs, strict JSON and exact boolean confirmation, bounded responses and timeouts, no automatic retries, and safe `FAILED_CONFIRMED` versus `UNKNOWN_OUTCOME` distinction.
- **Explicit activation boundary:** the constructor defaults its trusted safety gate to DENY. The current `createLiveTelegramServer` intentionally still uses `FakeModerationGateway`. There is no runtime or bot-token activation in this version; outbound ban/mute is possible only if a future explicitly approved integration injects this adapter plus an affirmative safety gate. Existing local ModerationService authorization, intent ledger and unknown-outcome replay block remain in force.
- Defense in depth: before any write, the gateway freshly checks its **own real Telegram bot identity**, administrator/creator status and `can_restrict_members` (for administrator), then checks that the target is a verified ordinary or currently present restricted **non-bot**. Creators, admins, other bots, unsupported statuses, departed members and uncertain API responses are protected. It checks its operator safety gate both before and after asynchronous rights lookups. An explicit STOP after preflight cancels the request.
- `NONE` / automatic unban/unmute is **deliberately denied** until an evidence-bound rollback is built: unconditional `unbanChatMember` can remove a current member and blanket permissions can override independent restrictions by other admins. No existing Telegram sanctions are reversed by this adapter.
- Added fake-HTTP tests for rights, bot/member identity spoofing, protected roles, independent mute permissions, exact ban payloads, disabled-by-default operation, mid-preflight STOP, errors and timeouts without retries, and real ModerationService + durable JSON/SQLite reconciliation. All tests and five offline demos gate merge. Successful offline tests are NOT a claim of live Telegram validation.

## 0.7.67 — 2026-10-25 — opt-in private student Inline Keyboard with actual published library

- Added `/studentinline` in private Telegram chats to browse the current approved PRIVATE educational catalogue using Inline Keyboard buttons, 8-per-page categories and resources, message edits, genuine back navigation and public-only resource details (title, university, cycle, degree, optional seats). Empty library/sections are described as empty rather than claiming imported or external opportunities exist.
- Bounded canonical `si:1:...` callbacks contain current-state fingerprints and list/page slots. Every click re-reads a single store snapshot and rechecks private education feature authorization, enabled category ancestor chain, published-only resource status, exact category/resource projection fingerprint and list page membership. Hidden/archived, newly reordered, malformed, expired-visibility or forged selection fails closed. Neither imported drafts nor reviewer/import/source locator metadata is exposed.
- Student navigation cannot call owner `mi:1`, staff `ms:1`, one-shot administrative `c_` or group moderation actions; group-context callbacks are denied. The existing student Reply Keyboard, FAQ and owner/staff menus remain functional. No production platform API, real Telegram membership grant, live AI provider, application submission or new content publication is claimed.
- Tests cover JSON and SQLite published-only drill-down, category/resource pagination, HTML escaping, stale fingerprints, privacy feature disable, empty library, cross-role blocking and replay-safe callbacks. Strict TypeScript, all tests and five offline demos required before merging.

## 0.7.66 — 2026-10-25 — private staff Inline Keyboard with scoped live-local authorization

- Added opt-in `/staffinline` in private Telegram chat. The staff menu lists only approved **local** groups with the moderation scope and a currently valid internal `chat.manage` delegation to the actor (or owner policy permission); it never infers live Telegram administrator rights.
- Added bounded `ms:1:...` callback routes, 8-per-page group browsing, message editing and back/home navigation, plus read-only group moderation summary counts. Current stored policy and actor grant are rechecked for **every callback**; stale group revisions, expired or revoked grants, dropped moderation scopes, shifted page membership, malformed callbacks, cross-role `mi:1` owner controls and group-chat access fail closed. No member identities or private moderation reports are exposed; only aggregate local counts.
- All Telegram callback acknowledgements and reply edits reuse the existing replay-safe durable outbox. The older Reply Keyboards and owner Inline Keyboard are preserved; this does **not** activate Telegram live ban, mute, delete, lock, protection filters, promotions or moderator privileges.
- Added strict callback-grammar, group/page versioning, JSON+SQLite grant-revocation/expiry, denied student/staff owner access and repeat-update tests. Full TypeScript, all unit/integration tests and five offline demos gate merging.

## 0.7.65 — 2026-10-25 — owner-only inline internal delegation audit

- Implemented the opt-in owner Telegram Inline Keyboard view **👑 المشرفون والصلاحيات → 📋 قائمة المشرفين**, backed by actual saved *internal* `grants` instead of a fake operational panel. Owners can inspect eight entries per page with active-by-time, expired, revoked and no-longer-approved-group counts, then drill into a single saved actor/capability/scope/issuer/expiration record.
- Each button has a bounded, canonical, read-only page/ordinal selector with a 12-hex digest of the exact current grant and status. A changed record, revoked grant, expired active grant or shifted page entry invalidates its old selection; the current ledger is re-read for every click, not cached client-side. Forged pages, malformed selectors and out-of-range slots fail closed.
- The owner-private Telegram callback gate remains mandatory: students, granted staff members and group chats cannot inspect the listing or details. This screen never grants, renews or revokes any right, and explicitly distinguishes internal MANARATAK permissions from real Telegram administrator/member permissions.
- Added JSON and SQLite tests for current-state listing, detail, pagination across 19 records, revoked/expired stale selectors, reordering, invalid callback grammar and student/staff/group isolation. This does not introduce a live Telegram permissions gateway or a moderator-facing operational interface; those are separate planned stages.

## 0.7.64 — 2026-10-25 — atomically confirmed owner local group actions

- **Transaction integrity:** owner inline `c_` confirmations now consume their one-shot approval and apply the corresponding *local* policy restriction in the SAME serialized durable JSON/SQLite transaction. The prior separation could consume approval before an unexpected failure of a subsequent transaction; no partial approval survives a failed policy precondition now.
- **New confirmation-only administrative controls:** a currently approved group's inline card can explicitly preview and confirm (1) pause of its mandatory channel-subscription rule, or (2) revocation of the group's local approval. The preview displays a local-only warning, creates an owner-bound 120-second one-shot nonce, and does not itself change the group. Revocation clears stored subscription dependencies and sets local group AI to OFF; neither action triggers Telegram leave, unmute, ban or network moderation.
- **Independent rule fencing:** the subscription-pause nonce also binds the subscription requirement version. A change to that rule's channels or mode invalidates the old nonce, even if the group's own version has not changed. Revoked, changed, expired, forged, wrong-user, wrong-context and duplicate tokens fail closed and do not consume a token unless a local change commits.
- **Compatibility:** the existing AI-OFF and internal assistant/publishing-scope restrictions now use the same atomic confirmation method, retaining their existing audit codes and idempotency. Legacy Reply Keyboard administration remains independent and unchanged. Real Telegram rights and permanent deployment are not asserted.
- **Test coverage:** added 13 tests across JSON and SQLite for exact preview selectors, pause/revocation behavior, dependency clearing, rule-only revision changes, owner/actor isolation, expiry, CAS staleness and concurrent one-shot confirmations. Full strict TypeScript, complete regression tests and five offline demos gate merge.

## 0.7.63 — 2026-10-25 — owner-bound one-shot LOCAL controls in inline group cards

- Owners browsing an approved group via the opt-in `/ownerinline` Inline Keyboard can now **preview**, then explicitly **confirm**, three *restrictive local-only actions*: group AI OFF, revoking the group's internal assistant scope, and revoking its internal publishing scope. No ban, mute, group exit, unmute, publication, bot Telegram-rights edit, or real AI activation is executed.
- Review issues a 144-bit unpredictable `c_...` callback reference stored in the existing durable callback ledger, bound to the owner ID, exact group ID, chat policy version, action and a **120-second expiry**. Confirmation atomically consumes the one-shot reference and then calls the existing policy revision-fenced operation. Stale/revoked policy, changed scope, replay, other actors, guessed tokens, old buttons, expiry and competing simultaneous clicks fail closed. A crash between consuming the reference and local policy mutation can leave the action unapplied; it is intentionally NOT auto-retried.
- The confirmed local transition is recorded by the existing policy audit trail, while the UI tells the owner it has **not modified Telegram permissions**. Existing Telegram Reply Keyboard administration remains operational; the Inline Keyboard migration is opt-in and does not authorize dangerous mutations by merely showing their labels.
- TDD adds JSON and SQLite coverage of preview immutability, owner-only one-shot confirmations, two scope restrictions, CAS revocation/expiry, cross-actor token theft, forged tokens, concurrency and no real moderation side effects. Strict type checking, complete test suite and five offline demos must pass before merge. The short-lived authorization is enforced even if historical callback metadata remains in local storage pending retention handling.

## 0.7.62 — 2026-10-25 — owner-only inline group drill-down (local read-only)

- "📋 مجموعاتي" in the opt-in `/ownerinline` dashboard now opens a real bounded, paginated Inline Keyboard list of currently locally approved groups (eight per page). Selecting a group opens current saved group scopes, AI policy, presence hint and subscription status; dedicated buttons display scope and subscription details. Back navigation returns to the actual group-list page, while old owner Reply Keyboard actions remain unchanged.
- Each group detail selector carries the canonical group ID, current chat-policy revision and list page. It is fully revalidated against current authorized owner identity, approved group, exact revision and page membership. Revoked/reconfigured/moved groups and forged or out-of-range selectors fail closed; no claim is made that saved presence or group rights prove live Telegram status.
- Duplicate Telegram callbacks are acknowledged without replaying planned responses. Strict callback validation rejects extra fields, noncanonical numbers, oversized selectors and control bytes. Connected read-only items are distinguished visibly from placeholders.
- Added JSON/SQLite regression tests for 19-group pagination, per-chat nested screens, cross-page navigation, policy changes and revocation, forged selectors, actor isolation, no state mutations, empty groups, and duplicate callback acknowledgments. This stage does NOT enable live Telegram moderation, subscription changes, or AI providers. Full strict TypeScript/tests/five offline demos required before merge.

## 0.7.61 — 2026-10-25 — B2 owner-only inline menu groundwork and safe read-only links

- Add opt-in `/ownerinline` navigation: two owner-dashboard pages for 16 approved sections, and all 253 subordinate approved labels with multi-page drill-down, back and home. Until ported, a button shows approved design notes only, never a misleading success.
- Strict private-owner `callback_query` handling, replay rejection, bounded callback_data, `answerCallbackQuery` and `editMessageText` for current bot-owned message. Reuse the durable reply outbox and distinguish queued plans from confirmed provider outcomes.
- Link six safe selectors to current authorized local group, subscription, FAQ, library, delivery and settings views. Keep the original owner operational interface and all student flows compatible. No new live ban/mute/publish/AI capabilities are declared or invoked.
- Add JSON/SQLite tests for all sections, invalid callbacks, replay, owner/staff isolation, Bot API serialization, safe live local summaries and failure handling; CI must pass strict types, complete tests and five demos before merge.

## 0.7.60 — 2026-10-23 — B3 actionable FAQ browse and search-result return buttons

- Preserve current approved FAQ browse page when opening a numbered reviewed question: answer keyboard gets `↩️ صفحة الأسئلة · pf:<page>` and original catalogue entry. On every return reread the current private reviewed FAQ catalogue; stale/out-of-range, disabled or group-only content cannot be recovered through old buttons.
- Preserve approved private FAQ search term, global visible ordinal and result page in bounded stateless selection labels, with a search-results return button in the resulting answer. Both selection and return require fresh approved search membership, source/category review and navigation feature permission. Do not store search sessions, aliases or student history in a database cursor.
- Keep old numbered/opaque FAQ selectors valid and preserve their existing current-source reauthorization; when a new contextual selector cannot fit keyboard limits, fall back to the original safe numbered button rather than returning malformed Telegram markup.
- Tests: 16 new JSON/SQLite regressions for browse page 2, keyword search pages 1 and 2, original/current publication checks, tampered ID/query/page, feature disable, malformed controls and group separation. RED proved 16 new failures against 1,276 previous green tests. Final CI strict TypeScript, full tests and five offline demos required.
- No real Phase17 AI, unreviewed search corpus, group bypass, or automatic generative answer publication enabled.

## 0.7.59 — 2026-10-23 — B3 contextual search results return in student Telegram UI

- Preserve the original search term and page in bounded, stateless Telegram search result button labels. After opening a reviewed private resource, students can tap `↩️ نتائج البحث` to return to the current authorized version of the same search page, alongside the existing category/all-categories navigation.
- Verify the exact current resource button representation, page membership, text/title and private category publication rights again for every selection. Strictly reject stale/archived resources, forged query/page/ID combinations, disabled private search and malformed Unicode or pagination controls; no new authorization route or stored student search session.
- Keep keyboard limits and backward compatibility: overflow on a very long ID/query falls back to the ordinary validated resource button, retaining category navigation rather than emitting malformed Telegram markup.
- TDD: 16 new JSON/SQLite navigation and revocation tests. 12 failed before implementation; after implementation, corrected a previous bounded-keyboard test which read the last segment as a resource ID without accounting for the new search suffix. GREEN passed strict TypeScript, **1,276/1,276** tests and five offline demos.
- This is an approved B3 local library navigation improvement. No Phase17 generative AI, external platform write or paid provider calls enabled.

## 0.7.58 — 2026-10-23 — B3 actionable student Telegram navigation breadcrumbs

- Improve actual Telegram student UI: resource details now include a verified category-return choice plus all-categories return, instead of offering only a generic back button that jumped to the home screen. Group/resources pages, including empty and multi-page listings, include an all-categories return while preserving the existing pagination, home and back buttons.
- Breadcrumb labels are bounded, stateless and parsed strictly. Re-use existing private category/resource B3 authorization on each click rather than trusting old button labels, showing retired resources, or storing student browsing trails. Forged labels or other-group categories cannot expose content.
- Add 10 JSON/SQLite navigation tests covering end-to-end selection, 10-item paging, return to reviewed categories, disabled/archived categories, malformed IDs, cross-group content isolation and valid Telegram keyboard constraints.
- TDD RED: 10 new regressions failed against v0.7.57; GREEN: strict TypeScript, 1,260/1,260 tests and five offline demos passed. No real Phase17 generative AI has been activated.

## 0.7.57 — 2026-10-23 — B6 owner-only privacy-safe Telegram outbox denial counters

- Record a strict optional `accessDenialCode` on durable `FAILED_CONFIRMED` Telegram reply jobs that the local dispatcher rejects *before* attempting any Bot API call. Three bounded categories: `LEGACY_UNVERIFIABLE`, `ACCESS_RECHECK_FAILED`, and `GROUP_UNAVAILABLE`. Do not persist raw reply text, user/chat/update IDs, provider error descriptions or tokens in the code field. Reject invalid values, including array-to-string coercion, in JSON and SQLite state decoders and runtime validators.
- Add read-only `summarizeOutboxAccessDenials`, requiring verified owner identity and enabled owner dashboard, with aggregate counts of failed jobs by local category and remaining unclassified/provider-confirmed failures. It never mutates state or retries a Telegram message and does not infer a precise external membership failure from a generic failed check.
- Extend the existing **📊 حالة الرسائل** trusted owner-private view with those five counts. No student-scoped identifiers, timestamps, individual jobs, source names, Telegram tokens or text are included. Disabled owner dashboard and malformed queue records fail closed.
- Preserve all prior outbox semantics: `SENDING` and `UNKNOWN_OUTCOME` are not replayed; prior failed jobs without new classification remain counted as OTHER and are not silently relabeled. This is a cumulative ledger report, not an actual Telegram delivery audit or privacy purge.
- TDD: 12 new JSON/SQLite regression tests. RED initially failed on absent source field; GREEN revealed four issues including a real coercion defect in schema validation, all fixed. Strict TS, **1,250/1,250** tests and five offline demos must pass before merge.
- Real Phase 17 generation, external AI billing and automatic student model responses remain OFF.

## 0.7.56 — 2026-10-23 — B6 block unverifiable legacy private Telegram queued replies

- Close the v0.7.55 upgrade gap: pre-upgrade private QUEUED replies could include group resources but had no reliable record of their scope, and the last-mile checker treated their private destination as sufficient authorization. Such unclassified jobs now fail closed when dispatched and have their queued text permanently redacted, without calling Telegram or creating an outbound attempt.
- Add an explicit, strictly validated `privateReplyKind` discriminator, set only when the trusted update is durably queued: `LOCAL` for non-group private replies; `GROUP_SCOPED` for private replies carrying group-backed `privateGroupAccess`. Remove this discriminator when the reply is claimed or rejected.
- Preserve previously queued v0.7.55 group-sourced private replies with an authentic `privateGroupAccess` even if the newer discriminator is absent; require their existing fresh membership, subscription, scoped content and 120-second expiration checks. New private-only LOCAL navigation is unaffected. Inconsistent source tag/proof pairs are rejected in both JSON/SQLite state validation and dispatch-time shape checks.
- Do not attempt to reclassify historical private replies from text or metadata. Quarantine unstarted legacy private items only. Already started or UNKNOWN Telegram attempts are not replayed. Some benign old private replies will be intentionally dropped and should be re-requested.
- TDD: 18 new JSON/SQLite tests. RED confirmed 12 previously failing cases; GREEN requires strict TS, 1,238 automated tests and all five offline demos before merge. Real Phase 17 AI remains disabled.

## 0.7.55 — 2026-10-23 — B6 private group-scope Telegram queued resource reauthorization

- Close the gap between admission and queued Telegram delivery when a student requests *group-scoped* published resources in private chat. Persist a `privateGroupAccess` source/recipient witness with actor, group scope, SHA-256 domain-separated content+subscription+policy epoch and 120-second expiry. Do not copy source text into authorization metadata.
- Require fresh actual group membership at dispatch even if no required channels exist; for ACTIVE mandatory-channel requirements, separately re-verify subscription channels. After awaiting Telegram, compare the original source/authorization epoch inside the durable one-shot queue claim. Reject and scrub stale, missing, expired or malformed proof without a Telegram send.
- Supply the same live, read-only Telegram membership gateway to the actual reply dispatcher. Add strict state schema and runtime validation: direct private recipient must equal actor ID, scope must be a canonical group ID, and group FAQ/menu metadata cannot coexist with private-group proof.
- Existing ordinary private scope browsing, group FAQ and group menu outbox semantics remain unchanged, and UNKNOWN external send outcomes are never retried. **Preexisting legacy DM jobs have no scoped proof and remain a documented migration risk**; no claim of retrospective coverage.
- TDD: 22 new JSON/SQLite and live test assertions; tests demonstrate membership loss, changed subscription and content while a request is queued, live provider-time rechecks and expiry. Strict TS, all unit/integration tests and five offline demos required.
- No Phase17 real model integration, automatic generated answers or production AI billing.

## 0.7.54 — 2026-10-22 — B6 prevent stale published group content in queued Telegram replies

- Bind both queued approved FAQ and group navigation messages to a **group-scoped content epoch** covering locally reviewed categories, published resources and FAQ approval/answer state, in addition to the existing membership/subscription/rule policy epoch. Digest input is deterministically sorted by ID. Do not persist raw source text in the witness.
- Upgrade the group reply witness hash domains from v1 to v2, ensuring all pre-v0.7.54 queued group messages with outdated, content-unaware authorization fail closed, including those with valid old actor/subscription witnesses. Such messages are rejected/redacted locally and not retried; previously started or UNKNOWN sends remain unchanged.
- Revalidate the same content-inclusive epoch during approved FAQ retrieval and again both before and inside exclusive outbox claim. Concurrent owner archiving or unpublishing an educational source, disabling a category, or changing approved FAQ text invalidates the send, including during an external membership-await race. Private-only changes don't invalidate unrelated group content.
- Add 16 JSON/SQLite regression tests: 12 failed in the RED state, and final successful TypeScript + 1,198/1,198 tests + five offline demos required before merge.
- This is a local pre-dispatch freshness fence, not an atomic revocation of a Telegram message already accepted by the provider. Phase17 generative AI, production model accounting and autonomous response publication remain OFF.

## 0.7.53 — 2026-10-22 — B6 guarded group navigation outbox membership, no real AI

- Close remaining pre-dispatch group resource-list leak: newly queued Telegram `/categories` and `/resources` replies now carry a 120-second, actor-scoped `groupMenuAccess` witness derived from the exact local group and subscription epoch. A queued GENERAL response with no such witness is denied/redacted as legacy, even if v0.7.52 supplied the GENERAL tag.
- Recheck the current group navigation policy and required-channel membership after message planning, just before claim, and fence changes during the external membership verification using an exclusive transaction comparing the original policy epoch. Expired, unknown and absent membership proof denies; stable permission still sends.
- Strict JSON/SQLite decoder and dispatcher validation of menu actor ID, digest, expiry, GENERAL origin and no simultaneous FAQ witness. Remove temporary actor IDs, reply bodies and origin tags on send claim or rejection. Private queued replies and v0.7.51+ protected FAQ are unaffected.
- 14 new JSON/SQLite regression cases; TDD RED recorded fourteen failures, then verified the fix with strict TS, all 1,182 automated tests and five offline demos on the final merge candidate.
- Constraint: Telegram does not give atomic membership-check/send; this is a last-local-claim fence rather than perfect prevention of external changes. Phase17 generative AI remains disconnected.

## 0.7.52 — 2026-10-22 — B6 block unclassified legacy queued Telegram group replies

- Introduce a strict optional `groupReplyKind` origin discriminator for newly queued group replies: `GENERAL` for ordinary group UI, `REVIEWED_FAQ` for replies with a short-lived B6 group-question witness. Save it when the trusted update is finished; remove it when the queue item is claimed or rejected.
- Close the upgrade bypass: earlier queued group replies with neither a new classification marker nor the v0.7.51 `groupQuestionAccess` witness have unverifiable provenance. Reject and redact them at dispatch rather than assuming they are safe navigation plans. Do not inspect HTML for authority, issue Telegram requests, create send attempt IDs, refund or automatically retry.
- Preserve the previously guarded v0.7.51 FAQ replies without the new origin marker: their original expiring proof and fresh membership reauthorization remain mandatory. Old unclassified **private** replies are unaffected; new group navigation replies with explicit GENERAL continue to dispatch normally.
- Validate group marker enum, status, group address and marker/witness consistency in the state decoder and dispatcher. JSON + SQLite: 14 new regression tests, plus strict TypeScript and all five existing offline demo gates.
- Limitation: pre-upgrade group navigation jobs may also be refused due to unknown provenance. Operators should reissue safe commands after upgrade. No automatic bulk migration or AI activation. External Telegram membership/send still cannot be atomic.

## 0.7.51 — 2026-10-22 — B6 short-lived pre-dispatch group FAQ authorization witness

- Fix the gap between B6's post-FAQ policy check and eventual queued outbound dispatch. Attach a 120-second, scoped `groupQuestionAccess` witness to approved group FAQ reply jobs only: actor ID, hashed group/subscription policy epoch, and expiration. The queued actor ID is short-lived persisted metadata, not pseudonymous; scrub it and the reply plan on claim/rejection.
- Extend `TelegramReplyDispatcher` to check the actor's current group AI permission, compare the policy/rule/channel epoch, and re-verify active mandatory-channel membership before irrevocably claiming the queued Telegram send. Compare the same epoch again inside the atomic local state transaction after external verification. Unknown/revoked membership, switched AI mode, rule changes, absent verifier or expired proof denies and redacts rather than sending.
- The production server explicitly passes the existing read-only `SubscriptionGate` to the dispatcher. Old B3/private reply jobs remain backward-compatible, and redaction and replay/no-blind-retry behavior are preserved.
- 18 new JSON/SQLite tests; strict typecheck, 1,154/1,154 automated tests and five offline demos passed on the final source commit. Release docs/head CI must also pass before merge.
- Limitation: membership and Telegram send cannot be atomic across the external provider boundary. This is a last-local-claim fence, not a guarantee against remote member removal between check and send; no Phase 17 AI or generated answer activated.

## 0.7.50 — 2026-10-22 — B6 stale group subscription evidence fence (OFFLINE reviewed FAQ)

- Fix a TOCTOU authorization flaw in the Telegram group approved-FAQ path: required-channel subscriptions previously were checked before awaiting a possibly slow B6 knowledge source, allowing plans based on stale membership when requirements were introduced, paused or changed during that await.
- Preserve an initial group/rule/required-channel epoch and fail closed on epoch mismatch or changed group authorization **after** answering from the approved FAQ. For active requirements, reverify current channel membership after the FAQ lookup and recheck the same local epoch again after the second external verification.
- Apply the last planning fence to both optional B6 reviewed-knowledge and legacy B3 FAQ-only group `/ask` paths. No bypass when the subscription adapter is missing or the previously unconfigured rule becomes active. Stable membership still works.
- Sixteen new JSON/SQLite regression cases, including rule update during a second membership lookup. TDD RED showed 8 previously unhandled failures in the first 10 scenarios; GREEN requires all 1,136 tests and the standard offline demos before merge.
- Scope limitation: this is a last-**planning**-step fence, not a delivery-time subscription reauthorization for queued outbox messages. No real Phase 17 AI, model billing or unreviewed Telegram AI output.

## 0.7.49 — 2026-10-22 — B6 owner-only direct replied-to question (OFFLINE approved knowledge)

- Recognize the explicit owner command `@BotUsername أجب عن هذا السؤال` or `/ask@BotUsername أجب عن هذا السؤال` only within approved group settings. Resolve the student question solely from the direct `reply_to_message` carried by that Telegram update, never from chat history or forwarded/quoted messages.
- Require a trusted owner identity; verify the direct reply target's message ID, current group, non-bot different sender, clean bounded text, no nested replies or forwarded/channel/bot provenance. Reject forged, malformed and cross-group targets. A missing target prompts reattachment without a guessed answer.
- Preserve existing Telegram subscription checks and B3/optional B6 reviewed FAQ permissions and post-await revocation; unrelated private FAQ and existing `/ask` continue unaffected. No model generation, central Phase17 provider connection, monetary billing or unreviewed student answers.
- TDD: 20 new cases over JSON/SQLite and pure target validation. RED had 9 failing behavior tests before implementation; subsequent corrected test fixture ensures future message IDs truly exceed current IDs. CI typecheck + 1120 tests + five offline demos are required before merge.

## 0.7.48 — 2026-10-22 — B6 Telegram UTF-16 explicit mention support, reviewed FAQ only

- Add `parseB6ExplicitMention` for current-message Telegram `MessageEntity` bot-prefix mention only. Validate bot username, exact mention span, UTF-16 entity offsets, bounded question, malformed/overlapping mention metadata, quotes and other-bot mentions. Text substrings without a matching Telegram entity never activate the assistant.
- Wire this reviewed question route into the existing Telegram group policy and subscription verification, preserving read-only approved B3 FAQ and the optional B6 preflight with post-await policy rechecks. Do not accept channel forwards or `sender_chat` impersonation and do not introduce persistent chat memory or a generative fallback.
- Add 21 JSON/SQLite/group and pure parser regressions, including group revocation during lookup, policy OFF, raw spoofed mentions, case folding and supplementary characters. TDD RED recorded missing behavior; GitHub Actions must verify full TypeScript checks and all offline demos on final head.
- No Phase 17 AI consumer API is connected or assumed. Mention answers are pre-approved knowledge, not generative AI.

## 0.7.47 — 2026-10-22 — B6 atomic offline Telegram HMAC secret continuity (no real AI)

- Pin a domain-separated secret-verifier fingerprint (`b6TelegramKeyBinding`) together with the first successful `b6tg1_` durable attempt reservation in a JSON/SQLite state transaction. Reject changed secrets on repeat/restart/race **before** calling a fake model; no automatic key rotation or billing refund.
- Fail closed for pre-v0.7.47 ledgers already containing attempts with no verifier: their original HMAC secret cannot be proven from an opaque request key, so enrollment requires future explicit, reviewed migration and cannot silently rewrite old idempotency evidence.
- Strictly validate optional `b6TelegramKeyBinding` for both storage engines. Deny direct Telegram-namespace reservations without binding while preserving non-Telegram offline simulation. No actor identities, prompts, secrets or chat histories are written into the reservation ledger.
- Fourteen regression tests added (JSON + SQLite). TDD first recorded 12 failing behavior tests on RED commit; source and final CI remain merge gates.
- Limitations: persisted fingerprint is a continuity guard, not production secret attestation, HMAC rotation, model receipt verification, real financial metering or live Telegram sends; Phase 17 remains unconnected and off.

## 0.7.46 — 2026-10-22 — B6 verified-update HMAC keys and durable-only fake admission (OFFLINE)

- Introduces the proposed `B6TelegramIntentKeys` boundary: HMAC-SHA256 of a distinct v1 domain and strictly validated bot ID / Telegram update number. Uses an explicitly supplied 64-hex-character (32-byte) secret; no actor IDs, student messages, session tokens, bot IDs or secrets are persisted in the B6 ledger. No key derivation from timestamps or retries.
- Adds a separate `B6TelegramDraftEntrypoint` and durable-only `B6GenerationDraftService.prepareDurableDraft`. Absent a durable reservation ledger, the new entrypoint returns `UNAVAILABLE` without calling even the fake model. Same verified update is rejected as `DUPLICATE` after reconstruction, independent of its subsequent delivery attempt. Bot/domain isolation and existing source/permission rechecks remain enforced.
- TDD: 16 new tests, 14 failing on the deliberately nonfunctional RED implementation; GREEN head passed **1,065/1,065** tests, typecheck and all offline demos in GitHub Actions. Final docs-head CI must pass before merge.
- Scope limitation: this module only accepts caller-supplied metadata claimed to be Telegram-verified. The existing live webhook application is not connected to the fake-generation entrypoint. HMAC key rotation requires a separate reviewed plan to retain replay-denial history. Phase 17 external provider and billing contracts are still absent; real AI and Telegram student sends remain disabled.

## 0.7.45 — 2026-10-22 — B6 bounded fake-call deadline and rollback-safe ephemeral admission (OFFLINE)

- Introduces strict optional `B6DraftConfig.maxDurationMs` (20–900,000 ms, default 30,000) for offline fake generation. A stalled fake-port promise resolves the service with `UNAVAILABLE` after the deadline; late text cannot be published or delivered. The local slot is released and an existing durable reservation becomes `UNKNOWN_OUTCOME` without refund or automatic replay.
- Hardens nonpersistent `B6EphemeralCallBudget` with monotonic clock high-water checks. Clock rollback returns `CLOCK_ROLLBACK` from `begin()` and does not reset spent UTC-day counters. Invalid or throwing clocks return `UNAVAILABLE` rather than escaping as uncaught exceptions; `summary()` still throws on bad clock reads.
- TDD: RED commit failed six new behavioral tests on JSON/SQLite and local budget; GREEN commit passed 1049/1049 tests plus typecheck and offline demos in GitHub Actions. Seven new test cases; final release CI must succeed on final head before merge.
- **Limits:** in-memory budget is not cross-process; wall-clock timeout does not prove an upstream provider stopped or completed. Real Phase 17 provider contracts, billing reconciliation and Telegram live generation remain disconnected and OFF.

## 0.7.44 — 2026-10-22 — B6 owner-only fake AI budget monitoring and unknown-outcome acknowledgement (OFFLINE)

- Adds a privacy-redacted **🧮 ميزانية المساعد التجريبية** owner Telegram menu with deterministic 8-record pagination. The owner can inspect UTC-day attempted calls and conserved reservation units, active calls, expired requests, and unknown outcomes. Report displays only short opaque attempt ID prefixes; **never** displays request keys, student prompts, AI answers, Telegram user IDs or provider secrets.
- Adds `B6OwnerBudgetReview` as an owner-policy-checked service with read-only `report`, explicit `quarantineExpired` and one-shot `acknowledge` operations. Expired in-flight attempts remain unchanged by report alone; an explicit owner action stores `UNKNOWN_OUTCOME` without replay, refund, provider inspection or outbound sends. A distinct review-preview and owner confirmation stores an operator-acknowledgement annotation and one audit record; the underlying outcome stays **UNKNOWN_OUTCOME** and still consumes reserved units permanently.
- Adds optional strict `operatorReview:{reviewedBy,reviewedAt}` field to schema-8 B6 ledger entries, **only for UNKNOWN_OUTCOME**. JSON and SQLite reject invalid/forged annotations and preserve exact prior ledger evidence. Repeated clicks, group/student copies, invalid attempt IDs and disabled owner dashboards cannot acknowledge or mutate the ledger. No model API calls occur from any of these actions.
- 17 new tests on JSON and SQLite cover no-mutating read reports, expired-but-not-yet-quarantined status, explicit quarantine, replays, duplicate concurrent review, invalid/revoked authorization, 8-record paging, signed context via Telegram private-owner simulation, copied group/student buttons, strict persistent schema and durable review records. **1042/1042 tests expected after source checks**; CI remains the merge gate.
- This is an **offline operator review indicator**, NOT provider receipt reconciliation, verified token usage, currency billing, real Phase 17 budget or automatic permission to retry. Live AI and Telegram sends remain OFF.

## 0.7.43 — 2026-10-22 — B6 additive durable fake-call reservation ledger (OFFLINE)

- Adds a strict, optional schema-8 `b6BudgetAttempts` ledger of **opaque request keys, UUID attempts, UTC-day conservative unit reservations, leases and statuses**; adds a monotonic high-water clock. The durable schema decoder runs identically for local JSON mock stores and SQLite state records, and rejects malformed or duplicate records rather than resetting spend evidence. No user IDs, raw student questions, responses, provider credentials or full chat history are stored in the ledger.
- `B6DurableBudget` atomically enforces daily attempt and reserved-unit limits and maximum in-flight calls; SQLite relies on the existing `BEGIN IMMEDIATE` write transaction to prevent concurrent oversubscription across bot processes. JSON remains single-process mock-only. Entries survive restart. Reusing a request key — even on a later day — is denied; expired reservations become `UNKNOWN_OUTCOME` during explicit recovery with **no automatic retries or credit refund**.
- The fake-only `B6GenerationDraftService` accepts an optional durable gate, in addition to its existing ephemeral gate. When injected, a stable request key is required, a conservative 8192-unit amount is reserved before a **fake model call**, completion/failure is settled, and a response that arrives after its lease or loses its reservation is suppressed. A provider exception remains `UNKNOWN_OUTCOME` and consumes capacity. The default, no-durable-budget behavior stays unchanged and OFF unless explicitly configured.
- 31 new tests (13 ledger/JSON+SQLite and 8 fake-generation integration test cases per backend plus supporting edge cases) validate restart replay denial, time rollback, unknown outcomes, UTC rollover, atomic concurrent reservations across store objects, mutation validation, no stored prompt PII, stale FAQ/source checks, late provider responses and no automatic redelivery. **1025/1025 pre-docs TypeScript+test CI checks passed**, offline demos included in release CI.
- No production Phase 17 provider, actual billing, receipt reconciliation, distributed JSON locking, owner-facing budget reconciliation, token-based pricing or live Telegram send is enabled. Hard 2000-record ledger capacity fails closed; reviewed retention/reconciliation is a separate future operation. Reserved units are intentionally conservative **not verified external token use or a currency budget**.

## 0.7.42 — 2026-10-22 — B6 fake-only quarantined generative drafts and temporary request admission

- Defines the proposed independent `AnswerGenerationPort` input contract, **not** a live OpenAI/Phase 17 connector. It receives a bounded scoped question, one trusted reviewed FAQ answer/source ID, and a maximum output length; it receives no Telegram actor identifier, session credential, previous conversation, group member list, or platform login.
- `B6GenerationDraftService` is **disabled by default**. With explicitly injected fake port and deliberate enablement, the existing B6 approved-knowledge preflight runs before the attempt and AGAIN after the awaited mock generation. Revoked private/group permissions, edited/archived FAQ, changed source ID or changed approved answer yield no generated draft.
- Fake output must match a strict versioned JSON shape and source ID, include bounded finite integer token usage, avoid Unicode control/bidi spoofing and oversized outputs. Any approved result remains `DRAFT` with `OWNER_REVIEW_REQUIRED`, never an answer that can be automatically published or sent. An escaped HTML field is supplied only for a future trusted owner review surface.
- `B6EphemeralCallBudget` enforces per-process UTC-day attempt limits and concurrent call slots; ambiguous failed provider calls still consume an attempt, and no automatic retry occurs. Its summary explicitly marks `durable:false`; it is **not** a production spend cap, real token billing, distributed quota, Phase 17 authorization or credential guard. Do not connect a paid provider behind it.
- 25 new JSON/SQLite and no-network tests cover default-OFF, current trusted FAQ before/after awaits, scope isolation, revocation, concurrent admission, day rollover, unknown-cost failures, strict output and safe HTML, preserving the existing 969 tests. **994/994 offline CI tests passed** before release metadata changes. No real AI calls, Telegram send, storage of raw student prompts or autonomous publication.

## 0.7.41 — 2026-10-22 — B6 knowledge-first answer planner, no generative AI (OFFLINE)

- Adds the first B6 `KnowledgeSourcePort` (minimal query scope + question, no Telegram actor ID, credentials, identity/session linkage or chat history), local approved FAQ lookup, and a `B6AnswerPreflight` that enforces the bot's existing private opt-in and explicit group-mention policies BEFORE calling a source.
- A returned source hint never authorizes an answer. After awaited source work, the planner checks the current chat policy/epoch and the trusted B3 FAQ publication, reviewer and category visibility again. Only exact matching, currently reviewed and published source-backed answers may be returned; revoked scope, archived/hidden sources, mismatched provider output and conflicting answers fail closed.
- Opt-in Telegram simulation integration: `/ask QUESTION` in a permitted opted-in private chat, and `/ask@BOT QUESTION` in approved groups, can use the planner only when explicitly injected into `TelegramUpdateApplication`. Without it, the previous group FAQ route remains unchanged and `/ask` private is not exposed. `/faq` always remains independent of AI mode.
- No external AI model, Phase 17 connection, prompt execution, source-web search, saved raw questions, platform provider, Telegram network dispatch or hidden fallback is implemented. Responses are labelled as reviewed saved FAQ, never AI-generated; no answer means no fabricated answer.
- 35 RED-first JSON/SQLite and Telegram integration tests covering strict scope, no history/actor passing to the port, opt-in/mention gating, forged hints, ambiguity, source edits and group revocation midflight, HTML-safe output and default-route backward compatibility. **969/969 CI tests passed** with all offline demos.

## 0.7.40 — 2026-10-22 — B5 signed owner Mini App external-source preview and integrity (OFFLINE)

- Adds two strictly opt-in **read-only** routes to the existing Telegram Mini App HMAC-protected administrative listener: `POST /admin/platform/preview` and `POST /admin/platform/integrity`. They exist only when a trusted B5 `PlatformCatalogPreviewService` is injected explicitly. The real Manaratak API, source URLs and service credentials are neither assumed nor connected.
- Both endpoints authenticate the Telegram Mini App signed actor, require the immutable owner, and recheck the current owner dashboard permission before and after external reads. Client-provided user IDs or scope cannot create authority; no source data is returned to students, delegates or groups.
- Request JSON is bounded to 2 KiB, checked for exact allowed keys and rejects duplicate top-level property names, including JSON escape aliases. Invalid scope, cursor, record ID, SHA-256 proof, methods, signature and content type fail closed.
- Preview returns bounded source metadata explicitly labeled `UNVERIFIED_EXTERNAL`; the integrity route checks only previously owner-reviewed locally published B5 resources, distinguishing CURRENT, SOURCE_CHANGED, NOT_ON_PAGE, UNAVAILABLE, LOCAL_ARCHIVED, and LOCAL_INCONSISTENT without local database changes or Telegram publication.
- 22 additional HTTP integration tests with signed Telegram Mini App fixtures across JSON/SQLite, including absent optional routes, forged students, invalid/duplicate JSON, upstream faults, source drift, archived state, changed authorization during I/O and unchanged state. All **934/934** offline CI tests passed along with the configured offline demos; this is NOT a public live web endpoint.

## 0.7.39 — 2026-10-22 — Explicit owner-confirmed B5 local archival (offline)

- Owner may inspect an externally sourced, locally published resource, preview archival, then separately confirm archival. No source-driven automatic archive, no claim that application periods have closed, and no messages to Telegram channels.
- The state transition validates owner dashboard and publication rights, exact B5 source-to-resource linkage, and the resource's current fingerprint in one JSON or SQLite transaction. Obsolete confirmations cannot archive a modified resource.
- 14 JSON/SQLite regression tests cover the Telegram confirmation path, forged or copied buttons, unavailable providers, competing clicks, updated publication text, and student-library visibility.

## 0.7.38 — 2026-10-22 — B5 owner read-only published-source integrity inspection (OFFLINE)

- **Published-resource source reconciliation is explicitly read-only.** The independent B5 inspector `inspectPublished(actor,sourceId,expectedDigest)` verifies the configured owner and dashboard, a unique local publication link, saved metadata/provenance and the currently read external cursor page. It checks both local state and owner permissions AGAIN after the source read, rejecting a stale or concurrently modified local record.
- Safe distinct diagnostics: `CURRENT` (matching source digest), `SOURCE_CHANGED` (updated revision/metadata), `NOT_ON_PAGE` (record missing from originally saved cursor page; this does NOT prove closure or removal), `UNAVAILABLE` (provider error, malformed page, no trusted conclusion), `LOCAL_ARCHIVED`, `LOCAL_INCONSISTENT`, `DENIED`, or `STALE`.
- Owner Telegram optional **🔬 سلامة المصادر الخارجية** menu lists currently linked locally published B5 records, eight per page, and offers a single-resource **🔬 فحص مصدر** action. Unverified source data is never exposed to students; button selectors are bounded and resolved uniquely to the full SHA-256 digest from authorized owner state.
- **No auto-update, auto-archive, auto-publish, source repair or Telegram channel announcement.** This is an advisory owner integrity signal only. The real Manaratak API still needs an independently verified authenticated reader contract and staging tests.
- 28 new RED-first tests: JSON/SQLite source drift, missing/invalid/unavailable, archived and locally tampered resources, owner authorization, read-only state guarantees, Telegram owner inventory, pagination, copied forged buttons, dashboard revocation, and no outbound effects. **898/898 CI tests passed**, including offline demos.

## 0.7.37 — 2026-10-22 — B5 owner confirmation screens for source-reviewed local publication (OFFLINE)

- An owner with the optional B5 reader can move from external metadata review to an explicit **private category picker**, a separate owner **category approval confirmation**, then a distinct **local visibility preview** and **local publication confirmation**. Selection and approval do not publish to students; the final confirmation can create a private published resource only through the already guarded v0.7.36 backend.
- New owner review selectors are treated as untrusted text. All button requests must originate from a verified owner private chat with an active dashboard. The store queue and categories are freshly authorized on each step. Source/category identifiers use stable bounded tokens, source digests are shortened ONLY for reply keyboard length; handlers must resolve unambiguously to an exact saved full SHA-256 digest, then approval/publication methods independently revalidate the current external source and its revision.
- Category picker is paginated in eight options, excludes invisible/disabled categories, and rejects forged or stale pages and copied student/group buttons. Additional JSON/SQLite Telegram integration tests cover the full owner decision path, forbidden publication paths, category pagination, revocation, source drift, byte/codepoint-safe keyboards and a maximum-length private category ID.
- No automatic Telegram channel broadcast, campaign, AI call, real Manaratak provider API or live bot deployment is added. Availability to actual owners still depends on an independently configured and authenticated external reader.

## 0.7.36 — 2026-10-22 — B5 explicit separate category approval and local publication for reviewed external metadata (OFFLINE)

- After owner-only external metadata review, a **new and separate owner approval** may bind exactly one current external candidate to a currently enabled `private` education category (`approveForLocal`). Approval changes the quarantined state to `APPROVED_FOR_LOCAL` and is **not** a local publication or Telegram/channel send.
- **Another explicit owner action** (`publishLocally`) freshly rereads the external source by its saved cursor, verifies the complete source revision+metadata SHA-256 digest again, rechecks category visibility including parent-chain, and transactionally creates **one** `private` published local educational resource. Seats are explicitly unknown (`null`), never guessed; only reviewed external title/university/cycle/degree are copied. No Telegram delivery/campaign or automatic announcement occurs.
- Both actions require configured immutable owner identity and active `owner.dashboard`+publish permission, with permission/category checks inside the final JSON/SQLite state transaction. Concurrent publishes are idempotent; archived locally published resources are **never revived**, a changed source cannot bypass review, and wrong/disabled/group categories fail closed.
- The additive schema-8 review queue validates explicit `APPROVED_FOR_LOCAL` and `PUBLISHED_LOCALLY` states, saved approver/category/provenance and local resource ID while preserving old staged/reviewed records. 16 new JSON/SQLite + concurrency + revocation tests; all 859 tests and offline demos pass.
- **No owner Telegram button for local publish is introduced in this slice.** The new service actions are available to a separately authorized future owner UI; the default Telegram owner buttons still stop at external metadata review. Real Manaratak API, external credentials, Telegram live and generative AI are not connected.

## 0.7.35 — 2026-10-22 — B5 two-step owner Telegram actions to stage and review external metadata (OFFLINE)

- The optional owner-only Telegram external catalogue now renders an explicit `📥 تسجيل مرشح` action for each visible external candidate (up to ten per page). The selected source ID, page cursor and complete read-only page fingerprint are stateless untrusted button claims; the application re-fetches and reauthorizes the current source page before adding an immutable item to the quarantined B5 review queue.
- After successful staging, a distinct `✅ تدقيق بيانات` button causes a new provider read and matches the original source revision and SHA-256 metadata digest. Only then can the source candidate be marked `REVIEWED_METADATA_ONLY`. Neither step is B3 import approval, local publication, campaign execution, student listing, or Telegram send.
- Persist the source page cursor with an optional validated `pageCursor` field in schema 8 (no destructive data migration); this lets second and later pages be staged and reviewed from their original exact page rather than incorrectly searching the first page.
- Forged, edited, stale, copy-replayed after source mutation, unauthorized student or group buttons and revoked owner-dashboard permissions are denied. Owner buttons remain bounded to Telegram's 256-byte text budget; no platform credentials or actual website network endpoint added.
- Ten new offline JSON/SQLite and owner Telegram integration tests cover both steps, second-page records, page provenance, stale revisions, direct unauthorized requests, source mutation between display/staging/review and no education/publishing side effects.

## 0.7.34 — 2026-10-22 — B5 quarantined external candidate staging and metadata-only review (NOT DEPLOYED)

- **Owner-only staged review queue** for external provider records. `stage(actor,sourceId,expectedPageFingerprint)` reads the *current* source preview again and accepts only a unique external record in the exact page the owner just inspected; no client-provided title, university, year or degree enters storage.
- Each staged candidate holds bounded external metadata, the source revision and a SHA-256 review digest, with initial `UNVERIFIED_EXTERNAL` status. Only `review(actor,sourceId,expectedDigest)` may mark it `REVIEWED_METADATA_ONLY`, and only after a fresh external read confirms the exact same fields. A changed revision/title/metadata, forged page proof or missing candidate fails closed rather than silently overwriting old reviews.
- Review is **not publication**: this queue is separate from `importRuns`, `educationResources`, campaigns and deliveries. It cannot grant student visibility, trigger B3 approval, or write/send Telegram content.
- Queue is additive and optional on schema-8 JSON/SQLite data, bounded to 200 unique records, strictly decoded including review status/actor/time consistency. JSON writes now validate state before disk commit like SQLite, preventing malformed persistent review queue entries.
- Tests include JSON and SQLite persistence, mock source mutation, forged proofs, simultaneous stage idempotency, owner dashboard revocation during a pending provider read, no provider call for nonowners and missing authorization, malformed state rejection. No actual production API, Telegram send or AI enabled.

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
