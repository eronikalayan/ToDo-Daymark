# Implementation Stage 3 — Safe Database Migration Infrastructure

**Date:** 2026-11-13
**Scope:** Stage 3 of [`BACKEND_REFACTORING_PLAN.md`](./BACKEND_REFACTORING_PLAN.md) §17 — **REF-029, REF-025, REF-028**.
**Predecessors:** [`IMPLEMENTATION_STAGE_01.md`](./IMPLEMENTATION_STAGE_01.md) · [`IMPLEMENTATION_STAGE_02.md`](./IMPLEMENTATION_STAGE_02.md)

**No application behaviour, schema or migration was changed.** All 25 files under `backend/src/`, all 7 migrations and `schema.prisma` are byte-identical to the pre-stage backup. **BE-001 is not fixed**; its migration exists only as a rehearsable candidate outside the migration history.

Git was not initialised, no commit was made, nothing was pushed or deployed.

---

## 1. Work completed

| Task | Status | Outcome |
| --- | --- | --- |
| **REF-029** — backup and restore | ✅ | Online-Backup-API snapshots with integrity verification; restore refuses protected and existing targets behind a two-key confirmation. Proven to capture WAL-resident rows a file copy loses. |
| **REF-025** — custom constraint preservation | ✅ | `prisma/sql/constraints.sql`, split into a genuinely executable Section A and a reference-only Section B, after establishing by measurement which objects can and cannot be re-applied. |
| **REF-028** — migration integrity verification | ✅ | 54 automated assertions plus a rehearsal runner that applies the candidate BE-001 migration to disposable copies and checks 18 conditions. Proven to **detect** a naive migration. |

**Stable suite grew from 151 to 207 tests, all passing.** The four known defects remain reproducible (13 control passes, 16 expected failures), unchanged.

---

## 2. Files created and changed

### Created

| File | Purpose |
| --- | --- |
| `backend/scripts/lib/db-safety.js` | Protected-path detection, schema/relationship/integrity inspection read from `sqlite_master` rather than Prisma. |
| `backend/scripts/lib/disposable-db.js` | Builds throwaway databases from the real migration history and seeds representative data. |
| `backend/scripts/lib/constraints.js` | Loader for `constraints.sql`; executes Section A only, exposes Section B as data for assertions. |
| `backend/scripts/db-backup.js` | REF-029 backup. |
| `backend/scripts/db-restore.js` | REF-029 restore, refusing by default. |
| `backend/scripts/rehearse-migration.js` | REF-028 rehearsal runner. |
| `backend/prisma/sql/constraints.sql` | REF-025 single source of truth for objects Prisma cannot see. |
| `backend/prisma/sql/proposed/be-001-fix-task-creator-cascade.sql` | Candidate BE-001 migration — **deliberately not in `prisma/migrations/`**. |
| `backend/test/migrations.test.js` | 30 migration-integrity assertions. |
| `backend/test/backup-restore.test.js` | 24 backup/restore and safety assertions. |
| `docs/audit/IMPLEMENTATION_STAGE_03.md` | This document. |

### Changed

| File | Change |
| --- | --- |
| `backend/scripts/test.js` | Added the two new suites to the stable list. |
| `backend/package.json`, `package.json` | Added `db:backup`, `db:restore`, `db:rehearse`. |
| `docs/audit/BACKEND_REFACTORING_PLAN.md` | **Factual correction** to §5.1 rule 5 and §5.2/S1 — see §9. |
| `docs/audit/BACKEND_CODE_REVIEW.md` | Matching correction to verification record V20. |

### Deliberately unchanged

`backend/src/**` (25 files) · `prisma/schema.prisma` · all 7 files in `prisma/migrations/` · `prisma.config.ts` · frontend · `.env` · `prisma/dev.db`.

---

## 3. Backup strategy

**Mechanism: SQLite's Online Backup API** (`better-sqlite3`'s `db.backup()`), not a file copy.

