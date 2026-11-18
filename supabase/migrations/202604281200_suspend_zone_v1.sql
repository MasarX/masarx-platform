-- Plan: PHASE B / Step: B4 (NETWORK marketplace + zones RPC contract gap-fill)
-- Migration: suspend_zone_v1 — flip zone is_active=false with full audit ladder.
-- Date: 2026-04-28
--
-- Purpose:
--   The NETWORK FE crosswalk audit (apps/console-v2/__audit__/CROSSWALK/NETWORK.md
--   §1.2) shows zones.tsx invokes a "suspend zone" UX action that is currently a
--   stub (setBulkPending + setTimeout, no runCommand). Backend has no canonical
--   write RPC for zone suspension; consumers either bypass with raw UPDATE or
--   the action remains stubbed. This migration introduces the canonical
--   `public.suspend_zone_v1(p_args jsonb)` write RPC following the Phase B
--   canonical RPC contract (capability gate + tenant scope guard + domain event +
--   decision_log entry tied to settings ladder).
--
-- Contract:
--   - Capability: zones.write (canonical key registered in
--     access_control_policy.capabilities; ops_admin and agreements_admin
--     receive it via existing role-template seeds)
--   - Tenant isolation: explicit org-membership guard inside body (FE clients
--     can never suspend a zone in another tenant; platform users may suspend
--     across tenants)
--   - Idempotent: re-calling on an already-suspended zone returns the same
--     envelope with already_processed=true; no duplicate domain_event/decision_log
--   - Append-only event ledger via domain_events
--   - Decision audit via log_decision tied to settings resolution

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281200_suspend_zone_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Lookup category seeds: zone_lifecycle decision_category + outcomes
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_decision_category_def UUID;
  v_decision_outcome_def UUID;
BEGIN
  -- decision_category: zone_lifecycle
  SELECT id INTO v_decision_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_decision_category_def IS NULL THEN
    RAISE WARNING 'decision_category lookup_definition missing; skipping zone_lifecycle seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES (
      v_decision_category_def,
      'zone_lifecycle',
      'Zone lifecycle (suspend/restore)',
      'active',
      1010
    )
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;

  -- decision_outcome: suspended / restored
  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NULL THEN
    RAISE WARNING 'decision_outcome lookup_definition missing; skipping suspended/restored seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES
      (v_decision_outcome_def, 'suspended', 'Suspended', 'active', 2010),
      (v_decision_outcome_def, 'restored', 'Restored', 'active', 2011)
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) suspend_zone_v1 RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.suspend_zone_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_zone_id_text TEXT := NULLIF(btrim(COALESCE(p_args->>'zone_id', '')), '');
  v_zone_id UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_zone public.zones%ROWTYPE;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_already_suspended BOOLEAN := FALSE;
  v_metadata_input JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'suspend_zone_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- 1) Capability gate (raises capability_denied if missing)
  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_caller_org_id);

  -- 2) Validate input
  IF v_zone_id_text IS NULL THEN
    RAISE EXCEPTION 'suspend_zone_v1 requires zone_id' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_zone_id := v_zone_id_text::UUID;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'suspend_zone_v1 invalid zone_id %', v_zone_id_text USING ERRCODE = '22023';
  END;

  -- 3) Resolve canonical zone row + enforce tenant scope
  SELECT * INTO v_zone FROM public.zones z WHERE z.id = v_zone_id FOR UPDATE;

  IF v_zone.id IS NULL THEN
    RAISE EXCEPTION 'suspend_zone_v1 zone % not found', v_zone_id USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_zone.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'suspend_zone_v1 zone % is outside current tenant scope', v_zone_id
      USING ERRCODE = '42501';
  END IF;

  -- 4) Idempotent path: already suspended -> return existing envelope
  IF v_zone.is_active = FALSE THEN
    v_already_suspended := TRUE;
    RETURN jsonb_build_object(
      'ok', TRUE,
      'zone_id', v_zone.id,
      'is_active', FALSE,
      'already_processed', TRUE,
      'correlation_id', NULL
    );
  END IF;

  -- 5) Mutate canonical row
  UPDATE public.zones
     SET is_active = FALSE,
         metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_strip_nulls(jsonb_build_object(
                      'suspended_at', to_jsonb(now()),
                      'suspended_by_user_id', to_jsonb(v_user_id),
                      'suspended_reason', v_reason
                    )),
         updated_at = now()
   WHERE id = v_zone.id;

  -- 6) Emit domain event (engine-first ledger)
  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload
  )
  VALUES (
    v_zone.organization_id,
    'zone.suspended',
    'zone',
    v_zone.id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'zone_id', v_zone.id,
      'organization_id', v_zone.organization_id,
      'suspended_by_user_id', v_user_id,
      'reason', v_reason,
      'metadata', v_metadata_input
    ))
  );

  -- 7) Decision audit (settings ladder evidence)
  v_decision_log_id := public.log_decision(
    p_organization_id := v_zone.organization_id,
    p_decision_category := 'zone_lifecycle',
    p_resource_type := 'zone',
    p_resource_id := v_zone.id,
    p_decision_point := 'zone.suspend',
    p_decision_outcome := 'suspended',
    p_performed_by_system := 'suspend_zone_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'zone_id', v_zone.id,
      'previous_is_active', TRUE,
      'reason', v_reason,
      'metadata', v_metadata_input
    )),
    p_decision_reason := COALESCE(v_reason, 'zone_suspend_no_reason')
  );

  -- 8) Canonical envelope
  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_id', v_zone.id,
    'is_active', FALSE,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

COMMENT ON FUNCTION public.suspend_zone_v1(JSONB) IS
  'Phase B (B4) canonical write RPC: suspend a zone (is_active=FALSE) with audit trail. Capability: zones.write. Idempotent. Args: { zone_id (uuid, required), reason (text, optional), metadata (jsonb, optional) }.';

REVOKE ALL ON FUNCTION public.suspend_zone_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suspend_zone_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604281200_suspend_zone_v1'));
COMMIT;
