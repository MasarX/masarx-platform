-- Plan: PLAN-202602-landing-last-mile-content-optimization / Step: S04
-- Migration: Marketing landing clients feed v1
-- Purpose:
--   - Keep landing "trusted clients" dynamic from production SSOT tables (no hardcoded list).
--   - Use row-driven client settings_override keys for public display + optional logo.
--   - Expose a least-privilege RPC for edge delivery to landing.

BEGIN;
SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Category registry metadata (SSOT)
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
  'marketing_landing_clients_policy',
  'Public landing clients feed policy (row-driven visibility + fallback behavior).',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global"]'::jsonb
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

-- ---------------------------------------------------------------------------
-- 2) Schema registry contract
-- ---------------------------------------------------------------------------
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'marketing_landing_clients_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'max_items', jsonb_build_object('type', 'integer', 'minimum', 1),
      'require_public_flag', jsonb_build_object('type', 'boolean'),
      'fallback_when_empty', jsonb_build_object('type', 'boolean'),
      'fallback_max_items', jsonb_build_object('type', 'integer', 'minimum', 1)
    )
  ),
  'Row-driven controls for marketing landing client references sourced from public.clients.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'max_items', 6,
      'require_public_flag', FALSE,
      'fallback_when_empty', TRUE,
      'fallback_max_items', 3
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) Landing clients feed RPC (least privilege)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marketing_landing_clients_list_v1(
  p_locale TEXT DEFAULT NULL
)
RETURNS TABLE (
  client_id UUID,
  display_name TEXT,
  logo_url TEXT,
  sort_order INT,
  source TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_max_items INT;
  v_require_public_flag BOOLEAN;
  v_fallback_when_empty BOOLEAN;
  v_fallback_max_items INT;
BEGIN
  -- Resolve row-driven policy from canonical settings ladder (global for landing feed).
  v_policy := public.resolve_settings_merged('marketing_landing_clients_policy', 'global', NULL::uuid);
  v_enabled := COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, TRUE);
  IF NOT v_enabled THEN
    RETURN;
  END IF;

  v_max_items := GREATEST(COALESCE(NULLIF(v_policy->>'max_items', '')::INT, 6), 1);
  v_require_public_flag := COALESCE(NULLIF(v_policy->>'require_public_flag', '')::BOOLEAN, FALSE);
  v_fallback_when_empty := COALESCE(NULLIF(v_policy->>'fallback_when_empty', '')::BOOLEAN, TRUE);
  v_fallback_max_items := GREATEST(COALESCE(NULLIF(v_policy->>'fallback_max_items', '')::INT, 3), 1);

  RETURN QUERY
  WITH configured AS (
    SELECT
      c.id AS client_id,
      COALESCE(NULLIF(BTRIM(c.settings_override->>'public_display_name'), ''), c.name) AS display_name,
      NULLIF(BTRIM(c.settings_override->>'public_logo_url'), '') AS logo_url,
      CASE
        WHEN COALESCE(c.settings_override->>'public_sort_order', '') ~ '^-?[0-9]+$'
          THEN (c.settings_override->>'public_sort_order')::INT
        ELSE 1000
      END AS sort_order
    FROM public.clients c
    WHERE c.status = 'active'
      AND (
        NOT v_require_public_flag
        OR CASE
             WHEN LOWER(COALESCE(c.settings_override->>'is_public_reference', '')) IN ('true', 'false')
               THEN (c.settings_override->>'is_public_reference')::BOOLEAN
             ELSE FALSE
           END
      )
    ORDER BY sort_order, c.updated_at DESC, c.name
    LIMIT v_max_items
  )
  SELECT
    configured.client_id,
    configured.display_name,
    configured.logo_url,
    configured.sort_order,
    'configured'::TEXT AS source
  FROM configured;

  IF NOT FOUND AND v_fallback_when_empty THEN
    RETURN QUERY
    SELECT
      c.id AS client_id,
      c.name AS display_name,
      NULLIF(BTRIM(c.settings_override->>'public_logo_url'), '') AS logo_url,
      2000 + ROW_NUMBER() OVER (ORDER BY c.updated_at DESC, c.name) AS sort_order,
      'fallback'::TEXT AS source
    FROM public.clients c
    WHERE c.status = 'active'
    ORDER BY c.updated_at DESC, c.name
    LIMIT LEAST(v_fallback_max_items, v_max_items);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.marketing_landing_clients_list_v1(TEXT)
  IS 'Returns marketing-safe client references from public.clients using settings_override keys (display/logo/sort/public flag).';

REVOKE EXECUTE ON FUNCTION public.marketing_landing_clients_list_v1(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.marketing_landing_clients_list_v1(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.marketing_landing_clients_list_v1(TEXT) FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT EXECUTE ON FUNCTION public.marketing_landing_clients_list_v1(TEXT)
      TO edge_api_gateway_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) api schema wrapper (PostgREST contract)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.marketing_landing_clients_list_v1(
  p_locale TEXT DEFAULT NULL
)
RETURNS TABLE (
  client_id UUID,
  display_name TEXT,
  logo_url TEXT,
  sort_order INT,
  source TEXT
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT * FROM public.marketing_landing_clients_list_v1(p_locale);
$$;

REVOKE ALL ON FUNCTION api.marketing_landing_clients_list_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.marketing_landing_clients_list_v1(TEXT) FROM anon;
REVOKE ALL ON FUNCTION api.marketing_landing_clients_list_v1(TEXT) FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.marketing_landing_clients_list_v1(TEXT)
      TO edge_api_gateway_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Seed global default (idempotent)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_existing RECORD;
  v_value JSONB;
  v_sv_id UUID := gen_random_uuid();
BEGIN
  SELECT *
    INTO v_existing
    FROM public.settings
   WHERE category = 'marketing_landing_clients_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT (examples->0)
    INTO v_value
    FROM public.schema_registry
   WHERE category = 'marketing_landing_clients_policy'
     AND version = 1
   LIMIT 1;

  v_value := COALESCE(v_value, jsonb_build_object('version', 1, 'enabled', TRUE));

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    'marketing_landing_clients_policy',
    'global',
    NULL::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    v_value,
    1,
    'seed marketing_landing_clients_policy global default',
    now(),
    now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
  ) VALUES (
    'marketing_landing_clients_policy',
    'global',
    NULL::uuid,
    v_sv_id,
    v_value,
    now()
  )
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();
END;
$$;

COMMIT;

