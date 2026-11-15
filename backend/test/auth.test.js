'use strict';

// REF-007 — authentication suite, split out of the original test/api.test.js.
// Every authentication assertion from that file is preserved here; see
// docs/audit/IMPLEMENTATION_STAGE_02.md for the full mapping.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/app');
const authService = require('../src/services/auth.service');
const F = require('./helpers/factories');
const { asUser, anonymous, request } = require('./helpers/client');

// `POST /api/auth/register` is limited to 5 requests per hour per IP in every
// environment (BE-017), and the limiter runs before validation, so even a 422
// consumes budget. This file therefore makes exactly 3 registration requests;
// every other user comes from a factory.
const client = anonymous(app);

after(async () => {
  await F.cleanup();
  await F.disconnect();
});

describe('session bootstrap', () => {
  test('an unauthenticated session request returns a null user, not a 401', async () => {
    const response = await client.get('/api/auth/session');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user, null);
  });

  test('an invalid cookie is treated as signed out rather than rejected', async () => {
    const response = await request(app).get('/api/auth/session').set('Cookie', 'daymark_session=garbage');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user, null);
  });
});

describe('registration', () => {
  test('creates an account, starts a session and never returns the password hash', async () => {
    const email = F.uniqueEmail('register');
    const response = await client.post('/api/auth/register', {
      name: 'Test Owner',
      email,
      password: F.DEFAULT_PASSWORD
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.user.name, 'Test Owner');
    assert.equal('passwordHash' in response.body.data.user, false);
    assert.match(response.headers['set-cookie'][0], /HttpOnly/i);

    // Registered through HTTP, so register it for cleanup explicitly.
    const created = await F.prisma.user.findUnique({ where: { email } });
    assert.ok(created);
    await F.prisma.user.delete({ where: { id: created.id } });
  });

  test('rejects a duplicate email with 409', async () => {
    const existing = await F.createUser();
    const response = await client.post('/api/auth/register', {
      name: 'Duplicate',
      email: existing.email,
      password: F.DEFAULT_PASSWORD
    });
    assert.equal(response.status, 409);
  });

  test('rejects an invalid email and a short password with 422', async () => {
    const response = await client.post('/api/auth/register', {
      name: 'Bad',
      email: 'not-an-email',
      password: 'short'
    });
    assert.equal(response.status, 422);
  });
});

describe('login', () => {
  test('succeeds with correct credentials', async () => {
    const user = await F.createUser();
    const response = await client.post('/api/auth/login', { email: user.email, password: user.password });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.email, user.email);
  });

  test('returns one generic error for an unknown email', async () => {
    const response = await client.post('/api/auth/login', {
      email: F.uniqueEmail('missing'),
      password: F.DEFAULT_PASSWORD
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, 'Invalid email or password');
  });

  test('returns the same generic error for a wrong password, so accounts cannot be discovered', async () => {
    const user = await F.createUser();
    const response = await client.post('/api/auth/login', { email: user.email, password: 'wrong-password-entirely' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, 'Invalid email or password');
  });
});

describe('current user', () => {
  test('returns the signed-in user', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/auth/me');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.email, user.email);
  });

  test('requires authentication', async () => {
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });

  test('exposes only allowlisted fields', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).get('/api/auth/me');
    assert.deepEqual(Object.keys(response.body.data.user).sort(), ['createdAt', 'email', 'id', 'name', 'updatedAt']);
  });
});

describe('logout', () => {
  test('revokes the session server-side, so the cookie stops working', async () => {
    const user = await F.createSignedInUser();
    const session = asUser(app, user);

    assert.equal((await session.get('/api/auth/me')).status, 200);
    assert.equal((await session.post('/api/auth/logout')).status, 204);

    // The same cookie must now be rejected: logout is a real revocation, not
    // merely a cookie deletion on the client.
    assert.equal((await session.get('/api/auth/me')).status, 401);
    assert.equal((await session.get('/api/auth/session')).body.data.user, null);

    const row = await F.prisma.session.findUnique({ where: { id: user.session.id } });
    assert.ok(row.revokedAt, 'the session row must be marked revoked');
  });

  test('succeeds even without a session', async () => {
    assert.equal((await client.post('/api/auth/logout')).status, 204);
  });
});

describe('password reset', () => {
  test('responds identically for known and unknown addresses', async () => {
    const user = await F.createUser();
    const known = await client.post('/api/auth/password-reset/request', { email: user.email });
    const unknown = await client.post('/api/auth/password-reset/request', { email: F.uniqueEmail('nobody') });

    assert.equal(known.status, 202);
    assert.deepEqual(unknown.body, known.body);
  });

  test('changes the password, revokes every session, and cannot be replayed', async () => {
    const user = await F.createSignedInUser();
    const nextPassword = 'new-correct-password-88';

    // A second, independent session proves the reset revokes all of them.
    const otherSession = await F.createSession(user.id);

    const reset = await authService.createPasswordReset(user.email);
    assert.ok(reset, 'a reset token must be issued for a known account');

    const confirmed = await client.post('/api/auth/password-reset/confirm', {
      token: reset.token,
      password: nextPassword
    });
    assert.equal(confirmed.status, 204);

    // Every pre-existing session is now dead.
    assert.equal((await asUser(app, user).get('/api/auth/me')).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', otherSession.cookie)).status, 401);

    // The token is single-use.
    const replay = await client.post('/api/auth/password-reset/confirm', {
      token: reset.token,
      password: nextPassword
    });
    assert.equal(replay.status, 400);

    // The old password no longer works; the new one does.
    assert.equal((await client.post('/api/auth/login', { email: user.email, password: user.password })).status, 401);
    assert.equal((await client.post('/api/auth/login', { email: user.email, password: nextPassword })).status, 200);
  });
});

describe('email verification', () => {
  test('consumes a one-time token and rejects a replay', async () => {
    const user = await F.createUser({ emailVerifiedAt: null });
    const token = authService.createEmailVerificationToken(user.id);

    const verified = await client.get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.meta.verified, true);

    const replayed = await client.get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    assert.equal(replayed.status, 400);
  });

  test('rejects a session token presented as a verification token', async () => {
    const user = await F.createSignedInUser();
    const response = await client.get(`/api/auth/verify-email?token=${encodeURIComponent(user.session.token)}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_VERIFICATION_TOKEN');
  });
});

describe('account deletion', () => {
  test('requires the correct password', async () => {
    const user = await F.createSignedInUser();
    const response = await asUser(app, user).delete('/api/auth/me', { password: 'wrong-password-xyz' });
    assert.equal(response.status, 401);
  });

  test('deletes the account and invalidates the session', async () => {
    const user = await F.createSignedInUser();
    const session = asUser(app, user);

    assert.equal((await session.delete('/api/auth/me', { password: user.password })).status, 204);
    assert.equal((await session.get('/api/auth/me')).status, 401);
    assert.equal(await F.prisma.user.count({ where: { id: user.id } }), 0);
  });
});
