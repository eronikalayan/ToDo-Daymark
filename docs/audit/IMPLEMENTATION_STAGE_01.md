# Implementation Stage 1 — Engineering Baseline (REF-001 … REF-005)

**Date:** 2026-11-13
**Scope:** Stage 1 of the execution sequence in [`BACKEND_REFACTORING_PLAN.md`](./BACKEND_REFACTORING_PLAN.md) §17 — tasks **REF-001 through REF-005** only.
**Related findings:** BE-026 (no version control, CI, linting or deployment definition), BE-027 (test structure).

**Nothing outside REF-001…REF-005 was implemented.** No application logic, API contract, database schema, migration, or dependency of the running service was changed. One task — **REF-001 (`git init`)** — is deliberately **not executed** and awaits explicit approval; see §3.

---

## 1. Initial repository state

Established by inspection before any file was modified.

| Property | Observed state |
| --- | --- |
| Project root | `/Users/stepanbasreghyan/Downloads/project` |
| **Git repository** | **None.** `git rev-parse --show-toplevel` → `fatal: not a git repository`. Every parent directory up to `/` was walked individually; no `.git` exists anywhere. |
| Git available | Yes — `git 2.50.1 (Apple Git-155)`, with `user.name` and `user.email` already configured globally. |
| Working-tree state | **Not applicable** — there is no repository, so there is no tracked state, history, branch, or remote. |
| Remote | None (no repository). |
| `.gitignore` | Two files existed: root (7 lines) and `backend/` (6 lines). Both already covered `node_modules`, `.env`, `prisma/*.db`, `*.db-journal`. |
| Root `package.json` | 6 scripts, all thin proxies to `backend` via `npm --prefix backend`. No dependencies. |
| `backend/package.json` | 6 scripts; 13 runtime dependencies; 2 devDependencies (`prisma`, `supertest`). `engines.node: ">=20.19.0"`. |
| Lint / format tooling | **None.** No ESLint, Prettier, Biome, or any lint-related package. |
| Node version config | **No `.nvmrc`.** Installed Node was `v25.2.1` (npm 11.6.2) — a non-LTS "Current" release, and **above** the documented requirement. |
| Test runner | `npm test` → `scripts/test.js`, which forces `NODE_ENV=test` and redirects `DATABASE_URL` to `prisma/test.db`. |
| **Test isolation** | **Verified safe** — see §7, check V0. |
| **CI platform** | **Could not be determined.** No `.github`, `.gitlab-ci.yml`, `.circleci`, `azure-pipelines.yml`, `Jenkinsfile`, `bitbucket-pipelines.yml` or `.travis.yml`; no remote; none supplied in context. |
| Sensitive / generated files present | `backend/.env` (386 B, real secret), `backend/prisma/dev.db` (151.5 KB), `backend/prisma/test.db` (229 KB), `backend/node_modules/`. |
| SQLite journal mode | `delete` (so `-wal`/`-shm` sidecars are not currently produced). |

---

## 2. Tasks completed

| Task | Status | Summary |
| --- | --- | --- |
| **REF-001** — initialise Git, commit baseline | ⛔ **Blocked — awaiting approval** | See §3. |
| **REF-002** — `.gitignore` excludes secrets, databases, dependencies | ✅ **Done and verified** | Both files rewritten; rules proven correct in an isolated throwaway repository. |
| **REF-003** — CI workflow | ⚠️ **Done, with a documented assumption** | `.github/workflows/ci.yml` created. Every command in it was executed against a simulated fresh clone before being written. The hosting platform is an assumption, and the file is inert until REF-001 lands. |
| **REF-004** — `.nvmrc` + native build toolchain documentation | ✅ **Done and verified** | Pinned to `20.20.2`; `npm ci` + full verification executed **on that exact version**. |
| **REF-005** — ESLint flat config + `npm run lint` | ✅ **Done and verified** | Passes clean on existing source with **zero source changes**, and proven non-vacuous. |

---

