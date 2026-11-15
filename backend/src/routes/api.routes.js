const express = require('express');
const { prisma } = require('../config/prisma');
const { asyncHandler } = require('../utils/async-handler');
const { notFound } = require('../middleware/not-found');
const { authRouter } = require('./auth.routes');
const { taskRouter } = require('./task.routes');
const { socialRouter } = require('./social.routes');

const router = express.Router();

router.get('/health', asyncHandler(async (request, response) => {
  await prisma.$queryRaw`SELECT 1`;
  response.status(200).json({ data: { status: 'ok', database: 'ok', timestamp: new Date().toISOString() } });
}));

// Every sub-router is mounted on an EXPLICIT prefix. The social router used to be
// mounted at '/', which made it match every path under /api — so an unmatched URL
// reached its router-level `authenticate` and came back 401 instead of 404
// (BE-004). A path-less mount turns a resource router into a catch-all.
router.use('/auth', authRouter);
router.use('/tasks', taskRouter);
router.use('/friends', socialRouter);

// Unknown API paths end here, with the project's JSON error envelope.
//
// Reachable only because nothing above is mounted at '/' any more. Scoping it to
// the API rather than relying on the application-level fallback also keeps the
// contract stable: adding a single-page-app catch-all to app.js later would
// otherwise start answering /api/unknown with HTML.
router.use(notFound);

module.exports = { apiRouter: router };
