CREATE TABLE IF NOT EXISTS subscription_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_key VARCHAR(64) NOT NULL CHECK (plan_key <> ''),
  status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'inactive')),
  access_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_entitlements_status_access_idx
  ON subscription_entitlements (status, access_until);