## 3. Tasks blocked or deferred

### REF-001 — Git initialisation: **not executed, awaiting explicit approval**

**Why it was not performed.** The task brief states: *"Do not initialize a new Git repository automatically if an existing repository is found"* and *"If Git initialization would create an entirely new repository, explain why it is needed and leave that operation pending explicit approval."*

No repository exists anywhere up the directory tree, so `git init` here would create an **entirely new repository**. That triggers the second clause, so the operation is left pending.

**Why it is nevertheless needed** (the justification required by the brief):

1. **It is the stated prerequisite for every later stage.** Plan §12.1 lists REF-001 as a hard dependency of *everything*, and §17 identifies Stage 4 (the BE-001 cascade migration) as the highest-risk change in the programme.
2. **That migration is not reversible in place.** Plan §5.1 rule 5 records that Prisma 7 with the better-sqlite3 adapter does **not** wrap migrations in a transaction, so a mid-migration failure leaves a partially migrated database. Restore-from-backup is the only rollback — and there is currently no way to revert the *code* half of such a change either.
3. **No change made from here on is currently revertible or reviewable.** There is no history, no diff, no blame, no branch, and no pull-request gate.
4. **`.gitignore` files already exist**, which indicates version control was intended but never initialised.

**What approval unblocks.** Once approved, the recommended sequence is:

```sh
cd /Users/stepanbasreghyan/Downloads/project
git init
git add -A
git status          # review: confirm no .env and no *.db are staged
git commit -m "Baseline: Daymark frontend and REST API before refactoring"
```

The `git status` review step matters: it is the moment the REF-002 rules are exercised for real. §7 check V2 pre-verifies that this will be clean.

**Not done, and not requested:** no remote was created, nothing was pushed, and no commit was made.

### Consequences of REF-001 being blocked

| Item | Impact |
| --- | --- |
| REF-002 verification | Could not use `git status --ignored` / `git ls-files` **in the project**. Worked around by replicating the file tree and both `.gitignore` files in a throwaway repository under the scratch directory — this proves the rules without initialising anything in the project (§7, V2). |
| REF-003 | The workflow file is inert: with no repository and no remote, nothing triggers it. It is committed now so the command sequence is reviewable, and because it was validated by executing each command manually. |
| Plan §12.3 traceability | BE-026 remains only partially closed until REF-001 is approved. |

### Deliberately out of scope (not blocked — simply not Stage 1)

REF-006 … REF-009 (fixtures, test splitting, regression tests), REF-025, REF-028, REF-029, REF-030, and every later task. In particular, **BE-004 was not fixed** — `GET /api/nope` still returns `401`, which §7 check V9 confirms as expected unchanged behaviour.

---

## 4. Files created

| File | Lines | Task | Purpose |
| --- | --- | --- | --- |
| `.nvmrc` | 1 | REF-004 | Single source of truth for the Node version (`20.20.2`), read by both developers (`nvm use`) and CI (`node-version-file`), so the two cannot drift. |
| `.github/workflows/ci.yml` | 115 | REF-003 | Verification pipeline: reproducible install, Prisma client generation, lint, test, two-tier dependency audit, migration-drift check, and a tracked-secret guard. |
| `backend/eslint.config.js` | 95 | REF-005 | ESLint 10 flat config scoped to the backend; correctness-oriented rule set chosen so it passes on existing code without reformatting it. |
| `docs/audit/IMPLEMENTATION_STAGE_01.md` | — | — | This document. |

---

## 5. Files modified

