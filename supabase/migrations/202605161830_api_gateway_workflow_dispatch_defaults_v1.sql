-- API Gateway workflow dispatch defaults.
--
-- Shipment-creating API Gateway routes must be workflow-engine-first. This
-- migration supplies a generic workflow template for first-tenant API shipment
-- creation, enables it only on shipment.create routes that do not already carry
-- a workflow policy, and exposes a narrow edge helper for dispatching the
-- outbound job created by that workflow.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605161830_api_gateway_workflow_dispatch_defaults_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  scope_id,
  notes
)
VALUES (
  '99990000-0000-0000-0000-000000790101',
  'api_gateway_shipment_create_default_v1',
  'Default API Gateway shipment-create workflow: materialize addresses, dispatch provider create, wait for canonical shipment readback.',
  1,
  'active',
  'global',
  NULL,
  'Generic first-tenant API Gateway shipment-create path. Route-specific workflows may override this in api_routes.policy.workflow.template_name.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'api_gateway_shipment_create_default_v1'
     AND status = 'active'
   ORDER BY updated_at DESC
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_shipment_create_default_v1 template missing after upsert';
  END IF;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    manual_action_required,
    enabled
  )
  VALUES
    (
      '99990000-0000-0000-0000-000000790111'::uuid,
      v_template_id,
      1,
      'materialize_addresses',
      'workflow',
      'always',
      'api_gateway_materialize_addresses',
      'v1',
      '{}'::jsonb,
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790112'::uuid,
      v_template_id,
      2,
      'dispatch_create',
      'workflow',
      'always',
      'api_gateway_dispatch_outbound',
      'v1',
      '{}'::jsonb,
      FALSE,
      TRUE
    ),
    (
      '99990000-0000-0000-0000-000000790113'::uuid,
      v_template_id,
      3,
      'wait_for_shipment',
      'workflow',
      'always',
      'wait_for_shipment',
      'v1',
      jsonb_build_object(
        'poll_interval_seconds', 2,
        'max_wait_seconds', 600,
        'decision_log_event', 'api_gateway.wait_for_shipment'
      ),
      FALSE,
      TRUE
    )
  ON CONFLICT (id) DO UPDATE
  SET workflow_template_id = EXCLUDED.workflow_template_id,
      sequence_order = EXCLUDED.sequence_order,
      operation_name = EXCLUDED.operation_name,
      operation_settings_category = EXCLUDED.operation_settings_category,
      transition_condition = EXCLUDED.transition_condition,
      handler_key = EXCLUDED.handler_key,
      handler_version = EXCLUDED.handler_version,
      metadata = EXCLUDED.metadata,
      manual_action_required = EXCLUDED.manual_action_required,
      enabled = EXCLUDED.enabled,
      updated_at = now();
END;
$do$;

UPDATE public.api_routes r
   SET policy = public.jsonb_deep_merge(
       COALESCE(r.policy, '{}'::jsonb),
       jsonb_build_object(
         'delivery', jsonb_build_object(
           'mode', 'accepted_async',
           'status_code', 202,
           'headers', jsonb_build_object('content-type', 'application/json')
         ),
         'workflow', jsonb_build_object(
           'enabled', TRUE,
           'template_name', 'api_gateway_shipment_create_default_v1'
         )
       )
     ),
       updated_at = now()
 WHERE r.enabled = TRUE
   AND public.api_gateway_route_canonical_intent_v1(COALESCE(r.policy, '{}'::jsonb)) = 'shipment.create'
   AND (
     COALESCE(r.policy, '{}'::jsonb) ? 'workflow'
   ) IS FALSE;

