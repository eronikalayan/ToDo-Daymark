const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('node:path');
const { env } = require('./config/env');
const { apiRouter } = require('./routes/api.routes');
const { notFound } = require('./middleware/not-found');
const { errorHandler } = require('./middleware/error-handler');
const { AppError } = require('./utils/app-error');

const app = express();
if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.disable('x-powered-by');

app.use((request, response, next) => {
  request.id = crypto.randomUUID();
  response.setHeader('X-Request-Id', request.id);
  next();
});
app.use(helmet());
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    // Requests from tools such as curl do not send Origin and are allowed.
    if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    const error = new Error('Origin is not allowed by CORS.');
    error.name = 'CorsError';
    callback(error);
  }
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(cookieParser());
app.use((request, response, next) => {
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
  const hasCookieSession = Boolean(request.cookies?.[env.COOKIE_NAME]);
  if (!isMutation || !hasCookieSession) return next();
  const origin = request.get('origin');
  if (!origin || !env.CORS_ORIGINS.includes(origin)) {
    return next(new AppError(403, 'Request origin is not allowed.', 'CSRF_ORIGIN_DENIED'));
  }
  next();
});
app.use(morgan(':method :status :response-time ms', { skip: () => env.NODE_ENV === 'test' }));
app.use('/api', apiRouter);
if (env.SERVE_FRONTEND) {
  const frontendFiles = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
    '/favicon.svg': 'favicon.svg'
  };
  for (const [route, fileName] of Object.entries(frontendFiles)) {
    app.get(route, (request, response, next) => {
      response.sendFile(path.resolve(__dirname, '../..', fileName), (error) => {
        if (error) next(error);
      });
    });
  }
}
app.use(notFound);
app.use(errorHandler);

module.exports = { app };
