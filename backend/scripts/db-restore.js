'use strict';

/**
 * REF-029 — restore a SQLite backup, with the brakes on.
 *
 *   node scripts/db-restore.js <backup.db> --to <target.db>
 *
 * Restoring is the only rollback available for the BE-001 table rebuild, because
 * migrations are not transactional on this stack (plan §5.1 rule 5). It is also
 * the single most destructive command in the repository, so it refuses by
 * default and has to be argued with:
 *
 *   • the target must not already exist           → otherwise pass --force
 *   • the target must not be a protected database → otherwise pass
 *       --allow-protected AND set
 *       DAYMARK_DB_RESTORE_CONFIRM=<the exact absolute target path>
 *
 * The two-key requirement for protected targets is deliberate: a typo cannot
 * satisfy both, and the confirmation names the file being replaced.
 *
 * Before replacing anything that exists, a safety copy of the current file is
 * taken first, so an incorrect restore is itself recoverable.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { resolveDatabasePath, assertWritableTarget, isProtected, snapshot } = require('./lib/db-safety');

function parseArguments(argv) {
  const options = { backup: null, target: null, force: false, allowProtected: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') options.target = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--allow-protected') options.allowProtected = true;
    else if (!arg.startsWith('--')) options.backup = arg;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (!options.backup || !options.target) {
    process.stderr.write('Usage: node scripts/db-restore.js <backup.db> --to <target.db> [--force] [--allow-protected]\n');
    process.exitCode = 1;
    return;
  }

  const backupPath = resolveDatabasePath(options.backup);
  if (!fs.existsSync(backupPath)) throw new Error(`Backup does not exist: ${backupPath}`);

  const targetPath = path.resolve(resolveDatabasePath(options.target));

  // ---- Second key for protected targets ------------------------------------
  if (isProtected(targetPath) && options.allowProtected) {
    const confirmation = process.env.DAYMARK_DB_RESTORE_CONFIRM;
    if (confirmation !== targetPath) {
      throw new Error(
        `Restoring over a protected database needs an explicit confirmation.\n` +
          `Set DAYMARK_DB_RESTORE_CONFIRM to exactly:\n  ${targetPath}\n` +
          (confirmation ? `It is currently set to a different path.\n` : 'It is not set.\n')
      );
    }
  }

  // Throws for a protected or already-existing target unless overridden.
  assertWritableTarget(targetPath, { allowProtected: options.allowProtected, allowOverwrite: options.force });

  // ---- Validate the backup BEFORE touching the target ----------------------
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  const backupState = snapshot(backup);
  backup.close();

  if (!backupState.integrity.integrityOk) {
    throw new Error(`Refusing to restore: the backup fails integrity_check (${backupState.integrity.integrityDetail})`);
  }
  if (backupState.integrity.foreignKeyViolationCount > 0) {
    throw new Error(
      `Refusing to restore: the backup has ${backupState.integrity.foreignKeyViolationCount} foreign-key violation(s)`
    );
  }

  // ---- Make the restore itself recoverable ---------------------------------
  let safetyCopy = null;
  if (fs.existsSync(targetPath)) {
    safetyCopy = `${targetPath}.replaced-${Date.now()}`;
    fs.copyFileSync(targetPath, safetyCopy);
    process.stdout.write(`Existing target copied aside first:\n  ${safetyCopy}\n\n`);
  }

  process.stdout.write(`Restoring ${backupPath}\n       -> ${targetPath}\n\n`);

  // Restore through the Online Backup API rather than a file copy, so the result
  // is a well-formed database even if the backup carried WAL content.
  const source = new Database(backupPath, { readonly: true, fileMustExist: true });
  await source.backup(targetPath);
  source.close();

  // Remove stale sidecars that could otherwise be applied on top of the new file.
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${targetPath}${sidecar}`;
    if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
  }

  // ---- Verify the RESULT ---------------------------------------------------
  const restored = new Database(targetPath, { readonly: true, fileMustExist: true });
  const restoredState = snapshot(restored);
  restored.close();

  const problems = [];
  if (!restoredState.integrity.integrityOk) problems.push('restored database fails integrity_check');
  if (restoredState.integrity.foreignKeyViolationCount > 0) problems.push('restored database has foreign-key violations');
  if (restoredState.schemaFingerprint !== backupState.schemaFingerprint) problems.push('schema fingerprint differs from the backup');
  for (const [table, count] of Object.entries(backupState.counts)) {
    if (restoredState.counts[table] !== count) {
      problems.push(`row count mismatch in ${table}: backup ${count}, restored ${restoredState.counts[table]}`);
    }
  }
  for (const [name, value] of Object.entries(backupState.relationships)) {
    if (restoredState.relationships[name] !== value) {
      problems.push(`relationship mismatch (${name}): backup ${value}, restored ${restoredState.relationships[name]}`);
    }
  }

  process.stdout.write(`  tables               ${restoredState.schema.tables.length}\n`);
  process.stdout.write(`  indexes / triggers   ${restoredState.schema.indexes.length} / ${restoredState.schema.triggers.length}\n`);
  process.stdout.write(`  CHECK constraints    ${restoredState.schema.checks.length}\n`);
  process.stdout.write(`  total rows           ${Object.values(restoredState.counts).reduce((a, b) => a + b, 0)}\n`);
  process.stdout.write(`  task-linked messages ${restoredState.relationships.chatMessagesLinkedToTasks}\n`);
  process.stdout.write(`  integrity_check      ${restoredState.integrity.integrityOk ? 'ok' : 'FAILED'}\n`);
  process.stdout.write(`  foreign_key_check    ${restoredState.integrity.foreignKeyViolationCount === 0 ? 'ok' : 'FAILED'}\n\n`);

  if (problems.length > 0) {
    process.stderr.write('RESTORE VERIFICATION FAILED:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    if (safetyCopy) process.stderr.write(`\nThe previous file is still available at:\n  ${safetyCopy}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Restore verified: structure, row counts and relationships all match the backup.\n');
  if (safetyCopy) process.stdout.write(`\nThe replaced file is kept at:\n  ${safetyCopy}\nDelete it once you are satisfied.\n`);
}

main().catch((error) => {
  process.stderr.write(`\nRestore refused: ${error.message}\n`);
  process.exitCode = 1;
});
