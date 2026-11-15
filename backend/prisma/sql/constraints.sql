-- =============================================================================
--  Daymark — database objects Prisma cannot see        (REF-025 / finding BE-019)
-- =============================================================================
--
--  WHY THIS FILE EXISTS
--  --------------------
--  `prisma migrate diff` reports "no drift" for this project while the database
--  contains two triggers and a CHECK constraint that appear nowhere in
--  schema.prisma. Prisma cannot represent those objects, so it cannot warn when
--  a migration destroys them.
--
--  That is not theoretical. A rebuild of `tasks` was executed against a copy of
--  the real database under `prisma migrate deploy`: both priority triggers were
--  gone afterwards (2 -> 0) and `migrate diff` still reported no drift.
--
--  SQLite implements many schema changes as a table rebuild
--  (CREATE new / INSERT SELECT / DROP old / RENAME). Everything attached to the
--  dropped table goes with it: indexes, triggers, CHECK constraints and foreign
--  keys. This file is the single source of truth for restoring them.
--
--
--  NOT EVERYTHING HERE CAN BE "JUST EXECUTED"
--  ------------------------------------------
--  The file is split into two sections because SQLite treats these object
--  classes differently. The behaviour below was established by execution on the
--  SQLite version this project actually bundles (3.53.2, via better-sqlite3 12.x):
--
--   SECTION A — RE-APPLIABLE. Triggers and indexes are standalone objects.
--               `DROP ... IF EXISTS` + `CREATE ...` is fully idempotent:
--               verified by running the pair three times and confirming exactly
--               one trigger and one index remained.
--
--   SECTION B — NOT RE-APPLIABLE. CHECK constraints, FOREIGN KEYs, NOT NULL and
--               DEFAULT clauses live inside the CREATE TABLE statement. They
--               must be written into the CREATE TABLE of any rebuild migration.
--               Section B is reference text, NOT an executable script.
--
--  On `ALTER TABLE ... ADD CONSTRAINT`, measured rather than assumed:
--    • SQLite 3.53.2 DOES accept it — but this is a recent feature and must not
--      be relied on for portability.
--    • It validates existing rows and FAILS ("constraint failed") if any row
--      violates the new constraint, so it cannot be used blindly during a
--      migration that has already copied data.
--    • It is NOT idempotent: re-running a named constraint fails with
--      "constraint c already exists".
--    • The project's existing CHECK is an UNNAMED, column-level constraint.
--      Adding a named one by ALTER would create a SECOND constraint rather than
--      restoring the original.
--    • After a table rebuild the CHECK must be inside the new CREATE TABLE
--      regardless, which makes a later ALTER redundant.
--  For those four reasons this file does not use ALTER TABLE ADD CONSTRAINT.
--
--  `ALTER TABLE ... ADD FOREIGN KEY` is a plain syntax error in SQLite. A
--  foreign key can only be introduced with a brand-new column, never added to
--  an existing one.
--
--
--  HOW TO USE IT
--  -------------
--   1. Writing a migration that rebuilds a table?
--        – copy that table's Section B text into the new CREATE TABLE verbatim;
--        – append that table's Section A statements at the end of the migration.
--   2. `test/migrations.test.js` (REF-028) asserts that every object named here
--      still exists after `prisma migrate deploy`, so an omission fails the
--      build instead of shipping.
--   3. Section A can be executed directly through
--      `scripts/lib/constraints.js` → `applyReappliableObjects(db)`.
--
--  Do not add new business rules here. This file records what already exists.
-- =============================================================================


-- =============================================================================
--  SECTION A — RE-APPLIABLE OBJECTS (safe to execute, idempotent)
-- =============================================================================

-- -----------------------------------------------------------------------------
--  A1. Triggers — `tasks`
--      These are the database-level enforcement of the task priority domain.
--      schema.prisma models `priority` as a plain String, so Prisma neither
--      knows about nor recreates these.
--      Source migration: 20261113060000_priority_constraint
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS "tasks_priority_insert_check";
CREATE TRIGGER "tasks_priority_insert_check"
BEFORE INSERT ON "tasks"
FOR EACH ROW
WHEN NEW."priority" NOT IN ('low', 'medium', 'high')
BEGIN
  SELECT RAISE(ABORT, 'invalid task priority');
