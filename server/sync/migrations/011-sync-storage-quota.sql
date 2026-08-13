ALTER TABLE users
  ADD COLUMN sync_entity_count integer NOT NULL DEFAULT 0,
  ADD COLUMN sync_storage_bytes bigint NOT NULL DEFAULT 0;

UPDATE users AS account
   SET sync_entity_count = (
         SELECT count(*)
           FROM (
             SELECT id FROM learning_plans WHERE user_id = account.id
             UNION ALL
             SELECT id FROM daily_records WHERE user_id = account.id
           ) AS retained_entities
       ),
       sync_storage_bytes = (
         SELECT coalesce(sum(octet_length(value::text)), 0)
           FROM (
             SELECT value FROM learning_plans WHERE user_id = account.id
             UNION ALL
             SELECT value FROM daily_records WHERE user_id = account.id
           ) AS retained_entities
       );

ALTER TABLE users
  ADD CONSTRAINT users_sync_entity_count_nonnegative CHECK (sync_entity_count >= 0),
  ADD CONSTRAINT users_sync_storage_bytes_nonnegative CHECK (sync_storage_bytes >= 0);
