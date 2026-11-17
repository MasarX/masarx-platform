-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S04
-- Migration: Address versioning (SSOT history) + policy-driven effective projection + decision logging
-- Purpose:
--   - Introduce public.address_versions (append-only) as SSOT history for address changes.
--   - Keep public.addresses as backward-compatible projection, derived via address_resolution_policy.
--   - Log each effective resolution to decision_log with settings ladder provenance (settings_resolution_log).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | workflow/row-driven | SSOT | RLS enforced
-- Date: 2026-01-06

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 0) Settings category + schema + global default (address_resolution_policy)
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'address_resolution_policy',
  'Policy-driven selection of latest effective address fields from address_versions (append-only).',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'address_resolution_policy'
      AND version = 1
  ) THEN
    INSERT INTO public.schema_registry (
      category,
      version,
      schema,
      description,
      examples,
      is_active
    )
    VALUES (
      'address_resolution_policy',
      1,
      jsonb_build_object(
        '$schema', 'http://json-schema.org/draft-07/schema#',
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'version', jsonb_build_object('type', 'integer', 'minimum', 1),
          'fields', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object(
              'type', 'object',
              'additionalProperties', TRUE,
              'required', jsonb_build_array('name'),
              'properties', jsonb_build_object(
                'name', jsonb_build_object('type', 'string'),
                'sources', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
                'fallback', jsonb_build_object('type', 'string')
              )
            )
          )
        )
      ),
      'Address field resolution policy: per-field preferred source order for effective projection.',
      jsonb_build_array(
        jsonb_build_object(
          'version', 1,
          'fields', jsonb_build_array(
            jsonb_build_object('name','normalized_line1','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','normalized_line2','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','district','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','city','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','province','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','postal_code','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','country','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','sa_short_code','sources',jsonb_build_array('short_code_extract','short_code_registry','user_input','legacy'),'fallback','latest_non_empty'),
            jsonb_build_object('name','coordinates','sources',jsonb_build_array('short_code_registry','here_reverse','provider_reverse','legacy'),'fallback','latest_non_empty')
          )
        )
      ),
      TRUE
    );
  END IF;
END $$;

WITH payload AS (
  SELECT
    'address_resolution_policy'::text AS category,
    jsonb_build_object(
      'version', 1,
      'fields', jsonb_build_array(
        jsonb_build_object('name','normalized_line1','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','normalized_line2','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','line1','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','line2','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','district','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','city','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','province','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','postal_code','sources',jsonb_build_array('short_code_reverse','here_reverse','ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','country','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','building_number','sources',jsonb_build_array('ai_extract','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','additional_directions','sources',jsonb_build_array('user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','sa_short_code','sources',jsonb_build_array('short_code_extract','short_code_registry','user_input','legacy'),'fallback','latest_non_empty'),
        jsonb_build_object('name','coordinates','sources',jsonb_build_array('short_code_registry','here_reverse','provider_reverse','legacy'),'fallback','latest_non_empty')
      )
    ) AS body
), ins AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, approved_at)
  SELECT p.category, 'global', NULL::uuid, 1, p.body, now()
  FROM payload p
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = p.category
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, category, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT i.category, 'global', NULL::uuid, i.id, i.value, now()
FROM ins i
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = i.category
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
);

-- ---------------------------------------------------------------------------
-- 1) SSOT history table: public.address_versions (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.address_versions (
  id UUID DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  address_id UUID NOT NULL,
  source_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID,
  created_by_system TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, client_id)
) PARTITION BY HASH (client_id);

