'use strict';

/**
 * Shared safety and inspection helpers for the database tooling (REF-029 / REF-028).
 *
 * Two responsibilities:
 *   1. Refuse to write to a database a human depends on.
 *   2. Describe a database precisely enough that a migration can be proven
 *      non-destructive — which means reading sqlite_master, not the Prisma
 *      schema. Prisma cannot see CHECK constraints or triggers at all
 *      (audit finding BE-019), so schema inspection through Prisma would
 *      silently miss exactly the objects most at risk.
 *
 * Nothing here ever prints row data. Only counts, names and structure.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const BACKUP_ROOT = path.join(PROJECT_ROOT, '.backups', 'db');

/** Resolve a path or a `file:` URL the way better-sqlite3 does. */
function resolveDatabasePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const withoutScheme = value.startsWith('file:') ? value.slice('file:'.length) : value;
  return path.resolve(BACKEND_ROOT, withoutScheme);
}

/**
 * Databases this tooling must never write to: the development database by
 * convention, plus whatever `.env` actually points at. Reading the real
 * configuration means the protection does not depend on a naming convention.
 * Only DATABASE_URL is read; no other value is parsed or retained.
 */
function protectedDatabasePaths() {
  const protectedPaths = new Set([path.join(BACKEND_ROOT, 'prisma', 'dev.db')]);
  try {
    const envFile = fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8');
    const line = envFile.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (line) {
      const raw = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      const resolved = resolveDatabasePath(raw);
      if (resolved) protectedPaths.add(resolved);
    }
  } catch {
    /* no .env (fresh clone or CI) */
  }
  return protectedPaths;
}

function isProtected(targetPath) {
  return protectedDatabasePaths().has(path.resolve(targetPath));
}

/** Throw unless `targetPath` is safe to write. */
function assertWritableTarget(targetPath, { allowProtected = false, allowOverwrite = false } = {}) {
  const resolved = path.resolve(targetPath);

  if (isProtected(resolved) && !allowProtected) {
    throw new Error(
      `Refusing to write to a protected database: ${resolved}\n` +
        'This is the development database (or the one .env points at). Restoring over it ' +
        'requires --allow-protected together with the DAYMARK_DB_RESTORE_CONFIRM environment ' +
        'variable set to this exact path. See docs/audit/IMPLEMENTATION_STAGE_03.md.'
    );
  }

  if (fs.existsSync(resolved) && !allowOverwrite) {
    throw new Error(
      `Refusing to overwrite an existing database: ${resolved}\n` +
        'Choose a target that does not exist, or pass --force if replacing it is genuinely intended.'
    );
  }

  const directory = path.dirname(resolved);
  if (!fs.existsSync(directory)) {
    throw new Error(`Target directory does not exist: ${directory}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/**
 * A structural description of a database: every object that must survive a
 * migration. Deliberately read from sqlite_master and the PRAGMA functions,
 * because that is the only place CHECK constraints, triggers and foreign-key
 * actions are all visible.
 */
function describeSchema(db) {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  const foreignKeys = [];
  const checks = [];
  for (const table of tables) {
    if (table.name === '_prisma_migrations') continue;
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${table.name}")`).all()) {
      foreignKeys.push({
        table: table.name,
        column: fk.from,
        references: `${fk.table}.${fk.to}`,
        onDelete: fk.on_delete,
        onUpdate: fk.on_update
      });
    }
    // CHECK constraints live inside the CREATE TABLE text; there is no PRAGMA for them.
    for (const match of String(table.sql ?? '').matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi)) {
      checks.push({ table: table.name, expression: match[1].replace(/\s+/g, ' ').trim() });
    }
  }

  return {
    tables: tables.map((t) => t.name),
    columns: Object.fromEntries(
      tables.map((t) => [
        t.name,
        db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => ({
          name: c.name,
          type: c.type,
          notNull: Boolean(c.notnull),
          defaultValue: c.dflt_value,
          primaryKey: Boolean(c.pk)
        }))
      ])
    ),
    foreignKeys: foreignKeys.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`)),
    checks: checks.sort((a, b) => a.table.localeCompare(b.table)),
    triggers: db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map((t) => `${t.tbl_name}.${t.name}`),
    indexes: db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all()
      .map((i) => `${i.tbl_name}.${i.name}`)
  };
}

/** Row counts per table. Counts only — never contents. */
function tableCounts(db) {
  const counts = {};
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()) {
    counts[name] = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c;
  }
  return counts;
}

/**
 * Relationships that a careless table rebuild silently destroys. These are the
 * numbers that caught the first-draft BE-001 migration: DROP TABLE fires
 * ON DELETE SET NULL on chat_messages.task_id.
 */
function relationshipCounts(db) {
  const has = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;

  return {
    chatMessagesLinkedToTasks: has('chat_messages')
      ? db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE task_id IS NOT NULL').get().c
      : 0,
    assignedTasks: has('tasks')
      ? db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE created_by_id IS NOT NULL AND created_by_id <> user_id').get().c
      : 0,
    tasksWithCreator: has('tasks')
      ? db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE created_by_id IS NOT NULL').get().c
      : 0,
    acceptedFriendships: has('friendships')
      ? db.prepare("SELECT COUNT(*) AS c FROM friendships WHERE status='accepted'").get().c
      : 0,
    orphanedTaskLinks: has('chat_messages')
      ? db.prepare('SELECT COUNT(*) AS c FROM chat_messages m LEFT JOIN tasks t ON t.id = m.task_id WHERE m.task_id IS NOT NULL AND t.id IS NULL').get().c
      : 0
  };
}

/** SQLite's own consistency checks. */
function integrityReport(db) {
  const integrity = db.pragma('integrity_check');
  const foreignKeyViolations = db.pragma('foreign_key_check');
  return {
    integrityOk: integrity.length === 1 && integrity[0].integrity_check === 'ok',
    integrityDetail: integrity.map((r) => r.integrity_check).join('; '),
    foreignKeyViolationCount: foreignKeyViolations.length,
    // Table names only — never the offending row values.
    foreignKeyViolationTables: [...new Set(foreignKeyViolations.map((v) => v.table))]
  };
}

/** A stable hash of the structure, for quick before/after comparison. */
function schemaFingerprint(db) {
  return crypto.createHash('sha256').update(JSON.stringify(describeSchema(db))).digest('hex');
}

/** Everything needed to prove a database survived an operation intact. */
function snapshot(db) {
  return {
    schema: describeSchema(db),
    schemaFingerprint: schemaFingerprint(db),
    counts: tableCounts(db),
    relationships: relationshipCounts(db),
    integrity: integrityReport(db)
  };
}

module.exports = {
  BACKEND_ROOT,
  PROJECT_ROOT,
  BACKUP_ROOT,
  resolveDatabasePath,
  protectedDatabasePaths,
  isProtected,
  assertWritableTarget,
  describeSchema,
  tableCounts,
  relationshipCounts,
  integrityReport,
  schemaFingerprint,
  snapshot
};
