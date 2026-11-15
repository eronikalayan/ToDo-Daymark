'use strict';

/**
 * Rate-limit factories (REF-012, audit finding BE-003).
 *
 * WHY FACTORIES
 * -------------
 * `express-rate-limit` keeps one counter store per limiter *instance*. Mounting a
 * single instance on several routes therefore makes them share a budget, and the
 * library emits no warning about it. That is how ten failed logins came to lock a
 * user out of registration, password reset and verification resend — exactly the
 * endpoints they needed next.
 *
 * Every function here returns a NEW instance, so each route gets its own store.
 *
 * WHY LAYERED, NOT COMPOSITE
 * --------------------------
 * A composite `ip + email` key was measured to be trivially bypassable: after a
 * budget was exhausted for one address, switching address — or merely changing its
 * case — produced a fresh budget. That is weaker than IP alone against spraying
 * and weaker than an account key against targeted brute force.
 *
 * Instead, two independent layers are applied and both must pass:
 *
 *   perIp       a generous ceiling that survives address variation; the only
 *               layer that constrains credential spraying across many accounts.
 *   perAccount  a strict ceiling that survives IP rotation; the only layer that
 *               constrains a targeted attack from many sources.
 *
 * AVOIDING A DENIAL OF SERVICE ON THE VICTIM
 * ------------------------------------------
 * An account-keyed limiter is itself an attack surface: filling a victim's budget
 * could lock the victim out. Two things keep that bounded:
 *
 *   • `skipSuccessfulRequests` on login, so a legitimate sign-in never consumes
 *     budget and normal use cannot reach the ceiling;
 *   • recovery endpoints never *reject* on an account key. They use
 *     `perAccountSoftLimit`, which suppresses the outbound email and still lets
 *     the route answer normally. An attacker can stop a victim being mail-bombed
 *     but can never stop them requesting a password reset.
 */

const rateLimit = require('express-rate-limit');
const { AppError } = require('../utils/app-error');

/**
 * Normalise an address exactly as `auth.schemas.js` does.
 *
 * Limiters run BEFORE `validate`, so `request.body.email` is still raw: untrimmed,
 * mixed case, possibly absent or not a string. Without normalising here, `A@x.com`
 * and `a@x.com` would occupy different buckets and the account layer could be
 * side-stepped by changing capitalisation.
 */
function accountKey(request) {
  const raw = request.body?.email;
  if (typeof raw !== 'string') return null;
  const normalised = raw.trim().toLowerCase();
  return normalised.length > 0 ? normalised : null;
}

/**
 * All 429 responses share one message on purpose. Saying "too many attempts for
 * this account" would confirm that the account exists, so the account layer and
 * the IP layer are indistinguishable to the caller.
 */
function rejectWith(message, code = 'RATE_LIMITED') {
  return (request, response, next) => next(new AppError(429, message, code));
}

const SHARED = {
  standardHeaders: 'draft-7',
  legacyHeaders: false
  // `validate` is deliberately left at its default (enabled). It is what surfaces
  // ERR_ERL_PERMISSIVE_TRUST_PROXY and ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, which
  // catch a misconfigured reverse proxy. Never switch it off to quieten startup.
};

/**
 * Per-IP ceiling. Rejects with 429 when exceeded.
 *
 * Note: this keys on `request.ip`, which is what `express-rate-limit` 7.x uses by
 * default. Its IPv6 subnet helper arrived in 8.x, so an IPv6 client can still
 * rotate within its own prefix. The account layer is what covers that case.
 */
function perIpLimit({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    ...SHARED,
    windowMs,
    limit,
    skipSuccessfulRequests,
    keyGenerator: (request) => `ip:${request.ip}`,
    handler: rejectWith(message)
  });
}

/**
 * Per-account ceiling keyed on the normalised address. Rejects with 429.
 *
 * Skipped entirely when the request carries no usable address, so a malformed body
 * cannot crash the limiter or collapse every caller into one shared bucket — the
 * per-IP layer still applies in that case.
 */