| File | Change | Task |
| --- | --- | --- |
| `.gitignore` | Rewritten: added `.env.*` variants with `!*.example` negations, `-wal`/`-shm` sidecars, `coverage/`; grouped with comments. | REF-002 |
| `backend/.gitignore` | Same treatment, scoped to `backend/`. | REF-002 |
| `package.json` (root) | Added one script: `"lint": "npm --prefix backend run lint"`, matching the existing proxy convention. | REF-005 |
| `backend/package.json` | Added one script: `"lint": "eslint ."`; added devDependencies `eslint@10.14.0` and `@eslint/js@10.0.1` (exact-pinned). | REF-005 |
| `backend/package-lock.json` | Regenerated by `npm install` for the two new devDependencies. | REF-005 |
| `backend/README.md` | Two additive subsections: *"Node version and the native SQLite build"* and *"Linting"*. Nothing existing was rewritten. | REF-004, REF-005 |

**No other file in the repository was modified.** Proof in §9.

---

## 6. Exact purpose of each change

### 6.1 `.gitignore` (both files) — REF-002

The pre-existing rules already covered the obvious cases. Two genuine gaps were closed:

| Added | Why |
| --- | --- |
| `.env.*` (+ `!.env.example`, `!backend/.env.example`) | Only the literal name `.env` was ignored. A developer creating `backend/.env.production` or `.env.local` — a normal thing to do — would have committed real secrets. The negations keep the `.env.example` templates committable, which was verified explicitly because an over-broad pattern here would silently delete the onboarding templates from the repository. |
| `*.db-wal`, `*.db-shm` | The journal mode is currently `delete`, so these do not appear today. They are listed as precaution: if Prisma, the driver adapter, or a configuration change ever switches to WAL, these sidecars contain real row data and would otherwise be committable. |
| `coverage/` at root | Already present in `backend/.gitignore`; added at root for symmetry. |

### 6.2 `.nvmrc` = `20.20.2` — REF-004

**Why this exact version.** `backend/package.json` declares `engines.node: ">=20.19.0"` and both READMEs say "Node.js 20.19 or newer". Pinning anything outside that line would invent a requirement the project never stated. `20.20.2` is the newest Node 20 LTS ("Iron") available, satisfies the declared range, and — decisively — is **installed on this machine**, which meant the pin could be verified by actually running the full install-and-test cycle on it rather than asserting it would work (§7, V5–V8).

Note that the previously installed Node (`v25.2.1`) is an odd-numbered "Current" release that never becomes LTS, which is not an appropriate baseline for a service intended for production.

**Why the native-build documentation was required.** `better-sqlite3` is a native addon whose compiled binary is bound to the Node ABI it was built for. Switching Node versions silently breaks it, producing `Could not locate the bindings file` and a blanket HTTP 500 from every database-backed route — precisely the failure the audit hit in check V1 and initially mistook for an application defect. Pinning a version without documenting the rebuild step would have *introduced* that trap. Hence the `npm rebuild better-sqlite3` instruction in `backend/README.md`.

### 6.3 `.github/workflows/ci.yml` — REF-003

Each step exists for a verified reason:

| Step | Reason |
| --- | --- |
| `actions/setup-node` with `node-version-file: .nvmrc` | Makes `.nvmrc` authoritative for CI too, so local and CI versions cannot diverge. |
| `npm ci` | Installs strictly from the lockfile and fails if the lockfile and `package.json` disagree — this is the reproducibility guarantee. |
| `npm run db:generate` | **Discovered by execution, not assumed.** Without it the suite fails with `Cannot find module '.prisma/client/default'`. `npm ci` does not generate the client. See §8.1. |
| `DATABASE_URL` set at job level | **Discovered by execution.** `prisma.config.ts` resolves `DATABASE_URL` eagerly, so `prisma generate` aborts with `PrismaConfigEnvError` when it is unset. Points at a throwaway runner-local file; `npm test` overrides it regardless. |
| `npm run lint` | REF-005 gate. |
| `npm test` | Uses the project's own runner, which isolates the database. A comment forbids substituting a direct `node --test` call, which would bind the development database. |
| `npm audit --omit=dev` | Production dependency surface must be clean; **any** vulnerability fails the build. |
| `npm audit --audit-level=high` | Full tree, but only high/critical block delivery — so a moderate advisory inside a linter's glob matcher does not stop releases. See §8.2. |
| `prisma migrate diff --exit-code` | Fails if the migration history stops producing the schema in `schema.prisma`. Read-only, creates no artifacts; validated with a negative control that introduced drift deliberately. |
| Tracked-secret guard | Fails the build if any `.env`, `*.db`, sidecar or `node_modules` file is ever tracked — the class of mistake REF-002 prevents, enforced rather than trusted. |