A copy of a live `.db` is not a backup: pages may sit in a `-wal` file that the main file does not contain, and a copy taken mid-transaction can be torn. This was demonstrated rather than asserted — see §5.

```sh
# Default target is DATABASE_URL, falling back to prisma/dev.db
npm run db:backup

# Explicit source, destination and label
node scripts/db-backup.js prisma/dev.db --out ../.backups/db --label pre-ref010
```

Properties:

- the source is opened **read-only**, so a backup can never alter it;
- output goes to `.backups/db/<label>_<timestamp>/`, **outside `backend/prisma/`**, so it can never be mistaken for a live database or picked up by the app;
- `.backups/` is in `.gitignore` (added in Stage 2) and sits outside `backend/`, so it reaches neither Git nor a deployment;
- a `manifest.json` records structure, counts and relationships — **never row data** (asserted by a test that greps the manifest for hashes, e-mail addresses and message bodies);
- any verification failure exits non-zero.

## 4. Restore strategy

Restore is the most destructive command in the repository, so it refuses by default.

```sh
# Normal case: a target that does not yet exist
node scripts/db-restore.js <backup.db> --to prisma/restored.db

# Replacing an existing, non-protected file
node scripts/db-restore.js <backup.db> --to <target.db> --force

# Restoring over the development database — two independent keys required
DAYMARK_DB_RESTORE_CONFIRM=/absolute/path/to/backend/prisma/dev.db \
  node scripts/db-restore.js <backup.db> --to prisma/dev.db --allow-protected --force
```

| Guard | Behaviour |
| --- | --- |
| Target already exists | refused unless `--force` |
| Target is protected (`dev.db`, or whatever `.env` points at) | refused unless `--allow-protected` **and** `DAYMARK_DB_RESTORE_CONFIRM` equals the exact absolute target path |
| Backup fails `integrity_check` or `foreign_key_check` | refused **before** the target is touched |
| An existing target is replaced | copied aside to `<target>.replaced-<timestamp>` first, so a mistaken restore is itself recoverable |
| Stale `-wal` / `-shm` / `-journal` sidecars | removed after restore, so nothing is replayed over the new file |

The protected deny-list is built from the **actual `DATABASE_URL` in `.env`**, not from a filename convention, so it protects the real database whatever it is called.

## 5. Backup integrity verification

Verified on disposable databases seeded with users, tasks, friendships, chat messages, **assigned tasks and chat messages referencing those tasks**.

| Check | Result |
| --- | --- |
| `PRAGMA integrity_check` on the backup | `ok` |
| `PRAGMA foreign_key_check` on the backup | 0 violations |
| Schema fingerprint source vs backup | identical |
| Row counts, all 8 tables | identical |
| Relationship counts (task links, assigned tasks, orphans) | identical |
| Restore → re-verify | structure, counts and relationships all match |

**The WAL demonstration.** With a live writer connected and a 20 632-byte `-wal` file present:

| | chat messages seen |
| --- | --- |
| live connection | 7 |
| naive `cp` of the main file | **6 — one row lost** |
| `db-backup.js` (Online Backup API) | **8 of 8** in the later run, matching the writer exactly |

This is why the tooling never copies files.

---

## 6. Constraint preservation strategy (REF-025)

The brief's caution was correct and the design is built on measurement, not assumption. Established on the SQLite this project actually bundles (**3.53.2**, via better-sqlite3 12.x):

| Operation | Result |
| --- | --- |
| `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` | ✅ fully idempotent (verified across 4 applications) |
| `DROP INDEX IF EXISTS` + `CREATE INDEX` | ✅ fully idempotent |
| `ALTER TABLE … ADD CONSTRAINT … CHECK` | ⚠️ **accepted by SQLite 3.53.2**, but: fails with `constraint failed` if any existing row violates it; fails with `constraint c already exists` on re-run (not idempotent); requires a *name*, whereas the project's CHECK is an unnamed column-level constraint, so an ALTER would add a **second** constraint rather than restore the original |
| `ALTER TABLE … ADD FOREIGN KEY` | ❌ plain syntax error; a foreign key can only arrive with a brand-new column |

