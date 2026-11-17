-- Migration: Global webhook_ingest_policy ACK status normalization
-- Purpose:
--   Ensure the canonical global webhook_ingest_policy uses status_code = 202
--   for accepted_async acknowledgements, aligning with pgTAP expectations and
--   HTTP async-accept semantics.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_settings_version_id UUID;
BEGIN
  SELECT sv.id
  INTO v_settings_version_id
  FROM settings_versions sv
  JOIN settings s ON s.settings_version_id = sv.id
  WHERE s.category = 'webhook_ingest_policy'
    AND s.scope_type = 'global'
  ORDER BY s.last_updated DESC
  LIMIT 1;

  IF v_settings_version_id IS NOT NULL THEN
    UPDATE settings_versions sv
    SET value = jsonb_set(
                  sv.value,
                  '{ack,status_code}',
                  to_jsonb(202),
                  true
                )
    WHERE sv.id = v_settings_version_id;

    UPDATE settings s
    SET cached_value = sv.value,
        last_updated = now()
    FROM settings_versions sv
    WHERE s.settings_version_id = sv.id
      AND s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'global';
  END IF;
END;
$$;

COMMIT;