**Platform assumption, stated plainly.** The CI platform could not be determined from the repository or the provided context. GitHub Actions was used because the refactoring plan names `.github/workflows/ci.yml`. If the project is hosted elsewhere, the file is inert and the same command sequence must be ported. This is recorded in a comment at the top of the workflow itself.

### 6.4 `backend/eslint.config.js` — REF-005

A **correctness-oriented** rule set, not a style enforcer. The brief forbids reformatting the source tree, and a linter that fires on correct code teaches a team to ignore it.

Starting from `@eslint/js` recommended, three adjustments were made — all in **configuration**, never in application source:

| Adjustment | Reason |
| --- | --- |
| `no-unused-vars` with `args: 'none'` | Express error middleware must keep its four-argument signature, and several handlers legitimately accept `next` without using it. Unused *variables* and imports are still reported. |
| `no-unused-vars` with `ignoreRestSiblings: true` | `auth.controller.js:50` uses the deliberate rest-destructuring "omit" idiom (`const { maxAge, ...clearOptions } = ...`). This is correct code; the rule has an option for exactly this case. |
| `require-atomic-updates` **not** enabled | Initially enabled speculatively; it produced three findings in `middleware/authenticate.js`, all false positives — an Express `request` object is unique per request and never shared between concurrent executions. It is not part of `eslint:recommended`. The one genuine non-atomic read-modify-write in the codebase (BE-021, `task.service.js`) is a Prisma call-sequencing issue this rule cannot detect. Removing it was preferred over adding `eslint-disable` comments, which would have modified application source. |

`no-console` is left **off**: `console` is the current logging mechanism and BE-025/REF-035 replaces it in a later phase. Forcing a change now would pre-empt that work.

Node globals are declared explicitly rather than adding the `globals` package, keeping the dev-dependency surface minimal.

### 6.5 `package.json` scripts — REF-005

One script added to each file. Every pre-existing script was verified byte-identical afterwards (§7, V11). The root entry follows the existing `npm --prefix backend` proxy convention.

**A `prepare` script was deliberately NOT added**, even though it would make `npm ci && npm test` work in one step. `prisma` is a devDependency, so a production `npm ci --omit=dev` would fail at the `prepare` step. Generation is therefore an explicit CI step instead.

---

## 7. Verification commands and results

