-- =============================================================================
--  BE-001 — a deleted creator must not destroy the recipient's task  (REF-010)
-- =============================================================================
--
--  tasks.created_by_id: NOT NULL + ON DELETE CASCADE  ->  nullable + ON DELETE SET NULL
--
--  `created_by_id` records who SENT a task; `user_id` records who OWNS it.
--  Cascading on provenance meant that one user deleting their own account also
--  deleted tasks belonging to somebody else. SET NULL keeps the task with its
--  owner and simply forgets the sender.
--
--  This file was rehearsed before promotion (Stage 3 / REF-028), twice:
--    • against seeded data covering every check, and
--    • against a restored copy of the real development database.
--  Both runs passed all 18 conditions. The executable statements below are
--  byte-identical to the rehearsed candidate; only this header differs.
--
--  THREE PROPERTIES THIS SQL DEPENDS ON — all measured, not assumed:
--
--  1. ATOMICITY. Prisma does not wrap a migration in a transaction: a runtime
--     failure midway leaves partial state behind. An explicit BEGIN ... COMMIT
--     does make it atomic. Hence the wrapper.
--
--  2. CHILD LINKS. DROP TABLE performs an implicit delete of every row, which
--     FIRES chat_messages.task_id's ON DELETE SET NULL and blanks every task
--     link (measured: 3 -> 0). PRAGMA defer_foreign_keys defers constraint
--     VIOLATIONS but not ACTIONS; PRAGMA foreign_keys=OFF would work but is a
--     no-op inside a transaction, so it is incompatible with property 1.
--     Guard B below captures and restores the links instead, which is correct
--     either way.
--
--  3. ATTACHED OBJECTS. A rebuild drops the table's indexes and triggers.
--     Prisma cannot see the triggers at all, and `migrate diff` still reports
--     "no drift" after they vanish. They are restated explicitly below; the
--     canonical definitions live in prisma/sql/constraints.sql.
--
--  ROLLBACK. A failure rolls back by itself. Once this has SUCCEEDED and any
--  creator has deleted their account, created_by_id contains NULLs and the
--  column can no longer be made NOT NULL — recovery then means restoring the
--  backup taken beforehand (scripts/db-restore.js).
-- =============================================================================

BEGIN;

-- Defer constraint VIOLATIONS while the table does not exist.
-- (Does not suppress ON DELETE actions — see Guard B.)
PRAGMA defer_foreign_keys=ON;

-- --- Guard B: preserve child references that DROP TABLE would blank ----------
CREATE TEMP TABLE "_task_link_backup" AS
  SELECT "id", "task_id" FROM "chat_messages" WHERE "task_id" IS NOT NULL;

-- --- Rebuild `tasks` with the corrected foreign key --------------------------
CREATE TABLE "new_tasks" (
  "id"             TEXT     NOT NULL PRIMARY KEY,
  "user_id"        TEXT     NOT NULL,
  "created_by_id"  TEXT,                                 -- was NOT NULL
  "title"          TEXT     NOT NULL,
  "description"    TEXT,
  "due_date"       DATETIME,
  "priority"       TEXT     NOT NULL DEFAULT 'medium',
  "priority_order" INTEGER  NOT NULL DEFAULT 2,
  "completed"      BOOLEAN  NOT NULL DEFAULT false,
  "completed_at"   DATETIME,
  "created_at"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     DATETIME NOT NULL,
  "sort_order"     INTEGER  NOT NULL DEFAULT 0,
  CONSTRAINT "tasks_user_id_fkey"       FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE   -- was CASCADE
);

-- Pure copy: every column carried across unchanged, no transformation.
INSERT INTO "new_tasks" (
  "id","user_id","created_by_id","title","description","due_date",
  "priority","priority_order","completed","completed_at","created_at","updated_at","sort_order"
)
SELECT
  "id","user_id","created_by_id","title","description","due_date",
  "priority","priority_order","completed","completed_at","created_at","updated_at","sort_order"
FROM "tasks";

DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";

-- --- Guard B restore: re-link only messages whose task still exists ----------
UPDATE "chat_messages"
SET "task_id" = (SELECT b."task_id" FROM "_task_link_backup" b WHERE b."id" = "chat_messages"."id")
WHERE "task_id" IS NULL
  AND EXISTS (SELECT 1 FROM "_task_link_backup" b WHERE b."id" = "chat_messages"."id")
  AND EXISTS (
    SELECT 1 FROM "tasks" t
    JOIN "_task_link_backup" b ON b."task_id" = t."id"
    WHERE b."id" = "chat_messages"."id"
  );

DROP TABLE "_task_link_backup";

-- --- Restore the 8 indexes the rebuild dropped -------------------------------
--     (canonical definitions: prisma/sql/constraints.sql section A2)
CREATE INDEX "tasks_user_id_idx"                ON "tasks"("user_id");
CREATE INDEX "tasks_completed_idx"              ON "tasks"("completed");
CREATE INDEX "tasks_due_date_idx"               ON "tasks"("due_date");
CREATE INDEX "tasks_user_id_completed_idx"      ON "tasks"("user_id", "completed");
CREATE INDEX "tasks_user_id_due_date_idx"       ON "tasks"("user_id", "due_date");
CREATE INDEX "tasks_user_id_priority_order_idx" ON "tasks"("user_id", "priority_order");
CREATE INDEX "tasks_user_id_sort_order_idx"     ON "tasks"("user_id", "sort_order");
CREATE INDEX "tasks_created_by_id_idx"          ON "tasks"("created_by_id");

-- --- Restore the 2 triggers the rebuild dropped ------------------------------
--     Prisma cannot see these. Omitting them loses task-priority validation
--     silently, with `migrate diff` still reporting no drift.
--     (canonical definitions: prisma/sql/constraints.sql section A1)
CREATE TRIGGER "tasks_priority_insert_check"
BEFORE INSERT ON "tasks"
FOR EACH ROW
WHEN NEW."priority" NOT IN ('low', 'medium', 'high')
BEGIN
  SELECT RAISE(ABORT, 'invalid task priority');
END;

CREATE TRIGGER "tasks_priority_update_check"
BEFORE UPDATE OF "priority" ON "tasks"
FOR EACH ROW
WHEN NEW."priority" NOT IN ('low', 'medium', 'high')
BEGIN
  SELECT RAISE(ABORT, 'invalid task priority');
END;

COMMIT;
