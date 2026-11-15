'use strict';

// REF-030 negative tests. The guard must refuse unsafe configurations.
//
// Every case runs in a CHILD PROCESS that only ever loads the guard module, so
// no application code is imported and no database connection is attempted. The
// final test asserts that the development database is byte-identical afterwards.
require('./helpers/guard');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACKEND_ROOT, 'prisma', 'dev.db');
const SAFE_URL = 'file:./prisma/test.db';

/** Load ONLY the guard in a child process with a controlled environment. */
function loadGuard({ env = {}, cwd = BACKEND_ROOT } = {}) {
  const result = spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(path.join(__dirname, 'helpers', 'guard.js'))}); console.log('GUARD_ALLOWED');`],
    {
      cwd,
      // A deliberately empty base environment: the child inherits nothing that
      // could accidentally make an unsafe configuration look safe.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: 'utf8'
    }
  );
  return {
    allowed: result.status === 0 && result.stdout.includes('GUARD_ALLOWED'),
    status: result.status,
    output: `${result.stdout}${result.stderr}`
  };
}

function devDbFingerprint() {
  if (!fs.existsSync(DEV_DB)) return 'absent';
  return crypto.createHash('md5').update(fs.readFileSync(DEV_DB)).digest('hex');
}

const devDbBefore = devDbFingerprint();

describe('REF-030 test database guard', () => {
  describe('refuses unsafe configurations', () => {
    const rejected = [
      {
        name: 'NODE_ENV is not set at all (the bare `node --test <file>` case)',
        env: { DATABASE_URL: SAFE_URL },
        expect: /NODE_ENV is not set/
      },
      {
        name: 'NODE_ENV=development',
        env: { NODE_ENV: 'development', DATABASE_URL: SAFE_URL },
        expect: /NODE_ENV is "development"/
      },
      {
        name: 'NODE_ENV=production without the explicit simulation opt-in',
        env: { NODE_ENV: 'production', DATABASE_URL: SAFE_URL },
        expect: /NODE_ENV is "production"/
      },
      {
        name: 'DATABASE_URL missing, so dotenv would silently supply the dev database',
        env: { NODE_ENV: 'test' },
        expect: /DATABASE_URL is not set/
      },
      {
        name: 'DATABASE_URL points at the development database',
        env: { NODE_ENV: 'test', DATABASE_URL: 'file:./prisma/dev.db' },
        expect: /protected database/
      },
      {
        name: 'DATABASE_URL points at the dev database by an indirect path',
        env: { NODE_ENV: 'test', DATABASE_URL: 'file:./prisma/../prisma/dev.db' },
        expect: /protected database/
      },
      {
        name: 'DATABASE_URL is a remote (non-SQLite) database',
        env: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://user@db.example.com:5432/daymark' },
        expect: /"postgresql:" scheme/
      },
      {
        name: 'DATABASE_URL is an unrecognised SQLite file',
        env: { NODE_ENV: 'test', DATABASE_URL: 'file:./prisma/production-copy.db' },
        expect: /not a recognised test database/
      },
      {
        name: 'DATABASE_URL escapes the prisma directory',
        env: { NODE_ENV: 'test', DATABASE_URL: 'file:../test.db' },
        expect: /not a recognised test database/
      }
    ];

    for (const scenario of rejected) {
      test(scenario.name, () => {
        const result = loadGuard({ env: scenario.env });
        assert.equal(result.allowed, false, 'guard must refuse this configuration');
        assert.notEqual(result.status, 0, 'child process must exit non-zero');
        assert.match(result.output, scenario.expect);
        assert.match(result.output, /TEST DATABASE GUARD \(REF-030\): execution refused/);
      });
    }

    test('refuses when the working directory is not the backend root', () => {
      // A relative file: URL resolves against process.cwd() (BE-022), so a wrong
      // working directory would silently create a new, empty database.
      const result = loadGuard({ env: { NODE_ENV: 'test', DATABASE_URL: SAFE_URL }, cwd: path.dirname(BACKEND_ROOT) });
      assert.equal(result.allowed, false);
      assert.match(result.output, /instead of the backend directory/);
    });
  });

  describe('allows correctly configured runs', () => {
    test('NODE_ENV=test with an isolated database', () => {
      const result = loadGuard({ env: { NODE_ENV: 'test', DATABASE_URL: SAFE_URL } });
      assert.equal(result.allowed, true, result.output);
    });

    test('production simulation only with the explicit opt-in', () => {
      const withoutOptIn = loadGuard({ env: { NODE_ENV: 'production', DATABASE_URL: SAFE_URL } });
      assert.equal(withoutOptIn.allowed, false);

      const withOptIn = loadGuard({
        env: { NODE_ENV: 'production', DATABASE_URL: SAFE_URL, DAYMARK_TEST_SIMULATE_PRODUCTION: '1' }
      });
      assert.equal(withOptIn.allowed, true, withOptIn.output);
    });

    test('the opt-in does NOT weaken the database checks', () => {
      // Production simulation still may not touch the development database.
      const result = loadGuard({
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'file:./prisma/dev.db',
          DAYMARK_TEST_SIMULATE_PRODUCTION: '1'
        }
      });
      assert.equal(result.allowed, false);
      assert.match(result.output, /protected database/);
    });
  });

  describe('the hazard it protects against is real', () => {
    test('without an explicit DATABASE_URL the application resolves to the development database', () => {
      // Configuration resolution only — this opens no connection. It demonstrates
      // exactly what an unguarded editor-launched test file would have bound to.
      const resolved = execFileSync(
        process.execPath,
        ['-e', "const {env}=require('./src/config/env'); console.log(env.NODE_ENV+'|'+env.DATABASE_URL);"],
        { cwd: BACKEND_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' }
      ).trim();

      const [nodeEnv, databaseUrl] = resolved.split('|');
      assert.equal(nodeEnv, 'development', 'an unguarded run falls back to the development environment');
      assert.match(databaseUrl, /dev\.db$/, 'an unguarded run would bind the development database');

      // And the guard refuses that exact situation.
      const guarded = loadGuard({ env: {} });
      assert.equal(guarded.allowed, false, 'the guard must refuse what the unguarded run would have accepted');
    });

    test('the guard throws rather than returning, so a test file cannot continue', () => {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `try { require(${JSON.stringify(path.join(__dirname, 'helpers', 'guard.js'))}); console.log('CONTINUED'); }
           catch (error) { console.log('THREW:' + error.message); }`
        ],
        { cwd: BACKEND_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' }, encoding: 'utf8' }
      );
      assert.match(result.stdout, /^THREW:/m);
      assert.doesNotMatch(result.stdout, /CONTINUED/);
    });

    test('failure output contains no secret values', () => {
      const result = loadGuard({ env: { NODE_ENV: 'test', DATABASE_URL: 'file:./prisma/dev.db' } });
      assert.doesNotMatch(result.output, /JWT_SECRET/i);
      assert.doesNotMatch(result.output, /EMAIL_PROVIDER_TOKEN/i);
      assert.doesNotMatch(result.output, /password/i);
    });
  });

  test('none of the above touched the development database', () => {
    assert.equal(devDbFingerprint(), devDbBefore, 'dev.db must be byte-identical after the guard tests');
  });
});
