# Implementation Stage 6 — API routing: BE-004

**Date:** 2026-11-15
**Scope:** REF-013 (router mounting and authentication boundaries), REF-014 (API not-found behaviour), REF-016 (related API documentation).
**Predecessors:** [Stage 1](./IMPLEMENTATION_STAGE_01.md) · [Stage 2](./IMPLEMENTATION_STAGE_02.md) · [Stage 3](./IMPLEMENTATION_STAGE_03.md) · [Stage 4](./IMPLEMENTATION_STAGE_04.md) · [Stage 5](./IMPLEMENTATION_STAGE_05.md)

**BE-004 is fixed.** Unknown `/api/*` paths now return `404 NOT_FOUND` to anonymous and authenticated callers alike, and the answer no longer depends on whether a session exists. All 23 endpoints remain reachable on their original methods and paths, and every authentication boundary is unchanged.

**With this stage, all four release-blocking findings — BE-001, BE-002, BE-003, BE-004 — are resolved.** The known-defect suite is now empty, and each defect's reproduction tests were promoted into the stable suite rather than deleted.

No schema change, no migration, no new dependency, no frontend change. Git was not initialised, no commit was made, nothing was pushed.

---

## 1. What was wrong

The audit recorded BE-004 as a single mounting mistake. Investigation found **two independent causes**, and fixing either one alone would have left the defect in place.

### Cause 1 — a resource router mounted at the API root

`api.routes.js:16` read:

```js
router.use('/', socialRouter);
```

A path-less mount makes a router the catch-all for its entire mount point. Every unmatched `/api/*` URL was therefore handed to the social router, and `notFound` — registered after it — was unreachable for the whole API surface.

### Cause 2 — router-level authentication

`social.routes.js` and `task.routes.js` each began with:

```js
router.use(authenticate);
```

Express matches a path-less `use` against *every* path under the mount, **including paths that have no route at all**. An anonymous request to a non-existent URL was rejected as unauthenticated before any routing decision was reached. `auth.routes.js` already attached `authenticate` per route, so these two files were the outliers.

### Why both mattered

A pre-change probe, run against the real application, isolated the two causes and showed that the status depended on the caller:

```
  path                               anon   authed
  /api/does-not-exist                401    404
  /api/                              401    404
  /api/auth/does-not-exist           401    404
  /api/tasks/a/b/c                   401    404
  /api/tasks/not-a-uuid/extra        401    404
  /api/friends/nope/extra            401    404
```

The `authed` column is the proof that Cause 1 alone was not the whole story: with a valid session, `authenticate` passed the request through and the global handler produced a correct 404. Anonymous callers were stopped one middleware earlier. Had only the mount been corrected, unknown paths *under* `/api/tasks` and `/api/friends` would still have answered 401, because those routers' own path-less `authenticate` would still have matched them.

### The user-visible damage

`app.js:74` signs the user out on any unexpected 401 while a user is present:

```js
if (response.status === 401 && currentUser) {
  showSignedOut('Your session expired. Please sign in again.');
}
```

So one mistyped or stale `/api/*` URL silently ended a healthy session. The defect was a correctness problem in the backend and a usability problem in the browser.

---

## 2. What changed, and in which files

| File | Change | Task |
| --- | --- | --- |
| `src/routes/api.routes.js` | `socialRouter` mounted on `/friends` instead of `/`; `notFound` registered as the last API-scoped middleware | REF-013, REF-014 |
| `src/routes/social.routes.js` | Rewritten for a `/friends` mount: paths relative, `authenticate` per route, literal `/requests` paths before `/:friendId` | REF-013 |
| `src/routes/task.routes.js` | `router.use(authenticate)` removed; `authenticate` attached to each of the 6 routes | REF-013 |
| `test/known-defects/be-004-unknown-route-401.test.js` → `test/api-routing.test.js` | Promoted to the stable suite; all original assertions preserved verbatim, endpoint-matrix and route-ordering coverage added | REF-013, REF-014 |
| `test/helpers/client.js` | Added one generic `request(method, path, body)` member; existing verbs untouched | supporting |
| `scripts/test.js` | `test/api-routing.test.js` registered in the stable suite; `DEFECT_SUITE` now empty, with a guard so an empty suite never degrades into directory discovery | REF-007 |
| `backend/README.md` | New "Route organization" section; corrected the false bearer-token claim; Tests table and project layout brought up to date | REF-016 |

Backup taken before any edit: `.backups/stage-06-20261115-135357` — 80 files, 64 content hashes verified byte-identical. It contains every file listed above, including the pre-move test file, so the move is reversible.

---

## 3. Routing changes

