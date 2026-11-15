'use strict';

/**
 * REF-028 — rehearse a candidate migration against a DISPOSABLE copy.
 *
 *   node scripts/rehearse-migration.js <path/to/candidate.sql> [--against <db>]
 *
 * The candidate is required: there is no default. `--against` rehearses on a
 * disposable COPY of a real database (typically a restored backup) instead of
 * synthetic seed data.
 *
 * WHAT IT DOES
 *   1. builds a throwaway database from the REAL migration history
 *   2. seeds representative data, including assigned tasks and the chat messages
 *      that reference them
 *   3. snapshots everything that must survive
 *   4. runs the candidate through a real `prisma migrate deploy`, against a
 *      throwaway copy of the migration history and schema
 *   5. re-snapshots and checks every post-migration condition
 *   6. verifies the behaviour the migration is supposed to deliver
 *   7. deletes the workspace
 *
 * SAFETY
 *   • never touches prisma/dev.db or prisma/test.db — the database is created
 *     fresh under the OS temp directory and removed afterwards
 *   • the candidate SQL is never copied into prisma/migrations/
 *   • exits non-zero if any condition fails
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { BACKEND_ROOT, isProtected, snapshot } = require('./lib/db-safety');
const { createWorkspace, applyMigrations, seedRepresentativeData, destroyWorkspace, PRISMA_CLI } = require('./lib/disposable-db');

// No default candidate. The BE-001 candidate was promoted into the migration
// history by REF-010, and pointing this tool at an already-applied migration
// would rehearse a no-op while reporting success. Future candidates are passed
// explicitly:
//   node scripts/rehearse-migration.js prisma/sql/proposed/<candidate>.sql
//   node scripts/rehearse-migration.js <candidate>.sql --against <copy-of-real.db>

/**
 * Run a candidate migration against a disposable database through real Prisma.
 * `schemaTransform` adapts schema.prisma to the post-migration state so the
 * drift check is meaningful; the real schema.prisma is never modified.
 */
function runCandidate({ candidatePath, databasePath, workspace, schemaTransform }) {
  if (isProtected(databasePath)) throw new Error(`Refusing to rehearse against a protected database: ${databasePath}`);

  // Throwaway copies of everything Prisma needs.
  fs.symlinkSync(path.join(BACKEND_ROOT, 'node_modules'), path.join(workspace, 'node_modules'));

  const migrationsDir = path.join(workspace, 'migrations');
  fs.cpSync(path.join(BACKEND_ROOT, 'prisma', 'migrations'), migrationsDir, { recursive: true });

  const candidateDir = path.join(migrationsDir, '29991231000000_rehearsal_candidate');
  fs.mkdirSync(candidateDir);
  fs.copyFileSync(candidatePath, path.join(candidateDir, 'migration.sql'));

  const schemaPath = path.join(workspace, 'schema.prisma');
  let schema = fs.readFileSync(path.join(BACKEND_ROOT, 'prisma', 'schema.prisma'), 'utf8');
  if (schemaTransform) schema = schemaTransform(schema);
  fs.writeFileSync(schemaPath, schema);

  fs.writeFileSync(
    path.join(workspace, 'prisma.config.ts'),
    `import { defineConfig } from 'prisma/config';\n` +
      `export default defineConfig({ schema: ${JSON.stringify(schemaPath)}, ` +
      `migrations: { path: ${JSON.stringify(migrationsDir)} }, ` +
      `datasource: { url: process.env.DATABASE_URL } });\n`
  );

  const deploy = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` }
  });

  // A broken harness must never masquerade as a passing rehearsal.
  if (/Cannot find module|Failed to load config/.test(deploy.stderr ?? '')) {
    throw new Error(`Rehearsal harness failed before the migration ran:\n${deploy.stderr}`);
  }

  const drift = spawnSync(
    process.execPath,
    [PRISMA_CLI, 'migrate', 'diff', '--from-migrations', migrationsDir, '--to-schema', schemaPath, '--exit-code'],
    { cwd: workspace, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${databasePath}` } }
  );

  return {
    applied: deploy.status === 0,
    deployOutput: `${deploy.stdout}${deploy.stderr}`,
    driftExitCode: drift.status,
    driftOutput: `${drift.stdout}${drift.stderr}`
  };
}