END;

DROP TRIGGER IF EXISTS "tasks_priority_update_check";
CREATE TRIGGER "tasks_priority_update_check"
BEFORE UPDATE OF "priority" ON "tasks"
FOR EACH ROW
WHEN NEW."priority" NOT IN ('low', 'medium', 'high')
BEGIN
  SELECT RAISE(ABORT, 'invalid task priority');
END;


-- -----------------------------------------------------------------------------
--  A2. Indexes — `tasks` (8)
--      Prisma does declare these, but a hand-written rebuild migration still has
--      to recreate them explicitly: DROP TABLE takes every index with it.
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS "tasks_user_id_idx";
CREATE INDEX "tasks_user_id_idx" ON "tasks"("user_id");

DROP INDEX IF EXISTS "tasks_completed_idx";
CREATE INDEX "tasks_completed_idx" ON "tasks"("completed");

DROP INDEX IF EXISTS "tasks_due_date_idx";
CREATE INDEX "tasks_due_date_idx" ON "tasks"("due_date");

DROP INDEX IF EXISTS "tasks_user_id_completed_idx";
CREATE INDEX "tasks_user_id_completed_idx" ON "tasks"("user_id", "completed");

DROP INDEX IF EXISTS "tasks_user_id_due_date_idx";
CREATE INDEX "tasks_user_id_due_date_idx" ON "tasks"("user_id", "due_date");

DROP INDEX IF EXISTS "tasks_user_id_priority_order_idx";
CREATE INDEX "tasks_user_id_priority_order_idx" ON "tasks"("user_id", "priority_order");

DROP INDEX IF EXISTS "tasks_user_id_sort_order_idx";
CREATE INDEX "tasks_user_id_sort_order_idx" ON "tasks"("user_id", "sort_order");

DROP INDEX IF EXISTS "tasks_created_by_id_idx";
CREATE INDEX "tasks_created_by_id_idx" ON "tasks"("created_by_id");


-- -----------------------------------------------------------------------------
--  A3. Indexes — `chat_messages` (3)
--      The two mirrored composite indexes are what let the bidirectional
--      conversation query use a MULTI-INDEX OR plan.
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS "chat_messages_sender_id_recipient_id_created_at_idx";
CREATE INDEX "chat_messages_sender_id_recipient_id_created_at_idx" ON "chat_messages"("sender_id", "recipient_id", "created_at");

DROP INDEX IF EXISTS "chat_messages_recipient_id_sender_id_created_at_idx";
CREATE INDEX "chat_messages_recipient_id_sender_id_created_at_idx" ON "chat_messages"("recipient_id", "sender_id", "created_at");

DROP INDEX IF EXISTS "chat_messages_task_id_idx";
CREATE INDEX "chat_messages_task_id_idx" ON "chat_messages"("task_id");


-- -----------------------------------------------------------------------------
--  A4. Indexes — `friendships` (3)
--      NOTE: the UNIQUE index is on the ORDERED pair, so (A,B) and (B,A) are
--      distinct rows. That is audit finding BE-020; it is recorded here as the
--      current state and is NOT changed by this file.
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS "friendships_requester_id_addressee_id_key";
CREATE UNIQUE INDEX "friendships_requester_id_addressee_id_key" ON "friendships"("requester_id", "addressee_id");

DROP INDEX IF EXISTS "friendships_addressee_id_status_idx";
CREATE INDEX "friendships_addressee_id_status_idx" ON "friendships"("addressee_id", "status");

DROP INDEX IF EXISTS "friendships_requester_id_status_idx";
CREATE INDEX "friendships_requester_id_status_idx" ON "friendships"("requester_id", "status");


-- -----------------------------------------------------------------------------
--  A5. Indexes — `users`, `sessions`, token tables (3)
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS "users_email_key";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

DROP INDEX IF EXISTS "sessions_user_id_expires_at_idx";
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

DROP INDEX IF EXISTS "email_verification_tokens_user_id_expires_at_idx";
CREATE INDEX "email_verification_tokens_user_id_expires_at_idx" ON "email_verification_tokens"("user_id", "expires_at");

DROP INDEX IF EXISTS "password_reset_tokens_user_id_expires_at_idx";
CREATE INDEX "password_reset_tokens_user_id_expires_at_idx" ON "password_reset_tokens"("user_id", "expires_at");


