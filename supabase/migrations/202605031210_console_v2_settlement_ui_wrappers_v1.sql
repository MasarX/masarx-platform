-- Spec-Issue: Console V2 finance/governance closure
-- Step: settlement create/transition browser-safe wrappers
-- Date: 2026-05-03
--
-- Purpose:
--   Expose settlement batch create and the Console-supported settlement
--   transition actions through authenticated, capability-gated UI wrappers.
--   The service SSOT remains create_settlement_batch_v1 /
--   transition_settlement_batch_v1; these wrappers only add browser caller
--   scope, capability, and row-driven transition-action validation.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031210_console_v2_settlement_ui_wrappers_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

-- Keep settlement status metadata aligned with the frontend SSOT and with the
-- service transition guard that checks lookup_values.metadata.is_final.
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || v.metadata::jsonb,
    is_default = (lv.value = 'open'),
    updated_at = now()
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('open',     '{"lifecycle":"working","is_terminal":false,"is_final":false,"allows_approve":true,"allows_reject":true,"is_aging_eligible":false,"is_kanban_column":true,"is_stepper_stage":true}'),
    ('locked',   '{"lifecycle":"working","is_terminal":false,"is_final":false,"allows_approve":true,"allows_reject":true,"is_aging_eligible":true,"is_kanban_column":true,"is_stepper_stage":true}'),
    ('approved', '{"lifecycle":"working","is_terminal":false,"is_final":false,"allows_approve":false,"allows_reject":true,"is_aging_eligible":false,"is_kanban_column":true,"is_stepper_stage":true}'),
    ('posted',   '{"lifecycle":"terminal","is_terminal":true,"is_final":true,"allows_approve":false,"allows_reject":false,"is_aging_eligible":false,"is_kanban_column":true,"is_stepper_stage":true}'),
    ('canceled', '{"lifecycle":"terminal","is_terminal":true,"is_final":true,"allows_approve":false,"allows_reject":false,"is_aging_eligible":false,"is_kanban_column":true,"is_stepper_stage":false}')
) AS v(value, metadata)
  ON TRUE
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'settlement_status'
  AND lv.value = v.value;

