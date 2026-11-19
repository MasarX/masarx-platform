-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: create_driver_compliance_event_v1 — generic compliance ledger append
-- Date: 2026-04-28
--
-- Notes:
--   - Generic ledger append for compliance/audit events (incident, training_completed,
--     license_expiry_notice, manual_check, etc.).
--   - Free-form event_type (lower-cased) — the SSOT ledger is the
--     driver_compliance_events table itself; not constrained to a closed lookup so callers
--     can extend without schema changes (table CHECK already requires non-empty lowercase).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280071_create_driver_compliance_event_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_driver_compliance_event_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_driver_user_id UUID;
  v_driver_profile_id UUID;
  v_event_type TEXT;
  v_payload JSONB;
  v_notes TEXT;

  v_dp public.driver_profiles%ROWTYPE;
  v_compliance_event_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_driver_user_id := NULLIF(p_args->>'driver_user_id', '')::UUID;
  v_driver_profile_id := NULLIF(p_args->>'driver_profile_id', '')::UUID;
  v_event_type := lower(NULLIF(btrim(COALESCE(p_args->>'event_type', '')), ''));
  v_payload := COALESCE(p_args->'payload', '{}'::jsonb);
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');

  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: event_type is required' USING ERRCODE = '22023';
  END IF;
  IF v_driver_user_id IS NULL AND v_driver_profile_id IS NULL THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: driver_user_id or driver_profile_id is required' USING ERRCODE = '22023';
  END IF;

  -- Resolve driver_profile (tenant-scoped) and validate
  SELECT *
    INTO v_dp
    FROM public.driver_profiles
   WHERE (v_driver_profile_id IS NOT NULL AND id = v_driver_profile_id)
      OR (v_driver_profile_id IS NULL AND user_id = v_driver_user_id AND organization_id = v_org_id)
   LIMIT 1;
  IF v_dp.id IS NULL THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: driver_profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dp.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'create_driver_compliance_event_v1: driver_profile % belongs to another organization', v_dp.id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('driver_compliance_policy', 'tenant', v_org_id);

  INSERT INTO public.driver_compliance_events (
    id,
    organization_id,
    user_id,
    event_type,
    actor_user_id,
    actor_system,
    payload
  )
  VALUES (
    v_compliance_event_id,
    v_org_id,
    v_dp.user_id,
    v_event_type,
    auth.uid(),
    'create_driver_compliance_event_v1',
    v_payload
      || jsonb_build_object(
           'driver_profile_id', v_dp.id,
           'notes', v_notes,
           'correlation_id', v_correlation_id,
           'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
         )
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'compliance.driver_event_recorded',
    'driver_compliance_event',
    v_compliance_event_id,
    jsonb_build_object(
      'driver_user_id', v_dp.user_id,
      'driver_profile_id', v_dp.id,
      'event_type', v_event_type,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'compliance.driver_event_recorded',
    'driver_compliance_event',
    v_compliance_event_id,
    'rpc_dispatch',
    'recorded',
    'create_driver_compliance_event_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_user_id', v_dp.user_id,
      'driver_profile_id', v_dp.id,
      'event_type', v_event_type,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_compliance_event_id', v_compliance_event_id,
    'driver_profile_id', v_dp.id,
    'driver_user_id', v_dp.user_id,
    'event_type', v_event_type,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_compliance_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_driver_compliance_event_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_driver_compliance_event_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_driver_compliance_event_v1(JSONB)
  IS 'Canonical RPC: append a generic row to public.driver_compliance_events. event_type is free-form (lowercased) — table CHECK guards non-empty/lowercase. Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280071_create_driver_compliance_event_v1'));
COMMIT;
