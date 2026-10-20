# بوت منارتك — MANARATAK BOT

**B0/B1 + B2-Core + B3 + B3 privacy-safe Telegram reply outbox and opt-in authenticated owner review and deployment preflight and ingress hardening and outbox monitoring and emergency STOP and offline acceptance and restore rehearsal (v0.7.0). Transport implemented but OFF by default — no live deployment verified.**

An independent TypeScript/Node.js 22 project based on `docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md` and `docs/START_HERE_MANARATAK_BOT_v1.2.1_AR.md`. B0/B1 supply the secure baseline; B2-Core adds individual moderation and subscription policies; B3 adds the first locally tested education content flow.








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
