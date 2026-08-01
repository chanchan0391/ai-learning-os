CREATE SEQUENCE IF NOT EXISTS sync_change_sequence;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS sync_devices (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS learning_plans (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  change_sequence bigint NOT NULL DEFAULT nextval('sync_change_sequence'),
  value jsonb NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS daily_records (
  user_id text NOT NULL,
  id text NOT NULL,
  plan_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  change_sequence bigint NOT NULL DEFAULT nextval('sync_change_sequence'),
  value jsonb NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, plan_id) REFERENCES learning_plans(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_operations (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS learning_plans_user_changes_idx
  ON learning_plans (user_id, change_sequence);
CREATE INDEX IF NOT EXISTS daily_records_user_changes_idx
  ON daily_records (user_id, change_sequence);
CREATE INDEX IF NOT EXISTS sync_cursors_user_created_idx
  ON sync_cursors (user_id, created_at);
