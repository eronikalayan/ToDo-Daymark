const { env } = require('../config/env');
const authService = require('../services/auth.service');
const { clearLoginBudget } = require('../middleware/rate-limit');

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.COOKIE_SAME_SITE,
    path: '/api',
    maxAge: env.JWT_TTL_SECONDS * 1000
  };
}

async function register(request, response) {
  const result = await authService.register(request.validated.body);

  // 202 Accepted: the account exists but cannot be used until it is verified, so
  // no session cookie is issued. The response is the same whether or not the
  // verification email was delivered — see authService.register.
  if (result.verificationRequired) {
    response.status(202).json({ data: { user: result.user }, meta: { verificationRequired: true } });
    return;
  }

  response.cookie(env.COOKIE_NAME, result.token, sessionCookieOptions());
  response.status(201).json({ data: { user: result.user }, meta: { verificationRequired: false } });
}

async function login(request, response) {
  const result = await authService.login(request.validated.body);
  response.cookie(env.COOKIE_NAME, result.token, sessionCookieOptions());
  response.status(200).json({ data: { user: result.user } });
}

function me(request, response) {
  response.status(200).json({ data: { user: request.user } });
}

function session(request, response) {
  response.status(200).json({ data: { user: request.user } });
}

async function logout(request, response) {
  const token = request.cookies?.[env.COOKIE_NAME];
  if (token) {
    try {
      const payload = require('jsonwebtoken').verify(token, env.JWT_SECRET, { issuer: 'daymark-api', audience: 'daymark-web', algorithms: ['HS256'] });
      await authService.revokeSession(payload.jti, payload.sub);
    } catch {
      // Clearing an expired or invalid cookie is still a successful logout.
    }
  }
  const { maxAge, ...clearOptions } = sessionCookieOptions();
  response.clearCookie(env.COOKIE_NAME, clearOptions);
  response.status(204).end();
}

async function verifyEmail(request, response) {
  const user = await authService.verifyEmail(request.validated.query.token);
  response.status(200).json({ data: { user }, meta: { verified: true } });
}

// `emailDeliverySuppressed` is set by the per-account mail budget in
// middleware/rate-limit.js. It withholds the email without changing the response,
// so a third party can stop an address being mail-bombed but cannot stop its
// owner from using recovery.
async function resendVerification(request, response) {
  await authService.resendVerification(request.validated.body.email, {
    sendEmail: !request.emailDeliverySuppressed
  });
  response.status(202).json({ data: { message: 'If that account needs verification, a link will be sent.' } });
}

async function requestPasswordReset(request, response) {
  await authService.requestPasswordReset(request.validated.body.email, {
    sendEmail: !request.emailDeliverySuppressed
  });
  response.status(202).json({ data: { message: 'If that account exists, a password reset link will be sent.' } });
}

async function resetPassword(request, response) {
  const { email } = await authService.resetPassword(request.validated.body.token, request.validated.body.password);

  // Consuming a reset token proves control of the mailbox, so the account's
  // login budget is released. Without this, a third party who knew the address
  // could spend its ten attempts and keep the owner from signing in for the rest
  // of the window — even with a password they had just set.
  await clearLoginBudget(email);

  response.status(204).end();
}

async function deleteAccount(request, response) {
  await authService.deleteAccount(request.user.id, request.validated.body.password);
  response.clearCookie(env.COOKIE_NAME, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: env.COOKIE_SAME_SITE, path: '/api' });
  response.status(204).end();
}

module.exports = { register, login, me, session, logout, deleteAccount, verifyEmail, resendVerification, requestPasswordReset, resetPassword };
