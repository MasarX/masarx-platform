-- Date: 2026-06-08
--
-- FieldOps Mobile V2 task cards must surface the canonical pickup client
-- reference. Pickup request creation persists that reference on shipments;
-- the task resolver should project it directly instead of showing only the
-- internal tracking number.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606081430_fieldops_mobile_v2_pickup_task_reference_projection_v1'));
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
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 is required before pickup reference projection patch'
      USING ERRCODE = '42883';
  END IF;

  IF position('display_reference' IN v_definition) > 0
     AND position('client_reference_number' IN v_definition) > 0 THEN
    v_updated := v_definition;
  ELSE
    v_updated := replace(
      v_definition,
      'COALESCE(s.tracking_number, ''STOP-'' || substr(rs.id::text, 1, 6)) AS title,',
      'CASE
        WHEN lower(COALESCE(rs.stop_kind, '''')) = ''pickup''
        THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''''), NULLIF(btrim(s.tracking_number), ''''), ''STOP-'' || substr(rs.id::text, 1, 6))
        ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''''), NULLIF(btrim(s.client_reference_number), ''''), ''STOP-'' || substr(rs.id::text, 1, 6))
      END AS title,'
    );

    v_updated := replace(
      v_updated,
      '        ''shipment_status'', s.status,',
      '        ''shipment_status'', s.status,
        ''client_reference_number'', NULLIF(btrim(s.client_reference_number), ''''),
        ''tracking_number'', NULLIF(btrim(s.tracking_number), ''''),
        ''display_reference'', CASE
          WHEN lower(COALESCE(rs.stop_kind, '''')) = ''pickup''
          THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''''), NULLIF(btrim(s.tracking_number), ''''))
          ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''''), NULLIF(btrim(s.client_reference_number), ''''))
        END,'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'resolve_fieldops_tasks_v1 pickup reference projection markers not found'
        USING ERRCODE = '42883';
    END IF;
  END IF;

  EXECUTE v_updated;
END $$;

COMMENT ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) IS
  'FieldOps Mobile V2 task resolver with route-map geocode projection and pickup client-reference display projection.';

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

SELECT pg_advisory_unlock(hashtext('202606081430_fieldops_mobile_v2_pickup_task_reference_projection_v1'));
COMMIT;
