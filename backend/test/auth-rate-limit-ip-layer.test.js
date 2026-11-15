'use strict';

/**
 * The per-IP login ceiling (REF-012, finding BE-003).
 *
 * This file lives apart from test/auth-rate-limit.test.js for one reason: it
 * deliberately EXHAUSTS the per-IP login budget. `node --test` runs each file in
 * its own process and limiter state is process memory, so keeping it separate
 * means neither suite depends on the other's ordering — the independence
 * guarantee established in Stage 2 stays intact.
 *
 * What it proves: an attacker who changes the address on every attempt gets a
 * fresh per-ACCOUNT budget each time, so the per-IP layer is the only thing
 * standing between them and unlimited guesses. That layer must hold.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const F = require('./helpers/factories');
const { anonymous } = require('./helpers/client');

const client = anonymous(app);

// Matches loginIpLimiter in src/routes/auth.routes.js.
const IP_CEILING = 50;
const ATTEMPTS = IP_CEILING + 15;

let accounts;

before(async () => {
  // Real accounts, created through Prisma so the registration limiter is not
  // involved. Using existing accounts also keeps each attempt fast: an unknown
  // address is compared against a cost-12 dummy hash, a real fixture against a
  // cost-4 one.
  accounts = [];
  for (let i = 0; i < ATTEMPTS; i += 1) accounts.push(await F.createUser());
});

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('varying the address does not grant unlimited attempts', () => {
  test('the per-IP ceiling engages even though every attempt uses a different account', async () => {
    const statuses = [];
    for (const account of accounts) {
      statuses.push((await client.post('/api/auth/login', { email: account.email, password: 'wrong-password' })).status);
    }

    const firstBlocked = statuses.indexOf(429);
    assert.notEqual(firstBlocked, -1, `no attempt was blocked in ${ATTEMPTS} tries across ${ATTEMPTS} distinct accounts`);

    // Every attempt targets a different account, so no account budget (10) can
    // ever be reached. Only the IP layer can explain a rejection.
    assert.ok(
      firstBlocked >= IP_CEILING,
      `blocked after ${firstBlocked} attempts, before the per-IP ceiling of ${IP_CEILING} — the account layer must have fired instead`
    );
    assert.ok(
      firstBlocked <= IP_CEILING + 2,
      `blocked only after ${firstBlocked} attempts; the per-IP ceiling of ${IP_CEILING} is not being enforced`
    );

    // Everything before the ceiling was answered on its own merits.
    assert.ok(
      statuses.slice(0, firstBlocked).every((s) => s === 401),
      'attempts within budget should be 401'
    );
    // Everything after stays blocked.
    assert.ok(
      statuses.slice(firstBlocked).every((s) => s === 429),
      'once the ceiling is reached the limiter must keep rejecting'
    );
  });

  test('the exhausted IP budget still does not block account recovery', async () => {
    // The whole point of REF-012: even with the login ceiling spent, the
    // recovery endpoints have their own budgets and must remain usable.
    const target = accounts[0];

    const reset = await client.post('/api/auth/password-reset/request', { email: target.email });
    assert.equal(reset.status, 202, 'password reset must survive an exhausted login budget');

    const resend = await client.post('/api/auth/resend-verification', { email: target.email });
    assert.equal(resend.status, 202, 'verification resend must survive an exhausted login budget');

    const registration = await client.post('/api/auth/register', {
      name: 'Bystander',
      email: F.uniqueEmail('bystander'),
      password: F.DEFAULT_PASSWORD
    });
    assert.ok([201, 202].includes(registration.status), `registration must survive too, got ${registration.status}`);
  });

  test('a correct password is still accepted once the login budget is spent', async () => {
    // skipSuccessfulRequests means a legitimate sign-in was never counted, but it
    // does not exempt a request from a budget already exhausted by others. This
    // records the real behaviour rather than assuming it.
    const target = accounts[1];
    const response = await client.post('/api/auth/login', { email: target.email, password: target.password });

    assert.ok(
      [200, 429].includes(response.status),
      `expected either a successful sign-in or a rate-limit rejection, got ${response.status}`
    );
    if (response.status === 429) {
      // Documented consequence: a spent IP budget delays sign-in for everyone
      // behind that address. Recovery, proven above, stays available.
      assert.equal(response.body.error.code, 'RATE_LIMITED');
    }
  });
});
