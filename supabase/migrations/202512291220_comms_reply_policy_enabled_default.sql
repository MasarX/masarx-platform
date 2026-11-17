-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S03
-- Migration: comms_reply_policy global default safety (enabled gate)
-- Purpose:
--   - Ensure a global comms_reply_policy default can be safely "disabled" without changing caller behavior.
--   - Preserve backwards compatibility: when policy.enabled is missing/invalid, treat as enabled=true.
-- Notes:
--   - We avoid re-copying the large send_comms_reply implementation by wrapping the core.
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- The large implementation currently lives in send_comms_reply_core (created by prior migrations).
-- Rename it to an implementation function and reintroduce send_comms_reply_core as a thin wrapper.
ALTER FUNCTION public.send_comms_reply_core(uuid, uuid, jsonb, uuid)
  RENAME TO send_comms_reply_core_impl;

CREATE OR REPLACE FUNCTION public.send_comms_reply_core(
  p_webhook_id uuid,
  p_webhook_source_id uuid,
  p_comm jsonb,
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_policy_row record;
  v_policy jsonb := NULL;
  v_enabled boolean := true;
BEGIN
  -- Resolve comms_reply_policy via ladder starting at source scope.
  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('comms_reply_policy', 'source', p_webhook_source_id)
    LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_missing');
  END IF;

  v_policy := v_policy_row.value;

  -- Backwards compatible: default to enabled when missing/invalid.
  BEGIN
    v_enabled := COALESCE(NULLIF(v_policy->>'enabled', '')::boolean, true);
  EXCEPTION
    WHEN others THEN
      v_enabled := true;
  END;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'policy_disabled');
  END IF;

  RETURN public.send_comms_reply_core_impl(p_webhook_id, p_webhook_source_id, p_comm, p_organization_id);
END;
$$;

COMMENT ON FUNCTION public.send_comms_reply_core(uuid, uuid, jsonb, uuid)
  IS 'Wrapper around send_comms_reply_core_impl that enforces comms_reply_policy.enabled (default true when missing).';

COMMIT;