Every result below was produced by executing the command. Nothing is asserted without execution.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| **V0** | **Test-runner database isolation** (gate for running tests at all) | static analysis of `scripts/test.js` + config resolution with no connection opened | **PASS.** The `DATABASE_URL` override appears *after* the `...process.env` spread, so the override wins. Resolution: `npm test` → `NODE_ENV=test`, `DATABASE_URL=file:./prisma/test.db`. A direct `node --test test/api.test.js` resolves to `NODE_ENV=development`, `file:./prisma/dev.db` — **so it was never run**. |
| **V1** | ESLint on existing source | `npx eslint .` | **PASS** — exit 0, zero errors, **zero source files changed**. (First run reported 4 errors; all resolved in configuration, see §6.4.) |
| **V2** | `.gitignore` correctness | throwaway repo in scratch dir, replicating the real tree | **PASS.** Ignored: `backend/.env`, `.env.production`, `.env.local`, `.env`, `dev.db`, `test.db`, `-journal`, `-wal`, `-shm`, both `node_modules/`, `*.log`, `.DS_Store`. Committable: both `.env.example` files, `schema.prisma`, all migrations, all source, both `package.json`, `package-lock.json`. **Zero leaks.** |
| **V3** | Secret-guard logic used in CI | same throwaway repo, with `git add -f` of a secret and a database | **PASS** — correctly detected `backend/.env` and `backend/prisma/dev.db`; did **not** trip on `.env.example`. |
| **V4** | Workflow YAML validity | `npx --yes js-yaml .github/workflows/ci.yml` | **PASS** — parsed; 10 steps; `node-version-file: .nvmrc`; `working-directory: backend`. (Project dependencies unaffected — npx uses its own cache.) |
| **V5** | Fresh clone on the pinned Node | `nvm use` → `npm ci` in a clone-equivalent copy containing no `node_modules`, no `.env`, no `*.db` | **PASS** — Node `v20.20.2`, ABI 115; 362 packages; `better-sqlite3` compiled from source and loaded successfully. |
| **V6** | Prisma client generation | `npm run db:generate` on the pinned Node | **FAIL without `DATABASE_URL`** (`PrismaConfigEnvError`); **PASS with it** (`Generated Prisma Client (v7.10.1)`). This finding shaped the CI design. |
| **V7** | Lint in the fresh clone | `npm run lint` | **PASS.** |
| **V8** | **Tests in the fresh clone on the pinned Node** | `npm test` | **PASS — `tests 1, pass 1, fail 0`.** Only `prisma/test.db` was created; **no `dev.db` appeared**. |
| **V9** | Live backend smoke test | real server on port 4188 against `test.db` | **PASS.** `/api/health` 200 `{"status":"ok","database":"ok"}`; `/api/auth/session` 200 `{"user":null}`; `/api/tasks` 401; `/api/auth/me` 401; `/api/nope` **401** (BE-004 unchanged, as intended); `/` 200 HTML 17 094 B; `/app.js` 200; `/styles.css` 200; 3/3 security headers; clean `SIGTERM` exit. |
| **V10** | Tests on the host | `npm test` from project root | **PASS — `tests 1, pass 1, fail 0`.** |
| **V11** | Pre-existing scripts unchanged | programmatic comparison against recorded originals | **PASS** — all 12 pre-existing scripts byte-identical; only `lint` added. |
| **V12** | Runtime dependencies unchanged | order-insensitive set comparison | **PASS** — 13 runtime dependencies, **none added, none removed, no version changed**. npm only re-sorted keys alphabetically. |
| **V13** | Audit, production surface | `npm audit --omit=dev` | **PASS — 0 vulnerabilities**, identical to the pre-Stage-1 baseline. |
| **V14** | Audit, full tree at the CI gate | `npm audit --audit-level=high` | **PASS** — exit 0, no high or critical. (4 moderate, dev-only — see §8.2.) |
| **V15** | Migration drift | `prisma migrate diff --exit-code` | **PASS — "No difference detected"**, exit 0. Negative control: adding a model to `schema.prisma` produced exit 2, restoring produced exit 0, so the check genuinely works. *(Via `npx` on the host this returns 126 — a pre-existing local permission problem, see §8.3.)* |
| **V16** | ESLint config is not vacuous | virtual file through `--stdin` (no file written) | **PASS** — caught unused variable, assignment-in-condition, constant condition, undefined global, and loose equality; and correctly did **not** flag the two intentionally allowed patterns. |
| **V17** | `dev.db` untouched | MD5 + mtime before and after all work | **PASS** — mtime `Nov 13 18:51` unchanged; MD5 identical. |
| **V18** | Application source untouched | mtime comparison across the whole tree | **PASS** — newest application file `Nov 13 18:43`; oldest Stage-1 file `Nov 13 21:30`. Every application file predates all Stage-1 work. |
| **V19** | Endpoint inventory intact | route-declaration count and listing | **PASS — 23 route declarations**, identical to the audited inventory. |
| **V20** | Schema and migrations intact | MD5 of `schema.prisma` and of all migration SQL | **PASS** — 7 migration directories, fingerprints unchanged. |

### Not executed, and why

