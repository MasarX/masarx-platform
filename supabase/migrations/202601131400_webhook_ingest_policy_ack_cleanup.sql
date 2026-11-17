-- Migration: Cleanup webhook_ingest_policy ack contract drift
-- Purpose:
--   - Remove unsupported keys from webhook_ingest_policy.ack.
--   - Preserve versioning via upsert_webhook_ingest_policy.
--   - Keep settings JSON schema compliant (docs/ops/schemas/webhook_ingest_policy.schema.json).
-- Date: 2026-01-13

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_ack JSONB;
  v_policy JSONB;
BEGIN
  FOR r IN
    SELECT scope_type, scope_id, cached_value
      FROM public.settings
     WHERE category = 'webhook_ingest_policy'
       AND cached_value ? 'ack'
       AND EXISTS (
         SELECT 1
           FROM jsonb_object_keys(cached_value->'ack') AS k
          WHERE k NOT IN (
            'mode',
            'status_code',
            'default_headers',
            'default_outcome',
            'reason_template',
            'response_mapping_id'
          )
       )
  LOOP
    v_ack := jsonb_strip_nulls(jsonb_build_object(
      'mode', r.cached_value->'ack'->'mode',
      'status_code', r.cached_value->'ack'->'status_code',
      'default_headers', r.cached_value->'ack'->'default_headers',
      'default_outcome', r.cached_value->'ack'->'default_outcome',
      'reason_template', r.cached_value->'ack'->'reason_template',
      'response_mapping_id', r.cached_value->'ack'->'response_mapping_id'
    ));

    v_policy := jsonb_set(r.cached_value, '{ack}', v_ack, true);
    UPDATE public.settings_versions
       SET effective_until = now()
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = r.scope_type
       AND (scope_id IS NOT DISTINCT FROM r.scope_id)
       AND effective_until IS NULL
       AND approved_at IS NOT NULL;
    PERFORM public.upsert_webhook_ingest_policy(r.scope_type, r.scope_id, v_policy);
  END LOOP;
END $$;

COMMIT;
