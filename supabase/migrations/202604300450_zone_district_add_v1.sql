-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S06
-- Migration: zone_district_add_v1
-- Capability: zones.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: insert public.zone_districts mapping row + decision_log
--   + domain_event. Idempotent on (zone, district). Replaces the FE phaseC6Rpc shim.
--
-- Args (jsonb):
--   { zone_id (uuid, required), canonical_district_id (uuid, required) }
-- Envelope: { ok, zone_district_id, already_processed, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300450_zone_district_add_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.zone_district_add_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_zone_id UUID;
  v_district_id UUID;
  v_zone public.zones%ROWTYPE;
  v_zone_district_id UUID;
  v_already BOOLEAN := FALSE;
  v_other_zone_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'zone_district_add_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_zone_id := NULLIF(p_args->>'zone_id', '')::uuid;
  v_district_id := NULLIF(p_args->>'canonical_district_id', '')::uuid;
  IF v_zone_id IS NULL OR v_district_id IS NULL THEN
    RAISE EXCEPTION 'zone_district_add_v1 requires zone_id and canonical_district_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_zone FROM public.zones WHERE id = v_zone_id;
  IF v_zone.id IS NULL THEN
    RAISE EXCEPTION 'zone_district_add_v1 zone % not found', v_zone_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_zone.organization_id);

  IF NOT public.is_platform_user() AND v_zone.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'zone_district_add_v1 zone % outside tenant scope', v_zone_id USING ERRCODE = '42501';
  END IF;

  -- Idempotent path: same (zone, district) already mapped
  SELECT id INTO v_zone_district_id
    FROM public.zone_districts
   WHERE zone_id = v_zone_id AND canonical_district_id = v_district_id;

  IF v_zone_district_id IS NOT NULL THEN
    v_already := TRUE;
  ELSE
    -- Conflict: district mapped to a different zone (zone_districts_unique_district)
    SELECT zone_id INTO v_other_zone_id
      FROM public.zone_districts
     WHERE canonical_district_id = v_district_id;
    IF v_other_zone_id IS NOT NULL THEN
      RAISE EXCEPTION 'zone_district_add_v1: canonical_district % already assigned to zone % (call zone_district_remove_v1 first)',
        v_district_id, v_other_zone_id USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.zone_districts (zone_id, canonical_district_id)
    VALUES (v_zone_id, v_district_id)
    RETURNING id INTO v_zone_district_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_zone.organization_id, 'zone_district.added', 'zone_district', v_zone_district_id, v_correlation_id,
      jsonb_build_object(
        'zone_id', v_zone_id,
        'canonical_district_id', v_district_id
      ),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_zone.organization_id,
    p_decision_category := 'zones.district_add',
    p_resource_type := 'zone_district',
    p_resource_id := v_zone_district_id,
    p_decision_point := 'zone_district_add_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_mapped' ELSE 'added' END,
    p_performed_by_system := 'zone_district_add_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'zone_id', v_zone_id,
      'canonical_district_id', v_district_id
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_district_id', v_zone_district_id,
    'already_processed', v_already,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.zone_district_add_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zone_district_add_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.zone_district_add_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: insert zone_districts mapping + decision_log + domain_event. Capability: zones.write. Idempotent on (zone, district).';

SELECT pg_advisory_unlock(hashtext('202604300450_zone_district_add_v1'));
COMMIT;
