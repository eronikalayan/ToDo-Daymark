'use strict';

/**
 * REF-029 — consistent SQLite backup.
 *
 *   node scripts/db-backup.js [source] [--out <dir>] [--label <name>]
 *
 * Defaults to the database named by DATABASE_URL, or prisma/dev.db.
 *
 * WHY NOT `cp`
 * ------------
 * Copying a live .db file is not a backup. SQLite may have pages in a hot
 * journal or a -wal file that the main file does not yet contain, and a copy
 * taken mid-transaction can be torn. This script uses SQLite's Online Backup
 * API (better-sqlite3's `db.backup()`), which takes a consistent snapshot of a
 * database that is open and in use, and folds any WAL content into the result.
 *
 * SAFETY
 * ------
 *   • the source is opened READ-ONLY, so a backup can never alter it
 *   • the destination must not already exist
 *   • destinations live outside backend/prisma/, so a backup can never be
 *     mistaken for a live database or picked up by the application
 *   • integrity_check and foreign_key_check are run against the RESULT
 *   • structure, row counts and key relationships are compared with the source
 *   • any failure exits non-zero
 *   • nothing but names, counts and structure is ever printed
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  BACKUP_ROOT,
  resolveDatabasePath,
  snapshot
} = require('./lib/db-safety');

function parseArguments(argv) {
  const options = { source: null, out: BACKUP_ROOT, label: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = path.resolve(argv[++i]);
    else if (arg === '--label') options.label = argv[++i];
    else if (!arg.startsWith('--')) options.source = arg;
  }
  return options;
}

function timestamp() {
  // Deterministic, filesystem-safe, sorts chronologically.
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  const sourcePath = resolveDatabasePath(options.source ?? process.env.DATABASE_URL ?? 'prisma/dev.db');
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database does not exist: ${sourcePath}`);
  }

  const label = options.label ?? path.basename(sourcePath, '.db');
  const backupDirectory = path.join(options.out, `${label}_${timestamp()}`);
  if (fs.existsSync(backupDirectory)) {
    throw new Error(`Backup directory already exists: ${backupDirectory}`);
  }
  fs.mkdirSync(backupDirectory, { recursive: true });

  const backupPath = path.join(backupDirectory, `${label}.db`);

  process.stdout.write(`Backing up ${sourcePath}\n           -> ${backupPath}\n\n`);

  // READ-ONLY: this connection cannot modify the source under any circumstance.
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const sourceState = snapshot(source);

  if (!sourceState.integrity.integrityOk) {
    source.close();
    throw new Error(`Source database failed integrity_check: ${sourceState.integrity.integrityDetail}`);
  }

  // SQLite Online Backup API. Safe while the source is open and being written to.
  await source.backup(backupPath);
  source.close();

  // Verify the RESULT, not the intention.
  const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
  const backupState = snapshot(restored);
  restored.close();

  const problems = [];
  if (!backupState.integrity.integrityOk) {
    problems.push(`backup failed integrity_check: ${backupState.integrity.integrityDetail}`);
  }
  if (backupState.integrity.foreignKeyViolationCount > 0) {
    problems.push(
      `backup has ${backupState.integrity.foreignKeyViolationCount} foreign-key violation(s) in: ` +
        backupState.integrity.foreignKeyViolationTables.join(', ')
    );
  }
  if (backupState.schemaFingerprint !== sourceState.schemaFingerprint) {
    problems.push('schema fingerprint differs between source and backup');
  }
  for (const [table, count] of Object.entries(sourceState.counts)) {
    if (backupState.counts[table] !== count) {
      problems.push(`row count mismatch in ${table}: source ${count}, backup ${backupState.counts[table]}`);
    }
  }
  for (const [name, value] of Object.entries(sourceState.relationships)) {
    if (backupState.relationships[name] !== value) {
      problems.push(`relationship mismatch (${name}): source ${value}, backup ${backupState.relationships[name]}`);
    }
  }

  // A manifest describing structure only. No row data, no configuration values.
  const manifest = {
    createdAt: new Date().toISOString(),
    sourcePath,
    backupPath,
    mechanism: 'sqlite-online-backup-api',
    sourceBytes: fs.statSync(sourcePath).size,
    backupBytes: fs.statSync(backupPath).size,
    schemaFingerprint: backupState.schemaFingerprint,
    tables: backupState.schema.tables,
    triggers: backupState.schema.triggers,
    indexes: backupState.schema.indexes,
    checks: backupState.schema.checks,
    foreignKeys: backupState.schema.foreignKeys,
    counts: backupState.counts,
    relationships: backupState.relationships,
    integrity: backupState.integrity,
    verified: problems.length === 0
  };
  fs.writeFileSync(path.join(backupDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`  tables               ${backupState.schema.tables.length}\n`);
  process.stdout.write(`  indexes / triggers   ${backupState.schema.indexes.length} / ${backupState.schema.triggers.length}\n`);
  process.stdout.write(`  CHECK constraints    ${backupState.schema.checks.length}\n`);
  process.stdout.write(`  foreign keys         ${backupState.schema.foreignKeys.length}\n`);
  process.stdout.write(`  total rows           ${Object.values(backupState.counts).reduce((a, b) => a + b, 0)}\n`);
  process.stdout.write(`  task-linked messages ${backupState.relationships.chatMessagesLinkedToTasks}\n`);
  process.stdout.write(`  integrity_check      ${backupState.integrity.integrityOk ? 'ok' : 'FAILED'}\n`);
  process.stdout.write(`  foreign_key_check    ${backupState.integrity.foreignKeyViolationCount === 0 ? 'ok' : 'FAILED'}\n\n`);

  if (problems.length > 0) {
    process.stderr.write('BACKUP VERIFICATION FAILED:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Backup verified.\n  ${backupDirectory}\n`);
  process.stdout.write(`Restore with:\n  node scripts/db-restore.js ${backupPath} --to <new-target.db>\n`);
}

main().catch((error) => {
  process.stderr.write(`\nBackup failed: ${error.message}\n`);
  process.exitCode = 1;
});
