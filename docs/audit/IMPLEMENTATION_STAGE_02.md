# Implementation Stage 2 — Test Infrastructure and Regression Protection

**Date:** 2026-11-13
**Scope:** Stage 2 of [`BACKEND_REFACTORING_PLAN.md`](./BACKEND_REFACTORING_PLAN.md) §17 — **REF-030, REF-006, REF-007, REF-008, REF-009**.
**Predecessor:** [`IMPLEMENTATION_STAGE_01.md`](./IMPLEMENTATION_STAGE_01.md)

**No production behaviour was changed.** No file under `src/`, no migration, no `schema.prisma`, no frontend file and no environment configuration was modified — verified by hash comparison against a pre-change backup (§13). **BE-001 to BE-004 remain unfixed and are now reproduced by automated tests.**

Git was not initialised, no commit was made and nothing was pushed, as instructed.

---

## 1. Starting project state

| Property | State at the start of Stage 2 |
| --- | --- |
| Git repository | **None** (REF-001 still pending approval). All change safety rests on the filesystem backup in §2. |
| Test suite | One file, `test/api.test.js`: a single `test()` containing **78 assertions** executed in one sequential block with shared state. |
| Test runner | `scripts/test.js` — forced `NODE_ENV=test`, redirected `DATABASE_URL` to `prisma/test.db`, ran `prisma migrate deploy`, then the one test file. |
| Baseline result | `npm test` → **tests 1, pass 1, fail 0**. |
| Test database isolation | Correct *when invoked through `npm test`*, but nothing enforced that entry point. |
| Known hazard (BE-027 / REF-030) | `node --test test/api.test.js` run directly resolved to `NODE_ENV=development` and **`DATABASE_URL=file:./prisma/dev.db`**. |
| Fixtures | None. Users were created through `POST /api/auth/register`, which is capped at 5 per hour per IP (BE-017). |
| Unit tests | None. |
| Lint | `npm run lint` passing (Stage 1). |

### Order and state coupling in the original suite

Analysed before splitting. The single test depended on order throughout: `owner`, `otherUser` and `intruder` agents were created once and reused across roughly 90 lines; the task created at line 59 was asserted against at lines 71–86, mutated at 151–159 and deleted at 162; the password reset at 171–185 depended on the account created at line 23. Every one of those couplings is removed in the new suites — each test now arranges its own fixtures.

---

## 2. Backup location and verification

Created **before any file was modified**, as required in the absence of version control.

| Item | Value |
| --- | --- |
| Location | `.backups/stage-02-20261113-215159/` (project root, **outside** `backend/`, so it can never be reached by test discovery) |
| Contents | `backend/src` (25 files), `backend/test`, `backend/scripts`, `backend/prisma` (schema, 7 migrations, both database files), `backend/.env`, `backend/.env.example`, both `package.json`, both `.gitignore`, `.nvmrc`, `eslint.config.js`, `backend/README.md` |
| Hash manifest | `ORIGINAL-HASHES.txt` — **40 MD5 hashes** |
| Readability check | **PASS** — all 40 files re-hashed from the backup and byte-identical to the originals |
| Restorability check | **PASS** — restored into a scratch directory and compared; `test/api.test.js` round-tripped at `5ec6fed193e76b0864398fa654a34966` |
| Excluded from VCS | `.backups/` added to the root `.gitignore` |
| Secrets | `backend/.env` is included in the backup because it is irreplaceable configuration. **Its contents are never printed, listed, logged or reproduced in any document**, including this one. |
| Published / uploaded | **No.** Local filesystem only. |
| Automatic restore | **Never performed.** The backup is for manual recovery only. |

---

## 3. Tasks completed

| Task | Status | Outcome |
| --- | --- | --- |
| **REF-030** — fail-closed test database guard | ✅ Done | `test/helpers/guard.js`, six independent checks, 17 negative/positive tests, plus a contract test that enforces its use mechanically. |
| **REF-006** — independent fixtures | ✅ Done | `test/helpers/factories.js` + `client.js`. Verified: 22 users created with no 429, zero leftovers after cleanup. |
| **REF-007** — split the monolith | ✅ Done | Four suites (`app`, `auth`, `tasks`, `social`), each independently runnable in any order. |
| **REF-008** — unit tests | ✅ Done (with a documented scope deviation, §6.3) | 55 unit tests across utilities and Zod schemas, no database. |
| **REF-009** — reproduce BE-001…BE-004 | ✅ Done | 4 suites, **16 failing assertions reproducing all four defects** and 13 passing control assertions. |