CREATE TABLE IF NOT EXISTS public.address_versions_p0
  PARTITION OF public.address_versions
  FOR VALUES WITH (MODULUS 1, REMAINDER 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'address_versions_address_fk'
      AND conrelid = 'public.address_versions'::regclass
  ) THEN
    ALTER TABLE public.address_versions
      ADD CONSTRAINT address_versions_address_fk
      FOREIGN KEY (address_id, client_id)
      REFERENCES public.addresses (id, client_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_address_versions_address_created
  ON public.address_versions (address_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_address_versions_source_created
  ON public.address_versions (source_type, created_at DESC);

COMMENT ON TABLE public.address_versions IS 'Append-only SSOT history of address changes used for policy-driven effective resolution.';
COMMENT ON COLUMN public.address_versions.payload IS 'Sparse JSON payload of address fields set by this version (policy-driven merge).';

-- ---------------------------------------------------------------------------
-- 2) RLS: mirror user-facing address access; write restricted to tenant/platform
-- ---------------------------------------------------------------------------
ALTER TABLE public.address_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.address_versions_p0 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.address_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.address_versions FROM anon;
REVOKE ALL ON TABLE public.address_versions FROM authenticated;

GRANT SELECT, INSERT ON TABLE public.address_versions TO authenticated;

REVOKE ALL ON TABLE public.address_versions_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.address_versions_p0 FROM anon;
REVOKE ALL ON TABLE public.address_versions_p0 FROM authenticated;

GRANT ALL ON TABLE public.address_versions_p0 TO service_role;

DROP POLICY IF EXISTS address_versions_p0_service_policy ON public.address_versions_p0;
CREATE POLICY address_versions_p0_service_policy ON public.address_versions_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS address_versions_select ON public.address_versions;
DROP POLICY IF EXISTS address_versions_insert ON public.address_versions;

CREATE POLICY address_versions_select ON public.address_versions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.shipments s
        WHERE s.sender_id = public.current_user_sender_id()
          AND s.client_id = address_versions.client_id
          AND (
            s.origin_address_id = address_versions.address_id
            OR s.destination_address_id = address_versions.address_id
          )
        LIMIT 1
      )
    )
  );

CREATE POLICY address_versions_insert ON public.address_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- Append-only immutability (block UPDATE/DELETE for all roles)
CREATE OR REPLACE FUNCTION public.address_versions_immutable_trg_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'address_versions is append-only (immutable); use a new version row instead'
    USING ERRCODE = '2F003';
END;
$$;

DROP TRIGGER IF EXISTS address_versions_immutable_trg_v1 ON public.address_versions;
CREATE TRIGGER address_versions_immutable_trg_v1
BEFORE UPDATE OR DELETE ON public.address_versions
FOR EACH ROW
EXECUTE FUNCTION public.address_versions_immutable_trg_v1();

