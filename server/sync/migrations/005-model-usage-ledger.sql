CREATE TABLE IF NOT EXISTS model_usage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 255),
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_usage_events_user_time_idx
  ON model_usage_events (user_id, occurred_at DESC);