---

## 4. Files created

| File | Purpose |
| --- | --- |
| `backend/test/helpers/guard.js` | REF-030 fail-closed guard. |
| `backend/test/helpers/factories.js` | REF-006 Prisma-level fixtures for all seven entities. |
| `backend/test/helpers/client.js` | Thin supertest wrapper attaching session cookie and `Origin`. |
| `backend/test/guard.test.js` | 17 tests proving the guard refuses unsafe configurations. |
| `backend/test/guard-contract.test.js` | Asserts every test file loads the guard first. |
| `backend/test/app.test.js` | Health, body parsing, error envelope, routing. |
| `backend/test/auth.test.js` | Registration, login, session, logout, reset, verification, deletion. |
| `backend/test/tasks.test.js` | Task CRUD, filtering, ownership isolation, recipient-owned assignment. |
| `backend/test/social.test.js` | Friend requests, messaging, cross-origin write protection. |
| `backend/test/unit/utils.test.js` | `toPublicUser`, `AppError`, `asyncHandler`. |
| `backend/test/unit/schemas.test.js` | All Zod request schemas. |
| `backend/test/known-defects/be-001-cross-user-task-deletion.test.js` | BE-001 regression. |
| `backend/test/known-defects/be-002-registration-email-failure.test.js` | BE-002 regression. |
| `backend/test/known-defects/fixtures/production-registration.js` | Child-process fixture for the production-only BE-002 path. |
| `backend/test/known-defects/be-003-shared-rate-limiter.test.js` | BE-003 regression. |
| `backend/test/known-defects/be-004-unknown-route-401.test.js` | BE-004 regression. |
| `docs/audit/IMPLEMENTATION_STAGE_02.md` | This document. |

---

## 5. Files modified

| File | Change | Why |
| --- | --- | --- |
| `backend/scripts/test.js` | Rewritten: stable / defect / all modes; explicit file lists; `--test-concurrency=1`. | REF-007 and Phase 8 need two independently runnable suites. Serial execution fixes a real flakiness problem (§8). All original safety properties are preserved. |
| `backend/package.json` | Added `test:defects` and `test:all`. | Separate command for the known-defect suite. |
| `package.json` (root) | Added matching proxy scripts. | Consistency with the existing `npm --prefix backend` convention. |
| `backend/README.md` | Rewrote the *Tests* section; updated the project layout; added "never run a test file directly". | Required documentation update. |
| `.github/workflows/ci.yml` | Renamed the test step to "Test (stable suite)"; added a comment explaining why `test:defects` is excluded. | CI must not be gated on known defects. |
| `.gitignore` (root) | Added `.backups/`. | Keep backups out of version control. |

### File removed

`backend/test/api.test.js` — split into the four suites. **Preserved in the backup** at `.backups/stage-02-20261113-215159/backend/test/api.test.js` (`5ec6fed193e76b0864398fa654a34966`). Assertion mapping in §9.

---

## 6. Test architecture

```text
backend/test/
├── helpers/
│   ├── guard.js          ← loaded FIRST by every file; aborts unsafe runs
│   ├── factories.js      ← Prisma-level fixtures
│   └── client.js         ← supertest + cookie + Origin
├── unit/                 ← no database
│   ├── utils.test.js
│   └── schemas.test.js
├── guard.test.js         ← negative tests for the guard
├── guard-contract.test.js← enforces "guard first" across all files
├── app.test.js   auth.test.js   tasks.test.js   social.test.js
└── known-defects/        ← EXPECTED TO FAIL
    ├── be-001…  be-002…  be-003…  be-004….test.js
    └── fixtures/production-registration.js
```

### Two suites, two commands

| Command | Files | Expected | Run by CI |
| --- | --- | --- | --- |
| `npm test` | 8 stable files | **151 pass, 0 fail** | **Yes** |
| `npm run test:defects` | 4 defect files | **13 pass (controls), 16 fail (defects)** | No |
| `npm run test:all` | all 12 | both, reported separately | No |