/** The BE-001 post-migration conditions, evaluated against before/after snapshots. */
function evaluateBe001(before, after, result, db) {
  const fkCreatedBy = after.schema.foreignKeys.find((f) => f.table === 'tasks' && f.column === 'created_by_id');
  const createdByColumn = after.schema.columns.tasks.find((c) => c.name === 'created_by_id');
  const taskIndexes = after.schema.indexes.filter((i) => i.startsWith('tasks.'));

  const conditions = [
    {
      id: 1,
      name: 'PRAGMA foreign_key_check returns no rows',
      pass: after.integrity.foreignKeyViolationCount === 0,
      detail: `${after.integrity.foreignKeyViolationCount} violation(s)`
    },
    {
      id: 2,
      name: 'tasks row count unchanged',
      pass: after.counts.tasks === before.counts.tasks,
      detail: `${before.counts.tasks} -> ${after.counts.tasks}`
    },
    {
      id: 3,
      name: 'chat_messages task links unchanged',
      pass: after.relationships.chatMessagesLinkedToTasks === before.relationships.chatMessagesLinkedToTasks,
      detail: `${before.relationships.chatMessagesLinkedToTasks} -> ${after.relationships.chatMessagesLinkedToTasks}`
    },
    {
      id: 4,
      name: 'both priority triggers present',
      pass: after.schema.triggers.includes('tasks.tasks_priority_insert_check') &&
        after.schema.triggers.includes('tasks.tasks_priority_update_check'),
      detail: after.schema.triggers.join(', ') || '(none)'
    },
    {
      id: 5,
      name: 'all 8 task indexes present',
      pass: taskIndexes.length === 8,
      detail: `${taskIndexes.length}/8`
    },
    {
      id: 6,
      name: 'tasks.created_by_id foreign key is ON DELETE SET NULL',
      pass: fkCreatedBy?.onDelete === 'SET NULL',
      detail: fkCreatedBy ? fkCreatedBy.onDelete : '(foreign key missing)'
    },
    {
      id: 7,
      name: 'prisma migrate diff reports no drift',
      pass: result.driftExitCode === 0,
      detail: `exit ${result.driftExitCode}`
    },
    // --- Additional conditions beyond the seven in the roadmap ---------------
    {
      id: 8,
      name: 'PRAGMA integrity_check passes',
      pass: after.integrity.integrityOk,
      detail: after.integrity.integrityDetail
    },
    {
      id: 9,
      name: 'tasks.created_by_id is now nullable',
      pass: createdByColumn !== undefined && createdByColumn.notNull === false,
      detail: createdByColumn ? `notNull=${createdByColumn.notNull}` : '(column missing)'
    },
    {
      id: 10,
      name: 'no orphaned chat->task references were introduced',
      pass: after.relationships.orphanedTaskLinks === 0,
      detail: `${after.relationships.orphanedTaskLinks} orphan(s)`
    },
    {
      id: 11,
      name: 'every other table kept its row count',
      pass: Object.entries(before.counts)
        .filter(([table]) => table !== '_prisma_migrations')
        .every(([table, count]) => after.counts[table] === count),
      detail: Object.entries(before.counts)
        .filter(([table]) => table !== '_prisma_migrations' && after.counts[table] !== count_(before, table))
        .map(([table]) => table)
        .join(', ') || 'all unchanged'
    },
    {
      id: 12,
      name: 'the friendships CHECK constraint survived',
      pass: after.schema.checks.some((c) => c.table === 'friendships'),
      detail: after.schema.checks.map((c) => `${c.table}: ${c.expression}`).join('; ') || '(none)'
    },
    {
      id: 13,
      name: 'priority triggers still ENFORCE (behaviour, not just existence)',
      ...(() => {
        try {
          db.prepare(
            `INSERT INTO tasks (id,user_id,created_by_id,title,priority,priority_order,sort_order,completed,created_at,updated_at)
             SELECT lower(hex(randomblob(16))),user_id,created_by_id,'probe','urgent',2,0,0,datetime('now'),datetime('now') FROM tasks LIMIT 1`
          ).run();
          return { pass: false, detail: 'an invalid priority was accepted' };
        } catch (error) {
          return { pass: /invalid task priority/.test(error.message), detail: error.message };
        }
      })()
    },
    {
      id: 14,
      name: 'assigned tasks still belong to their owners',
      pass: after.relationships.assignedTasks === before.relationships.assignedTasks,
      detail: `${before.relationships.assignedTasks} -> ${after.relationships.assignedTasks}`
    }
  ];

  return conditions;
}

