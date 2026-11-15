const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/app-error');
const { asyncHandler } = require('../utils/async-handler');
const { toPublicUser } = require('../utils/safe-user');

function createAuthenticator(optional) {
  return asyncHandler(async (request, response, next) => {
    const token = request.cookies?.[env.COOKIE_NAME];
    if (!token) {
      if (optional) {
        request.user = null;
        return next();
      }
      throw new AppError(401, 'Authentication required.', 'UNAUTHENTICATED');
    }

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, {
        issuer: 'daymark-api',
        audience: 'daymark-web',
        algorithms: ['HS256']
      });
    } catch {
      if (optional) {
        request.user = null;
        return next();
      }
      throw new AppError(401, 'Authentication required.', 'UNAUTHENTICATED');
    }

    if (typeof payload !== 'object' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      if (optional) {
        request.user = null;
        return next();
      }
      throw new AppError(401, 'Authentication required.', 'UNAUTHENTICATED');
    }
    const session = await prisma.session.findFirst({
      where: { id: payload.jti, userId: payload.sub, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true }
    });
    if (!session) {
      if (optional) {
        request.user = null;
        return next();
      }
      throw new AppError(401, 'Authentication required.', 'UNAUTHENTICATED');
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, createdAt: true, updatedAt: true }
    });
    if (!user) {
      if (optional) {
        request.user = null;
        return next();
      }
      throw new AppError(401, 'Authentication required.', 'UNAUTHENTICATED');
    }

    request.user = toPublicUser(user);
    next();
  });
}

const authenticate = createAuthenticator(false);
const optionalAuthenticate = createAuthenticator(true);

module.exports = { authenticate, optionalAuthenticate };