The defect suite is **not skipped and its assertions are not inverted**: each asserts the behaviour the backend *should* have, and fails because it does not. `npm run test:defects` deliberately exits 0 so expected failures do not look like a broken toolchain — the per-test results are the signal, and the runner prints a banner explaining this.

### 6.1 Control tests inside the defect suites

Each defect suite contains tests labelled `CONTROL` that assert behaviour which is **already correct** and must survive the fix. These pass today. They exist so a future fix cannot over-correct:

| Defect | Control guards against |
| --- | --- |
| BE-001 | A fix that stops deleting a user's **own** tasks along with their account. |
| BE-002 | A fix that starts issuing sessions before verification, or lets unverified accounts log in. |
| BE-003 | A fix that removes brute-force protection from login itself. |
| BE-004 | A fix that makes unknown routes 404 by **weakening authentication** on real routes. |

### 6.2 Why test files run serially

`node --test` defaults to one process per CPU (12 here). Every suite writes to the same SQLite file, and SQLite permits a single writer, so parallel files collided on the interactive transaction in `taskService.toggleTask`. Observed before the fix: **2 of 6 runs failed** with HTTP 500 (`PrismaClientKnownRequestError`) on toggle operations, while every suite passed in isolation.

This is contention in the harness, not a defect in the application — a deployed instance is a single writer. `--test-concurrency=1` resolves it; verified supported on both the pinned Node 20.20.2 and the host's 25.2.1. After the change: **6 of 6 runs green**.

> Incidentally, this was a live demonstration of **BE-011**: the error handler logged only `{ requestId, errorName: 'PrismaClientKnownRequestError' }` with no message, so the cause had to be inferred rather than read.

### 6.3 REF-008 scope deviation

The plan names `parseDate`, `exclusiveDateEnd`, `buildListWhere` and `PRIORITY_ORDER` for unit testing. **None is exported** from `src/services/task.service.js`, and Stage 2 may not modify production code — the brief is explicit: *"Do not rewrite production code to make trivial unit tests possible."*

Unit tests therefore cover what is genuinely exported: `toPublicUser`, `AppError`, `asyncHandler`, and all Zod schemas. The behaviour of the unexported helpers is covered end-to-end in `tasks.test.js` (inclusive single-day due-date ranges, priority ordering, search filtering) and at the schema level in `schemas.test.js` (the full date-validation matrix). Recorded here as a deviation for Stage 3 review; no roadmap edit was made.

---

## 7. Test database isolation strategy

`src/config/env.js` loads `.env` by absolute path, and **dotenv does not override variables already present in `process.env`** (verified). That single fact is what makes the hazard, and the fix, work:

- `npm test` sets `DATABASE_URL` *before* spawning Node → dotenv leaves it alone → isolated database.
- A direct `node --test <file>` sets nothing → dotenv supplies `.env` → **development database**.

`test/helpers/guard.js` runs six checks before anything else loads:

| # | Check | Rejects |
| --- | --- | --- |
| 1 | `NODE_ENV === 'test'` | unset, `development`, `production` without explicit opt-in |
| 2 | working directory is the backend root | a wrong cwd, which silently creates a new empty database (BE-022) |
| 3 | `DATABASE_URL` already present in `process.env` | an unset value that would fall through to `.env` |
| 4 | `file:` scheme | `postgresql://`, `mysql://`, any remote database |
| 5 | **deny-list** of protected paths | `prisma/dev.db` **and whatever `.env` actually points at**, resolved from the file itself |
| 6 | **allow-list** of recognised test databases | anything outside `prisma/{test,defects,guard-probe}.db` |

Checks 5 and 6 are independent: the deny-list is derived from real configuration, not from a filename convention, so requirement 8 ("must not rely exclusively on the filename containing `test`") is satisfied — a database named `test-something.db` outside the allow-list is still refused, and the real development database is refused whatever it is called.

**Failure mode:** the guard writes a framed explanation to stderr and **throws**. A throw during module load makes the test file fail loudly; it can never be mistaken for a pass. No secret is printed — only the resolved database path, which is not sensitive (asserted by a test).