function perAccountLimit({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    ...SHARED,
    windowMs,
    limit,
    skipSuccessfulRequests,
    skip: (request) => accountKey(request) === null,
    keyGenerator: (request) => `acct:${accountKey(request)}`,
    handler: rejectWith(message)
  });
}

/**
 * Per-account budget for OUTBOUND EMAIL that never rejects the request.
 *
 * On exceeding the budget it sets `request.emailDeliverySuppressed = true` and
 * calls `next()`. The route runs normally and returns its usual generic response;
 * only the email is withheld.
 *
 * This is what stops an account-keyed limit becoming a denial-of-service: a third
 * party can prevent a victim from being mail-bombed, but cannot prevent the victim
 * from using the endpoint. It also preserves the anti-enumeration property, since
 * the response body and status do not change when the budget is spent.
 */
function perAccountSoftLimit({ windowMs, limit }) {
  return rateLimit({
    ...SHARED,
    windowMs,
    limit,
    skip: (request) => accountKey(request) === null,
    keyGenerator: (request) => `mail:${accountKey(request)}`,
    handler: (request, response, next) => {
      request.emailDeliverySuppressed = true;
      next();
    }
  });
}

/** Per-authenticated-user ceiling. More precise than IP for signed-in traffic. */
function perUserLimit({ windowMs, limit, message }) {
  return rateLimit({
    ...SHARED,
    windowMs,
    limit,
    keyGenerator: (request) => (request.user ? `user:${request.user.id}` : `ip:${request.ip}`),
    handler: rejectWith(message)
  });
}

// ---------------------------------------------------------------------------
//  Login budgets
// ---------------------------------------------------------------------------
// These two are module-level singletons rather than being built in the route
// file, because the password-reset flow has to be able to CLEAR an account's
// login budget, and the module that owns the state should own the reset.
//
// Why clearing matters: `skipSuccessfulRequests` stops a correct password from
// consuming budget, but it cannot exempt a request from a budget that is
// already spent — the limiter rejects before the handler ever sees the
// password. Without a way out, anyone who knows an address could burn its ten
// attempts and keep the owner from signing in for fifteen minutes, even
// immediately after a successful password reset. That is the denial of service
// an account-keyed limit must not become.
//
// A reset token proves control of the mailbox, so consuming one is sound
// evidence that the account's owner is present. Clearing the budget then makes
// the recovery path complete: reset the password, sign in at once.

const MINUTE = 60 * 1000;
const QUARTER_HOUR = 15 * MINUTE;

// One generic message for every authentication rejection: distinguishing "too
// many attempts from your address" from "too many attempts for this account"
// would confirm that the account exists.
const AUTH_RATE_LIMIT_MESSAGE = 'Too many authentication attempts. Try again later.';

const loginIpLimiter = perIpLimit({
  windowMs: QUARTER_HOUR,
  limit: 50,
  message: AUTH_RATE_LIMIT_MESSAGE,
  skipSuccessfulRequests: true
});

const loginAccountLimiter = perAccountLimit({
  windowMs: QUARTER_HOUR,
  limit: 10,
  message: AUTH_RATE_LIMIT_MESSAGE,
  skipSuccessfulRequests: true
});

/**
 * Clear one account's login budget. Called after a password reset is consumed.
 * Never throws: failing to clear a budget must not fail the reset itself.
 */
async function clearLoginBudget(email) {
  const key = accountKey({ body: { email } });
  if (!key) return;
  try {
    await loginAccountLimiter.resetKey(`acct:${key}`);
  } catch (error) {
    console.error({ context: 'rate-limit:clear-login-budget', errorName: error?.name || 'Error' });
  }
}

module.exports = {
  accountKey,
  perIpLimit,
  perAccountLimit,
  perAccountSoftLimit,
  perUserLimit,
  AUTH_RATE_LIMIT_MESSAGE,
  loginIpLimiter,
  loginAccountLimiter,
  clearLoginBudget
};
