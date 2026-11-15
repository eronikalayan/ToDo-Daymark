'use strict';

// REF-008 — unit tests for the Zod request schemas.
//
// These schemas are the entire input contract of the API: `.strict()` on every
// object is what makes the service immune to mass assignment and prototype
// pollution, and the date and password rules encode real, non-obvious decisions.
// Testing them directly is far cheaper than discovering a regression through an
// integration test, and needs no database.
require('../helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../../src/schemas/auth.schemas');
const task = require('../../src/schemas/task.schemas');
const social = require('../../src/schemas/social.schemas');

/** Convenience: parse and return either the data or the issue paths. */
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: result.error.issues.map((i) => i.path.join('.')) };
};

describe('auth schemas', () => {
  const valid = { name: 'Ada Lovelace', email: 'Ada@Example.TEST', password: 'correct-horse-battery-7' };

  test('registration normalises the email to lower case and trims the name', () => {
    const result = parse(auth.registerSchema, { ...valid, name: '  Ada Lovelace  ' });
    assert.equal(result.ok, true);
    assert.equal(result.data.email, 'ada@example.test');
    assert.equal(result.data.name, 'Ada Lovelace');
  });

  test('registration rejects unknown fields', () => {
    const result = parse(auth.registerSchema, { ...valid, role: 'admin', id: 'forged' });
    assert.equal(result.ok, false);
  });

  test('password must be at least 8 characters', () => {
    assert.equal(parse(auth.registerSchema, { ...valid, password: '1234567' }).ok, false);
    assert.equal(parse(auth.registerSchema, { ...valid, password: '12345678' }).ok, true);
  });

  test('password is limited by BYTES, not characters, because bcrypt truncates at 72', () => {
    // 72 ASCII characters = 72 bytes: accepted.
    assert.equal(parse(auth.registerSchema, { ...valid, password: 'a'.repeat(72) }).ok, true);
    assert.equal(parse(auth.registerSchema, { ...valid, password: 'a'.repeat(73) }).ok, false);

    // 24 four-byte emoji = 96 bytes but only 24 characters: must still be rejected.
    const emoji = '🔐'.repeat(24);
    assert.equal(emoji.length < 72, true, 'fewer than 72 UTF-16 code units');
    assert.equal(Buffer.byteLength(emoji, 'utf8'), 96);
    assert.equal(parse(auth.registerSchema, { ...valid, password: emoji }).ok, false);
  });

  test('an invalid email is rejected', () => {
    for (const email of ['not-an-email', 'a@', '@b.com', '']) {
      assert.equal(parse(auth.registerSchema, { ...valid, email }).ok, false, `${email} must be rejected`);
    }
  });

  test('login accepts any non-empty password so existing accounts are never locked out by new rules', () => {
    // Deliberately laxer than registration: a password that predates the current
    // policy must still be presentable at login.
    assert.equal(parse(auth.loginSchema, { email: 'a@b.test', password: 'short' }).ok, true);
    assert.equal(parse(auth.loginSchema, { email: 'a@b.test', password: '' }).ok, false);
  });

  test('reset and verification tokens are bounded in length', () => {
    assert.equal(parse(auth.resetPasswordSchema, { token: 'x'.repeat(4096), password: 'correct-horse-7' }).ok, true);
    assert.equal(parse(auth.resetPasswordSchema, { token: 'x'.repeat(4097), password: 'correct-horse-7' }).ok, false);
    assert.equal(parse(auth.verifyEmailQuerySchema, { token: '' }).ok, false);
  });
});

