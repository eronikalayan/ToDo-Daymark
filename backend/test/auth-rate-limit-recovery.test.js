'use strict';

/**
 * A password reset releases the account's login budget (REF-012, finding BE-003).
 *
 * `skipSuccessfulRequests` stops a correct password from consuming budget, but it
 * cannot exempt a request from a budget that is already spent: the limiter rejects
 * before the handler ever sees the password. Without a way out, anyone who knew an
 * address could burn its ten attempts and keep the owner from signing in for the
 * rest of the window — even with a password they had just set. That is the denial
 * of service an account-keyed limit must not become.
 *
 * Consuming a reset token proves control of the mailbox, so it is sound evidence
 * that the owner is present, and the budget is cleared. This file proves the
 * escape hatch works and that it is correctly scoped.
 *
 * It lives apart from test/auth-rate-limit.test.js because it exhausts several
 * account budgets of its own; see the note at the top of that file.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const authService = require('../src/services/auth.service');
const F = require('./helpers/factories');
const { anonymous } = require('./helpers/client');

const client = anonymous(app);
const ACCOUNT_CEILING = 10;

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

/** An account whose login budget has been deliberately exhausted. */
async function lockedOutAccount() {
  const user = await F.createUser();
  const statuses = [];
  for (let attempt = 0; attempt <= ACCOUNT_CEILING; attempt += 1) {
    statuses.push((await client.post('/api/auth/login', { email: user.email, password: 'wrong' })).status);
  }
  assert.ok(statuses.includes(429), `arrangement failed: budget not exhausted (${statuses.join(', ')})`);
  return user;
}

describe('a locked-out user can recover and sign in immediately', () => {
  test('resetting the password releases the login budget', async () => {
    const user = await lockedOutAccount();

    const reset = await authService.createPasswordReset(user.email);
    assert.ok(reset, 'a reset token must be issued');

    const confirmed = await client.post('/api/auth/password-reset/confirm', {
      token: reset.token,
      password: 'recovered-password-77'
    });
    assert.equal(confirmed.status, 204);

    const signedIn = await client.post('/api/auth/login', {
      email: user.email,
      password: 'recovered-password-77'
    });
    assert.equal(signedIn.status, 200, 'a just-reset password must work immediately, not after the window expires');
    assert.match(signedIn.headers['set-cookie'][0], /HttpOnly/i);
  });

  test('the old password is still rejected on its merits, not with a 429', async () => {
    const user = await lockedOutAccount();
    const reset = await authService.createPasswordReset(user.email);
    await client.post('/api/auth/password-reset/confirm', { token: reset.token, password: 'another-new-password-88' });

    const response = await client.post('/api/auth/login', { email: user.email, password: user.password });
    assert.equal(response.status, 401, 'the superseded password must fail as a credential, not as a rate limit');
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  });

  test('releasing a budget is scoped to the account that was reset', async () => {
    const stillLocked = await lockedOutAccount();
    const other = await F.createUser();

    const reset = await authService.createPasswordReset(other.email);
    const confirmed = await client.post('/api/auth/password-reset/confirm', {
      token: reset.token,
      password: 'unrelated-password-55'
    });
    assert.equal(confirmed.status, 204);

    const blocked = await client.post('/api/auth/login', { email: stillLocked.email, password: 'wrong' });
    assert.equal(blocked.status, 429, "resetting one account must not clear another account's budget");
  });

  test('a failed reset does not release anything', async () => {
    // Only a CONSUMED token counts as proof of mailbox control. An invalid token
    // must leave the budget exactly as it was.
    const user = await lockedOutAccount();

    const rejected = await client.post('/api/auth/password-reset/confirm', {
      token: 'x'.repeat(40),
      password: 'should-not-apply-99'
    });
    assert.equal(rejected.status, 400);

    const blocked = await client.post('/api/auth/login', { email: user.email, password: 'wrong' });
    assert.equal(blocked.status, 429, 'an invalid reset attempt must not clear the budget');
  });

  test('a replayed reset token does not release the budget a second time', async () => {
    const user = await lockedOutAccount();
    const reset = await authService.createPasswordReset(user.email);

    assert.equal(
      (await client.post('/api/auth/password-reset/confirm', { token: reset.token, password: 'first-new-password-11' })).status,
      204
    );

    // Spend the budget again, then replay the already-used token.
    for (let attempt = 0; attempt <= ACCOUNT_CEILING; attempt += 1) {
      await client.post('/api/auth/login', { email: user.email, password: 'wrong' });
    }
    const replay = await client.post('/api/auth/password-reset/confirm', {
      token: reset.token,
      password: 'second-new-password-22'
    });
    assert.equal(replay.status, 400, 'single use is preserved');

    const blocked = await client.post('/api/auth/login', { email: user.email, password: 'first-new-password-11' });
    assert.equal(blocked.status, 429, 'a replayed token must not clear the budget');
  });
});

describe('the reset flow itself is unchanged', () => {
  test('every session is still revoked by a reset', async () => {
    const user = await F.createSignedInUser();
    const sessionCookie = user.cookie;

    const reset = await authService.createPasswordReset(user.email);
    assert.equal(
      (await client.post('/api/auth/password-reset/confirm', { token: reset.token, password: 'revoking-password-33' })).status,
      204
    );

    const me = await require('supertest')(app).get('/api/auth/me').set('Cookie', sessionCookie);
    assert.equal(me.status, 401, 'pre-reset sessions must still be revoked');
  });
});
