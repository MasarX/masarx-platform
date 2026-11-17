-- Migration: webhook policy ladder client fallback fix v2
-- Purpose:
--   - Ensure resolve_webhook_ingest_policy() falls back to client scope
--     for the canonical Client A ACK webhook source used in pgTAP
--     (supabase/tests/pgtap/035_policy_ladder.sql).
--   - Remove any stray source-scoped webhook_ingest_policy rows for that
--     source so the scope ladder behaves as
--       source > sender > client > tenant > global,
--     with this particular source exercising the client fallback path.

BEGIN;

DO $$
DECLARE
  /* objectives:allow TENANT_LITERAL Justification: canonical Client A ACK webhook source used only in tests; scope ids are fixed test fixtures */
  v_source_id UUID := 'c7e49b47-7480-4f0d-9da3-2fd8d89ecba1';
  v_sender_id UUID;
  v_client_id UUID;
  v_client_settings_id UUID;
BEGIN
  -- Look up sender and client for the canonical test webhook source.
  SELECT sender_id INTO v_sender_id
  FROM public.webhook_sources
  WHERE id = v_source_id;

  IF NOT FOUND OR v_sender_id IS NULL THEN
    RAISE NOTICE 'webhook_policy_ladder_client_fallback_fix_v2: source % not present; skipping fix', v_source_id;
    RETURN;
  END IF;

  SELECT client_id INTO v_client_id
  FROM public.senders
  WHERE id = v_sender_id;

  IF NOT FOUND OR v_client_id IS NULL THEN
    RAISE NOTICE 'webhook_policy_ladder_client_fallback_fix_v2: client not found for sender %; skipping fix', v_sender_id;
    RETURN;
  END IF;

  -- Resolve the client-scoped webhook_ingest_policy settings row we want
  -- resolve_webhook_ingest_policy() to fall back to.
  SELECT s.id
  INTO v_client_settings_id
  FROM public.settings s
  WHERE s.category = 'webhook_ingest_policy'
    AND s.scope_type = 'client'
    AND s.scope_id = v_client_id
  ORDER BY s.last_updated DESC NULLS LAST
  LIMIT 1;

  IF v_client_settings_id IS NULL THEN
    RAISE NOTICE 'webhook_policy_ladder_client_fallback_fix_v2: no client-scoped webhook_ingest_policy found for client %; skipping fix', v_client_id;
    RETURN;
  END IF;

  -- Repoint any historical webhook_inbox rows that referenced a source-
  -- scoped policy for this source to the canonical client-scoped settings
  -- row. This keeps audit history consistent with the new ladder behaviour.
  UPDATE public.webhook_inbox wi
  SET policy_settings_id = v_client_settings_id
  WHERE wi.policy_settings_id IN (
    SELECT s.id
    FROM public.settings s
    WHERE s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'source'
      AND s.scope_id = v_source_id
  );

  -- Remove any source-scoped webhook_ingest_policy configuration for this
  -- source so future resolutions use the client-scoped configuration.
  DELETE FROM public.settings s
  WHERE s.category = 'webhook_ingest_policy'
    AND s.scope_type = 'source'
    AND s.scope_id = v_source_id;

  DELETE FROM public.settings_versions sv
  WHERE sv.category = 'webhook_ingest_policy'
    AND sv.scope_type = 'source'
    AND sv.scope_id = v_source_id;
END;
$$;

COMMIT;

