const { Prisma } = require('@prisma/client');
const { ZodError } = require('zod');
const { AppError } = require('../utils/app-error');
const { env } = require('../config/env');

function errorHandler(error, request, response, next) {
  if (response.headersSent) return next(error);

  let statusCode = 500;
  let message = 'An unexpected error occurred.';
  let code = 'INTERNAL_ERROR';
  let details;

  if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
    code = error.code;
    details = error.details;
  } else if (error instanceof ZodError) {
    statusCode = 422;
    message = 'Validation failed';
    code = 'VALIDATION_ERROR';
    details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    statusCode = 409;
    message = 'A record with that value already exists.';
    code = 'CONFLICT';
  } else if (error instanceof SyntaxError && 'body' in error) {
    statusCode = 400;
    message = 'Request body contains invalid JSON.';
    code = 'INVALID_JSON';
  } else if (error?.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Request body is too large.';
    code = 'PAYLOAD_TOO_LARGE';
  } else if (error?.name === 'MulterError') {
    statusCode = 400;
    message = 'Invalid request.';
    code = 'BAD_REQUEST';
  } else if (error?.name === 'CorsError') {
    statusCode = 403;
    message = 'This origin is not allowed.';
    code = 'CORS_ORIGIN_DENIED';
  }

  // Do not log raw errors: ORM errors may include query arguments and user data.
  if (statusCode >= 500) {
    console.error({ requestId: request.id, errorName: error?.name || 'Error' });
  }

  const payload = { error: { message, code } };
  if (details) payload.error.details = details;
  if (env.NODE_ENV !== 'production' && statusCode >= 500) payload.error.requestId = request.id;
  response.status(statusCode).json(payload);
}

module.exports = { errorHandler };
