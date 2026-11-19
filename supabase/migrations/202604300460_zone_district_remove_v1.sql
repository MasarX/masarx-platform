-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S07
-- Migration: zone_district_remove_v1
-- Capability: zones.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: delete public.zone_districts mapping row + decision_log
--   + domain_event. Idempotent (already_processed when row absent).
--
-- Args (jsonb):
--   { zone_district_id (uuid, optional) — direct row id, OR
--     zone_id (uuid) + canonical_district_id (uuid) — composite }
-- Envelope: { ok, zone_district_id, already_processed, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300460_zone_district_remove_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.zone_district_remove_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_zone_district_id UUID;
  v_zone_id UUID;
  v_district_id UUID;
  v_existing public.zone_districts%ROWTYPE;
  v_zone public.zones%ROWTYPE;
  v_already BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'zone_district_remove_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_zone_district_id := NULLIF(p_args->>'zone_district_id', '')::uuid;
  v_zone_id := NULLIF(p_args->>'zone_id', '')::uuid;
  v_district_id := NULLIF(p_args->>'canonical_district_id', '')::uuid;

  IF v_zone_district_id IS NULL AND (v_zone_id IS NULL OR v_district_id IS NULL) THEN
    RAISE EXCEPTION 'zone_district_remove_v1 requires zone_district_id OR (zone_id + canonical_district_id)' USING ERRCODE = '23502';
  END IF;

  IF v_zone_district_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.zone_districts WHERE id = v_zone_district_id;
  ELSE
    SELECT * INTO v_existing FROM public.zone_districts
     WHERE zone_id = v_zone_id AND canonical_district_id = v_district_id;
  END IF;

  IF v_existing.id IS NULL THEN
    -- Idempotent: already removed; we still log a decision
    v_already := TRUE;
    v_zone_district_id := COALESCE(v_zone_district_id, v_existing.id);

    -- Surface organization_id if zone is known via input zone_id; else NULL
    SELECT * INTO v_zone FROM public.zones WHERE id = v_zone_id;

    PERFORM public.assert_capability_v1(
      'zones.write',
      'tenant',
      COALESCE(v_zone.organization_id, public.current_user_org_id())
    );
  ELSE
    SELECT * INTO v_zone FROM public.zones WHERE id = v_existing.zone_id;
    IF v_zone.id IS NULL THEN
      RAISE EXCEPTION 'zone_district_remove_v1 zone % not found', v_existing.zone_id USING ERRCODE = '23503';
    END IF;

    PERFORM public.assert_capability_v1('zones.write', 'tenant', v_zone.organization_id);

    IF NOT public.is_platform_user() AND v_zone.organization_id <> public.current_user_org_id() THEN
      RAISE EXCEPTION 'zone_district_remove_v1 zone % outside tenant scope', v_existing.zone_id USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.zone_districts WHERE id = v_existing.id;
    v_zone_district_id := v_existing.id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_zone.organization_id, 'zone_district.removed', 'zone_district', v_existing.id, v_correlation_id,
      jsonb_build_object(
        'zone_id', v_existing.zone_id,
        'canonical_district_id', v_existing.canonical_district_id
      ),
      'pending'
    );
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := COALESCE(v_zone.organization_id, public.current_user_org_id()),
    p_decision_category := 'zones.district_remove',
    p_resource_type := 'zone_district',
    p_resource_id := v_zone_district_id,
    p_decision_point := 'zone_district_remove_v1',
    p_decision_outcome := CASE WHEN v_already THEN 'already_removed' ELSE 'removed' END,
    p_performed_by_system := 'zone_district_remove_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'zone_district_id', v_zone_district_id,
      'zone_id', COALESCE(v_existing.zone_id, v_zone_id),
      'canonical_district_id', COALESCE(v_existing.canonical_district_id, v_district_id)
    ))
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

REVOKE ALL ON FUNCTION public.zone_district_remove_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zone_district_remove_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.zone_district_remove_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: delete zone_districts mapping + decision_log + domain_event. Capability: zones.write. Idempotent (already_removed when row absent).';

SELECT pg_advisory_unlock(hashtext('202604300460_zone_district_remove_v1'));
COMMIT;
