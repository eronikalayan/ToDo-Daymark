# Implementation Stage 4 — BE-001: a deleted creator must not destroy the recipient's task

**Date:** 2026-11-13
**Scope:** REF-010 (and the supporting adjustments it forces).
**Predecessors:** [Stage 1](./IMPLEMENTATION_STAGE_01.md) · [Stage 2](./IMPLEMENTATION_STAGE_02.md) · [Stage 3](./IMPLEMENTATION_STAGE_03.md)

**BE-001 is fixed.** `tasks.created_by_id` is now nullable with `ON DELETE SET NULL`, so a user deleting their own account no longer destroys tasks belonging to the people they sent tasks to.

**Zero application-code changes were required** — all 25 files under `backend/src/` are byte-identical. No existing migration was edited. Git was not initialised, no commit was made, nothing was pushed.

---

## 1. The defect and the shape of the fix

`tasks` carries two foreign keys to `users`, and they mean different things:

| Column | Meaning | Correct deletion rule |
| --- | --- | --- |
| `user_id` | **Ownership** — whose task this is | `CASCADE` — a user's own tasks go with them |
| `created_by_id` | **Provenance** — who *sent* it | `SET NULL` — forget the sender, keep the task |

Both were `CASCADE`. So when A assigned a task to B and A later deleted their account, B's task was deleted too — silently, irreversibly, and with no notification to B.

**The fix is the asymmetry**, and the asymmetry is now asserted from both directions, because the most likely way to reintroduce this defect is a future rebuild migration that copies both rules from the same template.

### Why `SET NULL` and not something else

| Option | Rejected because |
| --- | --- |
| `RESTRICT` | Blocks a user from deleting their own account whenever anyone still holds a task they sent. Unacceptable: account deletion is a user's right, and the blocker would be invisible to them. |
| Reassign `created_by_id` to the owner | Falsifies history — the task would claim the recipient sent it to themselves. |
| Soft-delete users (tombstone rows) | A far larger change touching authentication, uniqueness of `email`, and every user query. Not justified by this defect. |
| **`SET NULL`** | **Chosen.** Preserves the data that was being destroyed, and states the truth: the sender is gone. It also matches the rule already used for `chat_messages.task_id`, so the schema becomes internally consistent rather than gaining a new idea. |

---

## 2. Investigation before changing anything

Every reference to the column was enumerated first. The decisive finding:

> **Application code writes `created_by_id` in exactly one place (`task.service.js:56`) and never reads it.**

Authorization never consults it either — every task query is scoped by `{ id, userId }`. That is why this is a schema fix with no service, controller, route or middleware change, and why making the column nullable opens no authorization hole.

| Consumer | Reads `createdById`? | Impact |
| --- | --- | --- |
| `task.service.js` | writes only, on create | none |
| controllers / routes / middleware | no | none |
| Authorization predicates | no | none — ownership is `user_id` |
| Zod schemas | rejects it as input (`.strict()`) | none; a client still cannot set it |
| Frontend `app.js:314` | yes, for a display label | degrades correctly — see §6 |

---

## 3. Changes made

### Schema and migration

**`backend/prisma/schema.prisma`**

```prisma
// Provenance, not ownership: who SENT this task. Ownership is `userId`.
// Nullable with onDelete: SetNull so that a creator deleting their own account
// forgets the sender but never removes a task belonging to its recipient (BE-001).
createdById String?   @map("created_by_id")
createdBy   User?     @relation("TaskCreator", fields: [createdById], references: [id], onDelete: SetNull)
```

**`backend/prisma/migrations/20261113070000_fix_task_creator_cascade/migration.sql`** (new)

Promoted from the Stage-3 candidate. The executable statements are **byte-identical** to what was rehearsed — verified by stripping comments from both files and diffing (66 lines, md5 `8b095f9d11b702a76c2d887deacf9944`). Only the header comment differs.

It carries three protections, each of which exists because of something measured in Stage 3:

1. **`BEGIN … COMMIT`** — Prisma does not wrap migrations in a transaction, so without this a mid-migration failure leaves partial state behind.
2. **Guard B: capture and restore `chat_messages.task_id`** — `DROP TABLE` performs an implicit delete that *fires* the child `ON DELETE SET NULL` and blanks every task link (measured: 3 → 0). `PRAGMA defer_foreign_keys` defers violations, not actions; `PRAGMA foreign_keys=OFF` would work but is a no-op inside a transaction, so it is incompatible with protection 1.
3. **Explicit restatement of all 8 indexes and both triggers** — a rebuild drops them, Prisma cannot see the triggers, and `migrate diff` still reports "no drift" after they vanish.

