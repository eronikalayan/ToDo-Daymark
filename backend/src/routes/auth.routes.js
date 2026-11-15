const express = require('express');
const authController = require('../controllers/auth.controller');
const { authenticate, optionalAuthenticate } = require('../middleware/authenticate');
const { validate } = require('../middleware/validate');
const {
  perIpLimit,
  perAccountSoftLimit,
  loginIpLimiter,
  loginAccountLimiter,
  AUTH_RATE_LIMIT_MESSAGE
} = require('../middleware/rate-limit');
const { env } = require('../config/env');
const {
  registerSchema,
  loginSchema,
  deleteAccountSchema,
  verifyEmailQuerySchema,
  resendVerificationSchema,
  requestPasswordResetSchema,
  resetPasswordSchema
} = require('../schemas/auth.schemas');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

const MINUTE = 60 * 1000;
const QUARTER_HOUR = 15 * MINUTE;
const HOUR = 60 * MINUTE;

// Registration is capped per IP rather than per account: the address is, by
// definition, not yet an account. The production budget protects the email
// provider's quota; outside production nothing is sent, and a tight cap only
// obstructs development and test fixtures (audit finding BE-017).
const REGISTRATION_LIMIT = env.NODE_ENV === 'production' ? 10 : 200;

// --- Every limiter below is a DISTINCT instance, and therefore a distinct -----
// --- counter store. That isolation is the whole point of REF-012.        -----

// Login uses the shared budgets from middleware/rate-limit.js: a generous IP
// ceiling against spraying, plus a strict per-account ceiling against a targeted
// attack from many addresses. They live there because a successful password
// reset has to be able to clear the account budget.

const registerLimiter = perIpLimit({
  windowMs: HOUR,
  limit: REGISTRATION_LIMIT,
  message: 'Too many registration attempts. Try again later.'
});

// Recovery endpoints: the IP layer may reject, the account layer may only
// suppress the outbound email. A third party must never be able to lock the
// owner of an address out of recovering their own account.
const passwordResetRequestIpLimiter = perIpLimit({
  windowMs: HOUR,
  limit: 20,
  message: 'Too many password reset requests. Try again later.'
});
const passwordResetMailBudget = perAccountSoftLimit({ windowMs: HOUR, limit: 5 });

const passwordResetConfirmLimiter = perIpLimit({
  windowMs: QUARTER_HOUR,
  limit: 20,
  message: AUTH_RATE_LIMIT_MESSAGE
});

const resendVerificationIpLimiter = perIpLimit({
  windowMs: HOUR,
  limit: 20,
  message: 'Too many verification requests. Try again later.'
});
const resendVerificationMailBudget = perAccountSoftLimit({ windowMs: HOUR, limit: 5 });

router.post(
  '/register',
  registerLimiter,
  validate({ body: registerSchema }),
  asyncHandler(authController.register)
);
router.post(
  '/login',
  loginIpLimiter,
  loginAccountLimiter,
  validate({ body: loginSchema }),
  asyncHandler(authController.login)
);
router.get('/session', optionalAuthenticate, asyncHandler(authController.session));
router.get('/verify-email', validate({ query: verifyEmailQuerySchema }), asyncHandler(authController.verifyEmail));
router.post(
  '/resend-verification',
  resendVerificationIpLimiter,
  resendVerificationMailBudget,
  validate({ body: resendVerificationSchema }),
  asyncHandler(authController.resendVerification)
);
router.post(
  '/password-reset/request',
  passwordResetRequestIpLimiter,
  passwordResetMailBudget,
  validate({ body: requestPasswordResetSchema }),
  asyncHandler(authController.requestPasswordReset)
);
router.post(
  '/password-reset/confirm',
  passwordResetConfirmLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(authController.resetPassword)
);
router.get('/me', authenticate, asyncHandler(authController.me));
router.post('/logout', asyncHandler(authController.logout));
router.delete('/me', authenticate, validate({ body: deleteAccountSchema }), asyncHandler(authController.deleteAccount));

module.exports = { authRouter: router };
