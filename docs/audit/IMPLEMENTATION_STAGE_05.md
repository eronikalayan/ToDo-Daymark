# Implementation Stage 5 — Authentication reliability: BE-002 and BE-003

**Date:** 2026-11-15
**Scope:** REF-011 (BE-002) and REF-012 (BE-003).
**Predecessors:** [Stage 1](./IMPLEMENTATION_STAGE_01.md) · [Stage 2](./IMPLEMENTATION_STAGE_02.md) · [Stage 3](./IMPLEMENTATION_STAGE_03.md) · [Stage 4](./IMPLEMENTATION_STAGE_04.md)

**Both HIGH findings are fixed.** A provider outage can no longer orphan an account, and failed logins can no longer lock a user out of recovery.

No schema change, no migration, no frontend change. **BE-004 remains unfixed and independently reproducible.** Git was not initialised, no commit was made, nothing was pushed.

---

## 1. What was wrong

### BE-002 — registration was not atomic with email delivery

`authService.register()` committed the account; the **controller** then sent the verification email. A provider failure propagated to the error handler, so:

| Step | Before |
| --- | --- |
| `POST /auth/register` | **500 INTERNAL_ERROR** — but the row was already committed |
| `POST /auth/register` again | 409 `EMAIL_ALREADY_REGISTERED` |
| `POST /auth/login` | 403 `EMAIL_NOT_VERIFIED` |
| `POST /auth/resend-verification` | **500** — it called the same broken provider |

The address was permanently unusable with no self-service route out. The same defect sat on `password-reset/request`, where it was *also* an information leak: an unknown address answered 202 while a known address whose delivery failed answered 500, so a provider outage turned the endpoint into an account-existence oracle.

### BE-003 — one limiter instance shared across five routes

`express-rate-limit` keeps one counter store per **instance**. A single `loginLimiter` was mounted on `/register`, `/login`, `/resend-verification`, `/password-reset/request` and `/password-reset/confirm`, so ten failed logins returned 429 from all five — exactly the endpoints a user who has forgotten their password needs next. Behind a reverse proxy with the default `TRUST_PROXY_HOPS=0`, every client shares one bucket, so the lockout became global.

The library emits no warning for this shape, so only a test catches it.

---

## 2. What changed, and in which files

| File | Change |
| --- | --- |
| **`src/middleware/rate-limit.js`** *(new)* | Rate-limit factories: `perIpLimit`, `perAccountLimit`, `perAccountSoftLimit`, `perUserLimit`, the normalising `accountKey`, the shared login budgets, and `clearLoginBudget`. |
| `src/routes/auth.routes.js` | Every route gets its **own** limiter instance; login is layered per-IP + per-account; recovery endpoints get an IP limiter plus a non-rejecting mail budget. |
| `src/services/auth.service.js` | Owns email orchestration. New non-throwing `deliver()` helper; `register` delivers internally; new `resendVerification` and `requestPasswordReset` orchestrators; `resetPassword` now reports the address it reset. |
| `src/controllers/auth.controller.js` | No longer imports the email service at all. Shapes responses, honours the mail budget, and releases the login budget after a successful reset. |
| `src/config/env.js` | Production must state `TRUST_PROXY_HOPS` explicitly. |
| `scripts/test.js` | BE-002/BE-003 suites promoted to stable; only BE-004 remains in the defect suite. |
| `test/guard-contract.test.js` | Covers the relocated `test/fixtures/` directory. |

**Created:** `test/auth-email-reliability.test.js`, `test/auth-rate-limit.test.js`, `test/auth-rate-limit-recovery.test.js`, `test/auth-rate-limit-ip-layer.test.js`, `test/unit/rate-limit.test.js`, `test/fixtures/production-registration.js`.

**Removed:** the BE-002 and BE-003 files from `test/known-defects/` (their assertions now live in the stable suite).

**Verified untouched:** `prisma/schema.prisma`, all 8 migrations, `task.service.js`, `social.service.js`, `authenticate.js`, `app.js`, and every frontend file (`app.js`, `index.html`, `styles.css`, `favicon.svg` — byte-identical).

---

## 3. Why the implementation is correct

### BE-002: separate failure domains, enforced structurally

Account creation is durable. Delivery is a retryable call to a third party. The defect was letting the retryable step reject the durable one, so the fix makes that **impossible by construction** rather than by discipline:

