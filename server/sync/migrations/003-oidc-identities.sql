CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  CHECK (length(issuer) BETWEEN 1 AND 2048),
  CHECK (length(subject) BETWEEN 1 AND 255)
);
