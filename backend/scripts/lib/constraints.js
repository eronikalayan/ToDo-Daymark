'use strict';

/**
 * REF-025 — loader for prisma/sql/constraints.sql.
 *
 * Section A of that file (triggers and indexes) is executable and idempotent.
 * Section B (CHECK constraints, foreign keys, NOT NULL, DEFAULT) is embedded in
 * CREATE TABLE statements and cannot be applied to an existing table — it is
 * reference text for authoring rebuild migrations.
 *
 * This module therefore stops at the `=== SECTION B BEGINS ===` marker. Section B
 * is entirely comments, so even an accidental execution would be a no-op, but
 * stopping explicitly makes the boundary a property of the code rather than a
 * convention.
 *
 * It also exposes the expected object names so REF-028 can assert that a
 * database still contains everything this file promises.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONSTRAINTS_PATH = path.resolve(__dirname, '..', '..', 'prisma', 'sql', 'constraints.sql');
const SECTION_B_MARKER = '=== SECTION B BEGINS ===';

function readConstraintsFile() {
  return fs.readFileSync(CONSTRAINTS_PATH, 'utf8');
}

/** Only the executable part: everything before the Section B marker. */
function executableSection(source = readConstraintsFile()) {
  const markerIndex = source.indexOf(SECTION_B_MARKER);
  if (markerIndex === -1) {
    throw new Error(`constraints.sql is missing the "${SECTION_B_MARKER}" marker; refusing to guess where Section A ends.`);
  }
  return source.slice(0, markerIndex);
}

/** Strip comments and split into individual statements, keeping trigger bodies whole. */
function parseStatements(sql) {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  const statements = [];
  let buffer = '';
  let insideTrigger = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    buffer += `${buffer ? '\n' : ''}${rawLine}`;

    if (/^CREATE\s+TRIGGER/i.test(line)) insideTrigger = true;

    // A trigger ends at END; everything else ends at the first ;
    const ends = insideTrigger ? /^END\s*;/i.test(line) : line.endsWith(';');
    if (ends) {
      statements.push(buffer.trim());
      buffer = '';
      insideTrigger = false;
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

/**
 * Apply Section A to an open better-sqlite3 database.
 * Idempotent: every statement is a DROP ... IF EXISTS or a CREATE following one.
 */
function applyReappliableObjects(db) {
  const statements = parseStatements(executableSection());
  for (const statement of statements) db.exec(statement);
  return statements.length;
}

/** Object names Section A promises to create — used by the REF-028 assertions. */
function expectedObjects(source = readConstraintsFile()) {
  const section = executableSection(source);
  const triggers = [...section.matchAll(/CREATE\s+TRIGGER\s+"([^"]+)"/gi)].map((m) => m[1]);
  const indexes = [...section.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"/gi)].map((m) => ({
    name: m[1],
    table: m[2]
  }));
  return { triggers, indexes };
}

/**
 * Table-embedded definitions that a rebuild migration must copy by hand.
 * Returned so tests can assert they are still present in the live schema; they
 * can never be "applied".
 */
const TABLE_EMBEDDED = Object.freeze({
  checks: [{ table: 'friendships', column: 'status', values: ['pending', 'accepted'] }],
  foreignKeys: [
    // Ownership: deleting the owner removes their tasks.
    { table: 'tasks', column: 'user_id', references: 'users.id', onDelete: 'CASCADE' },
    // Provenance, not ownership (BE-001, fixed by REF-010 in migration
    // 20261113070000_fix_task_creator_cascade): deleting the sender must forget
    // the sender, never remove a task belonging to its recipient.
    { table: 'tasks', column: 'created_by_id', references: 'users.id', onDelete: 'SET NULL' },
    { table: 'chat_messages', column: 'sender_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'chat_messages', column: 'recipient_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'chat_messages', column: 'task_id', references: 'tasks.id', onDelete: 'SET NULL' },
    { table: 'friendships', column: 'requester_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'friendships', column: 'addressee_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'sessions', column: 'user_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'email_verification_tokens', column: 'user_id', references: 'users.id', onDelete: 'CASCADE' },
    { table: 'password_reset_tokens', column: 'user_id', references: 'users.id', onDelete: 'CASCADE' }
  ]
});

module.exports = {
  CONSTRAINTS_PATH,
  SECTION_B_MARKER,
  readConstraintsFile,
  executableSection,
  parseStatements,
  applyReappliableObjects,
  expectedObjects,
  TABLE_EMBEDDED
};
