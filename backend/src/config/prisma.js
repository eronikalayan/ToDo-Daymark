const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { env } = require('./env');

// Prisma 7 uses a driver adapter; keep one SQLite connection pool per process.
const adapter = new PrismaBetterSqlite3({ url: env.DATABASE_URL });
const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn'] : []
});

module.exports = { prisma };
