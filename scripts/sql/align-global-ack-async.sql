BEGIN;

-- Force global webhook_ingest_policy to accepted_async (202) with async mapping
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
      jsonb_build_object(
        'version', COALESCE((sv.value->>'version')::INT, 1),
        'ack', jsonb_build_object(
          'mode', 'accepted_async',
          'status_code', 202,
          'response_mapping_id', '88880000-0000-0000-0000-000000000002',
          'default_headers', jsonb_build_object('cache-control','no-store')
        )
      )
      || COALESCE(sv.value - 'ack' - 'version', '{}'::jsonb)
    ),
    change_reason = 'Align global webhook_ingest_policy to accepted_async (202)',
    approved_at = COALESCE(sv.approved_at, now()),
    effective_from = COALESCE(sv.effective_from, now())
WHERE sv.id = (
  SELECT s.settings_version_id
  FROM settings s
  WHERE s.category = 'webhook_ingest_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
);

UPDATE settings s
SET cached_value = sv.value,
    last_updated = now()
FROM settings_versions sv
WHERE s.settings_version_id = sv.id
  AND s.category = 'webhook_ingest_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL;

COMMIT;