-- ---------------------------------------------------------------------------
-- 3) Resolver: compute latest effective fields per policy (row-driven)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_address_effective_v1(
  p_address_id UUID,
  p_client_id UUID,
  p_scope_type TEXT DEFAULT 'client',
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_id UUID := COALESCE(p_scope_id, p_client_id);
  v_policy_row RECORD;
  v_policy JSONB;
  v_fields JSONB;
  v_field JSONB;
  v_name TEXT;
  v_sources JSONB;
  v_fallback TEXT;
  v_effective JSONB := '{}'::jsonb;
  v_provenance JSONB := '{}'::jsonb;
  v_candidate_id UUID;
  v_candidate_source_type TEXT;
  v_candidate_created_at TIMESTAMPTZ;
  v_candidate_payload JSONB;
  v_source TEXT;
BEGIN
  IF p_address_id IS NULL OR p_client_id IS NULL THEN
    RETURN jsonb_build_object('effective', '{}'::jsonb, 'provenance', '{}'::jsonb);
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('address_resolution_policy', p_scope_type, v_scope_id)
    LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'Missing address_resolution_policy for scope_type=% scope_id=%', p_scope_type, v_scope_id USING ERRCODE = '23514';
  END IF;

  v_policy := v_policy_row.value;
  v_fields := COALESCE(v_policy->'fields', '[]'::jsonb);

  FOR v_field IN SELECT * FROM jsonb_array_elements(v_fields)
  LOOP
    v_name := NULLIF(v_field->>'name', '');
    v_sources := COALESCE(v_field->'sources', '[]'::jsonb);
    v_fallback := COALESCE(NULLIF(v_field->>'fallback', ''), 'latest_non_empty');

    IF v_name IS NULL THEN
      CONTINUE;
    END IF;

    v_candidate_id := NULL;
    v_candidate_source_type := NULL;
    v_candidate_created_at := NULL;
    v_candidate_payload := NULL;

    -- Preferred per-source search
    FOR v_source IN
      SELECT jsonb_array_elements_text(v_sources)
    LOOP
      SELECT av.id, av.source_type, av.created_at, av.payload
        INTO v_candidate_id, v_candidate_source_type, v_candidate_created_at, v_candidate_payload
        FROM public.address_versions av
       WHERE av.client_id = p_client_id
         AND av.address_id = p_address_id
         AND av.source_type = v_source
         AND (av.payload ? v_name)
         AND (
           (jsonb_typeof(av.payload->v_name) <> 'string')
           OR NULLIF(av.payload->>v_name, '') IS NOT NULL
         )
       ORDER BY av.created_at DESC, av.id DESC
       LIMIT 1;

      EXIT WHEN FOUND;
    END LOOP;

    -- Fallback search across any source
    IF v_candidate_id IS NULL AND v_fallback = 'latest_non_empty' THEN
      SELECT av.id, av.source_type, av.created_at, av.payload
        INTO v_candidate_id, v_candidate_source_type, v_candidate_created_at, v_candidate_payload
        FROM public.address_versions av
       WHERE av.client_id = p_client_id
         AND av.address_id = p_address_id
         AND (av.payload ? v_name)
         AND (
           (jsonb_typeof(av.payload->v_name) <> 'string')
           OR NULLIF(av.payload->>v_name, '') IS NOT NULL
         )
       ORDER BY av.created_at DESC, av.id DESC
       LIMIT 1;
    END IF;

    IF v_candidate_id IS NOT NULL THEN
      v_effective := jsonb_set(v_effective, ARRAY[v_name], v_candidate_payload->v_name, TRUE);
      v_provenance := jsonb_set(
        v_provenance,
        ARRAY[v_name],
        jsonb_strip_nulls(jsonb_build_object(
          'version_id', v_candidate_id,
          'source_type', v_candidate_source_type,
          'created_at', v_candidate_created_at
        )),
        TRUE
      );
    END IF;
  END LOOP;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'effective', v_effective,
      'provenance', v_provenance,
      'policy', jsonb_build_object(
        'category', 'address_resolution_policy',
        'settings_id', v_policy_row.settings_id,
        'settings_version_id', v_policy_row.settings_version_id,
        'scope_type', v_policy_row.scope_type,
        'scope_id', v_policy_row.scope_id,
        'version', v_policy_row.version,
        'scope_path', v_policy_row.scope_path
      )
    )
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_address_effective_v1(UUID, UUID, TEXT, UUID)
  IS 'Resolve latest effective address field values by applying address_resolution_policy across address_versions.';

-- ---------------------------------------------------------------------------
-- 3b) Canonical write path: append patch version + project + log
-- ---------------------------------------------------------------------------
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
    now()
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

COMMENT ON FUNCTION public.apply_address_patch_v1(UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT, UUID)
  IS 'Append a new address_versions row (patch), then re-project addresses effective fields per address_resolution_policy with provenance logging.';

-- ---------------------------------------------------------------------------
-- 4) Trigger: append version on addresses writes; project effective + log decision
-- ---------------------------------------------------------------------------
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
    now()
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

DROP TRIGGER IF EXISTS address_versioning_trg_v1 ON public.addresses;
CREATE TRIGGER address_versioning_trg_v1
AFTER INSERT OR UPDATE ON public.addresses
FOR EACH ROW
EXECUTE FUNCTION public.address_versioning_trg_v1();

COMMIT;
