'use strict';

// REF-028 — migration integrity and regression verification (BE-019, BE-023, BE-001).
//
// Every assertion runs against a DISPOSABLE database built from the real
// checked-in migration history under the OS temp directory. prisma/dev.db and
// prisma/test.db are never opened here.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { BACKEND_ROOT, describeSchema, integrityReport, tableCounts, relationshipCounts, isProtected } =
  require('../scripts/lib/db-safety');
const { createSeededDatabase, destroyWorkspace, PRISMA_CLI } = require('../scripts/lib/disposable-db');
const constraints = require('../scripts/lib/constraints');

let workspace;
let databasePath;
let seed;
let db;
let schema;

before(() => {
  ({ workspace, databasePath, seed } = createSeededDatabase('daymark-migrations-test'));
  db = new Database(databasePath);
  schema = describeSchema(db);
});

after(() => {
  if (db) db.close();
  destroyWorkspace(workspace);
});

describe('the disposable database is genuinely disposable', () => {
  test('it is not a protected database', () => {
    assert.equal(isProtected(databasePath), false);
  });

  test('it lives outside backend/prisma', () => {
    assert.equal(path.resolve(databasePath).startsWith(path.join(BACKEND_ROOT, 'prisma')), false);
  });
});

describe('schema produced by the migration history', () => {
  const EXPECTED_TABLES = [
    '_prisma_migrations',
    'chat_messages',
    'email_verification_tokens',
    'friendships',
    'password_reset_tokens',
    'sessions',
    'tasks',
    'users'
  ];

  test('every expected table exists, and no unexpected one', () => {
    assert.deepEqual(schema.tables.slice().sort(), EXPECTED_TABLES);
  });

  test('every checked-in migration was applied', () => {
    const applied = db.prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL').all();
    const onDisk = fs
      .readdirSync(path.join(BACKEND_ROOT, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.equal(applied.length, onDisk.length);
    assert.deepEqual(applied.map((m) => m.migration_name).sort(), onDisk.slice().sort());
  });

  test('no migration was rolled back', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL').get().c, 0);
  });
});

describe('foreign keys and their deletion rules', () => {
  // The authoritative list lives in scripts/lib/constraints.js, so the test and
  // the constraint documentation cannot drift apart.
  for (const expected of constraints.TABLE_EMBEDDED.foreignKeys) {
    test(`${expected.table}.${expected.column} -> ${expected.references} ON DELETE ${expected.onDelete}`, () => {
      const actual = schema.foreignKeys.find((f) => f.table === expected.table && f.column === expected.column);
      assert.ok(actual, `missing foreign key on ${expected.table}.${expected.column}`);
      assert.equal(actual.references, expected.references);
      assert.equal(actual.onDelete, expected.onDelete);
    });
  }

  test('the full set of foreign keys matches exactly', () => {
    assert.equal(schema.foreignKeys.length, constraints.TABLE_EMBEDDED.foreignKeys.length);
  });

  test('BE-001 stays fixed: ownership cascades, provenance does not', () => {
    // The asymmetry IS the fix. A future migration that rebuilds `tasks` and
    // copies both rules from the same template would silently reintroduce the
    // defect, so both are asserted together.
    const owner = schema.foreignKeys.find((f) => f.table === 'tasks' && f.column === 'user_id');
    const creator = schema.foreignKeys.find((f) => f.table === 'tasks' && f.column === 'created_by_id');
    assert.equal(owner.onDelete, 'CASCADE', 'a user\'s own tasks must still go with their account');
    assert.equal(creator.onDelete, 'SET NULL', 'BE-001 regression: deleting a sender must not delete the recipient\'s task');
  });

  test('BE-001 stays fixed: created_by_id is nullable', () => {
    const column = schema.columns.tasks.find((c) => c.name === 'created_by_id');
    assert.equal(column.notNull, false, 'ON DELETE SET NULL requires a nullable column');
  });

  test('BE-001 stays fixed: the behaviour holds at the database level', () => {
    // Structure can be right while behaviour is wrong (for example if a future
    // rebuild recreated the column without the foreign key at all).
    //
    // This check deletes a user, so it runs against its OWN disposable database:
    // the shared one is used by the row-count assertions further down.
    const probe = createSeededDatabase('daymark-be001-behaviour');
    try {
      const probeDb = new Database(probe.databasePath);
      probeDb.pragma('foreign_keys = ON');

      const assigned = probeDb
        .prepare('SELECT id, user_id, created_by_id FROM tasks WHERE created_by_id IS NOT NULL AND created_by_id <> user_id LIMIT 1')
        .get();
      assert.ok(assigned, 'the seed must contain an assigned task');

      probeDb.prepare('DELETE FROM users WHERE id = ?').run(assigned.created_by_id);

      const survivor = probeDb.prepare('SELECT user_id, created_by_id FROM tasks WHERE id = ?').get(assigned.id);
      assert.ok(survivor, 'the task must survive its creator being deleted');
      assert.equal(survivor.user_id, assigned.user_id, 'ownership must be unchanged');
      assert.equal(survivor.created_by_id, null, 'provenance must be cleared, not cascaded');

      // The ownership cascade must still work in the same database.
      const own = probeDb.prepare('SELECT id, user_id FROM tasks WHERE created_by_id = user_id LIMIT 1').get();
      assert.ok(own, 'the seed must contain a self-created task');
      probeDb.prepare('DELETE FROM users WHERE id = ?').run(own.user_id);
      assert.equal(probeDb.prepare('SELECT id FROM tasks WHERE id = ?').get(own.id), undefined);

      probeDb.close();
    } finally {
      destroyWorkspace(probe.workspace);
    }
  });
});

describe('indexes', () => {
  test('every index promised by constraints.sql exists', () => {
    const promised = constraints.expectedObjects().indexes;
    assert.ok(promised.length >= 18, `expected at least 18 promised indexes, got ${promised.length}`);
    for (const index of promised) {
      assert.ok(
        schema.indexes.includes(`${index.table}.${index.name}`),
        `missing index ${index.name} on ${index.table}`
      );
    }
  });

  test('tasks carries all 8 of its indexes', () => {
    assert.equal(schema.indexes.filter((i) => i.startsWith('tasks.')).length, 8);
  });
});

describe('CHECK constraints (invisible to Prisma)', () => {
  test('friendships.status is constrained', () => {
    const check = schema.checks.find((c) => c.table === 'friendships');
    assert.ok(check, 'the friendships CHECK constraint is missing');
    assert.match(check.expression, /pending/);
    assert.match(check.expression, /accepted/);
  });

  test('it actually rejects an out-of-domain value', () => {
    const friendship = db.prepare('SELECT requester_id, addressee_id FROM friendships LIMIT 1').get();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO friendships (id,requester_id,addressee_id,status,created_at,updated_at)
             VALUES (lower(hex(randomblob(16))),?,?,'blocked',datetime('now'),datetime('now'))`
          )
          .run(friendship.requester_id, friendship.addressee_id),
      /CHECK constraint failed/
    );
  });
});

describe('triggers (invisible to Prisma)', () => {
  test('both priority triggers exist', () => {
    assert.ok(schema.triggers.includes('tasks.tasks_priority_insert_check'));
    assert.ok(schema.triggers.includes('tasks.tasks_priority_update_check'));
  });

  test('every trigger promised by constraints.sql exists', () => {
    for (const name of constraints.expectedObjects().triggers) {
      assert.ok(schema.triggers.some((t) => t.endsWith(`.${name}`)), `missing trigger ${name}`);
    }
  });

  test('the INSERT trigger rejects an invalid priority', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO tasks (id,user_id,created_by_id,title,priority,priority_order,sort_order,completed,created_at,updated_at)
             SELECT lower(hex(randomblob(16))),user_id,created_by_id,'probe','urgent',2,0,0,datetime('now'),datetime('now') FROM tasks LIMIT 1`
          )
          .run(),
      /invalid task priority/
    );
  });

  test('the UPDATE trigger rejects an invalid priority', () => {
    assert.throws(() => db.prepare("UPDATE tasks SET priority='urgent'").run(), /invalid task priority/);
  });

  test('valid priorities are still accepted', () => {
    for (const priority of ['low', 'medium', 'high']) {
      db.prepare('UPDATE tasks SET priority=? WHERE id=(SELECT id FROM tasks LIMIT 1)').run(priority);
    }
  });
});