Every sub-router is now mounted on an explicit prefix, and nothing is mounted on `/`:

| Prefix | Router |
| --- | --- |
| `/api/health` | defined inline in `api.routes.js` |
| `/api/auth` | `auth.routes.js` |
| `/api/tasks` | `task.routes.js` |
| `/api/friends` | `social.routes.js` |
| *(fallthrough)* | `notFound` |

`notFound` is scoped to the API rather than left to the application-level fallback. This is deliberate and it protects a contract: if a single-page-app catch-all is ever added to `app.js`, an API-scoped handler keeps `/api/unknown` answering JSON instead of HTML.

### `social.routes.js` was not split

The approved plan (§REF-013) proposed splitting it into `friend.routes.js` and `message.routes.js`. It was kept as one file, deliberately:

- Correctness here comes from the explicit mount plus per-route authentication, not from the file count. Both causes are fixed without a split.
- All six routes are the `/friends` resource and its `messages` sub-resource — one cohesive surface, well under the size where a split earns its keep.
- A message router mounted at `/friends/:friendId/messages` would need `mergeParams: true`, and `validate({ params: friendParams })` would then validate parameters owned by the parent router. That is added subtlety for no correctness gain.
- The filename matches `social.controller.js` and `social.service.js`; renaming it would churn imports across layers for a cosmetic result.

The stage brief asked to "avoid unnecessary router abstractions and unrelated restructuring", which is the deciding consideration. **This is a documented deviation from the plan, not an oversight** — §12.3 traceability has been updated to record it.

### Route ordering

Literal paths are registered before parameterized ones — `/requests` before `/:friendId`, `/:id/toggle` before `/:id`. There is no same-method overlap between `/requests` and `/:friendId` today, so this is a convention being made explicit rather than a bug being fixed, and it is now asserted by tests so a future route cannot quietly break it.

---

## 4. Authentication boundary changes

**No boundary moved.** The same requests require a session as before; only the mechanism by which authentication is attached changed, from router-level to per-route.

| Router | Before | After |
| --- | --- | --- |
| `task.routes.js` | `router.use(authenticate)` + 6 routes | `authenticate` on each of 6 routes |
| `social.routes.js` | `router.use(authenticate)` + 6 routes | `authenticate` on each of 6 routes |
| `auth.routes.js` | per route already | unchanged |

Verified structurally — 6 of 6 task routes and 6 of 6 social routes reference `authenticate`, and zero path-less `router.use(authenticate)` statements remain in any router — and behaviourally, by the endpoint matrix in §5.

Per-route attachment is the more defensive shape: it cannot accidentally guard a path that has no route, and the authentication requirement is visible on the line that defines the route rather than inferred from the top of the file. The cost is one token per route, and a missing `authenticate` is now caught by the endpoint matrix.

`optionalAuthenticate` on `GET /api/auth/session` is unchanged. Stage 5's rate limiting is unchanged: `socialWriteLimiter` is still a single instance shared by the four social write routes at 30 requests per minute, and the auth limiters were not touched.

---

## 5. Regression test results

All runs on the pinned Node.js 20.20.2.

| Check | Baseline (before Stage 6) | After |
| --- | --- | --- |
| `npm run lint` | PASS | **PASS** |
| `npm test` (stable) | 287 / 287 pass | **359 / 359 pass** |
| `npm run test:defects` | 11 tests, 6 pass, 5 fail *(expected)* | **empty — all defects fixed** |
| `npm run test:all` | — | **exit 0** |
| Stable suite, 3 consecutive runs | — | **359 / 359 every run** (no flakiness) |

The 5 previously failing tests were exactly the 5 BE-004 reproductions (4 unknown-path checks plus the same-status check); all 5 now pass. The 6 CONTROL tests, which assert that authentication was not weakened, passed at baseline and still pass. The stable suite grew by 72 tests — the promoted file now contributes 72 on its own (verified in isolation), comprising the original 11 plus the matrix, ordering, 404-discrimination, not-found-shape and bearer-token coverage added in this stage.

### An environmental failure, diagnosed rather than worked around

The first run of the defect suite on pinned Node 20.20.2 reported 3 failures, 2 of them inside the CONTROL block — which reads exactly like authentication having been weakened by the fix. It was not. Every one of the 3 raised the same error at `prisma.user.create()` in `test/helpers/factories.js:55`, i.e. during fixture setup rather than at any routing assertion:

```
The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 141. This version of Node.js requires
NODE_MODULE_VERSION 115.
```

