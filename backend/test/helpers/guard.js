'use strict';

/**
 * REF-030 — fail-closed test database guard (audit findings BE-027, BE-023).
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/config/env.js` loads `backend/.env` by absolute path. dotenv does not
 * override variables that are already present in `process.env` (verified), so:
 *
 *   • `npm test` sets DATABASE_URL=file:./prisma/test.db before spawning Node,
 *     dotenv leaves it alone, and the suite uses the isolated test database.
 *
 *   • `node --test test/foo.test.js` run straight from an editor sets nothing,
 *     dotenv therefore supplies the value from `.env`, and the suite silently
 *     binds the DEVELOPMENT database. That is the hazard this module prevents.
 *
 * HOW IT MUST BE USED
 * -------------------
 * `require('./helpers/guard')` (or `require('../helpers/guard')`) must be the
 * FIRST statement of every test file — before anything that can construct a
 * Prisma client. CommonJS `require` is synchronous and evaluated in source
 * order, so a guard placed first always runs first. `test/guard-contract.test.js`
 * enforces this mechanically, so the rule cannot quietly decay.
 *
 * The database file is opened lazily, at the first query rather than at client
 * construction (verified), but this module deliberately does not depend on that:
 * it aborts before the application is imported at all.
 *
 * FAILURE MODE
 * ------------
 * Throws. A throw during module load makes the test file fail loudly; it can
 * never be mistaken for a pass. No secret value is ever printed — only the
 * resolved database path, which is not sensitive.
 */

const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/** Database files that tests must never touch, whatever they are called. */
function forbiddenDatabasePaths() {
  const forbidden = new Set();

  // Convention-based: the development database shipped with the project.
  forbidden.add(path.join(BACKEND_ROOT, 'prisma', 'dev.db'));

  // Configuration-based: whatever the developer's own .env actually points at.
  // This is the authoritative answer and does not depend on any file naming
  // convention. Only DATABASE_URL is read; no other value is parsed or kept.
  try {
    const envFile = fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8');
    const line = envFile.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (line) {
      const raw = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      const resolved = resolveSqlitePath(raw);
      if (resolved) forbidden.add(resolved);
    }
  } catch {
    // No .env (a fresh clone, or CI). Nothing to protect beyond the convention.
  }

  return forbidden;
}

/** Resolve a `file:` SQLite URL the way better-sqlite3 does: against process.cwd(). */
function resolveSqlitePath(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  const withoutScheme = url.slice('file:'.length);
  return path.resolve(process.cwd(), withoutScheme);
}

function abort(problem, remedy) {
  const message = [
    '',
    '  ┌─────────────────────────────────────────────────────────────────────┐',
    '  │  TEST DATABASE GUARD (REF-030): execution refused                   │',
    '  └─────────────────────────────────────────────────────────────────────┘',
    `  Problem: ${problem}`,
    `  Fix:     ${remedy}`,
    '',
    '  Tests must never run against the development or production database.',
    '  Use `npm test` (stable suite) or `npm run test:defects`, which set a',
    '  test environment and an isolated database before Node starts.',
    ''
  ].join('\n');
  process.stderr.write(`${message}\n`);
  throw new Error(`Test database guard refused execution: ${problem}`);
}

function assertSafeTestEnvironment() {
  const nodeEnv = process.env.NODE_ENV;
  const databaseUrl = process.env.DATABASE_URL;

  // ---- Factor 1: an explicit environment -------------------------------------
  // `production` is accepted ONLY with a deliberate opt-in, because the BE-002
  // regression has to exercise production-only code paths. Every database check
  // below still applies in that mode, so the safety invariant is unchanged.
  const simulatingProduction =
    nodeEnv === 'production' && process.env.DAYMARK_TEST_SIMULATE_PRODUCTION === '1';

  if (nodeEnv !== 'test' && !simulatingProduction) {
    abort(
      `NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : 'not set'}, but tests require "test".`,
      'Run `npm test`. Do not run `node --test <file>` directly — it inherits .env and binds the development database.'
    );
  }

  // ---- Factor 2: the working directory must be the backend root --------------
  // Checked early, because SQLite resolves relative file: URLs against
  // process.cwd() (audit finding BE-022). A wrong working directory silently
  // creates a brand-new empty database, and it is the root cause of every path
  // check that would otherwise fail below — so it is reported first.
  if (path.resolve(process.cwd()) !== BACKEND_ROOT) {
    abort(
      `Tests are running from ${process.cwd()} instead of the backend directory.`,
      'Relative DATABASE_URL values resolve against the working directory. Run tests via `npm test` from backend/.'
    );
  }

  // ---- Factor 3: an explicitly supplied database -----------------------------
  // Must already be in process.env. If it is missing here, dotenv would later
  // fill it in from .env — which is precisely the silent failure being prevented.
  if (!databaseUrl) {
    abort(
      'DATABASE_URL is not set in the environment.',
      'Run `npm test`, which sets an isolated DATABASE_URL before Node starts. An unset value would fall through to .env.'
    );
  }

  // ---- Factor 4: it must be a local SQLite file ------------------------------
  if (!databaseUrl.startsWith('file:')) {
    const scheme = databaseUrl.split(':')[0];
    abort(
      `DATABASE_URL uses the "${scheme}:" scheme; tests only ever run against a local SQLite file.`,
      'Point DATABASE_URL at an isolated file: URL, e.g. file:./prisma/test.db'
    );
  }

  const resolved = resolveSqlitePath(databaseUrl);

  // ---- Factor 5: it must not be a protected database -------------------------
  // Deny-list first: this check is independent of any naming convention, so it
  // holds even for a database that happens to have "test" in its name.
  const forbidden = forbiddenDatabasePaths();
  if (forbidden.has(resolved)) {
    abort(
      `DATABASE_URL resolves to a protected database: ${resolved}`,
      'Tests must use a dedicated database such as prisma/test.db. Never point them at the development database.'
    );
  }

  // ---- Factor 6: it must sit where test databases are expected ---------------
  // Allow-list second, as defence in depth rather than as the primary check.
  const prismaDir = path.join(BACKEND_ROOT, 'prisma');
  const allowedNames = new Set(['test.db', 'defects.db', 'guard-probe.db']);
  if (path.dirname(resolved) !== prismaDir || !allowedNames.has(path.basename(resolved))) {
    abort(
      `DATABASE_URL resolves to ${resolved}, which is not a recognised test database.`,
      `Use one of: ${[...allowedNames].map((n) => `prisma/${n}`).join(', ')} (resolved relative to the backend directory).`
    );
  }

  return { nodeEnv, databasePath: resolved, simulatingProduction };
}

const environment = assertSafeTestEnvironment();

// Marker other helpers can assert on, so nothing reaches Prisma unguarded.
process.env.DAYMARK_TEST_GUARD_PASSED = '1';

module.exports = {
  ...environment,
  BACKEND_ROOT,
  resolveSqlitePath,
  forbiddenDatabasePaths,
  assertSafeTestEnvironment
};
