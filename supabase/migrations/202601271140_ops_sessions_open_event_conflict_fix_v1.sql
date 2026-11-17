-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Ops sessions open event conflict fix v1
-- Date: 2026-01-27
--
-- Fix:
--   - open_ops_session_v1 open-event insert used ON CONFLICT (ops_session_id, idempotency_key)
--     which is ambiguous inside PL/pgSQL because ops_session_id is also an output column.
--   - Use ON CONFLICT DO NOTHING for the open-event insert (safe; idempotency already enforced by session row).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601271140_ops_sessions_open_event_conflict_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.open_ops_session_v1(
  p_input JSONB
)
RETURNS TABLE (
  ops_session_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);

  v_session_type TEXT := NULL;
  v_default_status TEXT := NULL;
  v_branch_id UUID := NULL;
  v_device_id UUID := NULL;
  v_session_code TEXT := NULL;
  v_idempotency TEXT := NULL;
  v_opened_at TIMESTAMPTZ := NULL;
  v_meta JSONB := '{}'::jsonb;

  v_id UUID := gen_random_uuid();
  v_existing_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve organization_id';
  END IF;

  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_in) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'open_ops_session_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_session_type := lower(NULLIF(btrim(COALESCE(v_in->>'session_type', '')), ''));
  v_idempotency := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_session_code := NULLIF(btrim(COALESCE(v_in->>'session_code', '')), '');

  BEGIN v_branch_id := NULLIF(btrim(COALESCE(v_in->>'branch_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_opened_at := NULLIF(btrim(COALESCE(v_in->>'opened_at', '')), '')::timestamptz; EXCEPTION WHEN others THEN v_opened_at := NULL; END;
  v_opened_at := COALESCE(v_opened_at, now());

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN v_meta := '{}'::jsonb; END IF;

  IF v_session_type IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires session_type' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  -- Resolve default status via lookup (dynamic; no hardcoded enum values).
  SELECT lv.value
    INTO v_default_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'ops_session_status'
     AND lv.is_default IS TRUE
   ORDER BY lv.sort_order NULLS LAST, lv.value
   LIMIT 1;

  IF v_default_status IS NULL THEN
    RAISE EXCEPTION 'open_ops_session_v1 could not resolve default ops_session_status' USING ERRCODE = '23503';
  END IF;

  -- Validate session_type via lookup (dynamic; no hardcoded enum).
  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'ops_session_type'
    AND lv.value = v_session_type
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'open_ops_session_v1 invalid session_type: %', v_session_type USING ERRCODE = '23514';
  END IF;

  -- Create session projection (idempotent by org+idempotency_key).
  INSERT INTO public.ops_sessions (
    id,
    organization_id,
    session_type,
    status,
    branch_id,
    actor_user_id,
    device_id,
    session_code,
    idempotency_key,
    opened_at,
    closed_at,
    version,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    v_org,
    v_session_type,
    v_default_status,
    v_branch_id,
    v_user,
    v_device_id,
    v_session_code,
    v_idempotency,
    v_opened_at,
    NULL,
    1,
    v_meta,
    now(),
    now()
  )
  ON CONFLICT (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
    DO NOTHING;

  IF FOUND THEN
    ops_session_id := v_id;
    created := TRUE;

    INSERT INTO public.ops_session_events (
      ops_session_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_user_id,
      actor_system,
      payload,
      idempotency_key,
      session_version,
      decision_log_id,
      settings_resolution_id,
      created_at
    )
    VALUES (
      ops_session_id,
      v_org,
      'opened',
      NULL,
      v_default_status,
      v_user,
      'open_ops_session_v1',
      jsonb_strip_nulls(jsonb_build_object(
        'session_type', v_session_type,
        'status', v_default_status,
        'branch_id', v_branch_id,
        'device_id', v_device_id,
        'session_code', v_session_code,
        'opened_at', v_opened_at
      )),
      v_idempotency,
      1,
      NULL,
      NULL,
      now()
    )
    ON CONFLICT DO NOTHING;
  ELSE
    SELECT s.id INTO v_existing_id
    FROM public.ops_sessions s
    WHERE s.organization_id = v_org
      AND s.idempotency_key = v_idempotency
    LIMIT 1;

    IF v_existing_id IS NULL THEN
      RAISE EXCEPTION 'open_ops_session_v1 idempotency replay could not find session row' USING ERRCODE = '23503';
    END IF;

    ops_session_id := v_existing_id;
    created := FALSE;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'ops',
    p_resource_type := 'ops_session',
    p_resource_id := ops_session_id,
    p_decision_point := 'open',
    p_decision_outcome := CASE WHEN created IS TRUE THEN 'created' ELSE 'replayed' END,
    p_performed_by_system := 'open_ops_session_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'session_type', v_session_type,
      'branch_id', v_branch_id,
      'device_id', v_device_id,
      'session_code', v_session_code,
      'opened_at', v_opened_at,
      'idempotency_key', v_idempotency
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.open_ops_session_v1(JSONB)
  IS 'Create an ops session (projection + open event) idempotently by org+idempotency_key. Intended for driver/warehouse/branch sessionization.';

REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_ops_session_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.open_ops_session_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601271140_ops_sessions_open_event_conflict_fix_v1'));
COMMIT;

