'use strict';

// REF-006 — test data factories (audit findings BE-027, BE-017).
//
// Fixtures are created directly through Prisma rather than through the HTTP API
// for two reasons:
//
//   1. `POST /api/auth/register` is capped at 5 requests per hour per IP in every
//      environment (BE-017). Building fixtures through it exhausts the limiter and
//      makes suites fail for reasons unrelated to what they are testing.
//   2. A suite should be able to arrange state without also exercising half the
//      application to get there.
//
// This does NOT bypass authentication or authorization. Sessions produced here are
// real rows in the `sessions` table and the tokens are real HS256 JWTs signed with
// the same claims `auth.service.js` uses, so the application's own `authenticate`
// middleware validates them normally. Registration and login themselves are still
// covered by HTTP integration tests in test/auth.test.js.

require('./guard'); // must precede anything that can construct a Prisma client

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/config/prisma');
const { env } = require('../../src/config/env');

/** An allowlisted origin, required by the CSRF guard on every mutating request. */
const TRUSTED_ORIGIN = env.CORS_ORIGINS[0];

const DEFAULT_PASSWORD = 'correct-horse-battery-7';

// bcrypt reads the cost factor from the hash itself, so a cheap hash still
// verifies correctly through the application's real login path. Production
// hashing (cost 12) is unchanged; this only keeps fixtures fast.
const FIXTURE_BCRYPT_COST = 4;

const PRIORITY_ORDER = { low: 1, medium: 2, high: 3 };

// Unique across concurrent suites (each test file runs in its own process) and
// monotonic within one, so generated values are reproducible in a given run.
const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
let sequence = 0;
const nextId = () => `${RUN_ID}-${(sequence += 1)}`;

/** Users created by this process, cleaned up in dependency-safe order. */
const createdUserIds = new Set();

function uniqueEmail(label = 'user') {
  return `${label}-${nextId()}@example.test`;
}

async function createUser(overrides = {}) {
  const { password = DEFAULT_PASSWORD, ...rest } = overrides;
  const user = await prisma.user.create({
    data: {
      name: 'Test User',
      email: uniqueEmail('user'),
      passwordHash: bcrypt.hashSync(password, FIXTURE_BCRYPT_COST),
      emailVerifiedAt: new Date(),
      ...rest
    }
  });
  createdUserIds.add(user.id);
  return { ...user, password };
}

/**
 * A real session row plus the matching JWT, signed exactly as
 * auth.service.createAccessToken does.
 */
async function createSession(userId, overrides = {}) {
  const { expiresAt = new Date(Date.now() + 3600_000), revokedAt = null, ttlSeconds = 3600 } = overrides;
  const id = crypto.randomUUID();
  await prisma.session.create({ data: { id, userId, expiresAt, revokedAt } });
  const token = jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    jwtid: id,
    issuer: 'daymark-api',
    audience: 'daymark-web',
    expiresIn: ttlSeconds,
    algorithm: 'HS256'
  });
  return { id, token, cookie: `${env.COOKIE_NAME}=${token}` };
}

/** A user with a live session, ready to make authenticated requests. */
async function createSignedInUser(overrides = {}) {
  const user = await createUser(overrides);
  const session = await createSession(user.id);
  return { ...user, session, cookie: session.cookie };
}

async function createTask(ownerId, overrides = {}) {
  const { priority = 'medium', createdById = ownerId, ...rest } = overrides;
  return prisma.task.create({
    data: {
      userId: ownerId,
      createdById,
      title: `Task ${nextId()}`,
      priority,
      priorityOrder: PRIORITY_ORDER[priority],
      sortOrder: 0,
      ...rest
    }
  });
}

/** `status` is 'accepted' by default because most suites need an existing friendship. */
async function createFriendship(requesterId, addresseeId, overrides = {}) {
  return prisma.friendship.create({
    data: { requesterId, addresseeId, status: 'accepted', ...overrides }
  });
}

/** Two users who are already accepted friends. */
async function createFriends(overrides = {}) {
  const [a, b] = await Promise.all([
    createSignedInUser({ name: 'Friend A', ...overrides.a }),
    createSignedInUser({ name: 'Friend B', ...overrides.b })
  ]);
  const friendship = await createFriendship(a.id, b.id);
  return { a, b, friendship };
}

async function createMessage(senderId, recipientId, overrides = {}) {
  return prisma.chatMessage.create({
    data: { senderId, recipientId, body: `Message ${nextId()}`, ...overrides }
  });
}

async function createEmailVerificationToken(userId, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  return prisma.emailVerificationToken.create({
    data: { id, userId, expiresAt: new Date(Date.now() + 86_400_000), ...overrides }
  });
}

async function createPasswordResetToken(userId, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  return prisma.passwordResetToken.create({
    data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...overrides }
  });
}

/**
 * Removes everything this process created. Deleting the users is enough: every
 * other table cascades from `users`. Safe to call more than once.
 */
async function cleanup() {
  if (createdUserIds.size === 0) return;
  await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  createdUserIds.clear();
}

/** Release the connection. Call from a suite's `after()` hook. */
async function disconnect() {
  await prisma.$disconnect();
}

module.exports = {
  prisma,
  TRUSTED_ORIGIN,
  DEFAULT_PASSWORD,
  PRIORITY_ORDER,
  uniqueEmail,
  createUser,
  createSession,
  createSignedInUser,
  createTask,
  createFriendship,
  createFriends,
  createMessage,
  createEmailVerificationToken,
  createPasswordResetToken,
  cleanup,
  disconnect
};
