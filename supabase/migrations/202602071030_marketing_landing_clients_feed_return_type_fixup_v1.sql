-- Plan: PLAN-202602-landing-last-mile-content-optimization / Step: S99
-- Purpose:
--   - Fix return-type stability for marketing_landing_clients_list_v1 across
--     preview/prod schemas by enforcing explicit TABLE-contract casts.
--   - Prevent db-lint 42804 failures caused by bigint fallback sort_order.

BEGIN;
SET search_path TO public, extensions, pg_temp;

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
    configured.client_id::UUID,
    configured.display_name::TEXT,
    configured.logo_url::TEXT,
    configured.sort_order::INT,
    'configured'::TEXT AS source
  FROM configured;

  IF NOT FOUND AND v_fallback_when_empty THEN
    RETURN QUERY
    SELECT
      c.id::UUID AS client_id,
      c.name::TEXT AS display_name,
      NULLIF(BTRIM(c.settings_override->>'public_logo_url'), '')::TEXT AS logo_url,
      (2000 + ROW_NUMBER() OVER (ORDER BY c.updated_at DESC, c.name))::INT AS sort_order,
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

COMMIT;
