-- Migration: FieldOps Mobile V2 completed-route same-context readback.
-- Date: 2026-05-26
--
-- A single-stop route can become completed as part of POD closeout. Mobile V2
-- must still read the just-mutated row back in the same task/route context, so
-- the driver task resolver keeps completed route_runs visible while continuing
-- to hide cancelled/closed runs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605261735_fieldops_mobile_v2_completed_route_readback_v1'));
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
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 is required before completed-route readback patch'
      USING ERRCODE = '42883';
  END IF;

  IF position('rr.status = ''completed''' IN v_definition) > 0
     AND position('12 hours' IN v_definition) > 0 THEN
    v_updated := v_definition;
  ELSE
    v_updated := replace(
      v_definition,
      'AND rr.status NOT IN (''completed'', ''cancelled'', ''closed'')',
      'AND (
        rr.status NOT IN (''completed'', ''cancelled'', ''closed'')
        OR (
          rr.status = ''completed''
          AND lower(COALESCE(NULLIF(btrim(rs.metadata->>''status''), ''''), ''pending'')) IN (''done'', ''failed'', ''partial'')
          AND COALESCE(rr.updated_at, rr.ended_at, rr.created_at) >= v_now - INTERVAL ''12 hours''
        )
      )'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'resolve_fieldops_tasks_v1 completed-route marker not found'
        USING ERRCODE = '42883';
    END IF;
  END IF;

  EXECUTE v_updated;
END $$;

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

SELECT pg_advisory_unlock(hashtext('202605261735_fieldops_mobile_v2_completed_route_readback_v1'));
COMMIT;