The native binding had been built for Node 25 (ABI 141); Node 20.20.2 requires ABI 115. The tests that failed were those needing a user or a session; the purely anonymous checks passed, which is why the failure pattern looked selective. `npm rebuild better-sqlite3` under the pinned version resolved it, after which the suite was fully green. `package.json` and `package-lock.json` were verified byte-identical before and after by MD5. This is local `node_modules` state, not a repository defect — and worth recording because the symptom imitated the one regression this stage most needed to rule out.

### The endpoint matrix

All 23 endpoints, probed anonymously and with a session. The **anonymous** response is the clean routing signal: a protected route answers 401 before its handler runs, so it cannot emit a domain 404 that might be mistaken for a routing one.

```
  METHOD PATH                                  anon   authed
  GET    /api/health                           200    200
  POST   /api/auth/register                    422    422 VALIDATION_ERROR
  POST   /api/auth/login                       422    422 VALIDATION_ERROR
  GET    /api/auth/session                     200    200
  GET    /api/auth/verify-email                422    422 VALIDATION_ERROR
  POST   /api/auth/resend-verification         422    422 VALIDATION_ERROR
  POST   /api/auth/password-reset/request      422    422 VALIDATION_ERROR
  POST   /api/auth/password-reset/confirm      422    422 VALIDATION_ERROR
  POST   /api/auth/logout                      204    204
  GET    /api/auth/me                          401    200
  DELETE /api/auth/me                          401    422 VALIDATION_ERROR
  POST   /api/tasks                            401    422 VALIDATION_ERROR
  GET    /api/tasks                            401    200
  GET    /api/tasks/<uuid>                     401    404 TASK_NOT_FOUND
  PATCH  /api/tasks/<uuid>/toggle              401    404 TASK_NOT_FOUND
  PATCH  /api/tasks/<uuid>                     401    422 VALIDATION_ERROR
  DELETE /api/tasks/<uuid>                     401    404 TASK_NOT_FOUND
  GET    /api/friends                          401    200
  POST   /api/friends/requests                 401    422 VALIDATION_ERROR
  PATCH  /api/friends/requests/<uuid>          401    422 VALIDATION_ERROR
  DELETE /api/friends/<uuid>                   401    404 FRIEND_NOT_FOUND
  GET    /api/friends/<uuid>/messages          401    404 FRIEND_NOT_FOUND
  POST   /api/friends/<uuid>/messages          401    422 VALIDATION_ERROR

  23 endpoints, 0 problems
```

Two things this proves beyond reachability. The 404s under authentication carry `TASK_NOT_FOUND` / `FRIEND_NOT_FOUND`, never the router's `NOT_FOUND` — the routes reach their controllers. And `PATCH /api/friends/requests/<uuid>` is validated as a *request* id rather than a friend id, confirming the literal path still wins over `/:friendId`.

A first version of this probe reported 401 in the `authed` column for every protected endpoint, which contradicted the passing stable suite. The probe was at fault: it sent `POST /api/auth/logout` with its own session cookie partway down the list, revoking the session for everything after it. Minting a fresh session per endpoint produced the table above. Recorded because the mistake was mine, the first result looked alarming, and the correction is the reason the table can be trusted.

### Over a real socket

`supertest` dispatches in-process, so the fix was also confirmed against a running server on port 5599 with `curl`:

```
  GET    /api/does-not-exist     -> 404 NOT_FOUND
  GET    /api/                   -> 404 NOT_FOUND
  GET    /api/auth/nope          -> 404 NOT_FOUND
  GET    /api/tasks/a/b/c        -> 404 NOT_FOUND
  GET    /api/friends/x/y/z      -> 404 NOT_FOUND
  PUT    /api/tasks              -> 404 NOT_FOUND
  POST   /api/nothing-here       -> 404 NOT_FOUND
  GET    /api/health             -> 200
  GET    /api/tasks              -> 401 UNAUTHENTICATED
  GET    /api/auth/me            -> 401 UNAUTHENTICATED
  GET    /api/friends            -> 401 UNAUTHENTICATED
  GET    /totally-unknown        -> 404 NOT_FOUND
```

`PUT /api/tasks` is worth noting: an unrouted *method* on a real path also falls through to `notFound` rather than being rejected as unauthenticated. The server shut down cleanly with no stack traces.

### Promotion of the BE-004 tests

`test/known-defects/be-004-unknown-route-401.test.js` became `test/api-routing.test.js`, and `test/known-defects/` was removed as it was then empty. Nothing was weakened: a line-by-line comparison against the backup's copy confirms **0 of the original assertion and test-declaration lines are missing**, and the file grew from 10 assertions to 38. The "EXPECTED TO FAIL" header was replaced with an explanation of the two causes, since the file is now a regression guard.

