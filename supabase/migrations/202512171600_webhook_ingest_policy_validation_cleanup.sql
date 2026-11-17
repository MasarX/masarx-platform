-- Migration: Cleanup webhook_ingest_policy validation contract drift
-- Purpose:
--   - Remove unsupported `validation.max_payload_bytes` keys from webhook_ingest_policy settings.
--   - Keep settings JSON schema compliant (docs/ops/schemas/webhook_ingest_policy.schema.json).
--   - Use canonical `upsert_webhook_ingest_policy` to preserve versioning + SSOT semantics.
-- Date: 2025-12-17

BEGIN;

DO $$
DECLARE
  r RECORD;
  v_policy JSONB;
BEGIN
  FOR r IN
    SELECT scope_type, scope_id, cached_value
      FROM public.settings
     WHERE category = 'webhook_ingest_policy'
       AND (cached_value->'validation' ? 'max_payload_bytes')
  LOOP
    v_policy := r.cached_value #- '{validation,max_payload_bytes}';
    PERFORM public.upsert_webhook_ingest_policy(r.scope_type, r.scope_id, v_policy);
  END LOOP;
END $$;

COMMIT;