| Check | Reason |
| --- | --- |
| `node --test test/api.test.js` directly | **Deliberately never run.** V0 proved it binds `prisma/dev.db`. The brief forbids it, and the plan's REF-030 exists to make it impossible. |
| `git status --ignored`, `git ls-files` in the project | No repository (REF-001 blocked). Equivalent verification performed in an isolated throwaway repository (V2, V3). |
| CI pipeline end-to-end on the real platform | No repository, no remote, platform unidentified. Mitigated by executing every individual CI command manually (V5–V8, V13–V15). |
| `npm run db:migrate` | `prisma migrate dev` can **reset** a database on drift. Out of scope and never run. |

---

## 8. Remaining risks

### 8.1 The plan's REF-004 acceptance criterion is not achievable as written — **needs a decision**

Plan §11 states the REF-004 verification as: *"A fresh clone on the pinned Node version runs `npm ci && npm test` with no manual repair."*

Executing exactly that **fails**: `Cannot find module '.prisma/client/default'`. The real minimum sequence is:

```sh
nvm use
npm ci
DATABASE_URL='file:./prisma/test.db' npm run db:generate   # required; DATABASE_URL must be set
npm test
```

`backend/README.md` already documented the `db:generate` step (step 4 of "Run locally"), so the project was right and the plan's shorthand was wrong. The requirement that `DATABASE_URL` be set for `db:generate` was not documented anywhere and is newly discovered.

**No change was made to the roadmap.** The brief requires explicit justification before editing it, so this is raised here for approval instead. Recommended correction to plan §11 REF-004: replace the two-command criterion with the four-step sequence above.

### 8.2 ESLint introduces four moderate, dev-only advisories

Adding ESLint 10 pulls in `minimatch` with a moderate DoS advisory (GHSA-g3hv-75wg-m249), surfacing as 4 moderate findings via `@eslint/config-array` → `eslint` → `@eslint/js`.

- **Production surface is unaffected:** `npm audit --omit=dev` still reports **0 vulnerabilities**, exactly as before Stage 1.
- ESLint never executes in production; the advisory is in a linter's glob matcher.
- The alternative, `eslint@9.39.5`, is what `npm audit fix --force` proposes — but npm itself flags it as *"no longer supported"*, meaning no future security fixes. Trading a supported major for an unsupported one to clear a dev-only moderate is a bad trade.
- **Mitigation:** CI gates production dependencies at *any* severity and the full tree at *high*. The moderate is visible in `npm audit` output but does not block delivery.

**Decision taken:** ESLint 10.14.0. **Flagged for confirmation** — if policy requires a zero-finding `npm audit` across the full tree, the options are to wait for the upstream fix or to drop the linter.

### 8.3 Pre-existing: `node_modules/.bin/prisma` is not executable

`node_modules/.bin/prisma` has mode `-rw-rw-r--` (no execute bit, dated `Nov 13 17:54` — before any Stage-1 work), so `npx prisma …` returns exit 126 on this machine. The `eslint` shim installed during this stage **is** executable, confirming the problem is pre-existing and not caused here. It does not affect `npm run` scripts (npm resolves binaries internally) and does not affect CI (a clean `npm ci` sets permissions correctly — proven in V5/V15). A local `rm -rf node_modules && npm ci` would fix it.

### 8.4 Residual risks

| Risk | Severity | Note |
| --- | --- | --- |
| **No version control yet** | **High** | The single largest remaining risk. Until REF-001 is approved, nothing is revertible or reviewable, and no later stage should start. |
| CI platform unverified | Medium | The workflow may need porting. Commands are validated independently of the platform. |
| CI pipeline never executed as a pipeline | Medium | Each command was run manually; their composition on a real runner has not been observed. First push will be the real test. |
| `better-sqlite3` compile time in CI | Low | Compiles from source when no prebuild matches; `ubuntu-latest` has the toolchain. The 15-minute job timeout accommodates it. |
| `.nvmrc` pins an exact patch | Low | Requires a deliberate bump for Node security patches. This is intentional: reproducibility was the stated goal of this stage. |
| Host `node_modules` still built for Node 25 | Low | The host still runs Node 25.2.1 and its binding matches. Anyone running `nvm use` must then run `npm rebuild better-sqlite3` — now documented in `backend/README.md`. |

