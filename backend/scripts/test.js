'use strict';

/**
 * Test runner (REF-030 / REF-007 / Stage 2).
 *
 * Two suites, run by two commands:
 *
 *   npm test            stable suite — must pass, and is what CI gates on
 *   npm run test:defects known-defect suite — reproductions of defects that are
 *                        known but not yet fixed, so these are EXPECTED TO FAIL;
 *                        never run by CI. Currently empty: every audited defect
 *                        is fixed and its tests were promoted to the stable
 *                        suite (see DEFECT_SUITE below).
 *   npm run test:all     both, reported separately
 *
 * Safety properties, unchanged from the original runner and now enforced by
 * test/helpers/guard.js as well:
 *   • NODE_ENV is forced to "test"
 *   • DATABASE_URL is redirected to an isolated prisma/test.db
 *   • a developer's prisma/dev.db is never created, migrated, reset or read
 *
 * Note: `prisma migrate deploy` is used deliberately. `prisma migrate dev`
 * (npm run db:migrate) may RESET the database when it detects drift and must
 * never be used here or in CI.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(backendRoot, '.env') });

// Set after dotenv so these always win: dotenv does not override values that are
// already present, but it would supply them if they were absent.
const testEnvironment = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'file:./prisma/test.db',
  JWT_SECRET: 'test-only-secret-that-is-long-enough-for-hmac'
};

// Explicit file lists. `node --test <dir>` tries to require the directory as a
// module rather than scanning it, so directories are expanded here instead.
const STABLE_SUITE = [
  'test/unit/utils.test.js',
  'test/unit/schemas.test.js',
  'test/unit/rate-limit.test.js',
  'test/guard.test.js',
  'test/guard-contract.test.js',
  'test/app.test.js',
  'test/api-routing.test.js',
  'test/task-creator-lifecycle.test.js',
  'test/migrations.test.js',
  'test/backup-restore.test.js',
  'test/auth.test.js',
  'test/auth-email-reliability.test.js',
  // The three rate-limit files are deliberately separate processes: limiter
  // counters are process memory, so splitting them is what keeps each test
  // independent of the others' ordering. See auth-rate-limit.test.js.
  'test/auth-rate-limit.test.js',
  'test/auth-rate-limit-recovery.test.js',
  'test/auth-rate-limit-ip-layer.test.js',
  'test/tasks.test.js',
  'test/social.test.js'
];

/**
 * Known-defect suite — EMPTY, and that is the goal state.
 *
 * All four audited CRITICAL/HIGH defects are fixed, and each one's reproduction
 * tests were promoted into the stable suite rather than deleted, so the
 * behaviour they describe is now guarded permanently:
 *
 *   BE-001  REF-010  -> test/task-creator-lifecycle.test.js
 *   BE-002  REF-011  -> test/auth-email-reliability.test.js
 *   BE-003  REF-012  -> test/auth-rate-limit*.test.js
 *   BE-004  REF-013/014 -> test/api-routing.test.js
 *
 * The mechanism is kept for the next defect found before it can be fixed: add
 * the file here, and `npm test` stays green while `npm run test:defects`
 * reproduces it.
 */
const DEFECT_SUITE = [];

/**
 * Test files run ONE AT A TIME.
 *
 * `node --test` defaults to one process per CPU, and every suite writes to the
 * same SQLite file. SQLite allows a single writer, so parallel files collide on
 * the interactive transaction in taskService.toggleTask and surface as
 * intermittent HTTP 500s (observed: ~1 run in 3 failing with
 * PrismaClientKnownRequestError). That is contention in the test harness, not a
 * defect in the application — a deployed instance is a single writer.
 *
 * Serial execution is the right trade here: the whole suite takes a few seconds,
 * and a safety net has to be deterministic to be worth anything. Supported on
 * both the pinned Node 20.20.2 and newer releases.
 */
const SERIAL = '--test-concurrency=1';

const prismaCli = path.join(backendRoot, 'node_modules/prisma/build/index.js');

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendRoot,
    env: testEnvironment,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) process.exit(result.status || 1);
  return result.status ?? 1;
}

function applyMigrations() {
  run([prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma']);
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  process.stdout.write(`\n┌${'─'.repeat(width)}┐\n`);
  for (const line of lines) process.stdout.write(`│ ${line.padEnd(width - 1)}│\n`);
  process.stdout.write(`└${'─'.repeat(width)}┘\n\n`);
}

const mode = process.argv[2] ?? 'stable';

if (mode === 'stable' || mode === 'all') {
  applyMigrations();
  banner(['STABLE SUITE — must pass']);
  const status = run(['--test', SERIAL, ...STABLE_SUITE], { allowFailure: mode === 'all' });
  if (mode === 'all' && status !== 0) process.exitCode = status;
}

if ((mode === 'defects' || mode === 'all') && DEFECT_SUITE.length === 0) {
  banner([
    'KNOWN-DEFECT SUITE — empty.',
    '',
    'Every audited CRITICAL/HIGH defect is fixed, and its reproduction tests',
    'were promoted into the stable suite. See the DEFECT_SUITE comment above.'
  ]);
  // Nothing to run. `node --test` with no file arguments would DISCOVER and run
  // the whole test directory, which would silently re-run the stable suite and
  // report it as a known-defect result, so the branch below is skipped entirely.
} else if (mode === 'defects' || mode === 'all') {
  if (mode === 'defects') applyMigrations();
  banner([
    'KNOWN-DEFECT SUITE — failures below are EXPECTED',
    '',
    'These tests describe the behaviour the backend should have,',
    'and reproduce audit finding BE-004. It fails until REF-013/REF-014',
    'are implemented. CI does not run this suite.',
    'Tests labelled CONTROL assert behaviour that is already correct',
    'and must keep passing.'
  ]);
  // Deliberately tolerated: a non-zero status here is the point of the suite.
  const status = run(['--test', SERIAL, ...DEFECT_SUITE], { allowFailure: true });
  banner([
    status === 0
      ? 'All known-defect tests PASSED — the defects appear to be fixed.'
      : 'Known-defect tests failed, as expected: the defects are still present.',
    'Compare the failures against docs/audit/BACKEND_CODE_REVIEW.md.'
  ]);
  // `npm run test:defects` exits 0 so the expected failures do not look like a
  // broken toolchain; the per-test results above are the real signal.
  if (mode === 'defects') process.exitCode = 0;
}

if (!['stable', 'defects', 'all'].includes(mode)) {
  process.stderr.write(`Unknown test mode "${mode}". Use: stable | defects | all\n`);
  process.exitCode = 1;
}