describe('data integrity', () => {
  test('PRAGMA integrity_check passes', () => {
    const report = integrityReport(db);
    assert.equal(report.integrityOk, true, report.integrityDetail);
  });

  test('PRAGMA foreign_key_check passes', () => {
    const report = integrityReport(db);
    assert.equal(report.foreignKeyViolationCount, 0, report.foreignKeyViolationTables.join(', '));
  });

  test('the seeded records are all present', () => {
    const counts = tableCounts(db);
    assert.equal(counts.users, seed.expected.users);
    assert.equal(counts.tasks, seed.expected.tasks);
    assert.equal(counts.chat_messages, seed.expected.chatMessages);
    assert.equal(counts.friendships, seed.expected.friendships);
    assert.equal(counts.sessions, seed.expected.sessions);
  });

  test('task <-> chat message relationships are intact', () => {
    const relationships = relationshipCounts(db);
    assert.equal(relationships.chatMessagesLinkedToTasks, seed.expected.chatMessagesLinkedToTasks);
    assert.equal(relationships.assignedTasks, seed.expected.assignedTasks);
    assert.equal(relationships.orphanedTaskLinks, 0, 'a chat message references a task that no longer exists');
  });
});

describe('Prisma schema and migration history stay consistent', () => {
  test('migrate diff reports no drift', () => {
    const result = spawnSync(
      process.execPath,
      [
        PRISMA_CLI,
        'migrate',
        'diff',
        '--from-migrations',
        path.join(BACKEND_ROOT, 'prisma', 'migrations'),
        '--to-schema',
        path.join(BACKEND_ROOT, 'prisma', 'schema.prisma'),
        '--exit-code'
      ],
      { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${databasePath}` } }
    );
    assert.equal(result.status, 0, `drift detected:\n${result.stdout}${result.stderr}`);
  });

  test('drift detection is not vacuous: an altered schema IS detected', () => {
    // Negative control. A check that can never fail proves nothing.
    const altered = path.join(workspace, 'altered.prisma');
    fs.writeFileSync(
      altered,
      `${fs.readFileSync(path.join(BACKEND_ROOT, 'prisma', 'schema.prisma'), 'utf8')}\n\nmodel DriftProbe {\n  id String @id\n}\n`
    );
    const result = spawnSync(
      process.execPath,
      [PRISMA_CLI, 'migrate', 'diff', '--from-migrations', path.join(BACKEND_ROOT, 'prisma', 'migrations'), '--to-schema', altered, '--exit-code'],
      { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${databasePath}` } }
    );
    assert.equal(result.status, 2, 'migrate diff failed to notice an added model');
  });

  test('migrate diff CANNOT see triggers — which is why constraints.sql exists', () => {
    // Documents the BE-019 blind spot as an executable fact.
    const probe = createSeededDatabase('daymark-drift-blindspot');
    try {
      const probeDb = new Database(probe.databasePath);
      probeDb.exec('DROP TRIGGER tasks_priority_insert_check; DROP TRIGGER tasks_priority_update_check;');
      assert.equal(describeSchema(probeDb).triggers.length, 0);
      probeDb.close();

      const result = spawnSync(
        process.execPath,
        [PRISMA_CLI, 'migrate', 'diff', '--from-migrations', path.join(BACKEND_ROOT, 'prisma', 'migrations'), '--to-schema', path.join(BACKEND_ROOT, 'prisma', 'schema.prisma'), '--exit-code'],
        { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${probe.databasePath}` } }
      );
      assert.equal(result.status, 0, 'unexpected: migrate diff now reports trigger loss');
    } finally {
      destroyWorkspace(probe.workspace);
    }
  });
});

describe('constraints.sql (REF-025)', () => {
  test('it declares the Section B boundary', () => {
    assert.ok(constraints.readConstraintsFile().includes(constraints.SECTION_B_MARKER));
  });

  test('only Section A is executable; Section B never leaks into it', () => {
    const executable = constraints.executableSection();
    assert.equal(executable.includes('B3. tasks'), false);
    assert.equal(executable.includes(constraints.SECTION_B_MARKER), false);
  });

  test('re-applying Section A restores objects a rebuild would drop', () => {
    const probe = createSeededDatabase('daymark-constraints-reapply');
    try {
      const probeDb = new Database(probe.databasePath);
      probeDb.exec('DROP TRIGGER tasks_priority_insert_check; DROP TRIGGER tasks_priority_update_check; DROP INDEX tasks_user_id_idx;');
      assert.equal(describeSchema(probeDb).triggers.length, 0);

      constraints.applyReappliableObjects(probeDb);

      const restored = describeSchema(probeDb);
      assert.equal(restored.triggers.length, 2);
      assert.equal(restored.indexes.filter((i) => i.startsWith('tasks.')).length, 8);
      probeDb.close();
    } finally {
      destroyWorkspace(probe.workspace);
    }
  });

  test('Section A is idempotent', () => {
    const first = describeSchema(db);
    constraints.applyReappliableObjects(db);
    constraints.applyReappliableObjects(db);
    const second = describeSchema(db);
    assert.deepEqual(second.triggers, first.triggers);
    assert.deepEqual(second.indexes.slice().sort(), first.indexes.slice().sort());
  });
});
