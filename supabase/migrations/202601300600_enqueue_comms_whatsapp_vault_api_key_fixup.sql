-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: enqueue_comms_whatsapp Vault api_key resolver fixup
-- Purpose:
--   - enqueue_comms_whatsapp must validate api_key presence when provider_auth_configs uses
--     credentials_vault_id (credentials JSONB can be NULL).
--   - Keep outbound secret hygiene intact (no api_key persisted to outbound_calls).
-- Date: 2026-01-30

BEGIN;

DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.enqueue_comms_whatsapp(uuid,text,text,uuid,uuid,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'enqueue_comms_whatsapp_vault_api_key_fixup: missing function definition';
  END IF;

  -- Patch legacy credential lookup (credentials JSONB) to use the SSOT Vault resolver.
  v_def := replace(
    v_def,
    'NULLIF(pac.credentials->>''api_key'', '''')',
    'NULLIF(public.get_provider_auth_credential(pac.id, ''api_key''), '''')'
  );

  -- Fail fast if the expected patch did not apply (avoids silent no-op).
  IF position('get_provider_auth_credential(pac.id, ''api_key'')' IN v_def) = 0 THEN
    RAISE EXCEPTION 'enqueue_comms_whatsapp_vault_api_key_fixup: patch failed (pattern not found)';
  END IF;

  EXECUTE v_def;
END;
$$;

COMMIT;

