-- A provider response can be observed more than once when an accounting step is
-- retried. Keep exactly one charge for the same provider request before adding
-- the invariant so an older database with accidental duplicates can migrate.
DELETE FROM model_usage_events
 WHERE id IN (
   SELECT duplicate.id
     FROM model_usage_events duplicate
     JOIN model_usage_events original
       ON original.provider = duplicate.provider
      AND original.provider_request_id = duplicate.provider_request_id
      AND original.id < duplicate.id
    WHERE duplicate.provider_request_id IS NOT NULL
 );

CREATE UNIQUE INDEX IF NOT EXISTS model_usage_events_provider_request_unique_idx
  ON model_usage_events (provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