CREATE OR REPLACE FUNCTION public.apply_api_gateway_shipment_create_workflow_defaults_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(NEW.policy, '{}'::jsonb);
BEGIN
  IF COALESCE(NEW.enabled, FALSE) IS TRUE
     AND public.api_gateway_route_canonical_intent_v1(v_policy) = 'shipment.create' THEN
    IF (v_policy ? 'workflow') IS FALSE THEN
      v_policy := jsonb_set(
        v_policy,
        '{workflow}',
        jsonb_build_object(
          'enabled', TRUE,
          'template_name', 'api_gateway_shipment_create_default_v1'
        ),
        TRUE
      );
    ELSE
      IF COALESCE((v_policy #>> '{workflow,enabled}')::BOOLEAN, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'enabled shipment.create API Gateway routes must use workflow.enabled=true'
          USING ERRCODE = '23514';
      END IF;

      IF NULLIF(v_policy #>> '{workflow,template_name}', '') IS NULL
         AND NULLIF(v_policy #>> '{workflow,template_id}', '') IS NULL THEN
        v_policy := jsonb_set(
          v_policy,
          '{workflow,template_name}',
          to_jsonb('api_gateway_shipment_create_default_v1'::TEXT),
          TRUE
        );
      END IF;
    END IF;

    IF NULLIF(v_policy #>> '{delivery,mode}', '') IS NULL THEN
      v_policy := jsonb_set(v_policy, '{delivery,mode}', to_jsonb('accepted_async'::TEXT), TRUE);
    END IF;
  END IF;

  NEW.policy := v_policy;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_api_gateway_shipment_create_workflow_defaults_v1() IS
  'Before-insert/update guard for api_routes: enabled shipment.create routes are workflow-engine-first by default and cannot explicitly disable workflow mode.';

DROP TRIGGER IF EXISTS trg_api_routes_shipment_create_workflow_defaults_v1 ON public.api_routes;
CREATE TRIGGER trg_api_routes_shipment_create_workflow_defaults_v1
BEFORE INSERT OR UPDATE OF enabled, policy ON public.api_routes
FOR EACH ROW
EXECUTE FUNCTION public.apply_api_gateway_shipment_create_workflow_defaults_v1();

CREATE OR REPLACE FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(
  p_api_gateway_request_id UUID
)
RETURNS TABLE (
  job_id UUID,
  timeout_seconds INT
)
SECURITY DEFINER
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT
    oc.id AS job_id,
    COALESCE(NULLIF(ar.policy #>> '{delivery,timeout_seconds}', '')::INT, 30) AS timeout_seconds
  FROM public.api_gateway_requests agr
  JOIN public.api_routes ar
    ON ar.id = agr.route_id
  JOIN public.outbound_calls oc
    ON oc.id = agr.outbound_call_id
  WHERE agr.id = p_api_gateway_request_id
    AND agr.workflow_run_id IS NOT NULL
    AND oc.status = 'pending_edge'
  ORDER BY oc.created_at ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) IS
  'Edge helper for API Gateway workflow-mode accepted_async requests. Returns only pending_edge outbound jobs for a workflow-linked api_gateway_request so the edge function can dispatch the job without exposing broader queue reads.';

REVOKE ALL ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(
  p_api_gateway_request_id UUID
)
RETURNS TABLE (
  job_id UUID,
  timeout_seconds INT
)
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT *
    FROM public.get_api_gateway_edge_dispatch_jobs_v1(p_api_gateway_request_id);
$$;

COMMENT ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) IS
  'API schema wrapper for API Gateway workflow-mode edge dispatch helper.';

REVOKE ALL ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.progress_api_gateway_request_workflow_v1(
  p_api_gateway_request_id UUID,
  p_workflow_run_id UUID,
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_request public.api_gateway_requests%ROWTYPE;
BEGIN
  IF p_api_gateway_request_id IS NULL THEN
    RAISE EXCEPTION 'progress_api_gateway_request_workflow_v1 requires api_gateway_request_id'
      USING ERRCODE = '23502';
  END IF;

  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_api_gateway_request_workflow_v1 requires workflow_run_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_request
    FROM public.api_gateway_requests
   WHERE id = p_api_gateway_request_id;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'progress_api_gateway_request_workflow_v1 request % not found', p_api_gateway_request_id
      USING ERRCODE = '23503';
  END IF;

  IF v_request.workflow_run_id IS DISTINCT FROM p_workflow_run_id THEN
    RAISE EXCEPTION 'progress_api_gateway_request_workflow_v1 workflow % is not linked to request %',
      p_workflow_run_id, p_api_gateway_request_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.progress_workflow_run(p_workflow_run_id, COALESCE(p_input, '{}'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) IS
  'Narrow edge helper for API Gateway workflow-mode accepted_async requests. Validates the request/workflow link before invoking the canonical public.progress_workflow_run entrypoint.';

REVOKE ALL ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION api.progress_api_gateway_request_workflow_v1(
  p_api_gateway_request_id UUID,
  p_workflow_run_id UUID,
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  SELECT public.progress_api_gateway_request_workflow_v1(
    p_api_gateway_request_id,
    p_workflow_run_id,
    COALESCE(p_input, '{}'::jsonb)
  );
$function$;

COMMENT ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) IS
  'API schema wrapper for the narrow API Gateway request/workflow progress helper used by the edge runtime.';

REVOKE ALL ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605161830_api_gateway_workflow_dispatch_defaults_v1'));

COMMIT;