describe('task schemas', () => {
  describe('date handling', () => {
    const accepted = ['2026-12-01', '2026-02-28', '2024-02-29', '2026-12-01T10:00:00Z', '2026-12-01T10:00:00+05:00'];
    const rejected = ['2026-02-31', '2026-13-01', '2026-00-10', '2023-02-29', 'not-a-date', '12/01/2026', '20261201'];

    for (const value of accepted) {
      test(`accepts ${value}`, () => {
        assert.equal(parse(task.createTaskSchema, { title: 't', dueDate: value }).ok, true);
      });
    }

    for (const value of rejected) {
      test(`rejects ${value}`, () => {
        assert.equal(parse(task.createTaskSchema, { title: 't', dueDate: value }).ok, false);
      });
    }

    test('accepts an explicit null to clear the due date', () => {
      assert.equal(parse(task.createTaskSchema, { title: 't', dueDate: null }).ok, true);
    });
  });

  describe('createTaskSchema', () => {
    test('defaults the priority to medium', () => {
      assert.equal(parse(task.createTaskSchema, { title: 't' }).data.priority, 'medium');
    });

    test('trims the title and enforces its bounds', () => {
      assert.equal(parse(task.createTaskSchema, { title: '   padded   ' }).data.title, 'padded');
      assert.equal(parse(task.createTaskSchema, { title: '   ' }).ok, false);
      assert.equal(parse(task.createTaskSchema, { title: 'a'.repeat(200) }).ok, true);
      assert.equal(parse(task.createTaskSchema, { title: 'a'.repeat(201) }).ok, false);
    });

    test('rejects server-controlled fields, which is what prevents mass assignment', () => {
      for (const forged of [{ userId: 'x' }, { createdById: 'x' }, { id: 'x' }, { completedAt: new Date().toISOString() }, { createdAt: '2020-01-01' }]) {
        assert.equal(parse(task.createTaskSchema, { title: 't', ...forged }).ok, false, `${Object.keys(forged)[0]} must be rejected`);
      }
    });

    test('rejects a prototype-pollution attempt', () => {
      assert.equal(parse(task.createTaskSchema, { title: 't', __proto__: { polluted: true } }).ok, false);
      assert.equal({}.polluted, undefined);
    });

    test('validates assignedToId as a UUID and bounds sortOrder', () => {
      assert.equal(parse(task.createTaskSchema, { title: 't', assignedToId: 'nope' }).ok, false);
      assert.equal(parse(task.createTaskSchema, { title: 't', sortOrder: -1 }).ok, false);
      assert.equal(parse(task.createTaskSchema, { title: 't', sortOrder: 1_000_001 }).ok, false);
      assert.equal(parse(task.createTaskSchema, { title: 't', sortOrder: 0 }).ok, true);
    });
  });

  describe('updateTaskSchema', () => {
    test('requires at least one field', () => {
      assert.equal(parse(task.updateTaskSchema, {}).ok, false);
      assert.equal(parse(task.updateTaskSchema, { title: 'new' }).ok, true);
    });

    test('does not accept assignedToId, so a task cannot be reassigned after creation', () => {
      assert.equal(parse(task.updateTaskSchema, { assignedToId: '11111111-2222-4333-8444-555555555555' }).ok, false);
    });

    test('accepts explicit nulls for the nullable fields', () => {
      assert.equal(parse(task.updateTaskSchema, { description: null, dueDate: null }).ok, true);
    });
  });

  describe('listTasksSchema', () => {
    test('coerces query strings to the right types and applies defaults', () => {
      const result = parse(task.listTasksSchema, { completed: 'true', page: '2', limit: '50' });
      assert.equal(result.ok, true);
      assert.equal(result.data.completed, true);
      assert.equal(result.data.page, 2);
      assert.equal(result.data.limit, 50);
      assert.equal(result.data.sortBy, 'createdAt');
      assert.equal(result.data.order, 'desc');
    });

    test('only "true"/"false" are accepted for completed', () => {
      assert.equal(parse(task.listTasksSchema, { completed: 'false' }).data.completed, false);
      for (const value of ['maybe', '1', 'yes', '']) {
        assert.equal(parse(task.listTasksSchema, { completed: value }).ok, false, `${value} must be rejected`);
      }
    });

    test('enforces pagination bounds', () => {
      assert.equal(parse(task.listTasksSchema, { limit: '101' }).ok, false);
      assert.equal(parse(task.listTasksSchema, { limit: '100' }).ok, true);
      assert.equal(parse(task.listTasksSchema, { page: '0' }).ok, false);
    });

    test('rejects an inverted due-date range, reporting it against dueBefore', () => {
      const bad = parse(task.listTasksSchema, { dueAfter: '2026-12-10', dueBefore: '2026-12-01' });
      assert.equal(bad.ok, false);
      assert.ok(bad.issues.includes('dueBefore'));

      assert.equal(parse(task.listTasksSchema, { dueAfter: '2026-12-01', dueBefore: '2026-12-01' }).ok, true);
    });

    test('rejects unknown query parameters', () => {
      assert.equal(parse(task.listTasksSchema, { sortBy: 'createdAt', bogus: '1' }).ok, false);
    });

    test('does not yet accept sortOrder as a sort key (BE-013, scheduled for REF-041)', () => {
      assert.equal(parse(task.listTasksSchema, { sortBy: 'sortOrder' }).ok, false);
    });
  });

  describe('idParams', () => {
    test('accepts a UUID and rejects anything else', () => {
      assert.equal(parse(task.idParams, { id: '11111111-2222-4333-8444-555555555555' }).ok, true);
      for (const id of ['1', 'not-a-uuid', '', '11111111-2222-4333-8444']) {
        assert.equal(parse(task.idParams, { id }).ok, false, `${id} must be rejected`);
      }
    });
  });
});

describe('social schemas', () => {
  test('a friend request normalises the email', () => {
    assert.equal(parse(social.requestBody, { email: '  Friend@Example.TEST ' }).data.email, 'friend@example.test');
  });

  test('a decision must be accept or decline', () => {
    assert.equal(parse(social.requestDecisionBody, { action: 'accept' }).ok, true);
    assert.equal(parse(social.requestDecisionBody, { action: 'decline' }).ok, true);
    assert.equal(parse(social.requestDecisionBody, { action: 'block' }).ok, false);
  });

  test('message bodies are trimmed and bounded at 500 characters', () => {
    assert.equal(parse(social.messageBody, { body: '  hello  ' }).data.body, 'hello');
    assert.equal(parse(social.messageBody, { body: '   ' }).ok, false);
    assert.equal(parse(social.messageBody, { body: 'x'.repeat(500) }).ok, true);
    assert.equal(parse(social.messageBody, { body: 'x'.repeat(501) }).ok, false);
  });

  test('message pagination defaults to the first 50', () => {
    const result = parse(social.messagesQuery, {});
    assert.equal(result.data.page, 1);
    assert.equal(result.data.limit, 50);
  });

  test('friend route parameters must be UUIDs', () => {
    assert.equal(parse(social.friendParams, { friendId: 'nope' }).ok, false);
    assert.equal(parse(social.friendParams, { friendId: '11111111-2222-4333-8444-555555555555' }).ok, true);
  });
});
