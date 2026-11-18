-- Migration: FieldOps Mobile V2 route-map geocode projection.
-- Date: 2026-05-30
--
-- Mobile V2 route maps render from resolve_fieldops_tasks_v1. The task
-- envelope already carries route stop lineage; this patch adds canonical
-- destination address/geocode readback so the native V2 map can place stops
-- from PostGIS-backed coordinates instead of fixed UI anchors.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605300230_fieldops_mobile_v2_route_map_geocode_projection_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_definition TEXT;
  v_updated TEXT;
BEGIN
  SELECT pg_get_functiondef('public.resolve_fieldops_tasks_v1(text,jsonb)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 is required before route-map geocode projection patch'
      USING ERRCODE = '42883';
  END IF;

  IF position('destination_latitude' IN v_definition) > 0
     AND position('LEFT JOIN LATERAL (' IN v_definition) > 0 THEN
    v_updated := v_definition;
  ELSE
    v_updated := replace(
      v_definition,
      '    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rr.organization_id = v_caller_org',
      '    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    LEFT JOIN public.addresses da
      ON da.id = s.destination_address_id
     AND da.client_id = s.client_id
     AND da.organization_id = rr.organization_id
    LEFT JOIN LATERAL (
      SELECT
        g.provider_name,
        g.confidence_score,
        g.accuracy_type,
        ST_Y(g.coordinates::geometry) AS latitude,
        ST_X(g.coordinates::geometry) AS longitude,
        CASE
          WHEN jsonb_typeof(g.metadata->''accuracy_m'') = ''number''
          THEN (g.metadata->>''accuracy_m'')::NUMERIC
          WHEN jsonb_typeof(g.metadata->''accuracyM'') = ''number''
          THEN (g.metadata->>''accuracyM'')::NUMERIC
          ELSE NULL
        END AS accuracy_m,
        COALESCE(
          NULLIF(g.metadata->>''match_strategy'', ''''),
          NULLIF(g.metadata->>''match_type'', ''''),
          NULLIF(g.metadata->>''source'', '''')
        ) AS match_strategy
      FROM public.geocodes g
      WHERE g.address_id = da.id
        AND g.client_id = da.client_id
        AND g.organization_id = da.organization_id
      ORDER BY
        CASE WHEN COALESCE(g.is_primary, FALSE) THEN 0 ELSE 1 END,
        g.geocoded_at DESC NULLS LAST
      LIMIT 1
    ) geo ON TRUE
    WHERE rr.organization_id = v_caller_org'
    );

    v_updated := replace(
      v_updated,
      '        ''shipment_status'', s.status',
      '        ''shipment_status'', s.status,
        ''destination_address_id'', s.destination_address_id,
        ''address_validation_status'', da.validation_status,
        ''short_address'', NULLIF(da.sa_short_code, ''''),
        ''short_national_address'', NULLIF(da.sa_short_code, ''''),
        ''latitude'', geo.latitude,
        ''longitude'', geo.longitude,
        ''destination_latitude'', geo.latitude,
        ''destination_longitude'', geo.longitude,
        ''geocoding_status'', CASE
          WHEN da.id IS NULL THEN NULL
          WHEN geo.latitude IS NULL OR geo.longitude IS NULL THEN ''needs_review''
          ELSE ''geocoded''
        END,
        ''geocoding_accuracy'', geo.accuracy_type,
        ''geocoding_confidence'', geo.confidence_score,
        ''geocoding_accuracy_m'', geo.accuracy_m,
        ''geocoding_provider'', geo.provider_name,
        ''geocoding_match_strategy'', COALESCE(
          geo.match_strategy,
          CASE WHEN NULLIF(da.sa_short_code, '''') IS NOT NULL THEN ''sa_short_code'' ELSE NULL END
        )'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'resolve_fieldops_tasks_v1 route-map geocode projection markers not found'
        USING ERRCODE = '42883';
    END IF;
  END IF;

  EXECUTE v_updated;
END $$;

COMMENT ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) IS
  'FieldOps Mobile V2 task resolver with route-map geocode projection from destination addresses/geocodes.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_tasks_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id TEXT,
  type TEXT,
  title TEXT,
  sub TEXT,
  urgency TEXT,
  cta TEXT,
  route TEXT,
  eta_iso TIMESTAMPTZ,
  priority INT,
  area TEXT,
  code TEXT,
  action TEXT,
  tone TEXT,
  meta JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT * FROM public.resolve_fieldops_tasks_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605300230_fieldops_mobile_v2_route_map_geocode_projection_v1'));
COMMIT;