```js
let user;
try {
  user = await prisma.user.create({ ... });          // only this may reject
} catch (error) { /* P2002 -> 409 */ }

// Past this point the account exists and must not be undone.
if (requiresEmailVerification()) {
  await deliverVerificationEmail(user.email, user.id);   // cannot throw
  return { user: toPublicUser(user), token: null, verificationRequired: true };
}
```

`deliver()` catches, logs, and returns a boolean. Nothing that can fail sits inside the block whose rejection would discard the account.

**The response is identical whether delivery succeeded or not.** This is deliberate on three counts:

1. It does not leak provider health to anonymous callers.
2. Under REF-049 (generic registration) a field varying with delivery outcome could become an account-existence signal, because delivery is only attempted for *new* accounts.
3. Recovery does not depend on knowing. An unverified sign-in returns 403 `EMAIL_NOT_VERIFIED`, which is the frontend's documented cue to reveal its resend button (`app.js:184`). The loop is already closed.

This follows REF-011's revised instruction — *"no new existence-revealing field"* — in preference to the older C3 sketch that proposed `meta.verificationEmailSent`. The cost is that a user whose email silently failed sees "check your inbox"; the recovery path is one failed sign-in away, and §8 records the UX improvement for when REF-048 publishes the contract.

**Timing was preserved deliberately.** The bcrypt hash still runs *before* the uniqueness check, so the new-account and duplicate paths pay the same cost and response timing does not reveal whether an address is registered.

**Logging holds back the provider's error message**, which can contain the request URL and therefore the bearer token. Only `{ context, delivered, errorName }` is written — asserted by a test that greps the child process output for the token and the provider host.

### BE-003: layered, not composite; and recovery is never rejected on an account key

A composite `ip + email` key was measured in the audit revision to be trivially bypassable — switching address, or merely its case, produced a fresh budget. Two independent layers are applied instead, and both must pass:

| Layer | Guards against | Why it is needed |
| --- | --- | --- |
| per-IP, 50/15 min | credential spraying across many accounts | the only layer that survives address variation |
| per-account, 10/15 min | targeted brute force from many sources | the only layer that survives IP rotation |

`accountKey` applies the same `trim().toLowerCase()` the Zod schema applies, because **limiters run before validation** and would otherwise bucket `A@x.com` apart from `a@x.com`. It returns `null` for a missing or non-string address, and the account layer is `skip`-ped in that case so a malformed body can neither crash the limiter nor collapse every caller into one bucket.

**All 429 responses share one message.** Saying "too many attempts for this account" would confirm the account exists, so the account layer and the IP layer are indistinguishable to the caller.

Three things keep the account layer from becoming a denial of service — requirement 7, which deserved more than a budget number:

1. **`skipSuccessfulRequests` on login**, so a legitimate sign-in never consumes budget and normal use cannot reach the ceiling.
2. **Recovery endpoints never reject on an account key.** `perAccountSoftLimit` sets `request.emailDeliverySuppressed` and calls `next()`: the route runs, returns its usual generic 202, and only the *email* is withheld. A third party can stop an address being mail-bombed but can never stop its owner requesting a reset.
3. **A consumed reset token releases the account's login budget.**

Point 3 came out of writing the tests, not out of the plan. `skipSuccessfulRequests` stops a correct password *accumulating* budget but cannot exempt a request from a budget already spent — the limiter rejects before the handler ever sees the password. My own test caught the consequence: a user could reset their password and still not sign in for the rest of the window. Since consuming a reset token proves control of the mailbox, it is sound evidence the owner is present, so `clearLoginBudget(email)` runs after a successful reset. The release is scoped to that account, does not fire on an invalid token, and does not fire twice on a replayed one — all three asserted.

### Reverse-proxy trust

Every IP-keyed limit is only as accurate as `request.ip`. Both misconfigurations are dangerous in opposite directions: too low and all clients share one bucket (one attacker locks out everyone); too high and forged `X-Forwarded-For` entries are trusted and IP limits are bypassed outright. Production therefore **must state the value**, including `0` for a directly exposed server. Development and test are unaffected. `express-rate-limit`'s own proxy validation is left enabled.

### Deliberate non-goals