**Import ordering.** CommonJS `require` is synchronous and evaluated in source order, so a guard placed first always runs first. Verified separately that the SQLite file is opened lazily at the *first query*, not at client construction — but the guard deliberately does not depend on that, aborting before the application is imported at all. `guard-contract.test.js` enforces "guard first" across every test file, every helper and the child-process fixture, so the convention cannot decay.

**Production simulation.** BE-002 needs production-only code paths. The guard accepts `NODE_ENV=production` **only** with an explicit `DAYMARK_TEST_SIMULATE_PRODUCTION=1`, and **every database check still applies** — verified by a test asserting that the opt-in does not let a run reach `dev.db`.

---

## 8. Fixture strategy

Fixtures are created through Prisma rather than the HTTP API because `POST /api/auth/register` is capped at **5 requests per hour per IP in every environment** (BE-017), and the limiter runs before validation, so even a rejected request consumes budget.

This does **not** bypass authentication or authorization:

- Sessions are real rows in the `sessions` table, and tokens are real HS256 JWTs signed with the same claims (`subject`, `jwtid`, issuer `daymark-api`, audience `daymark-web`) that `auth.service.js` uses — so the application's own `authenticate` middleware validates them normally. Verified by a test that a factory session is accepted by the real middleware.
- Registration and login are still exercised over HTTP in `auth.test.js`.
- Fixture password hashes use bcrypt cost 4 instead of 12. bcrypt reads the cost from the hash, so the real login endpoint still verifies them correctly — verified by a test. Production hashing is untouched.

| Property | How it is achieved |
| --- | --- |
| Valid data | Schema-conformant defaults for every entity. |
| Controlled overrides | Every factory takes an overrides object. |
| Unique constraints | `RUN_ID` (timestamp + random) plus a monotonic counter; emails use the reserved `.test` TLD. |
| Foreign keys | Relationship factories (`createFriends`, `createTask(ownerId, { createdById })`) take real ids. |
| No global shared state | Each test arranges its own fixtures; files run in separate processes. |
| Cleanup | `cleanup()` deletes the users this process created; every other table cascades. Verified to leave zero rows. |
| Determinism | No reliance on wall-clock ordering or on rows created by other tests. |

Entities covered: users, sessions, tasks, friendships, chat messages, email-verification tokens, password-reset tokens — exactly the seven in `schema.prisma`, with nothing invented.

---

## 9. Existing tests preserved

All **78 assertions** of the original file were reviewed and carried across. Nothing was dropped.

| Original behaviour | Now in |
| --- | --- |
| Health 200 + `database: "ok"` | `app.test.js` |
| Signed-out session → `user: null` | `auth.test.js` |
| Register 201, name, no `passwordHash`, `HttpOnly` cookie | `auth.test.js` |
| Duplicate register → 409 | `auth.test.js` |
| Invalid registration → 422 | `auth.test.js` |
| Unknown-email login → 401 + generic message | `auth.test.js` |
| `/api/auth/me` → correct user | `auth.test.js` |
| Unauthenticated `/api/tasks` → 401 | `tasks.test.js` |
| Create task: raw title, priority, `completed: false` | `tasks.test.js` |
| Filter by completed + priority + search + pagination | `tasks.test.js` |
| Inclusive single-day due-date range, `sortBy=dueDate` | `tasks.test.js` |
| `completed=maybe` → 422 | `tasks.test.js` |
| `dueAfter > dueBefore` → 422 | `tasks.test.js` |
| Invalid calendar date `2026-02-31` → 422 | `tasks.test.js` |
| `sortBy=priority&order=desc` → high first | `tasks.test.js` |
| Friend request → 201; incoming list; accept → 200 `accepted` | `social.test.js` |
| Assignment: `userId` = recipient, `createdById` = sender | `tasks.test.js` |
| Assigned task absent from sender's list, present in recipient's | `tasks.test.js` |
| Sender GET/PATCH/toggle on assigned task → 404 | `tasks.test.js` |
| Recipient toggle → 200 `completed: true` | `tasks.test.js` |
| Sender `completed=true` list excludes it | `tasks.test.js` |
| Assign to non-friend → 404 | `tasks.test.js` |
| Chat message → 201; raw body round-trips | `social.test.js` |
| Chat history `taskId` links to the assignment | `tasks.test.js` |
| Non-friend chat history → 404 | `social.test.js` |
| Untrusted origin → 403 | `social.test.js` (now asserting **both** layers — see below) |
| Cross-user GET/PATCH/toggle/DELETE → 404 `TASK_NOT_FOUND` | `tasks.test.js` |
| Toggle → `completed: true` + `completedAt` set | `tasks.test.js` |
| Edit title + `completed: false` → `completedAt: null` | `tasks.test.js` |
| Delete → 204, then 404 | `tasks.test.js` |
| Logout → 204; `/me` → 401; session null; old cookie → 401 | `auth.test.js` |
| Reset request → 202; identical body for unknown email | `auth.test.js` |
| Reset confirm → 204; sessions revoked; replay → 400; old password → 401; new password → 200 | `auth.test.js` |
| Account deletion → 204; `/me` → 401 | `auth.test.js` |
| Verify email → 200 `verified: true`; replay → 400 | `auth.test.js` |