---

## 9. Confirmation that application behaviour was preserved

| Guarantee | Evidence |
| --- | --- |
| **All 23 API endpoints unchanged** | V19 — 23 route declarations, identical set. |
| **Request/response contracts unchanged** | V9 — live responses byte-checked for `/api/health`, `/api/auth/session`; status codes verified for `/api/tasks`, `/api/auth/me`, `/api/nope`. |
| **Authentication/authorization unchanged** | V9 — unauthenticated `/api/tasks` and `/api/auth/me` both still return 401. |
| **Database schema unchanged** | V20 — `schema.prisma` MD5 unchanged. |
| **Migrations unchanged** | V20 — 7 directories, combined SQL MD5 unchanged. No migration was created, edited, or applied. |
| **Session handling unchanged** | V9 — `/api/auth/session` still returns `200 {"data":{"user":null}}` when signed out. |
| **Frontend behaviour unchanged** | V9 — `/`, `/app.js`, `/styles.css` all 200; `index.html` still 17 094 bytes. No frontend file was modified. |
| **Business logic unchanged** | V18 — every file under `backend/src/` predates all Stage-1 work. |
| **Runtime dependencies unchanged** | V12 — 13 dependencies, none added/removed/changed. Only devDependencies grew. |
| **Test suite still passes** | V10 — `tests 1, pass 1, fail 0` on the host; V8 — same on the pinned Node in a fresh clone. |
| **Development database untouched** | V17 — `dev.db` MD5 and mtime identical before and after. |
| **Known defects deliberately still present** | V9 — `GET /api/nope` returns `401`, confirming BE-004 was **not** fixed in this stage. |

No source file was reformatted. ESLint was run in check mode only; `--fix` was never invoked on the project tree.

---

## 10. Recommendations for Stage 2

**Stage 2 is Plan §17 Stage 2: REF-030, REF-006 … REF-009** — the test safety net.

### Blocking prerequisite

**Approve and execute REF-001 first.** Stage 2 creates and restructures test files; without version control those changes are unrevertible. The commands are in §3.

### Recommended order within Stage 2

1. **REF-030 first, before any other test work.** It is the fail-closed guard that stops a suite from binding `dev.db`. Every later test task creates files that could be run directly from an editor, so the guard must exist before they do. V0 documents the exact failure it prevents.
2. **REF-006** (fixtures that bypass rate-limited endpoints). Note the audit's BE-017 finding: registration is capped at 5/hour per IP in *all* environments, which already blocked fixture creation during the audit. Factories must create users via Prisma directly.
3. **REF-007** (split `api.test.js` into independent suites). Expect order dependencies to surface — the current single test shares state across ~90 assertions. Per plan Phase 0, that is a finding, not a regression.
4. **REF-008** (unit tests for the pure helpers).
5. **REF-009 last** — the four regression tests for BE-001…BE-004, which **must fail** against current code before Stage 3 begins.

### Carry forward from this stage

- Add `npm run lint` to the local pre-push habit; CI enforces it, but failing locally is cheaper.
- When REF-030 is implemented, extend the CI "Assert no secret or database file is tracked" step to also assert that no suite can resolve a non-test `DATABASE_URL`.
- The `.github/workflows/ci.yml` platform assumption should be confirmed or corrected before Stage 2, so CI is genuinely gating by the time regression tests exist.
- §8.1 (REF-004 acceptance criterion) needs a decision; it does not block Stage 2.

### Explicitly not recommended yet

Do not begin Stage 3 (REF-025/028/029) or Stage 4 (the BE-001 migration) until Stage 2's regression tests exist and demonstrably fail. Plan §17 is explicit that Stages 1–3 exist solely to make Stage 4 survivable.
