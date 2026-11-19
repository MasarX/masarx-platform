-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: record_hours_of_service_segment_v1 — append HOS duty segment
-- Date: 2026-04-28
--
-- Behavior:
--   - Closes any open (segment_end IS NULL) prior segment for the driver in this org
--     before opening the new segment, ensuring at most one open segment per driver.
--   - duty_status must be a value in lookup hours_of_service_duty_status (driving / on_duty /
--     off_duty / sleeper) — row-driven, no hardcoded set.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280075_record_hours_of_service_segment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.record_hours_of_service_segment_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();

  v_driver_profile_id UUID;
  v_driver_user_id UUID;
  v_segment_start TIMESTAMPTZ;
  v_segment_end TIMESTAMPTZ;
  v_duty_status TEXT;
  v_notes TEXT;
  v_metadata JSONB;

  v_dp public.driver_profiles%ROWTYPE;
  v_segment_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_resolved_settings JSONB;
  v_lookup_exists BOOLEAN;
  v_closed_open_count INT := 0;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) <> 'object' THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: p_args must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: authenticated tenant user required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('fleet.write', v_scope_type, v_scope_id);

  v_driver_profile_id := NULLIF(p_args->>'driver_profile_id', '')::UUID;
  v_driver_user_id := NULLIF(p_args->>'driver_user_id', '')::UUID;
  v_segment_start := COALESCE(NULLIF(p_args->>'segment_start', '')::TIMESTAMPTZ, now());
  v_segment_end := NULLIF(p_args->>'segment_end', '')::TIMESTAMPTZ;
  v_duty_status := lower(NULLIF(btrim(COALESCE(p_args->>'duty_status', '')), ''));
  v_notes := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);

  IF v_driver_profile_id IS NULL AND v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: driver_profile_id or driver_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_duty_status IS NULL THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: duty_status is required' USING ERRCODE = '22023';
  END IF;
  IF v_segment_end IS NOT NULL AND v_segment_end < v_segment_start THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: segment_end must be >= segment_start' USING ERRCODE = '22023';
  END IF;

  -- Validate duty_status against the lookup (row-driven; no hardcoded set)
  SELECT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'hours_of_service_duty_status'
       AND lv.value = v_duty_status
  ) INTO v_lookup_exists;

  IF NOT v_lookup_exists THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: duty_status % not in lookup hours_of_service_duty_status', v_duty_status
      USING ERRCODE = '22023';
  END IF;

  -- Resolve driver_profile (tenant-scoped) and validate
  SELECT *
    INTO v_dp
    FROM public.driver_profiles
   WHERE (v_driver_profile_id IS NOT NULL AND id = v_driver_profile_id)
      OR (v_driver_profile_id IS NULL AND user_id = v_driver_user_id AND organization_id = v_org_id)
   LIMIT 1;
  IF v_dp.id IS NULL THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: driver_profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dp.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'record_hours_of_service_segment_v1: driver_profile % belongs to another organization', v_dp.id USING ERRCODE = '42501';
  END IF;

  v_resolved_settings := public.resolve_settings_merged('driver_compliance_policy', 'tenant', v_org_id);

  -- Close any open (active) segment for this driver in the same org so at most one segment is open
  WITH closed AS (
    UPDATE public.driver_hours_of_service
       SET segment_end = v_segment_start,
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           'closed_by', 'record_hours_of_service_segment_v1',
                           'closed_correlation_id', v_correlation_id,
                           'closed_for_new_segment', v_segment_id
                         )
     WHERE driver_id = v_dp.id
       AND organization_id = v_org_id
       AND segment_end IS NULL
    RETURNING id
  )
  SELECT COUNT(*)::INT INTO v_closed_open_count FROM closed;

  -- Insert the new segment
  INSERT INTO public.driver_hours_of_service (
    id,
    organization_id,
    driver_id,
    segment_start,
    segment_end,
    duty_status,
    notes,
    metadata,
    recorded_by_user_id,
    recorded_via_system
  )
  VALUES (
    v_segment_id,
    v_org_id,
    v_dp.id,
    v_segment_start,
    v_segment_end,
    v_duty_status,
    v_notes,
    v_metadata
      || jsonb_build_object(
           'correlation_id', v_correlation_id,
           'closed_open_count', v_closed_open_count,
           'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
         ),
    auth.uid(),
    'record_hours_of_service_segment_v1'
  );

  PERFORM public.enqueue_domain_event(
    v_org_id,
    'fleet.hours_of_service_recorded',
    'driver_hours_of_service',
    v_segment_id,
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'driver_user_id', v_dp.user_id,
      'duty_status', v_duty_status,
      'segment_start', v_segment_start,
      'segment_end', v_segment_end,
      'closed_open_count', v_closed_open_count,
      'requested_by', auth.uid()
    ),
    v_correlation_id
  );

  PERFORM public.log_decision(
    v_org_id,
    'fleet.hours_of_service_recorded',
    'driver_hours_of_service',
    v_segment_id,
    'rpc_dispatch',
    'recorded',
    'record_hours_of_service_segment_v1',
    v_correlation_id,
    jsonb_build_object(
      'driver_profile_id', v_dp.id,
      'driver_user_id', v_dp.user_id,
      'duty_status', v_duty_status,
      'closed_open_count', v_closed_open_count,
      'driver_compliance_policy', COALESCE(v_resolved_settings, '{}'::jsonb)
    ),
    v_notes
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'driver_hours_of_service_id', v_segment_id,
    'driver_profile_id', v_dp.id,
    'driver_user_id', v_dp.user_id,
    'duty_status', v_duty_status,
    'segment_start', v_segment_start,
    'segment_end', v_segment_end,
    'closed_open_count', v_closed_open_count,
    'correlation_id', v_correlation_id,
    'resolved_from', 'driver_compliance_policy/tenant'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_hours_of_service_segment_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_hours_of_service_segment_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.record_hours_of_service_segment_v1(JSONB)
  IS 'Canonical RPC: append a row to public.driver_hours_of_service (HOS duty segment). Closes any prior open segment first to enforce single-open-segment invariant. duty_status must be in lookup hours_of_service_duty_status. Capability-gated (fleet.write).';

SELECT pg_advisory_unlock(hashtext('202604280075_record_hours_of_service_segment_v1'));
COMMIT;
