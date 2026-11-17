-- Migration: Seed source-level webhook_ingest_policy for precedence test source
-- Purpose: Ensure resolve_webhook_ingest_policy returns scope_type='source' for
--          the test-basic-source webhook (id d78922af-ce74-4d3f-88cc-0a0640a6bd2d).

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_source CONSTANT UUID := 'd78922af-ce74-4d3f-88cc-0a0640a6bd2d'::UUID;
  v_policy JSONB;
BEGIN
  SELECT cached_value
  INTO v_policy
  FROM settings
  WHERE category = 'webhook_ingest_policy'
    AND scope_type = 'global'
    AND scope_id IS NULL
  LIMIT 1;

  IF v_policy IS NULL THEN
    v_policy := jsonb_build_object(
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'default_headers', jsonb_build_object('cache-control', 'no-store')
      ),
      'schema', jsonb_build_object('version', 'v1', 'registry', 'schema_registry'),
      'logging', jsonb_build_object('decision_point', 'http_response', 'include_payload', false),
      'version', 1,
      'workflow', NULL,
      'validation', jsonb_build_object(
        'idempotency', jsonb_build_object('header', 'Idempotency-Key', 'dedupe_window_seconds', 3600)
      ),
      'wait_for_ack', false
    );
  END IF;

  PERFORM upsert_webhook_ingest_policy(
    'source',
    v_source,
    v_policy
  );
END $$;

COMMIT;
