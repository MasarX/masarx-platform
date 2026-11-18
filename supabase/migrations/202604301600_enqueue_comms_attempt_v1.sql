-- Spec-Issue: W13-5 (OPERATIONS D3 §3 — CommsTab "Send now" orphan-toast closure)
-- Migration: canonical operator-initiated comms attempt enqueue.
--
-- Purpose:
--   Today, `public.comms_attempts` rows are written exclusively by
--   `comms_orchestrator_apply_v1` (workflow-driven) and per-channel
--   `enqueue_comms_*` helpers (e.g., `enqueue_comms_whatsapp`). The Console
--   shipments-drawer CommsTab "Send now" button has no canonical
--   operator-initiated seam. This migration adds:
--
--     1. `communication_policy.allow_operator_initiated_send` policy gate
--        (additive — defaults to FALSE on global so the change is
--        backward-compatible; tenants explicitly opt-in via settings).
--     2. `public.enqueue_comms_attempt_v1(p_args jsonb)` RPC that:
--          - Validates auth.uid() is set + holds `comms.write` capability
--          - Resolves communication_policy through the ladder context
--            (organization_id, client_id, sender_id, shipment_id)
--          - Fails closed with code `comms_operator_initiated_disabled` when
--            policy.allow_operator_initiated_send is not TRUE
--          - Validates channel ∈ communication_policy.allowed_channels
--          - Inserts a fresh row into `public.comms_attempts` with
--            `status='queued'` + audit metadata
--          - Returns canonical envelope:
--             { ok, comms_attempt_id, shipment_id, channel, template_id,
--               status, correlation_id, settings_resolution_id }
--     3. `public.api.enqueue_comms_attempt_v1` wrapper for browser/server
--        clients pinned to `db.schema='api'`.
--
-- Cross-references:
--   - `apps/console-v2/__audit__/DECISIONS/SHIPMENTS-DRAWER-CELL-EDITS.md` §3
--   - `supabase/migrations/202602061540_mobile_shell_policy_pack_v1.sql` (policy)
--   - `supabase/migrations/202510110005_communications.sql` (comms_attempts table)
--   - `supabase/migrations/202604111130_api_shipment_amend_cancel_wrappers_v1.sql` (api wrapper pattern)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301600_enqueue_comms_attempt_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Policy schema extension: communication_policy.allow_operator_initiated_send
--    Additive — preserves the existing keys (allowed_channels, templates).
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  v_global_value JSONB;
BEGIN
  SELECT cached_value
    INTO v_global_value
    FROM public.settings
   WHERE category = 'communication_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  IF v_global_value IS NULL THEN
    -- Policy pack not seeded yet — skip gracefully (the global seed may run
    -- after this migration in a fresh project). The RPC below will fail
    -- closed with code `comms_operator_initiated_disabled` when the policy
    -- key is missing, which is the canonical safe default.
    RAISE NOTICE 'communication_policy global default not present; allow_operator_initiated_send defaults to FALSE.';
    RETURN;
  END IF;

  IF v_global_value ? 'allow_operator_initiated_send' THEN
    RAISE NOTICE 'communication_policy.allow_operator_initiated_send already configured at global; leaving as-is.';
    RETURN;
  END IF;

  PERFORM public.upsert_settings_value_v1(
    'communication_policy',
    'global',
    NULL,
    jsonb_set(
      v_global_value,
      '{allow_operator_initiated_send}',
      'false'::jsonb,
      TRUE
    ),
    1,
    'W13-5 — backward-compatible default for operator-initiated comms send.'
  );
END;
$do$;

-- ---------------------------------------------------------------------------
-- 2) Canonical RPC: public.enqueue_comms_attempt_v1(p_args jsonb)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_comms_attempt_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_shipment_id UUID := NULL;
  v_channel TEXT := lower(NULLIF(btrim(COALESCE(v_args->>'channel', '')), ''));
  v_template_id UUID := NULL;
  v_recipient_override JSONB := COALESCE(v_args->'recipient_override', NULL);
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_attempt_id UUID := gen_random_uuid();
  v_target RECORD;
  v_org_id UUID := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_allowed_channels JSONB := '[]'::jsonb;
  v_allow_operator BOOLEAN := FALSE;
  v_settings_resolution_id UUID := gen_random_uuid();
  v_status TEXT := 'queued';
BEGIN
  -- ---- Auth gate ----
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- ---- Capability gate (comms.write) ----
  IF NOT public.user_has_resource_capability_v1('comms', 'write') THEN
    RAISE EXCEPTION 'enqueue_comms_attempt_v1 requires comms.write capability'
      USING ERRCODE = '42501';
  END IF;

  -- ---- Argument parsing ----
  BEGIN
    v_shipment_id := NULLIF(v_args->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  BEGIN
    v_template_id := NULLIF(v_args->>'template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  IF v_shipment_id IS NULL OR v_channel IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'invalid_request')
    );
  END IF;

  -- ---- Resolve shipment scope (RLS-aware via ui_shipment_mutation_access_v1) ----
  SELECT *
    INTO v_target
    FROM public.ui_shipment_mutation_access_v1(v_shipment_id)
   LIMIT 1;

  v_org_id := v_target.organization_id;

  -- ---- Resolve communication_policy through the ladder ----
  v_policy := public.resolve_communication_policy(
    jsonb_build_object(
      'organization_id', v_target.organization_id,
      'client_id', v_target.client_id,
      'sender_id', v_target.sender_id,
      'shipment_id', v_target.shipment_id
    )
  );

  v_allow_operator := COALESCE((v_policy->>'allow_operator_initiated_send')::BOOLEAN, FALSE);
  v_allowed_channels := COALESCE(v_policy->'allowed_channels', '[]'::jsonb);

  -- ---- Policy gate: operator-initiated send must be enabled ----
  IF v_allow_operator IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_operator_initiated_disabled',
        'policy_key', 'communication_policy.allow_operator_initiated_send'
      ),
      'correlation_id', v_correlation_id
    );
  END IF;

  -- ---- Channel allowlist gate ----
  IF NOT (v_allowed_channels @> to_jsonb(v_channel)) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'comms_channel_not_allowed',
        'channel', v_channel,
        'allowed_channels', v_allowed_channels
      ),
      'correlation_id', v_correlation_id
    );
  END IF;

  -- ---- Insert canonical comms_attempts row ----
  INSERT INTO public.comms_attempts (
    id,
    organization_id,
    shipment_id,
    channel,
    template_id,
    status,
    payload,
    timestamp
  )
  VALUES (
    v_attempt_id,
    v_org_id,
    v_shipment_id,
    v_channel,
    v_template_id,
    v_status,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'console.shipments_drawer.send_now',
      'requested_by_user_id', v_user_id,
      'recipient_override', v_recipient_override,
      'correlation_id', v_correlation_id
    )),
    now()
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'comms_attempt_id', v_attempt_id,
    'shipment_id', v_shipment_id,
    'channel', v_channel,
    'template_id', v_template_id,
    'status', v_status,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

COMMENT ON FUNCTION public.enqueue_comms_attempt_v1(JSONB)
  IS 'W13-5 operator-initiated comms attempt enqueue (CommsTab "Send now"). '
     'Policy-gated by communication_policy.allow_operator_initiated_send + '
     'allowed_channels. Inserts into public.comms_attempts with status=queued.';

REVOKE ALL ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_comms_attempt_v1(JSONB) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) api wrapper (browser/server clients pinned to db.schema='api')
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.enqueue_comms_attempt_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.enqueue_comms_attempt_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.enqueue_comms_attempt_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604301600_enqueue_comms_attempt_v1'));
COMMIT;
