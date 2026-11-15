'use strict';

/**
 * Builds throwaway SQLite databases for backup rehearsals and migration tests
 * (REF-028 / REF-029).
 *
 * Every database produced here:
 *   • lives under the OS temp directory, never under backend/prisma/
 *   • is created from nothing, so it can never overwrite an existing file
 *   • is applied through the REAL checked-in migration history, so a test is
 *     exercising what production would run rather than a hand-built schema
 *   • is seeded with the relationships that matter to BE-001: tasks assigned by
 *     one user to another, and chat messages referencing those tasks
 *
 * `prisma migrate deploy` is used deliberately. `prisma migrate dev` may RESET a
 * database when it detects drift and must never appear in tooling.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { BACKEND_ROOT, isProtected } = require('./db-safety');

const PRISMA_CLI = path.join(BACKEND_ROOT, 'node_modules', 'prisma', 'build', 'index.js');

/** A fresh directory under the OS temp dir. Tracked so cleanup removes only our own files. */
function createWorkspace(label = 'daymark') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return directory;
}

/**
 * Apply the checked-in migration history to a brand-new database file.
 * Returns the absolute path of the created database.
 */
function applyMigrations(targetPath) {
  const resolved = path.resolve(targetPath);

  if (isProtected(resolved)) {
    throw new Error(`Refusing to run migrations against a protected database: ${resolved}`);
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`Refusing to migrate over an existing database: ${resolved}`);
  }

  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: `file:${resolved}` }
    }
  );

  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed for ${resolved}:\n${result.stdout}\n${result.stderr}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`prisma migrate deploy reported success but produced no database at ${resolved}`);
  }
  return resolved;
}

const uuid = () => crypto.randomUUID();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

/**
 * Seed a representative dataset.
 *
 * Shape (deliberately mirrors the production relationships BE-001 touches):
 *   alice, bob, carol
 *   alice <-> bob accepted friendship
 *   alice owns 2 personal tasks
 *   alice ASSIGNS 2 tasks to bob    -> bob owns them, alice is created_by
 *   bob   ASSIGNS 1 task to alice   -> alice owns it, bob is created_by
 *   3 chat messages carry task_id pointing at those assigned tasks
 *   2 plain chat messages, sessions, and one token of each kind
 */
function seedRepresentativeData(databasePath) {
  const db = new Database(databasePath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');

  const users = ['alice', 'bob', 'carol'].map((name) => ({
    id: uuid(),
    name,
    email: `${name}-${crypto.randomBytes(3).toString('hex')}@disposable.test`
  }));
  const [alice, bob, carol] = users;

  const insertUser = db.prepare(
    `INSERT INTO users (id,name,email,password_hash,email_verified_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const user of users) {
    insertUser.run(user.id, user.name, user.email, '$2a$04$disposablehashvaluenotreal00000000000000000000000000', iso(), iso(), iso());
  }

  db.prepare(
    `INSERT INTO friendships (id,requester_id,addressee_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`
  ).run(uuid(), alice.id, bob.id, 'accepted', iso(), iso());

  const insertTask = db.prepare(
    `INSERT INTO tasks (id,user_id,created_by_id,title,description,due_date,priority,priority_order,sort_order,completed,completed_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const task = (ownerId, creatorId, title, priority = 'medium') => {
    const id = uuid();
    const order = { low: 1, medium: 2, high: 3 }[priority];
    insertTask.run(id, ownerId, creatorId, title, null, null, priority, order, 0, 0, null, iso(), iso());
    return id;
  };

  // Self-created tasks for more than one user: the BE-001 control needs a task
  // owned by somebody other than the creator being deleted.
  const ownTasks = [
    task(alice.id, alice.id, 'Alice personal A', 'low'),
    task(alice.id, alice.id, 'Alice personal B', 'high'),
    task(bob.id, bob.id, 'Bob personal A'),
    task(carol.id, carol.id, 'Carol personal A', 'low')
  ];
  // The relationships BE-001 destroys: owner !== creator.
  const assignedToBob = [task(bob.id, alice.id, 'Assigned to Bob 1'), task(bob.id, alice.id, 'Assigned to Bob 2', 'high')];
  const assignedToAlice = [task(alice.id, bob.id, 'Assigned to Alice 1')];

  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (id,sender_id,recipient_id,task_id,body,created_at) VALUES (?,?,?,?,?,?)`
  );
  // Notifications referencing the assigned tasks — what DROP TABLE silently nulls.
  insertMessage.run(uuid(), alice.id, bob.id, assignedToBob[0], 'Sent you a task: Assigned to Bob 1', iso(1));
  insertMessage.run(uuid(), alice.id, bob.id, assignedToBob[1], 'Sent you a task: Assigned to Bob 2', iso(2));
  insertMessage.run(uuid(), bob.id, alice.id, assignedToAlice[0], 'Sent you a task: Assigned to Alice 1', iso(3));
  // Plain conversation.
  insertMessage.run(uuid(), alice.id, bob.id, null, 'Morning', iso(4));
  insertMessage.run(uuid(), bob.id, alice.id, null, 'Morning to you', iso(5));

  const insertSession = db.prepare(
    `INSERT INTO sessions (id,user_id,expires_at,created_at,revoked_at) VALUES (?,?,?,?,?)`
  );
  insertSession.run(uuid(), alice.id, iso(86_400_000), iso(), null);
  insertSession.run(uuid(), bob.id, iso(86_400_000), iso(), null);
  insertSession.run(uuid(), carol.id, iso(-1000), iso(), iso());

  db.prepare(
    `INSERT INTO email_verification_tokens (id,user_id,expires_at,created_at) VALUES (?,?,?,?)`
  ).run(uuid(), carol.id, iso(86_400_000), iso());

  db.prepare(
    `INSERT INTO password_reset_tokens (id,user_id,expires_at,used_at,created_at) VALUES (?,?,?,?,?)`
  ).run(uuid(), alice.id, iso(3_600_000), null, iso());

  db.close();

  return {
    users: { alice, bob, carol },
    tasks: { ownTasks, assignedToBob, assignedToAlice },
    expected: {
      users: 3,
      tasks: ownTasks.length + assignedToBob.length + assignedToAlice.length,
      assignedTasks: assignedToBob.length + assignedToAlice.length,
      chatMessages: 5,
      chatMessagesLinkedToTasks: 3,
      friendships: 1,
      sessions: 3
    }
  };
}

/** A migrated, seeded, disposable database. */
function createSeededDatabase(label = 'daymark-disposable') {
  const workspace = createWorkspace(label);
  const databasePath = path.join(workspace, 'disposable.db');
  applyMigrations(databasePath);
  const seed = seedRepresentativeData(databasePath);
  return { workspace, databasePath, seed };
}

/** Remove a workspace created here, and nothing else. */
function destroyWorkspace(workspace) {
  if (!workspace) return;
  const resolved = path.resolve(workspace);
  if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(`Refusing to remove a directory outside the temp dir: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = {
  PRISMA_CLI,
  createWorkspace,
  applyMigrations,
  seedRepresentativeData,
  createSeededDatabase,
  destroyWorkspace
};