function count_(snapshotObject, table) {
  return snapshotObject.counts[table];
}

/** Does the migration actually fix BE-001? Checked by behaviour, on the copy. */
function verifyBe001Behaviour(db) {
  const results = [];

  const assigned = db
    .prepare('SELECT id, user_id, created_by_id FROM tasks WHERE created_by_id IS NOT NULL AND created_by_id <> user_id LIMIT 1')
    .get();
  if (!assigned) return [{ name: 'no assigned task available to test', pass: false }];

  // Capture the control subject BEFORE anything is deleted: a task whose owner
  // is also its creator, belonging to a user unrelated to the deletion below.
  const own = db
    .prepare('SELECT id, user_id FROM tasks WHERE created_by_id = user_id AND user_id <> ? LIMIT 1')
    .get(assigned.created_by_id);

  db.pragma('foreign_keys = ON');
  db.prepare('DELETE FROM users WHERE id = ?').run(assigned.created_by_id);

  const survivor = db.prepare('SELECT id, user_id, created_by_id FROM tasks WHERE id = ?').get(assigned.id);
  results.push({
    name: "the recipient's task survives the creator's account deletion",
    pass: survivor !== undefined,
    detail: survivor ? 'task still present' : 'TASK DELETED — BE-001 not fixed'
  });
  results.push({
    name: 'the task still belongs to its owner',
    pass: survivor?.user_id === assigned.user_id,
    detail: survivor ? `owner ${survivor.user_id === assigned.user_id ? 'unchanged' : 'CHANGED'}` : 'n/a'
  });
  results.push({
    name: 'created_by_id is nulled rather than taking the task with it',
    pass: survivor?.created_by_id === null,
    detail: survivor ? `created_by_id = ${survivor.created_by_id === null ? 'NULL' : survivor.created_by_id}` : 'n/a'
  });

  // Control: a user's OWN tasks must still be removed with their account, so the
  // fix cannot over-correct into orphaning tasks nobody owns.
  if (own) {
    db.prepare('DELETE FROM users WHERE id = ?').run(own.user_id);
    const gone = db.prepare('SELECT id FROM tasks WHERE id = ?').get(own.id) === undefined;
    results.push({
      name: "CONTROL: a user's own tasks are still deleted with their account",
      pass: gone,
      detail: gone ? 'deleted as expected' : 'OWN TASK SURVIVED — the fix over-corrected'
    });
  } else {
    // Distinguish "the check ran and the behaviour was wrong" (a failure) from
    // "the dataset could not exercise this check" (not applicable). A real
    // database may legitimately contain no suitable subject; reporting that as a
    // failure would make a safe migration look unsafe. It is still surfaced
    // loudly, because an N/A control is a guarantee this run did NOT verify.
    results.push({
      name: "CONTROL: a user's own tasks are still deleted with their account",
      applicable: false,
      detail: 'this dataset has no self-created task owned by a user other than the deleted creator'
    });
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const againstIndex = args.indexOf('--against');
  // `--against <db>` rehearses on a COPY of a real database (typically a restored
  // backup) instead of synthetic seed data. The source is only ever read.
  const againstPath = againstIndex === -1 ? null : path.resolve(args[againstIndex + 1]);
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== againstIndex + 1);

  if (!positional[0]) {
    throw new Error(
      'Usage: node scripts/rehearse-migration.js <candidate.sql> [--against <database.db>]\n' +
        'A candidate must be given explicitly: rehearsing an already-applied migration would be a no-op.'
    );
  }
  const candidatePath = path.resolve(positional[0]);
  if (!fs.existsSync(candidatePath)) throw new Error(`Candidate migration not found: ${candidatePath}`);
  if (againstPath && !fs.existsSync(againstPath)) throw new Error(`--against database not found: ${againstPath}`);

  process.stdout.write(`Rehearsing: ${path.relative(BACKEND_ROOT, candidatePath)}\n`);
  process.stdout.write(
    againstPath
      ? `Target:     a disposable COPY of ${againstPath}\n\n`
      : 'Target:     a disposable database under the OS temp directory\n\n'
  );

  const workspace = createWorkspace('daymark-rehearsal');
  let failures = 0;

  try {
    const databasePath = path.join(workspace, 'rehearsal.db');
    let seed = null;
    if (againstPath) {
      // Copy through the filesystem into the disposable workspace; the source is
      // never opened for writing and never migrated in place.
      fs.copyFileSync(againstPath, databasePath);
      for (const sidecar of ['-wal', '-shm', '-journal']) {
        const from = `${againstPath}${sidecar}`;
        if (fs.existsSync(from)) fs.copyFileSync(from, `${databasePath}${sidecar}`);
      }
    } else {
      applyMigrations(databasePath);
      seed = seedRepresentativeData(databasePath);
    }

    const beforeDb = new Database(databasePath, { readonly: true });
    const before = snapshot(beforeDb);
    beforeDb.close();

    process.stdout.write('Before the candidate migration:\n');
    process.stdout.write(`  tasks ${before.counts.tasks} | assigned ${before.relationships.assignedTasks} | ` +
      `chat messages ${before.counts.chat_messages} | task links ${before.relationships.chatMessagesLinkedToTasks}\n`);
    process.stdout.write(`  triggers ${before.schema.triggers.length} | task indexes ` +
      `${before.schema.indexes.filter((i) => i.startsWith('tasks.')).length} | checks ${before.schema.checks.length}\n\n`);

    const result = runCandidate({
      candidatePath,
      databasePath,
      workspace,
      // Reflect the post-migration state so the drift check means something.
      // The real schema.prisma is untouched.
      schemaTransform: (schema) =>
        schema
          .replace('createdById String    @map("created_by_id")', 'createdById String?   @map("created_by_id")')
          .replace(
            'createdBy   User      @relation("TaskCreator", fields: [createdById], references: [id], onDelete: Cascade)',
            'createdBy   User?     @relation("TaskCreator", fields: [createdById], references: [id], onDelete: SetNull)'
          )
    });

    if (!result.applied) {
      process.stderr.write(`The candidate migration FAILED to apply:\n${result.deployOutput}\n`);
      process.exitCode = 1;
      return;
    }

    const afterDb = new Database(databasePath);
    const after = snapshot(afterDb);

    process.stdout.write('Post-migration conditions:\n');
    for (const condition of evaluateBe001(before, after, result, afterDb)) {
      const mark = condition.pass ? 'PASS' : 'FAIL';
      if (!condition.pass) failures += 1;
      process.stdout.write(`  ${String(condition.id).padStart(2)}. [${mark}] ${condition.name}\n        ${condition.detail}\n`);
    }

    process.stdout.write('\nBehaviour the migration is meant to deliver:\n');
    let notApplicable = 0;
    for (const check of verifyBe001Behaviour(afterDb)) {
      const skipped = check.applicable === false;
      const mark = skipped ? ' N/A' : check.pass ? 'PASS' : 'FAIL';
      if (skipped) notApplicable += 1;
      else if (!check.pass) failures += 1;
      process.stdout.write(`      [${mark}] ${check.name}\n        ${check.detail ?? ''}\n`);
    }
    if (notApplicable > 0) {
      process.stdout.write(
        `\n  NOTE: ${notApplicable} check(s) could not be exercised by this dataset.\n` +
          '        Rely on the seeded rehearsal (run without --against) for those guarantees.\n'
      );
    }

    afterDb.close();
    if (seed) process.stdout.write(`\nSeeded expectations: ${JSON.stringify(seed.expected)}\n`);
  } finally {
    destroyWorkspace(workspace);
    process.stdout.write('\nDisposable workspace removed.\n');
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} condition(s) FAILED. The candidate migration is not safe to promote.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nAll conditions passed. The candidate is safe to promote in Stage 4 (REF-010).\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nRehearsal failed: ${error.message}\n`);
  process.exitCode = 1;
}
