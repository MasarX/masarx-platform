-- Spec-Issue: NETWORK W9 — close residual gaps on branches/zones canonical write RPCs
-- Step: W9-S05
-- Migration: zone_create_v1
-- Capability: zones.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: insert public.zones row + decision_log + domain_event,
--   optionally seeding initial zone_districts links. Replaces the FE phaseC6Rpc shim path.
--
-- Args (jsonb):
--   { name (text, required), slug (text, optional auto from name),
--     description (text, optional), sort_order (int, optional),
--     initial_district_ids (uuid[], optional),
--     metadata (jsonb, optional),
--     organization_id (uuid, optional — defaults to caller org) }
-- Envelope: { ok, zone_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300440_zone_create_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.zone_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org UUID := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_caller_org_id);
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_zone_id UUID;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_slug TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'slug', '')), ''));
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_sort_order INT := NULLIF(p_args->>'sort_order', '')::int;
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_initial_districts JSONB := p_args->'initial_district_ids';
  v_district_id UUID;
  v_district_links_added INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'zone_create_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_target_org);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'zone_create_v1 requires name' USING ERRCODE = '23502';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'zone_create_v1 requires organization_id (caller has no scope)' USING ERRCODE = '23502';
  END IF;

  -- Tenant guard
  IF v_caller_org_id IS NOT NULL
     AND v_target_org <> v_caller_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'zone_create_v1 organization % outside tenant scope', v_target_org USING ERRCODE = '42501';
  END IF;

  -- Auto-derive slug if absent
  IF v_slug IS NULL THEN
    v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
    v_slug := regexp_replace(v_slug, '(^-|-$)', '', 'g');
    IF v_slug IS NULL OR v_slug = '' THEN
      v_slug := 'zone';
    END IF;
    -- Ensure uniqueness within org
    WHILE EXISTS (SELECT 1 FROM public.zones z WHERE z.organization_id = v_target_org AND z.slug = v_slug) LOOP
      v_slug := v_slug || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
    END LOOP;
  END IF;

  INSERT INTO public.zones (
    organization_id, name, slug, description, sort_order, metadata
  ) VALUES (
    v_target_org, v_name, v_slug, v_description, v_sort_order, v_metadata
  ) RETURNING id INTO v_zone_id;

  -- Optional initial district mapping (org-match trigger guards correctness)
  IF jsonb_typeof(v_initial_districts) = 'array' THEN
    FOR v_district_id IN
      SELECT (jsonb_array_elements_text(v_initial_districts))::uuid
    LOOP
      BEGIN
        INSERT INTO public.zone_districts (zone_id, canonical_district_id)
        VALUES (v_zone_id, v_district_id);
        v_district_links_added := v_district_links_added + 1;
      EXCEPTION
        WHEN unique_violation THEN
          -- District already mapped to another zone: surface the failure rather than silently swallowing
          RAISE EXCEPTION 'zone_create_v1: canonical_district % already assigned to a zone', v_district_id
            USING ERRCODE = '23505';
      END;
    END LOOP;
  END IF;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_target_org, 'zone.created', 'zone', v_zone_id, v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'zone_id', v_zone_id,
      'organization_id', v_target_org,
      'name', v_name,
      'slug', v_slug,
      'description', v_description,
      'initial_district_count', to_jsonb(v_district_links_added)
    )),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'zones.create',
    p_resource_type := 'zone',
    p_resource_id := v_zone_id,
    p_decision_point := 'zone_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'zone_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'description', v_description,
      'sort_order', to_jsonb(v_sort_order),
      'initial_district_count', to_jsonb(v_district_links_added)
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_id', v_zone_id,
    'initial_district_count', v_district_links_added,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.zone_create_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zone_create_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.zone_create_v1(JSONB) IS
  'NETWORK W9 canonical write RPC: insert public.zones row (with optional initial district mapping) + decision_log + domain_event. Capability: zones.write.';

SELECT pg_advisory_unlock(hashtext('202604300440_zone_create_v1'));
COMMIT;
