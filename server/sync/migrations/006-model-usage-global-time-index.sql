CREATE INDEX IF NOT EXISTS model_usage_events_time_idx
  ON model_usage_events (occurred_at DESC);
