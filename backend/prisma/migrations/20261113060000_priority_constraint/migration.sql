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
