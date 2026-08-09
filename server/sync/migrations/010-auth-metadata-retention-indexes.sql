CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx
  ON auth_sessions (expires_at);

CREATE INDEX IF NOT EXISTS sync_devices_last_seen_idx
  ON sync_devices (last_seen_at);
