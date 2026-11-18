-- Migration: FieldOps Mobile V2 incident latest readback
-- Purpose: provide a backend-confirmed same-screen readback resolver after
--          submit_fieldops_incident_v1 so the Mobile V2 incident sheet does
--          not treat the write response alone as visible proof.

CREATE OR REPLACE FUNCTION public.resolve_fieldops_latest_incident_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_latest JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_latest_incident_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_latest_incident_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
           'incident_id', inc.id,
           'decision_log_id', inc.decision_log_id,
           'type_id', inc.type_id,
           'severity', inc.severity,
           'statement', inc.statement,
           'stop_id', inc.stop_id,
           'photo_storage_path', inc.photo_storage_path,
           'submitted_at', inc.created_at
         )
    INTO v_latest
    FROM public.fieldops_v2_incidents inc
   WHERE inc.organization_id = v_org
     AND inc.reported_by_user_id = v_user_id
   ORDER BY inc.created_at DESC, inc.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'active_role', COALESCE(NULLIF(btrim(p_active_role), ''), 'driver'),
    'latest_incident', v_latest
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_latest_incident_v1(TEXT, JSONB) IS
  'Mobile V2 latest incident readback for the authenticated caller. Used by the incident report sheet after submit_fieldops_incident_v1 for same-screen backend reconciliation.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_latest_incident_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_latest_incident_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_latest_incident_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_latest_incident_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_latest_incident_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_latest_incident_v1(TEXT, JSONB) TO authenticated, service_role;
