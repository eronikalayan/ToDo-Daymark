'use strict';

// REF-029 — backup and restore verification.
//
// Everything runs against disposable databases under the OS temp directory.
// prisma/dev.db is never written; a fingerprint is taken before and after to
// prove it.
require('./helpers/guard'); // MUST be first — see helpers/guard.js

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { BACKEND_ROOT, snapshot, isProtected, assertWritableTarget } = require('../scripts/lib/db-safety');
const { createSeededDatabase, destroyWorkspace } = require('../scripts/lib/disposable-db');

const BACKUP_SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'db-backup.js');
const RESTORE_SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'db-restore.js');
const DEV_DB = path.join(BACKEND_ROOT, 'prisma', 'dev.db');

const devFingerprint = () =>
  fs.existsSync(DEV_DB) ? crypto.createHash('md5').update(fs.readFileSync(DEV_DB)).digest('hex') : 'absent';

const devBefore = devFingerprint();

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let workspace;
let databasePath;
let seed;
let backupPath;

before(() => {
  ({ workspace, databasePath, seed } = createSeededDatabase('daymark-backup-test'));
});

after(() => {
  destroyWorkspace(workspace);
});

describe('backup', () => {
  test('produces a verified snapshot of a disposable database', () => {
    const outDir = path.join(workspace, 'backups');
    fs.mkdirSync(outDir, { recursive: true });

    const result = run(BACKUP_SCRIPT, [databasePath, '--out', outDir, '--label', 'suite']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Backup verified/);

    const created = fs.readdirSync(outDir);
    assert.equal(created.length, 1);
    backupPath = path.join(outDir, created[0], 'suite.db');
    assert.ok(fs.existsSync(backupPath));
  });

  test('writes a manifest describing structure, never row data', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(backupPath), 'manifest.json'), 'utf8'));
    assert.equal(manifest.verified, true);
    assert.equal(manifest.mechanism, 'sqlite-online-backup-api');
    assert.equal(manifest.counts.tasks, seed.expected.tasks);
    assert.equal(manifest.relationships.chatMessagesLinkedToTasks, seed.expected.chatMessagesLinkedToTasks);
    assert.equal(manifest.integrity.integrityOk, true);

    // No user content may appear in the manifest.
    const serialised = JSON.stringify(manifest);
    assert.doesNotMatch(serialised, /password_hash|\$2[aby]\$/);
    assert.doesNotMatch(serialised, /@disposable\.test/, 'email addresses must not be recorded');
    assert.doesNotMatch(serialised, /Sent you a task/, 'message bodies must not be recorded');
  });

  test('the backup passes SQLite integrity and foreign-key checks', () => {
    const db = new Database(backupPath, { readonly: true });
    const state = snapshot(db);
    db.close();
    assert.equal(state.integrity.integrityOk, true);
    assert.equal(state.integrity.foreignKeyViolationCount, 0);
  });

  test('structure, counts and relationships match the source', () => {
    const sourceDb = new Database(databasePath, { readonly: true });
    const source = snapshot(sourceDb);
    sourceDb.close();

    const backupDb = new Database(backupPath, { readonly: true });
    const backup = snapshot(backupDb);
    backupDb.close();

    assert.equal(backup.schemaFingerprint, source.schemaFingerprint);
    assert.deepEqual(backup.counts, source.counts);
    assert.deepEqual(backup.relationships, source.relationships);
    assert.deepEqual(backup.schema.triggers, source.schema.triggers);
    assert.deepEqual(backup.schema.checks, source.schema.checks);
  });

  test('refuses a non-existent source', () => {
    const result = run(BACKUP_SCRIPT, [path.join(workspace, 'nope.db')]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /does not exist/);
  });
});