-- =============================================================================
--  SECTION B — TABLE-EMBEDDED DEFINITIONS (reference only — DO NOT EXECUTE)
-- =============================================================================
--
--  Everything below is part of a CREATE TABLE statement and cannot be restored
--  by running SQL against an existing table. When a migration rebuilds one of
--  these tables, copy the relevant block into the new CREATE TABLE verbatim.
--
--  `scripts/lib/constraints.js` stops parsing at this marker, so Section B is
--  never executed by accident.
--
--  === SECTION B BEGINS ===
--
--  -----------------------------------------------------------------------------
--  B1. friendships — CHECK constraint (the only CHECK in the schema)
--  -----------------------------------------------------------------------------
--  Column-level, unnamed, inside CREATE TABLE "friendships":
--
--      "status" TEXT NOT NULL DEFAULT 'pending'
--          CHECK ("status" IN ('pending', 'accepted'))
--
--  Note that 'declined' is deliberately absent: declining deletes the row.
--  The API nevertheless reports status "declined" — audit finding BE-008. That
--  inconsistency is NOT resolved here.
--
--  -----------------------------------------------------------------------------
--  B2. friendships — foreign keys
--  -----------------------------------------------------------------------------
--      CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id")
--          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
--      CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id")
--          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
--
--  -----------------------------------------------------------------------------
--  B3. tasks — foreign keys  (BE-001 was fixed here)
--  -----------------------------------------------------------------------------
--  CURRENT STATE, as delivered by migration 20261113070000_fix_task_creator_cascade:
--
--      "user_id"       TEXT NOT NULL,
--      "created_by_id" TEXT,                      -- nullable
--      CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id")
--          REFERENCES "users" ("id") ON DELETE CASCADE  ON UPDATE CASCADE,
--      CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id")
--          REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
--
--  The asymmetry is deliberate and must be preserved by any future rebuild:
--    • user_id is OWNERSHIP      -> CASCADE: a user's own tasks go with them.
--    • created_by_id is PROVENANCE -> SET NULL: deleting the sender forgets the
--      sender but never removes a task belonging to its recipient.
--
--  Before REF-010 both were CASCADE, so one user deleting their account silently
--  destroyed another user's task. Do not "tidy" these two rules back into
--  agreement.
--
--  NULL `created_by_id` therefore means "the sender's account is gone". It can
--  only occur on an ASSIGNED task: for a self-created task the owner is also the
--  creator, so user_id's CASCADE removes the row first.
--
--  -----------------------------------------------------------------------------
--  B4. chat_messages — foreign keys
--  -----------------------------------------------------------------------------
--      CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id")
--          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
--      CONSTRAINT "chat_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id")
--          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
--      CONSTRAINT "chat_messages_task_id_fkey" FOREIGN KEY ("task_id")
--          REFERENCES "tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
--
--  *** CRITICAL FOR ANY REBUILD OF `tasks` ***
--  `DROP TABLE "tasks"` performs an implicit delete of every row, which FIRES
--  this ON DELETE SET NULL and blanks `chat_messages.task_id` for every message.
--  `PRAGMA defer_foreign_keys=ON` defers constraint VIOLATIONS; it does not
--  suppress ACTIONS. Measured on a copy of the real database: task links went
--  from 2 to 0.
--
--  Any migration that rebuilds `tasks` must capture and restore these links —
--  see plan §5.2/S1 "Guard B".
--
--  -----------------------------------------------------------------------------
--  B5. users, sessions, email_verification_tokens, password_reset_tokens
--  -----------------------------------------------------------------------------
--      users:   "email" TEXT NOT NULL                 (UNIQUE via index — Section A5)
--      sessions / email_verification_tokens / password_reset_tokens:
--               "id" TEXT NOT NULL PRIMARY KEY        -- supplied by the app (the JWT jti)
--               CONSTRAINT "<table>_user_id_fkey" FOREIGN KEY ("user_id")
--                   REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
--
--  The token tables reuse the JWT `jti` as their primary key; that is what makes
--  replay detection atomic. Never give these an autogenerated default.
--
--  === SECTION B ENDS ===
-- =============================================================================