### One assertion made more precise

The original asserted only `status === 403` for a mutation from `https://attacker.example`. Writing the split test revealed that the rejection comes from **CORS** (`CORS_ORIGIN_DENIED`), not the CSRF guard — `cors()` runs first, so an untrusted `Origin` never reaches the CSRF middleware. The CSRF guard handles the *missing*-`Origin` case.

Both layers are now asserted separately, so a future change to either cannot silently remove the protection. This strengthens coverage rather than reducing it.

---

## 10. New tests added

| Area | Tests | Highlights |
| --- | --- | --- |
| Guard negative cases | 17 | Every rejection path; the opt-in not weakening database checks; a demonstration that an unguarded run really does resolve to `dev.db`; no secrets in output; `dev.db` byte-identical afterwards. |
| Guard contract | 15 | Every test file, helper and fixture loads the guard first. |
| Unit — utilities | 15 | `toPublicUser` as an allowlist; `AppError` as a real `Error` subclass; `asyncHandler` forwarding rejections — including that a **synchronous** throw escapes `.catch(next)`. |
| Unit — schemas | 40 | Full date matrix including leap years; the **72-byte** bcrypt password rule proven with 24 four-byte emoji; mass-assignment and prototype-pollution rejection; query coercion and bounds. |
| App-level | 8 | Malformed JSON → 400; 16 KB limit → 413; error-envelope shape; `X-Request-Id` present. |
| Auth / tasks / social | 56 | The migrated assertions plus ownership, pagination and validation cases. |

New coverage not in the original: wrong-password login genericity, allowlisted `/me` fields, logout without a session, reassignment-through-update rejection, assignment to a *pending* friend, decline flow, self/duplicate/already-friends request rejection, reciprocal auto-accept, unfriending revoking conversation access, message-body bounds, messaging oneself, conversation pagination, and the missing-`Origin` CSRF path.

---

## 11. Known bugs reproduced

`npm run test:defects` → **29 tests, 13 pass (controls), 16 fail (defects)** — identical across repeated runs.

| Finding | Failing assertions | What is demonstrated |
| --- | --- | --- |
| **BE-001** | **4** | After the creator deletes their account: the task row is gone; it disappears from the recipient's list; the recipient gets 404 reading a task they own; `createdById` is not nulled. **Control passes:** a user's own tasks are still deleted with their account. |
| **BE-002** | **3** | Production registration with an unreachable provider returns **500** instead of 202; no verification metadata is returned; `resend-verification` — the only recovery path — fails identically. **4 controls pass:** the row is created unverified, no cookie is issued, login gives 403 `EMAIL_NOT_VERIFIED`, re-registration gives 409 (documenting the trap). |
| **BE-003** | **4** | After 10 failed logins: password-reset request, password-reset confirm, verification resend and an unrelated visitor's registration all return **429**. **2 controls pass:** login itself is still rate limited, and task routes are unaffected. |
| **BE-004** | **6** | `/api/does-not-exist`, `/api/auth/does-not-exist`, `/api/friends/…/extra` and `/api/` all return **401** unauthenticated; the same URL returns a different status depending on whether a session exists. **7 controls pass:** real routes still require authentication, authenticated callers still reach them, non-`/api` unknown routes are already 404, health is still public. |