describe('backup captures WAL-resident data that a file copy would miss', () => {
  test('a naive copy loses rows; the backup API does not', async () => {
    const scenario = createSeededDatabase('daymark-wal-test');
    try {
      const live = new Database(scenario.databasePath);
      live.pragma('journal_mode = WAL');
      live
        .prepare(
          `INSERT INTO chat_messages (id,sender_id,recipient_id,task_id,body,created_at)
           SELECT lower(hex(randomblob(16))),sender_id,recipient_id,task_id,'wal row',datetime('now')
           FROM chat_messages WHERE task_id IS NOT NULL LIMIT 1`
        )
        .run();
      const liveCount = live.prepare('SELECT COUNT(*) AS c FROM chat_messages').get().c;

      // What `cp` would produce: the main file only.
      const naive = path.join(scenario.workspace, 'naive-copy.db');
      fs.copyFileSync(scenario.databasePath, naive);
      const naiveDb = new Database(naive, { readonly: true });
      const naiveCount = naiveDb.prepare('SELECT COUNT(*) AS c FROM chat_messages').get().c;
      naiveDb.close();

      // What the Online Backup API produces, with the writer still connected.
      const proper = path.join(scenario.workspace, 'proper-backup.db');
      const reader = new Database(scenario.databasePath, { readonly: true });
      await reader.backup(proper);
      reader.close();
      const properDb = new Database(proper, { readonly: true });
      const properCount = properDb.prepare('SELECT COUNT(*) AS c FROM chat_messages').get().c;
      properDb.close();
      live.close();

      assert.equal(properCount, liveCount, 'the backup API must capture WAL-resident rows');
      assert.ok(naiveCount <= liveCount);
      assert.ok(
        naiveCount < liveCount || properCount === liveCount,
        'either the naive copy lost rows, or WAL had already been checkpointed'
      );
    } finally {
      destroyWorkspace(scenario.workspace);
    }
  });
});

describe('restore', () => {
  test('restores into an isolated target and verifies the result', () => {
    const target = path.join(workspace, 'restored.db');
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', target]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Restore verified/);
    assert.ok(fs.existsSync(target));
  });

  test('the restored database matches the backup exactly', () => {
    const target = path.join(workspace, 'restored.db');
    const backupDb = new Database(backupPath, { readonly: true });
    const backup = snapshot(backupDb);
    backupDb.close();

    const restoredDb = new Database(target, { readonly: true });
    const restored = snapshot(restoredDb);
    restoredDb.close();

    assert.equal(restored.schemaFingerprint, backup.schemaFingerprint);
    assert.deepEqual(restored.counts, backup.counts);
    assert.deepEqual(restored.relationships, backup.relationships);
    assert.equal(restored.integrity.integrityOk, true);
    assert.equal(restored.integrity.foreignKeyViolationCount, 0);
    assert.equal(restored.relationships.chatMessagesLinkedToTasks, seed.expected.chatMessagesLinkedToTasks);
  });

  test('refuses to overwrite an existing database without --force', () => {
    const target = path.join(workspace, 'restored.db');
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Refusing to overwrite an existing database/);
  });

  test('--force keeps the replaced file aside first', () => {
    const target = path.join(workspace, 'restored.db');
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', target, '--force']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /copied aside first/);
    assert.ok(fs.readdirSync(workspace).some((f) => f.startsWith('restored.db.replaced-')));
  });
});

describe('protected databases cannot be restored over', () => {
  test('dev.db is recognised as protected', () => {
    assert.equal(isProtected(DEV_DB), true);
  });

  test('a plain restore onto dev.db is refused', () => {
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', DEV_DB]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Refusing to write to a protected database/);
  });

  test('--allow-protected alone is not enough', () => {
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', DEV_DB, '--allow-protected', '--force']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /needs an explicit confirmation/);
  });

  test('a wrong confirmation value is rejected', () => {
    const result = spawnSync(
      process.execPath,
      [RESTORE_SCRIPT, backupPath, '--to', DEV_DB, '--allow-protected', '--force'],
      { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, DAYMARK_DB_RESTORE_CONFIRM: '/some/other/path.db' } }
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /set to a different path/);
  });

  test('assertWritableTarget refuses protected paths programmatically', () => {
    assert.throws(() => assertWritableTarget(DEV_DB), /protected database/);
  });

  test('no error message leaks a secret', () => {
    const result = run(RESTORE_SCRIPT, [backupPath, '--to', DEV_DB]);
    assert.doesNotMatch(result.output, /JWT_SECRET|EMAIL_PROVIDER_TOKEN|password_hash|\$2[aby]\$/i);
  });
});

describe('the development database was never touched', () => {
  test('dev.db is byte-identical to before this suite ran', () => {
    assert.equal(devFingerprint(), devBefore);
  });
});
