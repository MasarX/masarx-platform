BEGIN;
SELECT pg_advisory_lock(hashtext('202601051630_ui_get_trace_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_get_trace_v1(
  p_correlation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_org_id UUID := public.current_user_org_id();
  v_events JSONB := '[]'::jsonb;
  v_domain_events JSONB := '[]'::jsonb;
  v_workflow_runs JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_trace_v1 requires authenticated user';
  END IF;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_trace_v1 requires correlation_id';
  END IF;

  PERFORM public.assert_capability_v1('audit_log.read', v_scope_type, v_scope_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.event_time DESC), '[]'::jsonb)
    INTO v_events
    FROM public.observability_events_v e
    WHERE e.correlation_id = p_correlation_id
      AND (
        public.is_platform_user()
        OR e.organization_id = v_org_id
      );

  SELECT COALESCE(jsonb_agg(to_jsonb(de) ORDER BY de.created_at DESC), '[]'::jsonb)
    INTO v_domain_events
    FROM public.domain_events de
    WHERE de.correlation_id = p_correlation_id
      AND (
        public.is_platform_user()
        OR de.organization_id = v_org_id
      );

  SELECT COALESCE(jsonb_agg(to_jsonb(wr) ORDER BY wr.created_at DESC), '[]'::jsonb)
    INTO v_workflow_runs
    FROM public.workflow_runs wr
    WHERE wr.triggered_by_request_id = p_correlation_id;

  RETURN jsonb_build_object(
    'correlation_id', p_correlation_id,
    'observability_events', v_events,
    'domain_events', v_domain_events,
    'workflow_runs', v_workflow_runs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_get_trace_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_trace_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601051630_ui_get_trace_v1'));
COMMIT;
