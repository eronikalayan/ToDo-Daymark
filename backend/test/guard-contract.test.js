'use strict';

/**
 * REF-030 requirement 7 — "every test suite must receive the protection before
 * importing modules that may initialize Prisma".
 *
 * A convention that lives only in a comment decays. This suite enforces it
 * mechanically: it reads every test file and asserts that the guard is the first
 * thing each one requires, so a new suite cannot be added without protection and
 * an existing one cannot quietly lose it.
 */
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_ROOT = __dirname;

/** Every *.test.js under test/, recursively. */
function findTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [full] : [];
  });
}

/** The first `require(...)` specifier in a file, ignoring comments and 'use strict'. */
function firstRequireSpecifier(source) {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rawLine of withoutBlockComments.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line || /^['"]use strict['"];?$/.test(line)) continue;
    const match = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
    if (match) return match[1];
    // Any other executable statement before the first require also counts as
    // "something ran before the guard".
    return null;
  }
  return null;
}

const testFiles = findTestFiles(TEST_ROOT);

describe('REF-030 guard contract', () => {
  test('there is at least one test file to check', () => {
    assert.ok(testFiles.length > 0);
  });

  for (const file of testFiles) {
    const relative = path.relative(TEST_ROOT, file);

    test(`${relative} requires the guard before anything else`, () => {
      const specifier = firstRequireSpecifier(fs.readFileSync(file, 'utf8'));
      assert.ok(
        specifier !== null,
        `${relative} executes something before its first require(); the guard must come first`
      );
      assert.match(
        specifier,
        /helpers\/guard$/,
        `${relative} first requires "${specifier}". It must require the guard first, or it could ` +
          'initialise Prisma against the development database when run directly from an editor.'
      );
    });
  }

  test('fixture helpers that reach Prisma are guarded too', () => {
    const helperRoot = path.join(TEST_ROOT, 'helpers');
    for (const name of fs.readdirSync(helperRoot)) {
      if (name === 'guard.js' || !name.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(helperRoot, name), 'utf8');
      assert.match(
        firstRequireSpecifier(source) ?? '',
        /\.\/guard$/,
        `test/helpers/${name} must require the guard before anything else`
      );
    }
  });

  test('every child-process fixture is guarded as well', () => {
    // These spawn fresh processes, so they must re-validate the environment
    // themselves rather than inheriting a guarded parent.
    const fixtureRoot = path.join(TEST_ROOT, 'fixtures');
    assert.ok(fs.existsSync(fixtureRoot), 'test/fixtures/ must exist');

    const fixtures = fs.readdirSync(fixtureRoot).filter((name) => name.endsWith('.js'));
    assert.ok(fixtures.length > 0, 'there must be at least one fixture to check');

    for (const name of fixtures) {
      assert.match(
        firstRequireSpecifier(fs.readFileSync(path.join(fixtureRoot, name), 'utf8')) ?? '',
        /helpers\/guard$/,
        `test/fixtures/${name} must require the guard before anything else`
      );
    }
  });
});
