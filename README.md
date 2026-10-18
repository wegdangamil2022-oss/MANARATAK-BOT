# بوت منارتك — MANARATAK BOT

**B0/B1 + B2-Core + B3 core (v0.3.0). Simulation only, no live Telegram bot.**

An independent TypeScript/Node.js 22 project based on `docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md` and `docs/START_HERE_MANARATAK_BOT_v1.2.1_AR.md`. B0/B1 supply the secure baseline; B2-Core adds individual moderation and subscription policies; B3 adds the first locally tested education content flow.

## Commands

```sh
npm install
npm run check         # typecheck + all node:test cases (41 as of v0.3)
npm run demo          # previous B1 simulation
npm run demo:education # example document -> count -> manual approve -> visible resource
```

Node 22+, TypeScript; tests use synthetic identities and temporary JSON state only. No Telegram token, live webhook, AI provider, real file uploads, publishing to Telegram, or production platform database access.

## B3 features built and tested

- Owner-managed, nested, ordered, enabled/disabled category tree with strictly scoped `private` or specifically approved group navigation. A disabled parent hides children.
- A deterministic importer for MD/TXT/CSV/JSON. Limits UTF-8 input to 256 KiB / 1,000 records. Rejects mislabeled files, invalid CSV/JSON and nested JSON data. Structured headings or key-value fields only; **this does not analyze arbitrary prose or scanned documents**.
- Import report distinguishes sections, unique universities, *candidate* scholarship opportunities, potential duplicates, ambiguous records and **only explicitly stated** seats. Counts are not official verification. Unstructured records remain `NEEDS_REVIEW`.
- Content hash deduplicates identical imports within the same approved scope, across renamed files and process restart. It does **not** deduplicate all similar scholarships across independent files or years.
- Upload permission (`content.upload`) does not confer content approval/publication (`content.publish`). Candidate review and local resource publication are two explicit actions; duplicates and ambiguous rows cannot auto-publish. Local resource metadata and audit are persisted without full raw document bodies.
- Navigation returns `PUBLISHED` resources only from permitted scope + enabled category. Revoking chat permission, disabling a category, or archiving a resource prevents further browsing. The internal JSON store is for local simulation, **not production or multi-process concurrency**.

Run `npm run demo:education` for a self-contained example. The upload `origin` values (`TELEGRAM_ADMIN` / `ADMIN_WEB`) are labels in tests, **not operational adapters**. No students receive messages in this phase. Display layers that may later render imported content MUST treat imported strings as untrusted and escape them.

## Project structure

- `src/store.ts`, `src/policy.ts`, `src/pipeline.ts`, `src/callback.ts`, `src/outbound.ts`, `src/wizard.ts` — B1 core.
- `src/moderation.ts`, `src/subscription.ts` — B2-Core simulations.
- `src/ingestion.ts` — deterministic text-file extraction / counts.
- `src/education.ts` — category hierarchy, permissions, approval, local resource catalog.
- `src/education-demo.ts` — safe B3 walkthrough with synthetic CSV.
- `tests/*.test.ts` — 41 tests covering B1/B2/B3 including security, revocation, restart and concurrency.
- `docs/DECISIONS.md`, `docs/TRACEABILITY.md`, `CHANGELOG.md` — stage boundaries, evidence, decisions.

## Boundaries and next slices

**TESTED_MOCK only.** No live Telegram rights or upload/download, HTML/Markdown sanitizing renderer, production transactional DB or backups, verified official scholarship source, user-facing resource UI, real FAQ/question matching, real file retention erasure, real content moderation, PDF/XLSX/DOCX/OCR or AI provider. Those require separate tested work; B3 currently covers its first acceptance slice, **not every B3 enhancement or any of 703 requirements**.

Further B3 work may add trusted FAQ/resource-link slices and genuine admin Telegram and web adapters, but none is enabled automatically. B4 publishing and campaigns, B2-Advanced moderation, B5 platform APIs, and B6 AI remain PLANNED. Do not run live services or merge PR chains without distinct review and authorization.