No production code was changed to make any of these pass.

**Safety of the BE-002 reproduction:** no real email is sent and no real credential is used. `EMAIL_PROVIDER_URL` points at a closed loopback port (`https://127.0.0.1:1/send`) so the failure is a connection refusal; the token is the literal string `placeholder-not-a-real-credential`. The fixture runs in a child process bound to the isolated test database, re-validated by the guard.

---

## 12. Commands executed

```sh
# Baseline, before any change
npm test                                   # tests 1, pass 1, fail 0

# Guard (REF-030)
node --test test/guard.test.js             # with a correct env: 17/17 pass
node --test test/guard.test.js             # with no env: REFUSED before any DB access

# Suites in isolation (REF-007)
node --test test/app.test.js               # 8 pass
node --test test/auth.test.js              # 19 pass
node --test test/tasks.test.js             # 23 pass
node --test test/social.test.js            # 14 pass
node --test test/guard.test.js             # 17 pass
node --test test/guard-contract.test.js    # 15 pass
node --test test/unit/utils.test.js        # 15 pass
node --test test/unit/schemas.test.js      # 40 pass
node --test test/social.test.js test/tasks.test.js test/auth.test.js test/app.test.js   # reverse order

# Full suites
npm test                                   # stable
npm run test:defects                       # known defects
npm run lint

# Integrity
md5 -q backend/prisma/dev.db               # before and after every phase
prisma migrate diff --from-migrations … --exit-code
```

---

## 13. Verification results

| # | Category | Command | Result |
| --- | --- | --- | --- |
| 1 | Lint | `npm run lint` | **PASS** (exit 0, no findings) |
| 2 | Stable integration tests | `npm test` | **PASS — 151 tests, 151 pass, 0 fail, 37 suites** |
| 3 | Unit tests | `node --test test/unit/*.test.js` | **PASS — 55 tests**, with an assertion confirming `@prisma/client` is never loaded |
| 4 | Test database guard | `node --test test/guard.test.js` | **PASS — 17/17** |
| 5 | Negative configuration cases | included in #4 | **PASS** — 10 unsafe configurations refused: no `NODE_ENV`, `development`, `production` without opt-in, missing `DATABASE_URL`, `dev.db` directly, `dev.db` via an indirect path, `postgresql://`, an unrecognised `.db`, a path escaping `prisma/`, and a wrong working directory |
| 6 | Known-defect suite | `npm run test:defects` | **16 expected failures reproduced, 13 controls pass** — all four defects confirmed present |
| 7 | Repeated runs | `npm test` ×6 | **6/6 identical (151/151)** after the serial-execution fix; 2/6 failed before it |
| 8 | Suite independence | each file alone, and in reverse order | **PASS** — no order dependency |
| 9 | `dev.db` unmodified | MD5 before/after every phase | **PASS** — `3078946726247cf8f7d037dede4d6073` throughout |
| 10 | Production configuration unmodified | mtime check on `backend/.env`, `.env.example` | **PASS** — unchanged (Nov 13 18:41 / 18:42) |
| 11 | Application logic unmodified | 25 `src/` files vs backup hashes | **PASS — all byte-identical** |
| 12 | Prisma schema unmodified | hash of `schema.prisma`, `prisma.config.ts` | **PASS — byte-identical** |
| 13 | Migrations unmodified | hashes of all 7 migration files | **PASS — byte-identical** |
| 14 | Frontend unmodified | mtime of `app.js`, `index.html`, `styles.css`, `favicon.svg` | **PASS** — all predate Stage 2 |
| 15 | No stray databases | filesystem sweep | **PASS** — only `prisma/dev.db` and `prisma/test.db` exist |
| 16 | CI configuration valid | `js-yaml` parse | **PASS** |

### Unexpected failure investigated and resolved

Verification #7 initially showed intermittent failures (2 of 6 runs) while every suite passed alone. Rather than accept it, the cause was traced to SQLite write contention under parallel file execution (§6.2) and fixed with `--test-concurrency=1`. Re-verified at 6/6.

---

## 14. Remaining limitations

