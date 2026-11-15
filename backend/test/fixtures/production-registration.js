'use strict';

/**
 * Production registration / email-delivery fixture (REF-011, finding BE-002).
 *
 *   node test/fixtures/production-registration.js <email> <mode>
 *   mode: ok | http-500 | network-error | fail-then-ok
 *
 * A CHILD PROCESS is required because `src/config/env.js` reads NODE_ENV once, at
 * import time, so the production-only branches in auth.service cannot be reached
 * from a suite running under NODE_ENV=test.
 *
 * NO EMAIL IS EVER SENT AND NO CREDENTIAL IS EVER USED.
 * `globalThis.fetch` is replaced before the application is imported, so
 * `email.service.js` runs its real code path — including its `response.ok` check —
 * against an in-process stub. Nothing leaves the machine, there is no provider
 * URL to reach and the token below is a literal placeholder.
 *
 * Because the stub sees the payload the service built, it can recover the real
 * verification link, which lets the recovery path be proven end to end rather
 * than simulated.
 *
 * SAFETY: the parent supplies DATABASE_URL pointing at the isolated test
 * database and the REF-030 guard re-validates it here in production-simulation
 * mode, so the development database is unreachable from this process.
 */

require('../helpers/guard'); // validates the simulated-production environment

const email = process.argv[2];
const mode = process.argv[3] ?? 'network-error';
const password = 'correct-horse-battery-7';

// ---------------------------------------------------------------------------
// Email provider stub. Installed BEFORE the application is imported.
// ---------------------------------------------------------------------------
const deliveries = [];
let behaviour = mode === 'fail-then-ok' ? 'network-error' : mode;

globalThis.fetch = async (url, options) => {
  let payload;
  try {
    payload = JSON.parse(options?.body ?? 'null');
  } catch {
    payload = null;
  }

  if (behaviour === 'network-error') {
    // What a refused connection or DNS failure looks like to fetch().
    throw new TypeError('fetch failed');
  }
  if (behaviour === 'http-500') {
    deliveries.push({ accepted: false, subject: payload?.subject ?? null });
    return { ok: false, status: 500 };
  }

  deliveries.push({ accepted: true, subject: payload?.subject ?? null, text: payload?.text ?? '' });
  return { ok: true, status: 202 };
};

const request = require('supertest');
const { app } = require('../../src/app');
const { prisma } = require('../../src/config/prisma');

const ORIGIN = 'https://daymark.invalid';
const post = (path, body) => request(app).post(path).set('Origin', ORIGIN).send(body);

/** Pull the verification token out of the link the service actually built. */
function tokenFromLastDelivery() {
  const last = deliveries.filter((d) => d.accepted).at(-1);
  if (!last) return null;
  const match = /[?&]verify=([^\s&]+)/.exec(last.text ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

async function main() {
  const observations = { email, mode };

  // 1. Register.
  const registration = await post('/api/auth/register', { name: 'Production User', email, password });
  observations.registerStatus = registration.status;
  observations.registerBody = registration.body;
  observations.registerSetCookie = Boolean(registration.headers['set-cookie']);
  observations.deliveriesAfterRegister = deliveries.length;

  // 2. Did the account survive, and is it unverified?
  const row = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
  observations.userRowCreated = row !== null;
  observations.userVerified = row ? row.emailVerifiedAt !== null : null;

  // 3. Is the address now unusable for a second registration?
  const again = await post('/api/auth/register', { name: 'Production User', email, password });
  observations.reRegisterStatus = again.status;
  observations.reRegisterCode = again.body?.error?.code ?? null;

  // 4. Can the account sign in while unverified?
  const login = await post('/api/auth/login', { email, password });
  observations.loginStatus = login.status;
  observations.loginCode = login.body?.error?.code ?? null;
  observations.loginSetCookie = Boolean(login.headers['set-cookie']);

  // 5. Recovery. For `fail-then-ok` the provider comes back before the resend,
  //    which is what a transient outage looks like.
  if (mode === 'fail-then-ok') behaviour = 'ok';
  const resend = await post('/api/auth/resend-verification', { email });
  observations.resendStatus = resend.status;
  observations.resendCode = resend.body?.error?.code ?? null;
  observations.deliveriesAfterResend = deliveries.length;

  // 6. Follow the real link, then sign in.
  const token = tokenFromLastDelivery();
  observations.verificationLinkCaptured = token !== null;
  if (token) {
    const verified = await request(app).get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    observations.verifyStatus = verified.status;
    observations.verifyMeta = verified.body?.meta ?? null;

    const afterVerify = await post('/api/auth/login', { email, password });
    observations.loginAfterVerifyStatus = afterVerify.status;
    observations.loginAfterVerifySetCookie = Boolean(afterVerify.headers['set-cookie']);
  }

  // 7. Password reset must answer identically for a known and an unknown address,
  //    even while the provider is broken — otherwise a provider outage turns the
  //    endpoint into an account-existence oracle.
  behaviour = mode === 'ok' ? 'ok' : 'network-error';
  const resetKnown = await post('/api/auth/password-reset/request', { email });
  const resetUnknown = await post('/api/auth/password-reset/request', { email: `absent-${Date.now()}@example.test` });
  observations.resetKnown = { status: resetKnown.status, body: resetKnown.body };
  observations.resetUnknown = { status: resetUnknown.status, body: resetUnknown.body };

  observations.subjectsDelivered = deliveries.filter((d) => d.accepted).map((d) => d.subject);

  process.stdout.write(`\n__OBSERVATIONS__${JSON.stringify(observations)}__END__\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  process.stdout.write(`\n__OBSERVATIONS__${JSON.stringify({ fixtureError: String(error && error.message) })}__END__\n`);
  try {
    await prisma.$disconnect();
  } catch {
    /* already closed */
  }
  process.exitCode = 1;
});
