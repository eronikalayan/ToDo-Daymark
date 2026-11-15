const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const emailService = require('./email.service');
const { AppError } = require('../utils/app-error');
const { toPublicUser } = require('../utils/safe-user');

const BCRYPT_ROUNDS = 12;
// Used for unknown email addresses so login timing does not immediately reveal account existence.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('daymark-invalid-account-placeholder', BCRYPT_ROUNDS);

async function createAccessToken(userId) {
  const sessionId = require('node:crypto').randomUUID();
  const expiresAt = new Date(Date.now() + env.JWT_TTL_SECONDS * 1000);
  await prisma.session.create({ data: { id: sessionId, userId, expiresAt } });
  return jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    jwtid: sessionId,
    issuer: 'daymark-api',
    audience: 'daymark-web',
    expiresIn: env.JWT_TTL_SECONDS,
    algorithm: 'HS256'
  });
}

// Accounts must be verified before first sign-in only where a real provider is
// configured. Outside production nothing is sent, so registration verifies
// immediately and hands back a session, exactly as before.
const requiresEmailVerification = () => env.NODE_ENV === 'production';

/**
 * Deliver an email WITHOUT ever failing the caller (BE-002).
 *
 * Account creation is durable; delivery is a retryable call to a third party.
 * Letting the retryable step reject the durable one is the defect: a provider
 * outage used to leave an account that could not be registered again (409),
 * could not sign in (403) and could not be recovered. Delivery outcomes are
 * therefore logged, never thrown, and never reflected in a response body.
 *
 * Only the error's class name is logged. A provider error can carry the request
 * URL — and therefore the bearer token — in its message, so the message is
 * deliberately dropped. (Structured, redacted logging arrives with REF-035.)
 */
async function deliver(kind, send) {
  try {
    await send();
    return true;
  } catch (error) {
    console.error({ context: `email-delivery:${kind}`, delivered: false, errorName: error?.name || 'Error' });
    return false;
  }
}

const deliverVerificationEmail = (email, userId) =>
  deliver('verification', () => emailService.sendVerificationEmail(email, createEmailVerificationToken(userId)));

const deliverPasswordResetEmail = (email, token) =>
  deliver('password-reset', () => emailService.sendPasswordResetEmail(email, token));

async function register({ name, email, password }) {
  // Hash before the uniqueness check, as before: both the new-account and the
  // duplicate path then pay the same bcrypt cost, so response timing does not
  // reveal whether the address was already registered.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let user;
  try {
    user = await prisma.user.create({
      data: { name, email, passwordHash, emailVerifiedAt: requiresEmailVerification() ? null : new Date() },
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true }
    });
  } catch (error) {
    if (error?.code === 'P2002') throw new AppError(409, 'An account with that email already exists.', 'EMAIL_ALREADY_REGISTERED');
    throw error;
  }

  // Past this point the account exists and must not be undone. Anything that can
  // fail is kept outside the block above and cannot propagate.
  if (requiresEmailVerification()) {
    await deliverVerificationEmail(user.email, user.id);
    // The response is identical whether or not delivery succeeded: it must not
    // leak provider state, and recovery does not depend on knowing. An
    // unverified user signing in gets 403 EMAIL_NOT_VERIFIED, which is the
    // documented cue to request another link.
    return { user: toPublicUser(user), token: null, verificationRequired: true };
  }

  return { user: toPublicUser(user), token: await createAccessToken(user.id), verificationRequired: false };
}

/**
 * Re-send a verification link. Resolves for any address, whether or not it
 * belongs to an unverified account and whether or not delivery worked, so the
 * caller can always answer with one generic response (BE-016).
 */
async function resendVerification(email, { sendEmail = true } = {}) {
  if (!sendEmail) return;
  const user = await getUnverifiedUser(email);
  if (!user) return;
  await deliverVerificationEmail(user.email, user.id);
}

/**
 * Issue and deliver a password-reset link. Resolves for unknown addresses and for
 * delivery failures alike.
 *
 * This matters for more than reliability: before, an unknown address returned 202
 * while a known address whose delivery failed returned 500 — so a provider outage
 * turned this endpoint into an account-existence oracle.
 */
async function requestPasswordReset(email, { sendEmail = true } = {}) {
  const reset = await createPasswordReset(email);
  if (!reset || !sendEmail) return;
  await deliverPasswordResetEmail(reset.email, reset.token);
}

function createEmailVerificationToken(userId) {
  return jwt.sign({ purpose: 'verify-email' }, env.JWT_SECRET, {
    subject: userId,
    issuer: 'daymark-api',
    audience: 'daymark-email-verification',
    expiresIn: 60 * 60 * 24,
    jwtid: require('node:crypto').randomUUID(),
    algorithm: 'HS256'
  });
}