- **`social.routes.js` was left alone.** It also mounts one instance on four routes, but those are all social writes with one intended combined budget — related concerns, unlike login versus recovery. `perUserLimit` exists for when that route group is revisited.
- **No queue, worker, service or dependency was added.** The fix is a try/catch boundary and a limiter factory.

---

## 4. Edge cases tested

**Email reliability** (`test/auth-email-reliability.test.js`, 25 tests). Four provider behaviours are driven through a child process with `globalThis.fetch` stubbed before the app is imported, so `email.service.js` runs its real code path — including its `response.ok` check — with nothing leaving the machine:

| Mode | Covers |
| --- | --- |
| `ok` | delivery succeeds; the captured link verifies the account; the verified account then signs in |
| `network-error` | `fetch` throws, as a refused connection does |
| `http-500` | the provider answers but rejects — a different failure path from a throw |
| `fail-then-ok` | a transient outage: registration during the outage, resend after recovery |

Also: no session for an unverified account; duplicate registration in and out of production; unverified login refused with `EMAIL_NOT_VERIFIED` and no cookie; the failure-mode response **byte-identical** to the success response; password reset answering identically for known and unknown addresses *while the provider is broken*; no token or provider host in the logs; and the non-production path unchanged (immediate verification, 201, session issued).

Because the stub sees the payload the service built, the recovery test extracts the **real** verification link and follows it, rather than simulating one.

**Rate limiting** (17 unit + 21 integration tests). `accountKey` normalisation including five case/whitespace variants collapsing to one key and seven malformed bodies returning `null`; per-IP counting regardless of address; per-account isolation between accounts; a case variant failing to escape an exhausted budget; the soft limiter suppressing without rejecting; both layers producing identical rejections; and — directly reproducing the defect — one shared instance leaking budget across routes while two factory instances do not.

End to end: the four endpoints that used to be collateral damage; brute-force protection still engaging; `skipSuccessfulRequests` proven by nine failures, three successes, then a tenth attempt still answered 401; the per-IP ceiling engaging after ~50 attempts **across 65 distinct accounts** (so no account budget could explain it); and the full locked-out → reset → sign-in journey.

---

## 5. Test results

| Check | Result |
| --- | --- |
| `npm run lint` | **PASS** |
| `npm test` (stable) | **PASS — 287 tests, 287 pass, 0 fail, 77 suites** (was 221) |
| `npm run test:defects` | **11 tests, 6 pass, 5 fail** — BE-004 only, its 5 original failures |
| `test/auth-email-reliability.test.js` alone | **25/25** |
| `test/unit/rate-limit.test.js` alone | **17/17** |
| `test/auth-rate-limit.test.js` alone | **12/12** |
| `test/auth-rate-limit-recovery.test.js` alone | **6/6** |
| `test/auth-rate-limit-ip-layer.test.js` alone | **3/3** |
| Pinned Node 20.20.2: lint / stable / defects | **PASS / 287-287-0 / 6-5** — identical |
| BE-001 regression, live over HTTP | **recipient keeps the task, `createdById` null** |
| `dev.db` | **unchanged** (`47f9178a…`) |

### Independent verification beyond the suite

Against a live server: registration issues an `HttpOnly` cookie and `meta.verificationRequired=false` outside production; duplicate registration 409; wrong password and unknown address return byte-identical 401 messages; eleven failed logins produce 429 while `password-reset/request` (202), `resend-verification` (202), `password-reset/confirm` (400) and `register` (201) all keep working and `/api/tasks` still answers 401; an upper-case variant of the exhausted address is still 429.

Production configuration: refuses to start without `TRUST_PROXY_HOPS`; starts with `0` or `1`; development and test unaffected.

### Problems found during the work, and fixed

| Problem | Resolution |
| --- | --- |
| After a password reset the user still could not sign in | Real defect, found by my own test. Fixed with `clearLoginBudget` — see §3. |
| My first test file had hidden order dependencies: the reset test cleared the budget a later brute-force test asserted on | Restructured so every test owns its account; the three rate-limit concerns are now separate files because limiter counters are process-global. |
| The restructure pushed the file past the 50-request per-IP login ceiling | Split by concern into three files, each comfortably inside the budget and each independently runnable. |
| A lint error in the new fixture | Fixed. |
| A promoted test's name promised more than it asserted | Renamed, and the property it claimed is now genuinely covered by the `ok` mode. |

