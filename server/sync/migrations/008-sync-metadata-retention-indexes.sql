CREATE INDEX IF NOT EXISTS sync_cursors_created_idx
  ON sync_cursors (created_at);

CREATE INDEX IF NOT EXISTS sync_operations_created_idx
  ON sync_operations (created_at);
