BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261122044001_ui_dashboard_metrics_v1'));

CREATE FUNCTION public.ui_dashboard_metrics_v1(p_resources TEXT[] DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $dashboard$
BEGIN
  IF COALESCE(cardinality(p_resources), 0) > 32 THEN
    RAISE EXCEPTION 'Too many dashboard resources in a single request' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('metrics', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'resource', btrim(resource.key),
        -- A nonempty list with no matching column skips numeric aggregates.
        'total', public.ui_resource_metrics_v1(btrim(resource.key), '{}'::jsonb, ARRAY[NULL]::text[])->'total'
      )
      ORDER BY resource.ordinal
    )
    FROM unnest(p_resources) WITH ORDINALITY AS resource(key, ordinal)
    WHERE NULLIF(btrim(resource.key), '') IS NOT NULL
  ), '[]'::jsonb));
END;
$dashboard$;

CREATE FUNCTION api.ui_dashboard_metrics_v1(p_resources TEXT[] DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $dashboard$
  SELECT public.ui_dashboard_metrics_v1(p_resources);
$dashboard$;

REVOKE ALL ON FUNCTION public.ui_dashboard_metrics_v1(TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_dashboard_metrics_v1(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_dashboard_metrics_v1(TEXT[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_dashboard_metrics_v1(TEXT[]) TO authenticated, service_role;
COMMIT;
