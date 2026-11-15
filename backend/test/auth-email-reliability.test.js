'use strict';

/**
 * Registration and email-delivery reliability — the permanent guard for BE-002.
 *
 * `authService.register` used to commit the account and then let the controller
 * send the verification email. A provider outage surfaced as a 500 while the row
 * was already committed, leaving an address that could not be registered again
 * (409), could not sign in (403) and could not be recovered, because
 * `resend-verification` called the same broken provider and failed identically.
 *
 * REF-011 moved delivery into the service and made it non-throwing: account
 * creation is durable, delivery is retryable, and the retryable step can no
 * longer reject the durable one.
 *
 * These tests began as failing assertions in test/known-defects/ and now live in
 * the stable suite. The production-only paths run in a child process with
 * `globalThis.fetch` stubbed, so no email is sent and no credential is used.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app } = require('../src/app');
const authService = require('../src/services/auth.service');
const F = require('./helpers/factories');
const { asUser, anonymous } = require('./helpers/client');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'production-registration.js');

/** Run the production-simulation fixture in one of its provider modes. */
function runFixture(mode) {
  const email = F.uniqueEmail(`prod-${mode}`);
  const result = spawnSync(process.execPath, [FIXTURE, email, mode], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,

      // Production code paths, with the guard's explicit opt-in. Every database
      // check in the guard still applies.
      NODE_ENV: 'production',
      DAYMARK_TEST_SIMULATE_PRODUCTION: '1',
      DATABASE_URL: 'file:./prisma/test.db',

      // Production configuration validation requires each of these.
      JWT_SECRET: `simulated-production-secret-${'x'.repeat(48)}`,
      APP_BASE_URL: 'https://daymark.invalid',
      CORS_ORIGIN: 'https://daymark.invalid',
      SERVE_FRONTEND: 'false',
      TRUST_PROXY_HOPS: '0',

      // Never contacted: globalThis.fetch is stubbed before the app is imported.
      EMAIL_PROVIDER_URL: 'https://provider.invalid/send',
      EMAIL_PROVIDER_TOKEN: 'placeholder-not-a-real-credential',
      EMAIL_FROM: 'noreply@daymark.invalid'
    }
  });

  const match = /__OBSERVATIONS__(.*)__END__/s.exec(result.stdout ?? '');
  assert.ok(match, `fixture produced no observations.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const observed = JSON.parse(match[1]);
  assert.equal(observed.fixtureError, undefined, `fixture errored: ${observed.fixtureError}`);
  return { observed, email, output: `${result.stdout}${result.stderr}` };
}

const runs = {};

before(() => {
  // Each mode is one child process, reused across the assertions below.
  for (const mode of ['ok', 'network-error', 'http-500', 'fail-then-ok']) {
    runs[mode] = runFixture(mode);
  }
});

after(async () => {
  for (const run of Object.values(runs)) {
    if (run?.email) await F.prisma.user.deleteMany({ where: { email: run.email } });
  }
  await F.prisma.user.deleteMany({ where: { email: { startsWith: 'absent-' } } });
  await F.cleanup();
  await F.disconnect();
});

describe('successful delivery', () => {
  test('registration is accepted, the email goes out, and no session is issued', () => {
    const { observed } = runs.ok;
    assert.equal(observed.registerStatus, 202);
    assert.equal(observed.registerBody.meta.verificationRequired, true);
    assert.equal(observed.deliveriesAfterRegister, 1, 'exactly one verification email');
    assert.equal(observed.registerSetCookie, false, 'an unverified account must never get a session');
    assert.equal(observed.userVerified, false);
  });

  test('the delivered link verifies the account, which can then sign in', () => {
    const { observed } = runs.ok;
    assert.equal(observed.verificationLinkCaptured, true);
    assert.equal(observed.verifyStatus, 200);
    assert.deepEqual(observed.verifyMeta, { verified: true });
    assert.equal(observed.loginAfterVerifyStatus, 200);
    assert.equal(observed.loginAfterVerifySetCookie, true, 'a verified account does get a session');
  });

  test('only the verification email is sent during registration', () => {
    assert.deepEqual(runs.ok.observed.subjectsDelivered.slice(0, 1), ['Verify your Daymark email']);
  });
});

describe('failed delivery must not damage the account', () => {
  for (const mode of ['network-error', 'http-500']) {
    describe(`provider failure mode: ${mode}`, () => {
      test('registration is still accepted, not a 500', () => {
        const { observed } = runs[mode];
        assert.notEqual(observed.registerStatus, 500, 'a provider outage must not become a server error');
        assert.equal(observed.registerStatus, 202);
        assert.equal(observed.registerBody.meta.verificationRequired, true);
      });

      test('the account exists and is unverified', () => {
        const { observed } = runs[mode];
        assert.equal(observed.userRowCreated, true);
        assert.equal(observed.userVerified, false);
      });

      test('no session is issued', () => {
        assert.equal(runs[mode].observed.registerSetCookie, false);
      });

      test('the response is byte-identical to the successful-delivery response', () => {
        // Provider health must not be observable: otherwise the response becomes
        // a signal about infrastructure, and under REF-049 (generic registration)
        // it could become an account-existence signal.
        assert.deepEqual(runs[mode].observed.registerBody.meta, runs.ok.observed.registerBody.meta);
        assert.equal(runs[mode].observed.registerStatus, runs.ok.observed.registerStatus);
      });

      test('recovery stays available: resend-verification still answers 202', () => {
        const { observed } = runs[mode];
        assert.notEqual(observed.resendStatus, 500);
        assert.equal(observed.resendStatus, 202);
      });

      test('no secret or provider detail leaks into the logs', () => {
        const { output } = runs[mode];
        assert.match(output, /email-delivery:verification/, 'the failure must be logged');
        assert.doesNotMatch(output, /placeholder-not-a-real-credential/);
        assert.doesNotMatch(output, /provider\.invalid/);
        assert.doesNotMatch(output, /JWT_SECRET|simulated-production-secret/);
      });
    });
  }
});

describe('retry and recovery after a transient outage', () => {
  test('a resend once the provider recovers delivers a working link', () => {
    const { observed } = runs['fail-then-ok'];
    assert.equal(observed.registerStatus, 202, 'registration happened during the outage');
    assert.equal(observed.deliveriesAfterRegister, 0, 'nothing was delivered during the outage');
    assert.equal(observed.resendStatus, 202);
    assert.equal(observed.deliveriesAfterResend, 1, 'the resend delivered once the provider returned');
    assert.equal(observed.verificationLinkCaptured, true);
  });

  test('the account is fully usable afterwards', () => {
    const { observed } = runs['fail-then-ok'];
    assert.equal(observed.verifyStatus, 200);
    assert.equal(observed.loginAfterVerifyStatus, 200);
    assert.equal(observed.loginAfterVerifySetCookie, true);
  });
});

describe('duplicate registration', () => {
  test('a second registration of the same address is rejected, outage or not', () => {
    for (const mode of ['ok', 'network-error', 'http-500']) {
      assert.equal(runs[mode].observed.reRegisterStatus, 409, `mode ${mode}`);
      assert.equal(runs[mode].observed.reRegisterCode, 'EMAIL_ALREADY_REGISTERED', `mode ${mode}`);
    }
  });

  test('duplicate detection is unaffected outside production too', async () => {
    const existing = await F.createUser();
    const response = await anonymous(app).post('/api/auth/register', {
      name: 'Duplicate',
      email: existing.email,
      password: F.DEFAULT_PASSWORD
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'EMAIL_ALREADY_REGISTERED');
  });
});

describe('unverified accounts cannot authenticate', () => {
  test('login is refused with EMAIL_NOT_VERIFIED and no cookie', () => {
    for (const mode of ['ok', 'network-error', 'http-500']) {
      assert.equal(runs[mode].observed.loginStatus, 403, `mode ${mode}`);
      assert.equal(runs[mode].observed.loginCode, 'EMAIL_NOT_VERIFIED', `mode ${mode}`);
      assert.equal(runs[mode].observed.loginSetCookie, false, `mode ${mode}`);
    }
  });
});

describe('password reset stays enumeration-safe during an outage', () => {
  test('a known and an unknown address get identical answers even when delivery fails', () => {
    // Before REF-011 an unknown address returned 202 while a known address whose
    // delivery failed returned 500, so a provider outage leaked which addresses
    // were registered.
    for (const mode of ['network-error', 'http-500', 'fail-then-ok']) {
      const { resetKnown, resetUnknown } = runs[mode].observed;
      assert.equal(resetKnown.status, 202, `mode ${mode}: known address`);
      assert.equal(resetUnknown.status, 202, `mode ${mode}: unknown address`);
      assert.deepEqual(resetKnown.body, resetUnknown.body, `mode ${mode}: bodies must match`);
    }
  });
});

describe('the non-production path is unchanged', () => {
  test('registration verifies immediately and returns a session', async () => {
    const email = F.uniqueEmail('dev-register');
    const response = await anonymous(app).post('/api/auth/register', {
      name: 'Dev User',
      email,
      password: F.DEFAULT_PASSWORD
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.meta.verificationRequired, false);
    assert.match(response.headers['set-cookie'][0], /HttpOnly/i);

    const created = await F.prisma.user.findUnique({ where: { email } });
    assert.notEqual(created.emailVerifiedAt, null, 'outside production the account starts verified');
    await F.prisma.user.delete({ where: { id: created.id } });
  });

  test('resend-verification answers 202 for unknown, verified and unverified addresses alike', async () => {
    const unverified = await F.createUser({ emailVerifiedAt: null });
    const verified = await F.createUser();
    const client = anonymous(app);

    for (const [label, email] of [
      ['unknown', F.uniqueEmail('nobody')],
      ['verified', verified.email],
      ['unverified', unverified.email]
    ]) {
      const response = await client.post('/api/auth/resend-verification', { email });
      assert.equal(response.status, 202, label);
      assert.deepEqual(response.body, {
        data: { message: 'If that account needs verification, a link will be sent.' }
      }, label);
    }
  });

  test('a verification token still verifies an unverified account end to end', async () => {
    const user = await F.createUser({ emailVerifiedAt: null });
    const token = authService.createEmailVerificationToken(user.id);

    const verified = await anonymous(app).get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.meta.verified, true);

    const replay = await anonymous(app).get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    assert.equal(replay.status, 400, 'single use is preserved');
  });

  test('an existing session is unaffected by any of this', async () => {
    const user = await F.createSignedInUser();
    assert.equal((await asUser(app, user).get('/api/auth/me')).status, 200);
  });
});