**Therefore `constraints.sql` has two sections, and only one of them is executable.**

### Section A — re-appliable (executed)

2 triggers + 18 indexes, each as `DROP … IF EXISTS` followed by `CREATE`. 40 statements, applied by `constraints.js → applyReappliableObjects(db)`. Verified: dropping objects and re-applying restores exactly 2 triggers and 8 task indexes, and the restored triggers genuinely enforce.

### Section B — table-embedded (reference only, never executed)

The `friendships.status` CHECK, all 10 foreign keys with their delete rules, NOT NULL and DEFAULT clauses, and the PK choices for the token tables. These must be **copied into the `CREATE TABLE` of any rebuild migration**. The loader stops at an explicit `=== SECTION B BEGINS ===` marker, so the boundary is enforced by code rather than convention — asserted by a test.

### How each object class survives a future migration

| Object | Preserved by |
| --- | --- |
| Triggers | Section A, restated in the rebuild migration; existence **and behaviour** asserted by REF-028 |
| Indexes | Section A, restated in the rebuild migration; count asserted |
| CHECK constraints | Section B, copied into the new `CREATE TABLE`; presence and enforcement asserted |
| Foreign keys + delete rules | Section B; every one of the 10 asserted individually against `constraints.js` |
| Child rows referencing a rebuilt table | Capture-and-restore ("Guard B") in the migration itself; link count asserted |

---

## 7. Migration testing architecture

```
test/migrations.test.js        30 assertions, disposable DB from the real migration history
test/backup-restore.test.js    24 assertions, disposable DBs + the real scripts
scripts/rehearse-migration.js  applies a CANDIDATE migration to a disposable copy
scripts/lib/disposable-db.js   builds + seeds throwaway databases
scripts/lib/db-safety.js       inspection and protected-path refusal
scripts/lib/constraints.js     Section A executor / Section B data
```

`test/migrations.test.js` covers: expected tables; all 7 migrations applied and none rolled back; each of the 10 foreign keys and its delete rule; every index promised by `constraints.sql`; the CHECK constraint's existence **and** enforcement; both triggers' existence **and** enforcement; `integrity_check`; `foreign_key_check`; seeded records intact; task↔chat relationships intact with zero orphans; Prisma drift; Section A idempotency; and Section B exclusion from execution.

Two negative controls keep the suite honest:

- **Drift detection is not vacuous** — an added model makes `migrate diff` exit 2.
- **Drift cannot see triggers** — dropping both triggers still yields exit 0, which is BE-019 expressed as an executable fact and the whole justification for `constraints.sql`.

---

## 8. BE-001 migration rehearsal

```sh
npm run db:rehearse        # or: node scripts/rehearse-migration.js [candidate.sql]
```

Run against a disposable copy only. Seed: 3 users, 7 tasks (3 assigned across users), 5 chat messages (**3 referencing assigned tasks**), 1 friendship, 3 sessions, 2 tokens.

### Result: all 18 conditions passed

| # | Condition | Result |
| --- | --- | --- |
| 1 | `PRAGMA foreign_key_check` returns no rows | PASS — 0 violations |
| 2 | `tasks` row count unchanged | PASS — 7 → 7 |
| 3 | `chat_messages` task links unchanged | PASS — **3 → 3** |
| 4 | Both priority triggers present | PASS |
| 5 | All 8 task indexes present | PASS — 8/8 |
| 6 | `tasks.created_by_id` is `ON DELETE SET NULL` | PASS |
| 7 | `prisma migrate diff` reports no drift | PASS — exit 0 |
| 8 | `PRAGMA integrity_check` passes | PASS — `ok` |
| 9 | `tasks.created_by_id` is nullable | PASS |
| 10 | No orphaned chat→task references | PASS — 0 |
| 11 | Every other table kept its row count | PASS |
| 12 | The `friendships` CHECK survived | PASS |
| 13 | Priority triggers still **enforce** | PASS — `invalid task priority` |
| 14 | Assigned tasks still belong to their owners | PASS — 3 → 3 |
| B1 | Recipient's task survives the creator's deletion | PASS |
| B2 | The task still belongs to its owner | PASS |
| B3 | `created_by_id` becomes NULL instead of taking the task | PASS |
| B4 | **CONTROL** — a user's own tasks are still deleted with their account | PASS |

