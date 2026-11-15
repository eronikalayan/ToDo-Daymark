'use strict';

/**
 * Authentication rate-limit isolation — the permanent guard for BE-003.
 *
 * A single `loginLimiter` instance used to be mounted on five auth routes.
 * `express-rate-limit` keeps one counter store per instance, so ten failed
 * logins locked the user out of registration, password reset, reset confirmation
 * and verification resend — precisely the endpoints they needed next. The library
 * emits no warning for this shape, so only a test catches it.
 *
 * REF-012 gave every route its own instance and layered a generous per-IP ceiling
 * with a strict per-account ceiling.
 *
 * WHY THE RATE-LIMIT TESTS ARE SPLIT ACROSS THREE FILES
 * -----------------------------------------------------
 * Limiter counters live in process memory and the per-IP login ceiling is 50 per
 * 15 minutes, which is a budget shared by every test in a file. `node --test`
 * runs each file in its own process, so splitting by concern is what keeps each
 * test independent of the others' ordering:
 *
 *   auth-rate-limit.test.js           isolation between endpoints, and the
 *                                     per-account layer  (~37 login attempts)
 *   auth-rate-limit-recovery.test.js  a reset releases the account budget
 *   auth-rate-limit-ip-layer.test.js  the per-IP ceiling, which it exhausts
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { anonymous } = require('./helpers/client');

const client = anonymous(app);

// Matches loginAccountLimiter in src/middleware/rate-limit.js.
const ACCOUNT_CEILING = 10;

/** Fail `attempts` logins for one address and return the statuses observed. */
async function failLogins(email, attempts) {
  const statuses = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await client.post('/api/auth/login', { email, password: `wrong-password-${attempt}` });
    statuses.push(response.status);
  }
  return statuses;
}

let victim;

before(async () => {
  victim = await F.createUser();
  // Exhaust the login budget for ONE account, exactly as a user who has
  // forgotten their password would.
  const statuses = await failLogins(victim.email, ACCOUNT_CEILING + 1);
  assert.ok(
    statuses.includes(429),
    `arrangement failed: the login limiter never engaged (statuses: ${statuses.join(', ')})`
  );
});

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('failed logins must not consume other endpoints\' budgets', () => {
  test('password reset can still be requested', async () => {
    const response = await client.post('/api/auth/password-reset/request', { email: victim.email });
    assert.notEqual(response.status, 429, 'a user who failed to log in must still be able to reset');
    assert.equal(response.status, 202);
  });

  test('a password reset can still be confirmed', async () => {
    // A rejected token is fine: the point is that the endpoint is reachable.
    const response = await client.post('/api/auth/password-reset/confirm', {
      token: 'x'.repeat(40),
      password: 'brand-new-password-99'
    });
    assert.notEqual(response.status, 429);
    assert.equal(response.status, 400, 'an invalid token should be rejected on its own merits');
  });

  test('verification email can still be resent', async () => {
    const response = await client.post('/api/auth/resend-verification', { email: victim.email });
    assert.notEqual(response.status, 429);
    assert.equal(response.status, 202);
  });

  test('an unrelated visitor can still register', async () => {
    const response = await client.post('/api/auth/register', {
      name: 'Unrelated Visitor',
      email: F.uniqueEmail('unrelated'),
      password: F.DEFAULT_PASSWORD
    });
    assert.notEqual(response.status, 429, "one user's failed logins must not stop anyone signing up");
    assert.ok([201, 202].includes(response.status), `expected a successful registration, got ${response.status}`);
  });

  test('unrelated resources are untouched', async () => {
    const response = await client.get('/api/tasks');
    assert.equal(response.status, 401, 'an unauthenticated task request should be 401, not 429');
  });
});

