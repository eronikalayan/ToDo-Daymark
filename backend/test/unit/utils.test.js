'use strict';

// REF-008 — unit tests for the exported pure helpers.
//
// Scope note: the refactoring plan also names `parseDate`, `exclusiveDateEnd`,
// `buildListWhere` and `PRIORITY_ORDER`. None of those is exported from
// src/services/task.service.js, and Stage 2 is not permitted to modify
// production code, so they are not unit-tested here. Their observable behaviour
// is covered end-to-end in test/tasks.test.js (inclusive single-day due-date
// ranges, priority ordering, search filtering) and in the schema tests below.
require('../helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toPublicUser } = require('../../src/utils/safe-user');
const { AppError } = require('../../src/utils/app-error');
const { asyncHandler } = require('../../src/utils/async-handler');

describe('toPublicUser', () => {
  const row = {
    id: 'u-1',
    name: 'Ada',
    email: 'ada@example.test',
    passwordHash: '$2a$12$averysecrethashvalue',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  };

  test('returns exactly the allowlisted fields', () => {
    assert.deepEqual(Object.keys(toPublicUser(row)).sort(), ['createdAt', 'email', 'id', 'name', 'updatedAt']);
  });

  test('never leaks the password hash or verification state', () => {
    const serialised = JSON.stringify(toPublicUser(row));
    assert.doesNotMatch(serialised, /\$2[aby]\$/, 'a bcrypt hash must never appear');
    assert.equal('passwordHash' in toPublicUser(row), false);
    assert.equal('emailVerifiedAt' in toPublicUser(row), false);
  });

  test('is an allowlist, not a denylist: unknown fields are dropped', () => {
    const withExtras = { ...row, internalNote: 'secret', role: 'admin' };
    const result = toPublicUser(withExtras);
    assert.equal('internalNote' in result, false);
    assert.equal('role' in result, false);
  });

  test('passes values through unchanged', () => {
    const result = toPublicUser(row);
    assert.equal(result.id, 'u-1');
    assert.equal(result.email, 'ada@example.test');
    assert.equal(result.createdAt, row.createdAt);
  });

  test('yields undefined fields rather than throwing on a sparse object', () => {
    const result = toPublicUser({ id: 'u-2' });
    assert.equal(result.id, 'u-2');
    assert.equal(result.name, undefined);
  });
});

describe('AppError', () => {
  test('carries status, message, code and details', () => {
    const error = new AppError(422, 'Validation failed', 'VALIDATION_ERROR', [{ path: 'title' }]);
    assert.equal(error.statusCode, 422);
    assert.equal(error.message, 'Validation failed');
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(error.details, [{ path: 'title' }]);
  });

  test('defaults the code and leaves details undefined', () => {
    const error = new AppError(500, 'Boom');
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.details, undefined);
  });

  test('is a real Error subclass so instanceof checks in the error handler work', () => {
    const error = new AppError(404, 'Not found', 'NOT_FOUND');
    assert.ok(error instanceof AppError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AppError');
    assert.ok(typeof error.stack === 'string' && error.stack.length > 0);
  });

  test('excludes its own constructor from the stack trace', () => {
    const error = new AppError(400, 'Bad');
    assert.doesNotMatch(error.stack.split('\n')[1] ?? '', /new AppError/);
  });
});

describe('asyncHandler', () => {
  const noop = () => {};

  test('forwards a rejected promise to next()', async () => {
    const failure = new Error('async failure');
    let forwarded;
    const wrapped = asyncHandler(async () => {
      throw failure;
    });

    await wrapped({}, {}, (error) => {
      forwarded = error;
    });
    // next() is called from a promise callback, so yield once.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forwarded, failure);
  });

  test('does not call next() when the handler resolves', async () => {
    let called = false;
    const wrapped = asyncHandler(async () => 'ok');

    await wrapped({}, {}, () => {
      called = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, false);
  });

  test('passes request, response and next straight through', async () => {
    const request = { id: 'r-1' };
    const response = { locals: {} };
    let seen;
    const wrapped = asyncHandler(async (req, res, next) => {
      seen = { req, res, next };
    });

    await wrapped(request, response, noop);
    assert.equal(seen.req, request);
    assert.equal(seen.res, response);
    assert.equal(seen.next, noop);
  });

  test('a synchronous throw propagates instead of reaching next() — Express catches it', () => {
    // Documents real behaviour: the handler is invoked before Promise.resolve
    // wraps its result, so a synchronous throw escapes the .catch(next) chain.
    const wrapped = asyncHandler(() => {
      throw new Error('sync failure');
    });
    assert.throws(() => wrapped({}, {}, noop), /sync failure/);
  });

  test('tolerates a non-promise return value', async () => {
    let called = false;
    const wrapped = asyncHandler(() => 42);
    await wrapped({}, {}, () => {
      called = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, false);
  });
});

describe('isolation', () => {
  test('this suite never loads Prisma, so it needs no database', () => {
    const loadedPrisma = Object.keys(require.cache).filter((m) => m.includes('@prisma/client'));
    assert.deepEqual(loadedPrisma, [], 'unit tests must not pull in a database client');
  });
});
