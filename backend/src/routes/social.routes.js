const express = require('express');
const rateLimit = require('express-rate-limit');
const socialController = require('../controllers/social.controller');
const { authenticate } = require('../middleware/authenticate');
const { validate } = require('../middleware/validate');
const {
  friendParams,
  requestParams,
  requestBody,
  requestDecisionBody,
  messageBody,
  messagesQuery
} = require('../schemas/social.schemas');
const { asyncHandler } = require('../utils/async-handler');
const { AppError } = require('../utils/app-error');

// Mounted at /api/friends by api.routes.js, so every path below is relative to
// that prefix. It used to be mounted at the bare /api root, which made this
// router the catch-all for the entire API surface (BE-004).
const router = express.Router();

// `authenticate` is attached PER ROUTE, not as a router-level `use`.
//
// A path-less `router.use(authenticate)` matches every path under the mount —
// including paths that have no route at all. An anonymous request to a URL that
// does not exist was therefore rejected as unauthenticated before the not-found
// handler could ever run, and the bundled frontend signs the user out on any
// unexpected 401 (app.js:74). Authentication must guard the routes it owns, not
// every string that happens to start with the mount path.
//
// auth.routes.js already attached authenticate per route, so this also makes the
// three route files consistent with one another.
const socialWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (request, response, next) => next(new AppError(429, 'Too many social actions. Try again shortly.', 'RATE_LIMITED'))
});

router.get('/', authenticate, asyncHandler(socialController.listFriends));

// The literal /requests paths are registered before the /:friendId ones so a
// reader can see that the specific case wins. There is no same-method overlap
// between them today, but the ordering is the convention to keep.
router.post(
  '/requests',
  authenticate,
  socialWriteLimiter,
  validate({ body: requestBody }),
  asyncHandler(socialController.sendFriendRequest)
);
router.patch(
  '/requests/:id',
  authenticate,
  socialWriteLimiter,
  validate({ params: requestParams, body: requestDecisionBody }),
  asyncHandler(socialController.decideFriendRequest)
);

router.delete(
  '/:friendId',
  authenticate,
  socialWriteLimiter,
  validate({ params: friendParams }),
  asyncHandler(socialController.removeFriend)
);
router.get(
  '/:friendId/messages',
  authenticate,
  validate({ params: friendParams, query: messagesQuery }),
  asyncHandler(socialController.listMessages)
);
router.post(
  '/:friendId/messages',
  authenticate,
  socialWriteLimiter,
  validate({ params: friendParams, body: messageBody }),
  asyncHandler(socialController.sendMessage)
);

module.exports = { socialRouter: router };
