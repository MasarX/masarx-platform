-- Plan: PLAN-202601-plans-backlog-auto-archive / Step: S02
-- Migration: Address versions created_at uses clock_timestamp()
-- Purpose:
--   - Ensure address_versions ordering is deterministic within long transactions.
--   - Fix workflows/tests where multiple address versions are appended in a single transaction
--     (e.g. insert address then hydrate via geocoding cache_write).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-25

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Use wall-clock time so multiple inserts in one transaction get distinct timestamps,
-- keeping resolve_address_effective_v1 (ORDER BY created_at DESC, id DESC) deterministic.
ALTER TABLE public.address_versions
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

ALTER TABLE public.address_versions_p0
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION public.address_versioning_trg_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_skip TEXT := current_setting('app.address_versioning_skip', true);
  v_source TEXT := NULLIF(current_setting('app.address_version_source', true), '');
  v_system TEXT := NULLIF(current_setting('app.worker_name', true), '');
  v_payload JSONB;
  v_res JSONB;
  v_eff JSONB;
  v_policy JSONB;
  v_settings_res_id UUID;
  v_org UUID;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN
    RETURN NEW;
  END IF;

  IF v_skip = '1' OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  v_source := COALESCE(v_source, 'legacy');
  v_system := COALESCE(v_system, 'address_versioning_trg_v1');
  v_org := NEW.organization_id;

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'raw_input', NULLIF(NEW.raw_input, ''),
      'normalized_line1', NULLIF(NEW.normalized_line1, ''),
      'normalized_line2', NULLIF(NEW.normalized_line2, ''),
      'line1', NULLIF(NEW.line1, ''),
      'line2', NULLIF(NEW.line2, ''),
      'district', NULLIF(NEW.district, ''),
      'city', NULLIF(NEW.city, ''),
      'province', NULLIF(NEW.province, ''),
      'postal_code', NULLIF(NEW.postal_code, ''),
      'country', NULLIF(NEW.country, ''),
      'building_number', NULLIF(NEW.building_number, ''),
      'additional_directions', NULLIF(NEW.additional_directions, ''),
      'sa_short_code', NULLIF(NEW.sa_short_code, ''),
      'coordinates', CASE
        WHEN NEW.coordinates IS NULL THEN NULL
        ELSE jsonb_build_object(
          'latitude', ST_Y(NEW.coordinates::geometry)::numeric,
          'longitude', ST_X(NEW.coordinates::geometry)::numeric
        )
      END
    )
  );

  INSERT INTO public.address_versions (
    organization_id,
    client_id,
    address_id,
    source_type,
    payload,
    created_by_user_id,
    created_by_system,
    created_at
  ) VALUES (
    NEW.organization_id,
    NEW.client_id,
    NEW.id,
    v_source,
    COALESCE(v_payload, '{}'::jsonb),
    NULL,
    v_system,
    clock_timestamp()
  );

  v_res := public.resolve_address_effective_v1(NEW.id, NEW.client_id, 'client', NEW.client_id);
  v_eff := COALESCE(v_res->'effective', '{}'::jsonb);
  v_policy := COALESCE(v_res->'policy', '{}'::jsonb);

  -- Record provenance + decision (SSOT log)
  IF v_org IS NOT NULL AND v_policy ? 'settings_id' THEN
    v_settings_res_id := public.log_settings_resolution(
      p_organization_id := v_org,
      p_category := 'address_resolution_policy',
      p_winning_scope_type := NULLIF(v_policy->>'scope_type', ''),
      p_winning_scope_id := NULLIF(v_policy->>'scope_id', '')::uuid,
      p_winning_settings_id := NULLIF(v_policy->>'settings_id', '')::uuid,
      p_winning_settings_version_id := NULLIF(v_policy->>'settings_version_id', '')::uuid,
      p_winning_version := COALESCE(NULLIF(v_policy->>'version', '')::int, 0),
      p_scope_path := COALESCE(v_policy->'scope_path', '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'address_id', NEW.id,
        'client_id', NEW.client_id,
        'source_type', v_source
      )),
      p_merge_notes := NULL
    );

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'address_resolution',
      p_resource_type := 'addresses',
      p_resource_id := NEW.id,
      p_decision_point := 'address_effective_projection',
      p_decision_outcome := 'resolved',
      p_performed_by_system := v_system,
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'effective', v_eff,
        'provenance', v_res->'provenance',
        'policy', v_policy
      )),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_settings_res_id
    );
  END IF;

  -- Projection update (skip re-versioning)
  PERFORM set_config('app.address_versioning_skip', '1', true);

  UPDATE public.addresses a
  SET
    raw_input = COALESCE(NULLIF(v_eff->>'raw_input', ''), a.raw_input),
    normalized_line1 = COALESCE(NULLIF(v_eff->>'normalized_line1', ''), a.normalized_line1),
    normalized_line2 = COALESCE(NULLIF(v_eff->>'normalized_line2', ''), a.normalized_line2),
    line1 = COALESCE(NULLIF(v_eff->>'line1', ''), a.line1),
    line2 = COALESCE(NULLIF(v_eff->>'line2', ''), a.line2),
    district = COALESCE(NULLIF(v_eff->>'district', ''), a.district),
    city = COALESCE(NULLIF(v_eff->>'city', ''), a.city),
    province = COALESCE(NULLIF(v_eff->>'province', ''), a.province),
    postal_code = COALESCE(NULLIF(v_eff->>'postal_code', ''), a.postal_code),
    country = COALESCE(NULLIF(v_eff->>'country', ''), a.country),
    building_number = COALESCE(NULLIF(v_eff->>'building_number', ''), a.building_number),
    additional_directions = COALESCE(NULLIF(v_eff->>'additional_directions', ''), a.additional_directions),
    sa_short_code = COALESCE(NULLIF(v_eff->>'sa_short_code', ''), a.sa_short_code),
    coordinates = CASE
      WHEN (v_eff ? 'coordinates') AND jsonb_typeof(v_eff->'coordinates') = 'object'
        AND NULLIF(v_eff->'coordinates'->>'longitude', '') IS NOT NULL
        AND NULLIF(v_eff->'coordinates'->>'latitude', '') IS NOT NULL
      THEN ST_SetSRID(
        ST_MakePoint(
          (v_eff->'coordinates'->>'longitude')::numeric,
          (v_eff->'coordinates'->>'latitude')::numeric
        ),
        4326
      )::geography
      ELSE a.coordinates
    END,
    updated_at = now()
  WHERE a.id = NEW.id
    AND a.client_id = NEW.client_id;

  -- Reset within the same transaction so other address updates still version.
  PERFORM set_config('app.address_versioning_skip', '0', true);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_address_patch_v1(
  p_address_id UUID,
  p_client_id UUID,
  p_organization_id UUID,
  p_source_type TEXT,
  p_patch JSONB,
  p_performed_by_system TEXT DEFAULT NULL,
  p_scope_type TEXT DEFAULT 'client',
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_system TEXT := COALESCE(NULLIF(p_performed_by_system, ''), NULLIF(current_setting('app.worker_name', true), ''), 'apply_address_patch_v1');
  v_source TEXT := COALESCE(NULLIF(p_source_type, ''), 'legacy');
  v_patch JSONB := COALESCE(p_patch, '{}'::jsonb);
  v_scope_id UUID := COALESCE(p_scope_id, p_client_id);
  v_res JSONB;
  v_eff JSONB;
  v_policy JSONB;
  v_settings_res_id UUID;
BEGIN
  IF p_address_id IS NULL OR p_client_id IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'apply_address_patch_v1 requires address_id, client_id, organization_id' USING ERRCODE = '23502';
  END IF;

  PERFORM 1
  FROM public.addresses a
  WHERE a.id = p_address_id
    AND a.client_id = p_client_id
    AND a.organization_id = p_organization_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not found for id=% client_id=% org=%', p_address_id, p_client_id, p_organization_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.address_versions (
    organization_id,
    client_id,
    address_id,
    source_type,
    payload,
    created_by_user_id,
    created_by_system,
    created_at
  ) VALUES (
    p_organization_id,
    p_client_id,
    p_address_id,
    v_source,
    jsonb_strip_nulls(v_patch),
    NULL,
    v_system,
    clock_timestamp()
  );

  v_res := public.resolve_address_effective_v1(p_address_id, p_client_id, p_scope_type, v_scope_id);
  v_eff := COALESCE(v_res->'effective', '{}'::jsonb);
  v_policy := COALESCE(v_res->'policy', '{}'::jsonb);

  IF v_policy ? 'settings_id' THEN
    v_settings_res_id := public.log_settings_resolution(
      p_organization_id := p_organization_id,
      p_category := 'address_resolution_policy',
      p_winning_scope_type := NULLIF(v_policy->>'scope_type', ''),
      p_winning_scope_id := NULLIF(v_policy->>'scope_id', '')::uuid,
      p_winning_settings_id := NULLIF(v_policy->>'settings_id', '')::uuid,
      p_winning_settings_version_id := NULLIF(v_policy->>'settings_version_id', '')::uuid,
      p_winning_version := COALESCE(NULLIF(v_policy->>'version', '')::int, 0),
      p_scope_path := COALESCE(v_policy->'scope_path', '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'address_id', p_address_id,
        'client_id', p_client_id,
        'source_type', v_source,
        'patch', v_patch
      )),
      p_merge_notes := NULL
    );

    PERFORM public.log_decision(
      p_organization_id := p_organization_id,
      p_decision_category := 'address_resolution',
      p_resource_type := 'addresses',
      p_resource_id := p_address_id,
      p_decision_point := 'apply_address_patch_v1',
      p_decision_outcome := 'resolved',
      p_performed_by_system := v_system,
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'effective', v_eff,
        'provenance', v_res->'provenance',
        'policy', v_policy
      )),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_settings_res_id
    );
  END IF;

  -- Project effective back to addresses without generating an extra version row.
  PERFORM set_config('app.address_versioning_skip', '1', true);

  UPDATE public.addresses a
  SET
    raw_input = COALESCE(NULLIF(v_eff->>'raw_input', ''), a.raw_input),
    normalized_line1 = COALESCE(NULLIF(v_eff->>'normalized_line1', ''), a.normalized_line1),
    normalized_line2 = COALESCE(NULLIF(v_eff->>'normalized_line2', ''), a.normalized_line2),
    line1 = COALESCE(NULLIF(v_eff->>'line1', ''), a.line1),
    line2 = COALESCE(NULLIF(v_eff->>'line2', ''), a.line2),
    district = COALESCE(NULLIF(v_eff->>'district', ''), a.district),
    city = COALESCE(NULLIF(v_eff->>'city', ''), a.city),
    province = COALESCE(NULLIF(v_eff->>'province', ''), a.province),
    postal_code = COALESCE(NULLIF(v_eff->>'postal_code', ''), a.postal_code),
    country = COALESCE(NULLIF(v_eff->>'country', ''), a.country),
    building_number = COALESCE(NULLIF(v_eff->>'building_number', ''), a.building_number),
    additional_directions = COALESCE(NULLIF(v_eff->>'additional_directions', ''), a.additional_directions),
    sa_short_code = COALESCE(NULLIF(v_eff->>'sa_short_code', ''), a.sa_short_code),
    coordinates = CASE
      WHEN (v_eff ? 'coordinates') AND jsonb_typeof(v_eff->'coordinates') = 'object'
        AND NULLIF(v_eff->'coordinates'->>'longitude', '') IS NOT NULL
        AND NULLIF(v_eff->'coordinates'->>'latitude', '') IS NOT NULL
      THEN ST_SetSRID(
        ST_MakePoint(
          (v_eff->'coordinates'->>'longitude')::numeric,
          (v_eff->'coordinates'->>'latitude')::numeric
        ),
        4326
      )::geography
      ELSE a.coordinates
    END,
    updated_at = now()
  WHERE a.id = p_address_id
    AND a.client_id = p_client_id;

  PERFORM set_config('app.address_versioning_skip', '0', true);

  RETURN v_res;
END;
$$;

COMMENT ON FUNCTION public.address_versioning_trg_v1()
  IS 'Append a new address_versions row for each addresses write, then re-project effective fields per address_resolution_policy with provenance logging.';

COMMENT ON FUNCTION public.apply_address_patch_v1(UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT, UUID)
  IS 'Append a new address_versions row (patch), then re-project addresses effective fields per address_resolution_policy with provenance logging.';

COMMIT;