INSERT INTO public.lookup_definitions (
  category, description, owner_role, approval_policy, is_mutable,
  organization_id, scope_type
)
VALUES (
  'settlement_batch_transition_action',
  'Console-visible settlement batch transition actions. Validates public.ui_transition_settlement_batch_v1 before delegating to the service SSOT.',
  'finance',
  'tier_1',
  FALSE,
  NULL,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, FALSE, 'active', v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('lock', 'Lock', 10, '{"from_status":"open","to_status":"locked","console_visible":true}'),
    ('post', 'Post', 20, '{"from_status":"approved","to_status":"posted","console_visible":true}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'settlement_batch_transition_action'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.ui_create_settlement_batch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_metadata jsonb := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_payload jsonb;
  v_batch_id uuid;
  v_event_id uuid;
  v_created boolean := FALSE;
  v_status text := NULL;
  v_version integer := NULL;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_settlement_batch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('settlements.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_settlement_batch_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_settlement_batch_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'kind', lower(NULLIF(btrim(COALESCE(v_args->>'kind', '')), '')),
    'scope_type', lower(NULLIF(btrim(COALESCE(v_args->>'scope_type', '')), '')),
    'branch_id', NULLIF(v_args->>'branch_id', ''),
    'client_id', NULLIF(v_args->>'client_id', ''),
    'sender_id', NULLIF(v_args->>'sender_id', ''),
    'subject_type', lower(NULLIF(btrim(COALESCE(v_args->>'subject_type', '')), '')),
    'subject_id', NULLIF(v_args->>'subject_id', ''),
    'window_start_at', NULLIF(v_args->>'window_start_at', ''),
    'window_end_at', NULLIF(v_args->>'window_end_at', ''),
    'idempotency_key', NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), ''),
    'actor_user_id', v_user_id,
    'actor_system', 'ui_create_settlement_batch_v1',
    'metadata', v_metadata || jsonb_build_object(
      'source',
      COALESCE(v_args#>>'{metadata,source}', 'console-v2/finance/settlements')
    )
  ));

  SELECT r.settlement_batch_id, r.settlement_event_id, r.created
    INTO v_batch_id, v_event_id, v_created
  FROM public.create_settlement_batch_v1(v_payload) AS r
  LIMIT 1;

  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_settlement_batch_v1 did not return settlement_batch_id'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT b.status, b.version
    INTO v_status, v_version
  FROM public.settlement_batches b
  WHERE b.id = v_batch_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'settlement_batch_id', v_batch_id,
    'settlement_event_id', v_event_id,
    'created', COALESCE(v_created, FALSE),
    'status', v_status,
    'version', v_version,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_transition_settlement_batch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_batch public.settlement_batches%ROWTYPE;
  v_batch_id uuid;
  v_to_status text := lower(NULLIF(btrim(COALESCE(v_args->>'to_status', '')), ''));
  v_payload jsonb := COALESCE(v_args->'payload', '{}'::jsonb);
  v_service_payload jsonb;
  v_event_id uuid := NULL;
  v_status text := NULL;
  v_version integer := NULL;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('settlements.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_batch_id := NULLIF(v_args->>'settlement_batch_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_batch_id := NULL;
  END;

  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 requires settlement_batch_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 requires to_status'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_batch
  FROM public.settlement_batches
  WHERE id = v_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 settlement_batch_id % not found', v_batch_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_user() AND v_batch.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 cannot transition settlements in other organizations'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_batch_transition_action'
    AND lv.status = 'active'
    AND COALESCE((lv.metadata->>'console_visible')::boolean, TRUE) IS TRUE
    AND lv.metadata->>'from_status' = v_batch.status
    AND lv.metadata->>'to_status' = v_to_status
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_transition_settlement_batch_v1 transition from % to % is not configured',
      v_batch.status, v_to_status
      USING ERRCODE = '23514';
  END IF;

  v_service_payload := jsonb_strip_nulls(jsonb_build_object(
    'settlement_batch_id', v_batch_id,
    'to_status', v_to_status,
    'status_reason', NULLIF(btrim(COALESCE(v_args->>'status_reason', '')), ''),
    'payload', v_payload || jsonb_build_object(
      'source',
      COALESCE(v_args#>>'{payload,source}', 'console-v2/finance/settlements')
    ),
    'idempotency_key', NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), ''),
    'ops_session_id', NULLIF(v_args->>'ops_session_id', ''),
    'actor_user_id', v_user_id,
    'actor_system', 'ui_transition_settlement_batch_v1'
  ));

  SELECT r.settlement_event_id
    INTO v_event_id
  FROM public.transition_settlement_batch_v1(v_service_payload) AS r
  LIMIT 1;

  SELECT b.status, b.version
    INTO v_status, v_version
  FROM public.settlement_batches b
  WHERE b.id = v_batch_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'settlement_batch_id', v_batch_id,
    'settlement_event_id', v_event_id,
    'status', v_status,
    'version', v_version,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_create_settlement_batch_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_settlement_batch_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_create_settlement_batch_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_create_settlement_batch_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_transition_settlement_batch_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_transition_settlement_batch_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_transition_settlement_batch_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ui_transition_settlement_batch_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_settlement_batch_v1(jsonb) IS
  'Console V2 authenticated wrapper for create_settlement_batch_v1. Requires settlements.write and current org scope.';
COMMENT ON FUNCTION public.ui_transition_settlement_batch_v1(jsonb) IS
  'Console V2 authenticated wrapper for transition_settlement_batch_v1. Requires settlements.write and a row-driven settlement_batch_transition_action.';

CREATE OR REPLACE FUNCTION api.ui_create_settlement_batch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_create_settlement_batch_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_transition_settlement_batch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_transition_settlement_batch_v1(p_args);
$$;

REVOKE ALL ON FUNCTION api.ui_create_settlement_batch_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_settlement_batch_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_create_settlement_batch_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_create_settlement_batch_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_transition_settlement_batch_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_transition_settlement_batch_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_transition_settlement_batch_v1(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_transition_settlement_batch_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_create_settlement_batch_v1(jsonb) IS
  'API schema wrapper for public.ui_create_settlement_batch_v1.';
COMMENT ON FUNCTION api.ui_transition_settlement_batch_v1(jsonb) IS
  'API schema wrapper for public.ui_transition_settlement_batch_v1.';

SELECT pg_advisory_unlock(hashtext('202605031210_console_v2_settlement_ui_wrappers_v1'));

COMMIT;