describe('brute-force protection is preserved', () => {
  test('further wrong-password attempts on an exhausted account are blocked', async () => {
    const response = await client.post('/api/auth/login', { email: victim.email, password: 'wrong-again' });
    assert.equal(response.status, 429, 'brute-force protection on login itself must not be weakened');
  });

  test('the rejection reveals neither the layer nor the account', async () => {
    // One generic message for every authentication rejection. Saying "too many
    // attempts for this account" would confirm the account exists. (The
    // layer-indistinguishability property itself is proven in
    // test/unit/rate-limit.test.js, which can exhaust both layers cheaply.)
    const response = await client.post('/api/auth/login', { email: victim.email, password: 'wrong' });
    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, 'RATE_LIMITED');
    assert.equal(response.body.error.message, 'Too many authentication attempts. Try again later.');
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
  });
});

describe('the per-account layer cannot be escaped by varying the address', () => {
  test('case and whitespace variants share one budget', async () => {
    const target = await F.createUser();
    const variants = [
      target.email,
      target.email.toUpperCase(),
      `  ${target.email}  `,
      target.email.replace(/^./, (c) => c.toUpperCase())
    ];

    // Ten attempts spread across the variants fill a single bucket.
    const statuses = [];
    for (let attempt = 0; attempt < ACCOUNT_CEILING; attempt += 1) {
      const email = variants[attempt % variants.length];
      statuses.push((await client.post('/api/auth/login', { email, password: 'wrong' })).status);
    }
    assert.ok(statuses.every((s) => s === 401), `expected all 401 while within budget, got ${statuses.join(', ')}`);

    // The eleventh is blocked whichever spelling is used.
    const blockedLower = await client.post('/api/auth/login', { email: target.email, password: 'wrong' });
    assert.equal(blockedLower.status, 429, 'the canonical spelling escaped the account budget');
    const blockedUpper = await client.post('/api/auth/login', { email: target.email.toUpperCase(), password: 'wrong' });
    assert.equal(blockedUpper.status, 429, 'an upper-case variant escaped the account budget');
  });
});

describe('a correct password does not consume the account budget', () => {
  test('successful logins are not counted', async () => {
    const user = await F.createUser();

    // Nine failures put the account one below its ceiling of ten.
    const failures = await failLogins(user.email, ACCOUNT_CEILING - 1);
    assert.ok(failures.every((s) => s === 401), `unexpected statuses: ${failures.join(', ')}`);

    // Three successful logins. If these counted, the budget would be at twelve.
    for (let i = 0; i < 3; i += 1) {
      const ok = await client.post('/api/auth/login', { email: user.email, password: user.password });
      assert.equal(ok.status, 200, `successful login ${i + 1}`);
    }

    // Still within budget, so a further failure is answered on its own merits.
    const next = await client.post('/api/auth/login', { email: user.email, password: 'wrong' });
    assert.equal(next.status, 401, 'successful logins must not have consumed budget');
  });
});

describe('recovery endpoints are never rejected on an account key', () => {
  test('repeated reset requests keep answering 202, so a third party cannot lock the owner out', async () => {
    const target = await F.createUser();

    // Well past the per-account mail budget of five. The email is withheld, but
    // the endpoint must stay usable and the answer must not change.
    const responses = [];
    for (let i = 0; i < 9; i += 1) {
      responses.push(await client.post('/api/auth/password-reset/request', { email: target.email }));
    }

    assert.ok(responses.every((r) => r.status === 202), `statuses: ${responses.map((r) => r.status).join(', ')}`);
    assert.equal(
      new Set(responses.map((r) => JSON.stringify(r.body))).size,
      1,
      'the response body must not change once the mail budget is spent'
    );
  });

  test('repeated resend-verification requests behave the same way', async () => {
    const target = await F.createUser({ emailVerifiedAt: null });
    const responses = [];
    for (let i = 0; i < 9; i += 1) {
      responses.push(await client.post('/api/auth/resend-verification', { email: target.email }));
    }
    assert.ok(responses.every((r) => r.status === 202));
    assert.equal(new Set(responses.map((r) => JSON.stringify(r.body))).size, 1);
  });

  test('a spent mail budget for one address does not affect another', async () => {
    const other = await F.createUser();
    const response = await client.post('/api/auth/password-reset/request', { email: other.email });
    assert.equal(response.status, 202);
  });
});
