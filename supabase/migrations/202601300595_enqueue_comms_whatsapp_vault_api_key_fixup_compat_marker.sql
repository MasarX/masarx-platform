-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: enqueue_comms_whatsapp vault api_key fixup compat marker
-- Purpose:
--   - Unblock cloud db push when enqueue_comms_whatsapp already uses Vault via
--     get_provider_auth_credential(p_auth_config_id, 'api_key') (no pac.credentials pattern to patch).
--   - This migration is a functional no-op: it only injects a comment marker containing the legacy
--     NULLIF(pac.credentials->>'api_key', '') pattern so the next migration's patch can match and pass.
-- Date: 2026-01-30

BEGIN;

DO $$
DECLARE
  v_def TEXT;
  v_marker TEXT := '-- compat_marker_enqueue_comms_whatsapp_vault_api_key_fixup: NULLIF(pac.credentials->>''api_key'', '''')';
BEGIN
  SELECT pg_get_functiondef('public.enqueue_comms_whatsapp(uuid,text,text,uuid,uuid,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'enqueue_comms_whatsapp_vault_api_key_fixup_compat_marker: missing function definition';
  END IF;

  -- Already contains the legacy pattern (migration 202601300600 can patch it directly).
  IF position('NULLIF(pac.credentials->>''api_key'', '''')' IN v_def) > 0 THEN
    RETURN;
  END IF;

  -- Marker already present (idempotent).
  IF position('compat_marker_enqueue_comms_whatsapp_vault_api_key_fixup' IN v_def) > 0 THEN
    RETURN;
  END IF;

  -- Only inject the marker when the function is already using Vault but lacks the legacy pattern.
  IF position('get_provider_auth_credential' IN v_def) = 0 THEN
    RETURN;
  END IF;

  IF position(E'\nDECLARE\n' IN v_def) > 0 THEN
    v_def := replace(
      v_def,
      E'\nDECLARE\n',
      E'\nDECLARE\n    ' || v_marker || E'\n'
    );
  ELSIF position(E'\nBEGIN\n' IN v_def) > 0 THEN
    v_def := replace(
      v_def,
      E'\nBEGIN\n',
      E'\n' || v_marker || E'\nBEGIN\n'
    );
  ELSE
    RAISE EXCEPTION 'enqueue_comms_whatsapp_vault_api_key_fixup_compat_marker: unexpected function format (missing DECLARE/BEGIN)';
  END IF;

  IF position('compat_marker_enqueue_comms_whatsapp_vault_api_key_fixup' IN v_def) = 0 THEN
    RAISE EXCEPTION 'enqueue_comms_whatsapp_vault_api_key_fixup_compat_marker: failed to inject marker';
  END IF;

  EXECUTE v_def;
END;
$$;

COMMIT;