### Keeping the constraint documentation in step

| File | Change |
| --- | --- |
| `backend/prisma/sql/constraints.sql` | Section B3 now documents the delivered state, explains *why* the two rules differ, and warns against "tidying" them back into agreement. |
| `backend/scripts/lib/constraints.js` | The authoritative foreign-key table now records `SET NULL`. `test/migrations.test.js` asserts every entry against the live schema, so the documentation and the database cannot drift apart. |

### Tests

| File | Change |
| --- | --- |
| `backend/test/task-creator-lifecycle.test.js` | **New.** The Stage-2 regression tests, promoted from `known-defects/` now that they pass, plus coverage added below. |
| `backend/test/known-defects/be-001-cross-user-task-deletion.test.js` | **Removed** — its assertions live in the file above. |
| `backend/test/migrations.test.js` | The assertion that deliberately pinned the *defect* now pins the *fix*, asserts nullability, and adds a behavioural check on its own disposable database. |
| `backend/scripts/test.js` | BE-001 moved from the defect suite to the stable suite; banner text updated to BE-002…BE-004. |

### Tooling

`backend/scripts/rehearse-migration.js`:

- **`--against <db>`** added, so a candidate can be rehearsed on a disposable **copy of a real database** rather than only synthetic seed data. This implements Stage 3's own recommendation and was used before applying the migration.
- **Pass/fail/not-applicable** distinction added. A check that the dataset cannot exercise is now reported `[ N/A]` with a prominent note, instead of counting as a failure. A check that *couldn't run* is not a check that *failed*, and conflating the two would make a safe migration look unsafe.
- **The default candidate was removed.** It pointed at `prisma/sql/proposed/`, which has been deleted now that the file is a real migration. Rehearsing an already-applied migration would be a no-op reporting success, so a candidate must be passed explicitly.

`backend/prisma/sql/proposed/` was removed: the migration is now the single source of truth, and a duplicate copy could drift.

---

## 4. Engineering decisions

### REF-015 (`createdBy: { id, name } | null`) was deliberately **not** implemented

The roadmap lists REF-015 alongside REF-010. It is deferred, with reasons:

- It is **not required for correctness**. BE-001 is a data-integrity defect; exposing a nested creator object is a presentation improvement.
- It would add a **join to every task query** across five endpoints, to serve a label the client already renders correctly without it.
- The bundled frontend resolves creator names from its own friends list and falls back gracefully (§6). A nested object would change five response shapes for no behaviour the client needs today.
- Its stated rationale — "never a dangling id" — is satisfied by this migration anyway: the id is now properly nulled rather than left pointing at a deleted row.

Recommendation: schedule REF-015 with the Phase-4 API work (REF-041…REF-048), where response shapes are being revised deliberately and an OpenAPI document exists to describe them.

### `createdById` stays in the response, as `null`

It is not omitted. Omitting a field changes its contract from "nullable string" to "optional" and forces clients to distinguish absent from null. Verified: the task response still has exactly **13 fields**, the same as before.

### The migration was promoted unchanged

Stage 3 cautioned against editing the candidate during promotion, since the artefact that was verified is the artefact that should ship. Only the header comment changed; the diff of executable statements is empty.

### Local `node_modules` damage, worked around rather than papered over

`npm run db:generate` failed silently with `Permission denied`, then `Cannot find module './cli.js'`. Investigation: 10 of 12 `.bin` shims had lost their execute bit, and `.bin/prisma` is a *different package's* shim (it requires `./cli.js`; prisma's bin is `build/index.js`). This is local filesystem damage in the delivered `node_modules`, not a repository defect — the same command works in a clean install on the pinned Node (verified, §7).

Operations here used the module entry point directly. **No repository file was changed to accommodate it**, and the fix for a developer hitting this is `rm -rf node_modules && npm ci`.

---

## 5. Migration safety and how it was applied

```
1. Backed up dev.db                      -> .backups/db/pre-ref010_2026-11-13_18-42-41/
                                            verified: integrity ok, FK ok, 41 rows, 2 task links
2. Rehearsed on seeded data              -> 18/18 conditions PASS (every check exercised)
3. Rehearsed on a RESTORED COPY of the
   real dev.db                           -> all conditions PASS, 1 N/A (see below)
4. Promoted the migration unchanged      -> executable SQL diff empty
5. Updated schema.prisma, regenerated
   the Prisma client                     -> migrate diff: no drift
6. npm run db:deploy on dev.db           -> applied
7. Verified the result                   -> see table below
```