async function verifyEmail(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'daymark-api',
      audience: 'daymark-email-verification',
      algorithms: ['HS256']
    });
  } catch {
    throw new AppError(400, 'Verification link is invalid or expired.', 'INVALID_VERIFICATION_TOKEN');
  }
  if (typeof payload !== 'object' || payload.purpose !== 'verify-email' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new AppError(400, 'Verification link is invalid or expired.', 'INVALID_VERIFICATION_TOKEN');
  }
  try {
    return await prisma.$transaction(async (transaction) => {
      await transaction.emailVerificationToken.create({ data: { id: payload.jti, userId: payload.sub, expiresAt: new Date(payload.exp * 1000) } });
      const user = await transaction.user.update({
        where: { id: payload.sub },
        data: { emailVerifiedAt: new Date() },
        select: { id: true, name: true, email: true, createdAt: true, updatedAt: true }
      });
      return toPublicUser(user);
    });
  } catch (error) {
    if (error?.code === 'P2002' || error?.code === 'P2025') {
      throw new AppError(400, 'Verification link is invalid, expired, or already used.', 'INVALID_VERIFICATION_TOKEN');
    }
    throw error;
  }
}

async function getUnverifiedUser(email) {
  return prisma.user.findFirst({
    where: { email, emailVerifiedAt: null },
    select: { id: true, email: true }
  });
}

async function createPasswordReset(email) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return null;
  const tokenId = require('node:crypto').randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.passwordResetToken.create({ data: { id: tokenId, userId: user.id, expiresAt } });
  const token = jwt.sign({ purpose: 'reset-password' }, env.JWT_SECRET, {
    subject: user.id,
    issuer: 'daymark-api',
    audience: 'daymark-password-reset',
    expiresIn: 60 * 60,
    jwtid: tokenId,
    algorithm: 'HS256'
  });
  return { email: user.email, token };
}

async function resetPassword(token, password) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'daymark-api',
      audience: 'daymark-password-reset',
      algorithms: ['HS256']
    });
  } catch {
    throw new AppError(400, 'Password reset link is invalid or expired.', 'INVALID_RESET_TOKEN');
  }
  if (typeof payload !== 'object' || payload.purpose !== 'reset-password' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new AppError(400, 'Password reset link is invalid or expired.', 'INVALID_RESET_TOKEN');
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let email;
  try {
    email = await prisma.$transaction(async (transaction) => {
      const reset = await transaction.passwordResetToken.findFirst({
        where: { id: payload.jti, userId: payload.sub, usedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true }
      });
      if (!reset) throw new AppError(400, 'Password reset link is invalid, expired, or already used.', 'INVALID_RESET_TOKEN');
      const marked = await transaction.passwordResetToken.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() }
      });
      if (!marked.count) throw new AppError(400, 'Password reset link is invalid, expired, or already used.', 'INVALID_RESET_TOKEN');
      const updated = await transaction.user.update({
        where: { id: payload.sub },
        data: { passwordHash },
        select: { email: true }
      });
      await transaction.passwordResetToken.updateMany({ where: { userId: payload.sub, usedAt: null }, data: { usedAt: new Date() } });
      await transaction.session.updateMany({ where: { userId: payload.sub, revokedAt: null }, data: { revokedAt: new Date() } });
      return updated.email;
    });
  } catch (error) {
    if (error?.code === 'P2025') throw new AppError(400, 'Password reset link is invalid or expired.', 'INVALID_RESET_TOKEN');
    throw error;
  }

  // Returned so the caller can clear this account's login rate-limit budget:
  // consuming a reset token proves control of the mailbox, and the owner must be
  // able to sign in with the new password immediately rather than waiting out a
  // budget somebody else may have spent.
  return { email };
}

async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Use one generic error for unknown email and wrong password to prevent account discovery.
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!passwordMatches) throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  if (env.NODE_ENV === 'production' && !user.emailVerifiedAt) {
    throw new AppError(403, 'Verify your email address before signing in.', 'EMAIL_NOT_VERIFIED');
  }
  return { user: toPublicUser(user), token: await createAccessToken(user.id) };
}

async function revokeSession(sessionId, userId) {
  if (!sessionId) return;
  await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

async function deleteAccount(userId, password) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, 'Password confirmation failed.', 'INVALID_CREDENTIALS');
  }
  await prisma.user.delete({ where: { id: userId } });
}

module.exports = {
  register,
  login,
  deleteAccount,
  revokeSession,
  createEmailVerificationToken,
  verifyEmail,
  getUnverifiedUser,
  createPasswordReset,
  resetPassword,
  // Orchestrators added by REF-011. The primitives above are kept because tests
  // and the verification flow use them directly to obtain a token without email.
  resendVerification,
  requestPasswordReset,
  requiresEmailVerification
};
