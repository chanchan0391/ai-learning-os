CREATE TABLE IF NOT EXISTS request_rate_limits (
  scope text NOT NULL,
  key_hash text NOT NULL CHECK (length(key_hash) = 64),
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, key_hash, window_started_at),
  CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS request_rate_limits_expiry_idx
  ON request_rate_limits (expires_at);