---

## 6. API contract changes

**One behavioural change, strictly an improvement:**

| Endpoint | Before | After |
| --- | --- | --- |
| `POST /auth/register` (production, delivery fails) | **500** `INTERNAL_ERROR` | **202** `{ data: { user }, meta: { verificationRequired: true } }` |
| `POST /auth/resend-verification` (delivery fails) | **500** | **202**, generic message |
| `POST /auth/password-reset/request` (known address, delivery fails) | **500** | **202**, generic message |

No response **shape** changed: no field was added, removed or retyped. The 202 body is exactly the shape the success path already returned, which is why the frontend needs no change.

429 messages are now per-endpoint in wording (registration, reset and verification each say what they are about) while every *authentication* rejection keeps one shared message. The `RATE_LIMITED` code is unchanged.

Rate-limit budgets changed, which is the point of REF-012. The registration budget is now environment-aware (10/hour in production, 200 elsewhere). That last item overlaps **REF-057** (BE-017); it is delivered here because plan §3.2 — the specification REF-012 points at — prescribes it, and because it is the same line of code. REF-057 should be marked partially delivered rather than re-churning this file later.

---

## 7. Frontend impact

**None.** `app.js`, `index.html`, `styles.css` and `favicon.svg` are byte-identical to the pre-stage backup.

Every value the client branches on still exists and is still produced: `meta.verificationRequired` (`app.js:175`), `INVALID_CREDENTIALS` (181), `EMAIL_NOT_VERIFIED` (184 — the cue that reveals the resend button), `EMAIL_ALREADY_REGISTERED`, `error.details[].path/message` (77), and `error.message` for the 429 path. All three frontend assets still serve `200` from the running server.

The recovery UX in fact gets better without a client change: a user whose verification email silently failed now reaches a working account, and one failed sign-in reveals the resend button.

---

## 8. Remaining risks

| Risk | Severity | Note |
| --- | --- | --- |
| **No version control** | **High** | Unchanged since Stage 1 and still the dominant process risk. This stage changed five application files; recovery depends entirely on `.backups/`. |
| A spent per-IP login budget delays sign-in for everyone behind that address | Medium | Inherent to IP-keyed limiting and the reason the ceiling is 50 rather than 10. Recovery endpoints have their own budgets and stay available — asserted. Mitigated properly only by correct `TRUST_PROXY_HOPS`, which production now must state. |
| IPv6 clients can rotate within their own prefix | Low–medium | `express-rate-limit` 7.x keys on bare `request.ip`; the subnet helper arrived in 8.x. The account layer covers the targeted case. An upgrade is the clean fix. |
| In-memory limiter stores do not survive a restart and are per-instance | Medium | Fine for the single-process SQLite deployment. A multi-instance deployment needs a shared store, which is a deployment decision (plan §16 Q1), not a code defect. |
| A user whose verification email silently fails sees "check your inbox" | Low | Deliberate: the alternative leaks provider state and, under REF-049, account existence. Recovery is one failed sign-in away. Best closed when REF-048 publishes the contract and the client can show a resend prompt proactively. |
| The mail budget withholds a legitimate sixth reset email within an hour | Low | The trade-off against mail-bombing. Five per hour per address is generous; the endpoint itself stays usable. |
| Registration budget relaxed outside production | Low | Deliberate (BE-017). Production remains at 10/hour. |

---

## 9. State after this stage

| Finding | Status |
| --- | --- |
| **BE-001** (CRITICAL) | Fixed in Stage 4, still verified — live and in the suite |
| **BE-002** (HIGH) | **Fixed and regression-guarded** |
| **BE-003** (HIGH) | **Fixed and regression-guarded** |
| BE-004 (HIGH) | **Still open, still independently reproducible** (5 failures) |
| BE-016 | Improved: the reset endpoint is no longer an existence oracle during an outage. The registration 409 remains, gated on REF-049 |
| BE-017 | Partially delivered: the registration budget is environment-aware |

**Stage 6 can begin.** It is REF-013/REF-014 (BE-004: unknown `/api/*` routes answering 401 instead of 404), a routing change with failing regression tests already in place, touching no database and no authentication logic. Approving REF-001 first remains the standing recommendation.