The empty-suite path in `scripts/test.js` needed care: `node --test` with no file arguments *discovers and runs the whole test directory*, so an empty `DEFECT_SUITE` would have silently re-run the stable suite and reported it as a known-defect result. The branch is skipped entirely instead, and the mechanism is kept for the next defect found before it can be fixed.

---

## 6. API compatibility assessment

**No breaking change.** For every legitimate request, the method, path, status code and response body are byte-for-byte what they were before.

| Aspect | Assessment |
| --- | --- |
| Endpoints | All 23 preserved; none added, removed, renamed or re-pathed |
| Methods | Unchanged |
| Request shapes | Unchanged — no validation schema was touched |
| Response shapes | Unchanged for every legitimate endpoint |
| Error envelope | Unchanged: `{ "error": { "message", "code" } }`, `details` only when present |
| Authentication | Identical requirements; attachment mechanism only |
| Rate limiting | Stage 5 behaviour preserved, including the shared `socialWriteLimiter` |

The one observable change is the defect being fixed: unknown `/api/*` paths return `404 NOT_FOUND` where they previously returned `401 UNAUTHENTICATED`. Per §4.5 of the plan this is an observable behaviour change rather than a breaking one — no client can deliberately depend on a mistyped URL reporting an authentication failure.

**Frontend impact is a strict improvement, with no frontend change.** `app.js` was not modified. Its blanket `401 ⇒ sign out` rule at line 74 now fires only on genuine authentication failures; a stale or mistyped `/api/*` URL surfaces as a normal "Request failed (404)" error instead of ending the session. The frontend calls only the documented endpoints, all of which are unchanged.

---

## 7. Remaining risks

| Risk | Severity | Assessment |
| --- | --- | --- |
| A future router mounted at `/` reintroduces the catch-all | Low | `test/api-routing.test.js` fails if any unknown path stops being 404; the convention is documented in `README.md` and in the routers' comments |
| A new route added without `authenticate` | Low | The endpoint matrix asserts the requirement per endpoint, but a *newly added* route is only covered once it is added to `API_SURFACE`. The inventory length is asserted to be 23, so adding an endpoint without updating the matrix fails the suite — the failure is a reminder, not automatic coverage |
| Literal/parameterized ordering broken by a future route | Low | Asserted for the two existing cases; a new overlapping pair would need its own assertion |
| `socialWriteLimiter` shared across four write routes | Informational | Pre-existing Stage 5 behaviour, deliberately unchanged here. One instance means one counter store shared by the four routes — acceptable for same-category writes, unlike the BE-003 case where it spanned unrelated recovery endpoints |
| `better-sqlite3` ABI mismatch between Node versions | Informational | Local environment only. Switching Node versions requires `npm rebuild better-sqlite3`; `npm ci` on the pinned version resolves it |

No new risk is introduced by this stage. BE-004's own risk is retired.

---

## 8. Scope and safety confirmations

- **Git:** not initialised, no commit, no push, no remote. Still unavailable by design; the backup is the rollback path.
- **Database:** no schema change, no migration, no `dev.db` access. Only `prisma/test.db` was written, by the test runner.
- **Dependencies:** none added. `package.json` and `package-lock.json` verified byte-identical (MD5) before and after the `better-sqlite3` rebuild.
- **Frontend:** `app.js` and `index.html` unmodified.
- **Authentication:** no redesign. Boundaries unchanged, verified per endpoint.
- **Rate limiting:** no redesign. Stage 5 configuration untouched.
- **Tests:** no assertion removed, skipped, inverted or weakened. Verified mechanically against the backup.

---

## 9. State after this stage

All four release-blocking findings are resolved:

| Finding | Severity | Task | Stage | Guarded by |
| --- | --- | --- | --- | --- |
| BE-001 | CRITICAL | REF-010 | 4 | `test/task-creator-lifecycle.test.js` |
| BE-002 | HIGH | REF-011 | 5 | `test/auth-email-reliability.test.js` |
| BE-003 | HIGH | REF-012 | 5 | `test/auth-rate-limit*.test.js` |
| BE-004 | HIGH | REF-013, REF-014 | 6 | `test/api-routing.test.js` |

BE-015 (the README's false bearer-token claim) was also corrected under REF-016, since that is REF-016's documented content. The claim was disproved at runtime first: the identical JWT returns 200 in the session cookie and 401 `UNAUTHENTICATED` as an `Authorization: Bearer` header, because `authenticate` reads only the cookie. The documented boundary is now asserted by a test.

**Stage 7 readiness.** The baseline is healthy: lint clean, 359 stable tests passing deterministically across three runs, an empty known-defect suite, and a verified backup. The remaining roadmap work is MEDIUM and LOW findings — no release blocker is outstanding.

Stage 7 has **not** been started.
