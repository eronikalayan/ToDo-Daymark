ALTER TABLE "tasks" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "tasks_user_id_sort_order_idx" ON "tasks"("user_id", "sort_order");