1. **REF-008 scope deviation** (§6.3) — four named functions are not unit-testable without exporting them from production code. Behaviour is covered indirectly. Needs a Stage 3 decision: export them during REF-010-era work, or formally accept the indirect coverage.
2. **The defect suite is a snapshot of current behaviour.** When REF-010…REF-014 land, those 16 assertions should flip to passing and the files should migrate into the stable suite. They are not yet wired into any automation that enforces that transition.
3. **Serial execution** costs wall-clock time. At the current size (~10 s) this is irrelevant; if the suite grows substantially, per-file databases would restore parallelism.
4. **The production-simulation path is an opt-in in the guard.** It is narrow — every database check still applies — but it is an exception, and any future use of `DAYMARK_TEST_SIMULATE_PRODUCTION` should be reviewed.
5. **No coverage reporting.** Not in Stage 2's scope; plan §9.3 defines targets for later.
6. **Not run on the pinned Node.** All Stage 2 verification ran on the host's Node 25.2.1. Stage 1 verified `npm ci && npm test` on the pinned 20.20.2; the new suites have not been re-verified there. CI will be the first to do so — and CI cannot run until REF-001 is approved.
7. **BE-017 is worked around, not fixed.** Fixtures avoid the registration limiter; the limiter itself is still 5/hour in development (REF-057).

---

## 15. Risks and blockers

| Risk | Severity | Note |
| --- | --- | --- |
| **No version control** | **High** | Unchanged from Stage 1 and still the largest process risk. Stage 2 deleted `test/api.test.js`; recovery depends entirely on the §2 backup. Stage 3 modifies the database schema, where this matters far more. |
| CI has never actually run | Medium | Every command is verified individually, but the pipeline has not executed as a pipeline. Blocked on REF-001. |
| Stage 2 not verified on Node 20.20.2 | Low–medium | See limitation 6. |
| Backup is a single local copy | Medium | One directory on one machine, not replicated. It is the only recovery mechanism until REF-001. |
| Defect-suite drift | Low | If a fix lands without moving these tests, the suite silently becomes a passing suite nobody reads. Stage 3 should move BE-001's file into the stable suite as part of REF-010. |

**No new blockers were discovered.** The SQLite contention problem was found and fixed within this stage.

---

## 16. Readiness for Stage 3

**Stage 3 (REF-025, REF-028, REF-029 — migration prerequisites) can begin, subject to the REF-001 decision.**

Stage 2 delivered what Stage 3 depends on:

| Stage 3 needs | Provided by Stage 2 |
| --- | --- |
| A regression test that fails before REF-010 and passes after | `be-001-cross-user-task-deletion.test.js` — 4 failing assertions plus a control |
| Confidence that migration work cannot damage a developer's database | REF-030 guard; `dev.db` verified byte-identical throughout |
| A repeatable green baseline to diff against | 151/151, stable across 6 consecutive runs |
| Fixtures for migration data-integrity assertions | `factories.js`, including `chat_messages.task_id` links via `createMessage(..., { taskId })` |

### Recommended Stage 3 sequence

1. **REF-029 first** — rehearse backup/restore on a **copy**. Plan §5.1 rule 5 records that migrations are not transactional on this stack, so restore is the only rollback for REF-010.
2. **REF-025** — extract the two priority triggers and the `friendships.status` CHECK into `prisma/sql/constraints.sql`.
3. **REF-028** — the migration test, asserting all seven post-migration conditions from plan §5.2/S1, including the `chat_messages.task_id` link count that the first-draft migration was proven to destroy.

### Explicit cautions for Stage 3

- Use **only** the verified migration SQL in plan §5.2/S1, with Guard B (capture/restore of `chat_messages.task_id`) and both triggers restated as explicit SQL.
- Never use `npm run db:migrate` (`prisma migrate dev`) — it may reset the database on drift. Use `db:deploy`.
- Take a fresh backup before REF-010, as Stage 2 did here.
- When REF-010 lands, move `be-001-cross-user-task-deletion.test.js` from `known-defects/` into the stable suite and update `scripts/test.js`.

**Do not begin Stage 4 (the BE-001 migration itself) until REF-029's restore rehearsal has actually been performed.**
