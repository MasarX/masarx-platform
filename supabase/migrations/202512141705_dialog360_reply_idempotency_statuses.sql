-- Migration: Dialog360 reply webhook idempotency supports status callbacks too
-- Purpose:
--   - Dialog360 delivers both inbound messages and delivery status updates to the same webhook URL.
--   - Use config-driven fallback idempotency key extraction so both shapes dedupe safely:
--       messages[0].id OR statuses[0].id
--   - Requires jsonb_resolve_path '|' support (202512141700_jsonb_resolve_path_multi.sql).
-- Date: 2025-12-14

BEGIN;

DO $$
DECLARE
  v_source_id UUID;
  v_policy JSONB;
  v_body_path TEXT := 'entry.0.changes.0.value.messages.0.id|entry.0.changes.0.value.statuses.0.id';
BEGIN
  SELECT id
    INTO v_source_id
    FROM public.webhook_sources
   WHERE source_identifier = 'dialog360_reply'
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_source_id IS NULL THEN
    RETURN;
  END IF;

  SELECT cached_value
    INTO v_policy
    FROM public.settings
   WHERE category = 'webhook_ingest_policy'
     AND scope_type = 'source'
     AND scope_id = v_source_id
   ORDER BY last_updated DESC NULLS LAST
   LIMIT 1;

  IF v_policy IS NULL THEN
    v_policy := public.resolve_settings('webhook_ingest_policy', 'source', v_source_id);
  END IF;

  v_policy := COALESCE(v_policy, '{}'::jsonb);

  v_policy := jsonb_set(
    v_policy,
    '{validation,idempotency,body_path}',
    to_jsonb(v_body_path),
    TRUE
  );

  PERFORM public.upsert_webhook_ingest_policy('source', v_source_id, v_policy);
END $$;

COMMIT;