Conditions 8–14 and B1–B4 are **additional** to the seven in the roadmap. They were added because existence checks alone cannot distinguish a trigger that exists from one that works (13), cannot catch an over-correction that orphans tasks (B4), and cannot confirm the migration delivers its purpose (B1–B3).

### The rehearsal provably detects a bad migration

A deliberately naive candidate — the obvious implementation, without the capture/restore guard and without restating triggers — was rejected with **5 failures**: lost chat links (3 → 0), both triggers missing, only 1 of 8 indexes, drift detected, and triggers no longer enforcing. A check that can never fail proves nothing; this one fails when it should.

### Also measured: the real `dev.db` is in the blast radius

`prisma/dev.db` currently holds **2 chat messages referencing tasks** and **2 assigned tasks**. A naive migration would silently destroy those links in a developer's own database.

---

## 9. Atomicity findings — a correction to the roadmap

**Finding: migrations are not atomic by default, but an explicit transaction makes them atomic.**

Measured with a migration containing a genuine runtime failure (a duplicate primary key after a successful `CREATE TABLE` + `INSERT`), run through real `prisma migrate deploy`:

| Migration body | Outcome |
| --- | --- |
| No explicit transaction (Prisma's default) | exit 1, **partial state left behind** — the probe table survived |
| Wrapped in `BEGIN; … COMMIT;` | exit 1, **rolled back completely** — no trace of the probe table |

The candidate BE-001 migration is therefore wrapped in `BEGIN … COMMIT`, and roadmap §5.1 rule 5 plus §5.2/S1 have been corrected.

Two consequences:

1. `PRAGMA foreign_keys=OFF` cannot be used inside such a migration — it is a no-op within a transaction. Child-row protection must use capture-and-restore, which is what the candidate does and which works either way.
2. Atomicity protects against a **failed** migration only. Once a rebuild **succeeds** and `created_by_id` contains NULLs, the column can never be made `NOT NULL` again. Undoing a successful migration still requires the REF-029 backup, so REF-029 remains a hard prerequisite for Stage 4.

### Why revision 2 was wrong

Revision 2 stated flatly that migrations are not transactional. That was measured with a harness whose temporary workspace lacked `node_modules`, so `prisma.config.ts` could not resolve `prisma/config` and **the migration never executed** — the "clean rollback" was simply nothing happening. The harness now aborts with `HARNESS BROKEN: migration never executed` if that signature appears, and `rehearse-migration.js` carries the same guard. Re-measuring with the fixed harness reconfirmed every *other* finding: the naive rebuild still destroys chat links (3 → 0) and still drops both triggers.

---

## 10. Exact verification commands

```sh
# Lint and both test suites
npm run lint
npm test                 # stable
npm run test:defects     # known defects, expected to fail

# Migration integrity and backup/restore suites alone
node --test --test-concurrency=1 test/migrations.test.js test/backup-restore.test.js

# Rehearse the candidate BE-001 migration on a disposable copy
npm run db:rehearse
node scripts/rehearse-migration.js /path/to/other-candidate.sql

# Backup and restore
npm run db:backup
node scripts/db-backup.js prisma/dev.db --out ../.backups/db --label pre-ref010
node scripts/db-restore.js <backup.db> --to <new-target.db>

# Prisma drift against the real schema and history
DATABASE_URL='file:./prisma/test.db' node node_modules/prisma/build/index.js migrate diff \
  --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code

# Pinned Node (in an isolated copy, so the host's native binding is not rebuilt)
nvm use && npm ci && npm run db:generate && npm test
```

---

## 11. Test results

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Lint | `npm run lint` | **PASS** (exit 0) |
| 2 | Stable suite | `npm test` | **PASS — 207 tests, 207 pass, 0 fail, 51 suites** (was 151) |
| 3 | Known-defect suite | `npm run test:defects` | **13 pass (controls), 16 fail** — all four defects still reproducible, unchanged |
| 4 | Migration integrity | `node --test test/migrations.test.js` | **PASS — 30 assertions** |
| 5 | Backup / restore | `node --test test/backup-restore.test.js` | **PASS — 24 assertions** |
| 6 | BE-001 rehearsal | `npm run db:rehearse` | **PASS — 18/18 conditions** |
| 7 | Rehearsal rejects a naive migration | `node scripts/rehearse-migration.js <naive>` | **PASS — 5 failures, correctly refused** |
| 8 | SQLite integrity of `dev.db` (read-only) | `PRAGMA integrity_check` / `foreign_key_check` | **`ok` / 0 violations** |
| 9 | Prisma drift | `migrate diff --exit-code` | **exit 0 — no drift** |
| 10 | Pinned Node 20.20.2, stable suite | `nvm use && npm ci && npm test` | **PASS — 207/207**, identical to the host |
| 11 | Pinned Node 20.20.2, defect suite | `npm run test:defects` | **13 pass / 16 fail** — identical to the host |
| 12 | Pinned Node 20.20.2, rehearsal | `npm run db:rehearse` | **PASS — all conditions** |

Result 10 closes a limitation recorded in Stage 2 (§14, item 6): the suites had never been run on the pinned Node version.

### Unexpected failures, investigated

| Observation | Resolution |
| --- | --- |
| The BE-001 control initially reported *"no suitable control task found"* | A seed gap, not a migration fault: only `alice` had self-created tasks, and she was the creator being deleted. Seed now gives `bob` and `carol` their own tasks. **The control refusing to pass silently when it had nothing to test is the behaviour we want.** |
| First atomicity measurement said "both atomic" | Harness defect — see §9. Fixed, re-measured, roadmap corrected. |

---

## 12. Database safety evidence

| Guarantee | Evidence |
| --- | --- |
| `dev.db` not modified | MD5 `3078946726247cf8f7d037dede4d6073` before and after **every** phase of this stage |
| `dev.db` never opened for writing | Every read uses `{ readonly: true }`; the backup source connection is read-only by construction |
| No existing database reset | `prisma migrate dev` never invoked; only `migrate deploy`, and only against fresh temp files |
| Migration tests target disposable databases only | Asserted in-suite: the database is not protected and does not live under `backend/prisma/` |
| Tests cannot overwrite an existing database | `applyMigrations()` refuses a path that already exists; `assertWritableTarget()` refuses existing and protected targets |
| Fail-closed on unsafe configuration | 4 refusal tests: plain protected restore, `--allow-protected` without confirmation, wrong confirmation value, programmatic `assertWritableTarget` |
| Cleanup removes only our own files | `destroyWorkspace()` refuses any path outside the OS temp directory |
| No destructive SQL against a user-owned database | The rehearsal refuses a protected target before doing anything |
| No secrets or row data in output | Asserted: the manifest contains no hash, e-mail or message body; refusal messages contain no secret |
| Stage-2 protections intact | The REF-030 guard still passes 17/17; `guard-contract.test.js` confirms both new suites load it first |
| Application source untouched | 25 `src/` files, 7 migrations and `schema.prisma` byte-identical to the Stage-3 backup |
| Migration history untouched | Still exactly 7 migrations; the BE-001 candidate sits in `prisma/sql/proposed/` |

**Stage-3 backup:** `.backups/stage-03-20261113-221636/` — 68 files, 1.3 MB, 57 hashes, verified readable and byte-identical at creation. The Stage-2 backup was re-verified intact (40/40) before this stage began.

---

## 13. Remaining risks

| Risk | Severity | Note |
| --- | --- | --- |
| **No version control** | **High** | Unchanged since Stage 1 and still the dominant process risk. Stage 4 edits `schema.prisma` and adds a migration that rebuilds a table; without Git, recovery depends entirely on the filesystem backups. |
| A successful BE-001 migration is one-way | Medium | Atomicity protects against failure, not against regret. Once `created_by_id` holds NULLs the column cannot be made `NOT NULL` again. Take a fresh backup immediately before REF-010. |
| Rehearsal fidelity | Medium | The rehearsal uses seeded data, not a copy of `dev.db`. Before REF-010, also rehearse against a **backup of the real `dev.db`** restored to a disposable path — the tooling supports this and `dev.db` is known to contain 2 affected links. |
| SQLite-version-specific findings | Low–medium | The `ADD CONSTRAINT` semantics in §6 hold for 3.53.2 as bundled by better-sqlite3 12.x. A dependency upgrade can change them; `constraints.sql` does not rely on the feature, which limits the exposure. |
| CI still unproven end to end | Medium | CI runs `npm test`, which now includes both new suites, but the pipeline has never executed — blocked on REF-001. The suites add ~8 s. |
| `.backups/` is a single local copy | Medium | Not replicated. It is the only recovery mechanism until Git exists. |
| Backups contain real data | Medium | A backup of `dev.db` holds real rows. `.backups/` is gitignored and outside `backend/`, but it is unencrypted on disk and must not be shared. |

---

## 14. Readiness for Stage 4

**Stage 4 (REF-010 — applying the BE-001 fix) is ready to begin, subject to the REF-001 decision.**

Every Stage-4 precondition is now satisfied and demonstrated:

| Stage 4 needs | Provided |
| --- | --- |
| A rehearsed, verified migration | 18/18 conditions pass on disposable copies; proven to reject a naive alternative |
| Protection for `chat_messages.task_id` | Guard B, with the link count asserted before and after |
| Protection for triggers, indexes and CHECKs | `constraints.sql` + 30 assertions that fail if anything is lost |
| A working backup and a rehearsed restore | Both verified, including WAL-resident data |
| A rollback path | Atomic on failure; backup restore for a successful-but-unwanted change |
| A failing regression test that must flip | Stage 2's `be-001-cross-user-task-deletion.test.js` — 4 failures |
| A green baseline to diff against | 207/207 on host **and** pinned Node |

### Recommended Stage 4 sequence

1. **Approve and execute REF-001** (git init + baseline commit). Stage 4 is the first stage that changes stored data.
2. `npm run db:backup` against `dev.db`, with the manifest retained.
3. **Rehearse once more against a restore of that backup**, not only seeded data.
4. Promote `prisma/sql/proposed/be-001-fix-task-creator-cascade.sql` into `prisma/migrations/<timestamp>_fix_task_creator_cascade/migration.sql` **unchanged**.
5. Update `schema.prisma`: `createdById String?` with `onDelete: SetNull`.
6. `npm run db:deploy` — never `db:migrate`.
7. Move `be-001-cross-user-task-deletion.test.js` from `known-defects/` into the stable suite and update `scripts/test.js`.
8. Update the two assertions that currently pin the **defective** state: `scripts/lib/constraints.js` (`tasks.created_by_id` → `SET NULL`) and the matching test in `migrations.test.js`, which carries a comment saying exactly this.
9. Re-run everything, including `npm run db:rehearse`, and confirm 16 → 0 expected failures for BE-001.

### Explicit cautions

- Do **not** edit the candidate SQL while promoting it; it is the artefact that was verified.
- Do **not** run `prisma migrate dev` — it may reset the database on drift.
- The `migrations.test.js` assertion *"BE-001 is still present: tasks.created_by_id cascades"* is designed to fail the moment the fix lands. That failure is the signal to update it, not a regression.