### dev.db, before and after

| | Before | After |
| --- | --- | --- |
| users / tasks / chat messages | 6 / 3 / 4 | **6 / 3 / 4** |
| friendships / sessions | 1 / 20 | **1 / 20** |
| assigned tasks (owner ≠ creator) | 2 | **2** |
| **chat messages linked to tasks** | **2** | **2** |
| triggers / task indexes | 2 / 8 | **2 / 8** |
| CHECK constraints / foreign keys | 1 / 10 | **1 / 10** |
| `created_by_id` `ON DELETE` | CASCADE | **SET NULL** |
| `created_by_id` nullable | no | **yes** |
| `integrity_check` / `foreign_key_check` | ok / 0 | **ok / 0** |
| orphaned task links | 0 | **0** |

**No row, relationship, index, trigger or constraint was lost.** The only count that changed is `_prisma_migrations` (7 → 8).

The real `dev.db` was squarely in the blast radius: it held **2 chat messages referencing tasks** and **2 assigned tasks**. A naive migration would have destroyed those links.

### The one N/A, and why it is not a gap

On real data, the control *"a user's own tasks are still deleted with their account"* reported **N/A**: `dev.db`'s only self-created task belongs to a user who is also an assigning creator, so after deleting that user there was no independent subject left to test. That is a property of the dataset, not of the migration. The same control **passes** on seeded data, which is constructed to contain self-created tasks for three different users, and it is also covered by two tests in the stable suite.

### Rollback

- A **failed** migration rolls back by itself (the explicit transaction).
- A **successful** migration is one-way: once `created_by_id` holds NULLs the column cannot be made `NOT NULL` again. Recovery is a restore, and that path was **verified live after the migration**: restoring `pre-ref010` into a disposable target reproduced the pre-migration schema (`CASCADE`, 7 migrations, 3 tasks, 2 links) exactly.

```sh
# Roll back dev.db to the pre-migration state (two-key confirmation required)
DAYMARK_DB_RESTORE_CONFIRM=/absolute/path/to/backend/prisma/dev.db \
  node scripts/db-restore.js ../.backups/db/pre-ref010_*/pre-ref010.db \
       --to prisma/dev.db --allow-protected --force
```

A post-migration baseline backup was also taken: `.backups/db/post-ref010_*/`.

---

## 6. Independent verification beyond the test suite

Passing tests were treated as necessary but not sufficient.

### Database integrity

- `PRAGMA integrity_check` → `ok`; `PRAGMA foreign_key_check` → 0 violations.
- All 10 foreign keys checked individually against the documented table; **zero orphaned** `chat_messages.task_id` references.
- **Fresh install vs upgraded database** (audit finding BE-023): a brand-new database built from all 8 migrations has a schema fingerprint **identical** to the migrated `dev.db` (`f60328b8154e4342`). Upgraded and fresh installations cannot diverge.
- `prisma migrate diff --exit-code` → 0, both before and after.

### Existing API behaviour, over real HTTP

A live server was driven through the complete scenario:

| Step | Result |
| --- | --- |
| Register sender + recipient, befriend, assign a task | owner = recipient, creator = sender |
| Chat notification links to the task | yes |
| Sender deletes their account | `204` |
| `GET /api/tasks/:id` as recipient | **`200`** (was `404` before the fix) |
| `createdById` | **`null`**, field present not omitted |
| `userId` | unchanged — still the recipient |
| Task still in the recipient's list | yes |
| Still editable / toggleable | `200` / `200` |
| Response field count | **13 — unchanged** |
| `/health`, `/auth/session`, `/tasks` (401), `/auth/me` (401/200), `/friends` (200) | all unchanged |

### Frontend compatibility

The only frontend reference is `app.js:314`. Its **actual expression** was executed against every possible state:

| Task state | Renders |
| --- | --- |
| self-created | `""` |
| assigned by a known friend | `"Sent by Dana"` |
| assigned by someone not in the friends list | `"Sent by a friend"` |
| **assigned, creator deleted (new)** | **`"Sent by a friend"`** |

No throw, and the fallback is semantically correct. **No frontend change is required**, and none was made. `/`, `/app.js` and `/styles.css` all still serve `200`.

