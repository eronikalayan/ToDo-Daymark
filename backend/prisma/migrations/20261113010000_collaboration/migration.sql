-- Backfill the creator as the current owner for tasks created before assignment support.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE "new_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "due_date" DATETIME,
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "priority_order" INTEGER NOT NULL DEFAULT 2,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "completed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_tasks" (
  "id", "user_id", "created_by_id", "title", "description", "due_date", "priority", "priority_order", "completed", "completed_at", "created_at", "updated_at"
)
SELECT "id", "user_id", "user_id", "title", "description", "due_date", "priority", CASE "priority" WHEN 'low' THEN 1 WHEN 'high' THEN 3 ELSE 2 END, "completed", "completed_at", "created_at", "updated_at"
FROM "tasks";

DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";

CREATE INDEX "tasks_user_id_idx" ON "tasks"("user_id");
CREATE INDEX "tasks_completed_idx" ON "tasks"("completed");
CREATE INDEX "tasks_due_date_idx" ON "tasks"("due_date");
CREATE INDEX "tasks_user_id_completed_idx" ON "tasks"("user_id", "completed");
CREATE INDEX "tasks_user_id_due_date_idx" ON "tasks"("user_id", "due_date");
CREATE INDEX "tasks_user_id_priority_order_idx" ON "tasks"("user_id", "priority_order");
CREATE INDEX "tasks_created_by_id_idx" ON "tasks"("created_by_id");

CREATE TABLE "friendships" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requester_id" TEXT NOT NULL,
  "addressee_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'accepted')),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "friendships_requester_id_addressee_id_key" ON "friendships"("requester_id", "addressee_id");
CREATE INDEX "friendships_addressee_id_status_idx" ON "friendships"("addressee_id", "status");
CREATE INDEX "friendships_requester_id_status_idx" ON "friendships"("requester_id", "status");

CREATE TABLE "chat_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sender_id" TEXT NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "task_id" TEXT,
  "body" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "chat_messages_sender_id_recipient_id_created_at_idx" ON "chat_messages"("sender_id", "recipient_id", "created_at");
CREATE INDEX "chat_messages_recipient_id_sender_id_created_at_idx" ON "chat_messages"("recipient_id", "sender_id", "created_at");
CREATE INDEX "chat_messages_task_id_idx" ON "chat_messages"("task_id");