### Known defects BE-002…BE-004 still reproduce

24 tests, 12 control passes, **12 expected failures** — unchanged apart from BE-001's removal (previously 29/13/16). The fix did not mask the remaining defects.

---

## 7. Verification results

| # | Check | Result |
| --- | --- | --- |
| 1 | `npm run lint` | **PASS** |
| 2 | `npm test` (stable) | **PASS — 221 tests, 221 pass, 0 fail, 54 suites** (was 207) |
| 3 | `npm run test:defects` | **24 tests, 12 pass, 12 fail** — BE-002…BE-004 still reproduce |
| 4 | Repeated stable runs ×3 | **221/221 every time** |
| 5 | Migration integrity suite | **PASS**, including the new BE-001 assertions |
| 6 | Rehearsal on seeded data | **18/18 conditions** |
| 7 | Rehearsal on a copy of real `dev.db` | **all PASS, 1 N/A** (§5) |
| 8 | Rehearsal rejects a naive migration | **PASS — 5 failures, correctly refused** |
| 9 | `prisma migrate diff --exit-code` | **0 — no drift** |
| 10 | Fresh install vs upgraded schema | **identical fingerprint** |
| 11 | `integrity_check` / `foreign_key_check` on `dev.db` | **ok / 0 violations** |
| 12 | Live HTTP end-to-end | **PASS — all 18 assertions** |
| 13 | Frontend expression with `null` | **PASS — graceful on all 4 states** |
| 14 | Backup → restore → verify, post-migration | **PASS** |
| 15 | Rollback to pre-migration state | **PASS — verified on a disposable copy** |
| 16 | Pinned Node 20.20.2: lint, stable, defects | **PASS — 221/221, 12/12, lint clean** |

### Unexpected failures, investigated

| Observation | Resolution |
| --- | --- |
| `npm test` showed 1 failure after the fix | A bug in a test **I** wrote: `userId: { equals: undefined }` is a no-op filter in Prisma, so the query counted every row. Rewritten to assert the real invariant (no task may exist without an owner). |
| API tests failed when run with bare `node --test` | Expected: that bypasses the runner's `migrate deploy`, so `test.db` was still on the old schema. Running through `npm test` applies migrations first. Not a product issue; the REF-030 guard already forbids bare execution. |
| `npm run db:generate` silently did nothing | Damaged local `node_modules` — see §4. |

---

## 8. Remaining risks

| Risk | Severity | Note |
| --- | --- | --- |
| **No version control** | **High** | Unchanged since Stage 1 and now the sharpest it has been: this stage altered stored data. Recovery depends entirely on `.backups/`. REF-001 should be approved before any further stage. |
| The migration is one-way once applied | Medium | Inherent. Mitigated by the verified `pre-ref010` backup and a rehearsed restore path. |
| `createdById: null` reaches API clients | Low–medium | The bundled frontend handles it; a third-party client assuming a string would break. There are no known third-party clients. Belongs in release notes, and in the OpenAPI document when REF-048 lands. |
| A future rebuild of `tasks` could reintroduce the defect | Low | This is the likeliest regression path — copying both foreign keys from one template. Guarded by `migrations.test.js` (asserts the asymmetry explicitly), `constraints.js`, `constraints.sql` §B3, and the behavioural tests. |
| Deleting a sender still removes the chat notification | Low | `chat_messages.sender_id` cascades, so the "Sent you a task" message disappears while the task survives. Pre-existing behaviour, unchanged here, and arguably correct — but worth a product decision alongside BE-024 (unfriend retention). |
| `.backups/` is a single local copy | Medium | Not replicated, unencrypted, and now contains real data from two points in time. |
| Local `node_modules` is damaged | Low | Only affects this machine; `npm ci` fixes it. Verified working on the pinned Node in a clean install. |

---

## 9. State after this stage

| Finding | Status |
| --- | --- |
| **BE-001** (CRITICAL) | **Fixed and regression-guarded** |
| BE-002, BE-003, BE-004 (HIGH) | Still open, still reproducible by `npm run test:defects` |
| BE-019, BE-023 | Mitigations from Stage 3 exercised for real by this migration |

The next item in the roadmap's execution sequence is **Stage 5: REF-011 (BE-002, registration resilience) and REF-012 (BE-003, layered rate limiters)**. Both are application-code changes with failing regression tests already in place, and neither touches the database schema.
