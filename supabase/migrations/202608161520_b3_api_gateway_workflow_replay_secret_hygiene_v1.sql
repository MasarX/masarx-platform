-- API Gateway workflow dispatch, replay-header isolation, and persisted secret hygiene.
--
-- Provider credentials remain dispatch-time only. API Gateway replay lineage is
-- retained on inbound readback, but never crosses the provider egress boundary.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202607151340_api_gateway_workflow_replay_secret_hygiene_v1'));
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.api_gateway_sanitize_outbound_headers_v1(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(jsonb_object_agg(lower(btrim(entry.key)), entry.value), '{}'::jsonb)
  FROM jsonb_each_text(COALESCE(p_headers, '{}'::jsonb)) entry
  WHERE NULLIF(btrim(entry.key), '') IS NOT NULL
    AND NULLIF(btrim(entry.value), '') IS NOT NULL
    AND lower(btrim(entry.key)) <> ALL (ARRAY[
      'authorization', 'proxy-authorization', 'apikey', 'x-api-key', 'x-client-info',
      'idempotency-key', 'x-idempotency-key', 'x-webhook-token', 'x-internal-edge-token',
      'x-masarx-replay-of', 'connection', 'content-length', 'host', 'keep-alive',
      'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
      'accept', 'accept-encoding', 'accept-language', 'origin', 'referer', 'user-agent',
      'traceparent', 'tracestate', 'baggage', 'sentry-trace', 'x-correlation-id',
      'x-request-id', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
      'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
      'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-path', 'x-forwarded-port',
      'x-forwarded-prefix', 'x-forwarded-proto', 'x-forwarded-url', 'x-original-uri',
      'x-real-ip', 'x-rewrite-url', 'x-envoy-original-path'
    ]::TEXT[]);
$function$;

COMMENT ON FUNCTION public.api_gateway_sanitize_outbound_headers_v1(JSONB) IS
  'Strips auth, replay, browser, proxy, runtime, and tracing headers from API Gateway provider egress.';

CREATE OR REPLACE FUNCTION public.api_gateway_strip_body_field_auth_v1(
  p_body JSONB,
  p_auth_fields JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_body JSONB := COALESCE(p_body, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_body) <> 'object' OR jsonb_typeof(COALESCE(p_auth_fields, '{}'::jsonb)) <> 'object' THEN
    RETURN public.redact_sensitive_json(v_body);
  END IF;

  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
  INTO v_body
  FROM jsonb_each(v_body) entry
  WHERE entry.key NOT IN (
    SELECT auth_entry.key FROM jsonb_each_text(COALESCE(p_auth_fields, '{}'::jsonb)) auth_entry
    UNION
    SELECT auth_entry.value
    FROM jsonb_each_text(COALESCE(p_auth_fields, '{}'::jsonb)) auth_entry
    WHERE NULLIF(btrim(auth_entry.value), '') IS NOT NULL
  );

  RETURN public.redact_sensitive_json(COALESCE(v_body, '{}'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_strip_body_field_auth_v1(JSONB, JSONB) IS
  'Removes both credential keys and mapped provider field names before API Gateway payload persistence.';

CREATE OR REPLACE FUNCTION public.api_gateway_outbound_secret_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_request_id UUID;
  v_auth_mode TEXT;
  v_auth_fields JSONB;
BEGIN
  BEGIN
    v_request_id := NULLIF(NEW.context->>'api_gateway_request_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_request_id := NULL;
  END;

  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(route.policy #>> '{auth,mode}', ''), COALESCE(route.policy #> '{auth,fields}', '{}'::jsonb)
  INTO v_auth_mode, v_auth_fields
  FROM public.api_gateway_requests request
  JOIN public.api_routes route ON route.id = request.route_id
  WHERE request.id = v_request_id;

  NEW.headers := public.api_gateway_sanitize_outbound_headers_v1(NEW.headers);
  IF v_auth_mode = 'body_fields' THEN
    NEW.body := public.api_gateway_strip_body_field_auth_v1(NEW.body, v_auth_fields);
  ELSE
    NEW.body := public.redact_sensitive_json(COALESCE(NEW.body, '{}'::jsonb));
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_gateway_outbound_secret_guard_v1 ON public.outbound_calls;
CREATE TRIGGER trg_api_gateway_outbound_secret_guard_v1
BEFORE INSERT OR UPDATE OF headers, body, context ON public.outbound_calls
FOR EACH ROW
EXECUTE FUNCTION public.api_gateway_outbound_secret_guard_v1();

CREATE OR REPLACE FUNCTION public.api_gateway_workflow_secret_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_request_id UUID;
  v_auth_mode TEXT;
  v_auth_fields JSONB;
  v_key TEXT;
BEGIN
  BEGIN
    v_request_id := NULLIF(NEW.context #>> '{api_gateway,api_gateway_request_id}', '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_request_id := NULL;
  END;

  IF v_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(route.policy #>> '{auth,mode}', ''), COALESCE(route.policy #> '{auth,fields}', '{}'::jsonb)
  INTO v_auth_mode, v_auth_fields
  FROM public.api_gateway_requests request
  JOIN public.api_routes route ON route.id = request.route_id
  WHERE request.id = v_request_id;

  IF NEW.context #> '{api_gateway,outbound_headers}' IS NOT NULL THEN
    NEW.context := jsonb_set(
      NEW.context,
      '{api_gateway,outbound_headers}',
      public.api_gateway_sanitize_outbound_headers_v1(NEW.context #> '{api_gateway,outbound_headers}'),
      TRUE
    );
  END IF;

  IF v_auth_mode = 'body_fields' THEN
    FOREACH v_key IN ARRAY ARRAY['payload', 'transformed_payload']::TEXT[] LOOP
      IF NEW.context->v_key IS NOT NULL THEN
        NEW.context := jsonb_set(
          NEW.context,
          ARRAY[v_key],
          public.api_gateway_strip_body_field_auth_v1(NEW.context->v_key, v_auth_fields),
          TRUE
        );
      END IF;
    END LOOP;

    IF NEW.context #> '{api_gateway,request_body}' IS NOT NULL THEN
      NEW.context := jsonb_set(
        NEW.context,
        '{api_gateway,request_body}',
        public.api_gateway_strip_body_field_auth_v1(NEW.context #> '{api_gateway,request_body}', v_auth_fields),
        TRUE
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_gateway_workflow_secret_guard_v1 ON public.workflow_runs;
CREATE TRIGGER trg_api_gateway_workflow_secret_guard_v1
BEFORE INSERT OR UPDATE OF context ON public.workflow_runs
FOR EACH ROW
EXECUTE FUNCTION public.api_gateway_workflow_secret_guard_v1();

CREATE OR REPLACE FUNCTION public.api_gateway_policy_intent_v1(p_policy JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(
    p_policy #>> '{workflow,intent}',
    p_policy #>> '{workflow,canonical_intent}',
    p_policy #>> '{postprocess,canonical_intent}',
    p_policy #>> '{postprocess,intent}',
    p_policy #>> '{intake,canonical_intent}',
    p_policy #>> '{intake,intent}',
    p_policy->>'canonical_intent',
    p_policy->>'operation',
    p_policy->>'intent',
    p_policy #>> '{mapping,target}',
    p_policy #>> '{mapping,intent}'
  )), ''));
  v_mode TEXT := lower(COALESCE(p_policy #>> '{postprocess,mode}', ''));
BEGIN
  IF v_intent IN (
    'shipment.create', 'shipment_create', 'shipment.created',
    'shipment_created', 'shipments.create', 'create_shipment'
  ) THEN
    RETURN 'shipment.create';
  END IF;

  IF v_intent IS NULL AND v_mode = 'shipment_create_v1' THEN
    RETURN 'shipment.create';
  END IF;

  RETURN COALESCE(v_intent, '');
END;
$function$;

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type, scope_id, notes
)
VALUES (
  '99990000-0000-0000-0000-000000790101',
  'api_gateway_shipment_create_default_v1',
  'Default API Gateway shipment-create workflow: materialize addresses, dispatch provider create, wait for canonical shipment readback.',
  1, 'active', 'global', NULL,
  'Generic row-driven API Gateway shipment-create path. Route-specific workflows may override this template.'
)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

DO $seed$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'api_gateway_shipment_create_default_v1' AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'api_gateway_shipment_create_default_v1 template missing after upsert';
  END IF;

  INSERT INTO public.workflow_template_steps (
    id, workflow_template_id, sequence_order, operation_name,
    operation_settings_category, transition_condition, handler_key,
    handler_version, metadata, manual_action_required, enabled
  ) VALUES
    ('99990000-0000-0000-0000-000000790111', v_template_id, 1, 'materialize_addresses',
     'workflow', 'always', 'api_gateway_materialize_addresses', 'v1', '{}'::jsonb, FALSE, TRUE),
    ('99990000-0000-0000-0000-000000790112', v_template_id, 2, 'dispatch_create',
     'workflow', 'always', 'api_gateway_dispatch_outbound', 'v1', '{}'::jsonb, FALSE, TRUE),
    ('99990000-0000-0000-0000-000000790113', v_template_id, 3, 'wait_for_shipment',
     'workflow', 'always', 'wait_for_shipment', 'v1',
     jsonb_build_object(
       'poll_interval_seconds', 2,
       'max_wait_seconds', 600,
       'decision_log_event', 'api_gateway.wait_for_shipment'
     ), FALSE, TRUE)
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
$seed$;

CREATE OR REPLACE FUNCTION public.apply_api_gateway_shipment_create_workflow_defaults_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(NEW.policy, '{}'::jsonb);
BEGIN
  IF COALESCE(NEW.enabled, FALSE)
     AND public.api_gateway_policy_intent_v1(v_policy) = 'shipment.create' THEN
    IF COALESCE((v_policy #>> '{workflow,enabled}')::BOOLEAN, TRUE) IS NOT TRUE THEN
      RAISE EXCEPTION 'enabled shipment.create API Gateway routes must use workflow.enabled=true'
        USING ERRCODE = '23514';
    END IF;

    v_policy := public.jsonb_deep_merge(
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202),
        'workflow', jsonb_build_object(
          'enabled', TRUE,
          'template_name', 'api_gateway_shipment_create_default_v1'
        )
      ),
      v_policy
    );
  END IF;

  NEW.policy := v_policy;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_routes_shipment_create_workflow_defaults_v1 ON public.api_routes;
CREATE TRIGGER trg_api_routes_shipment_create_workflow_defaults_v1
BEFORE INSERT OR UPDATE OF enabled, policy ON public.api_routes
FOR EACH ROW
EXECUTE FUNCTION public.apply_api_gateway_shipment_create_workflow_defaults_v1();

UPDATE public.api_routes route
SET policy = public.jsonb_deep_merge(
      jsonb_build_object(
        'delivery', jsonb_build_object('mode', 'accepted_async', 'status_code', 202),
        'workflow', jsonb_build_object(
          'enabled', TRUE,
          'template_name', 'api_gateway_shipment_create_default_v1'
        )
      ),
      COALESCE(route.policy, '{}'::jsonb)
    ),
    updated_at = now()
WHERE route.enabled
  AND public.api_gateway_policy_intent_v1(COALESCE(route.policy, '{}'::jsonb)) = 'shipment.create';

CREATE OR REPLACE FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(p_api_gateway_request_id UUID)
RETURNS TABLE (job_id UUID, timeout_seconds INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT outbound.id,
         COALESCE(NULLIF(route.policy #>> '{delivery,timeout_seconds}', '')::INTEGER, 30)
  FROM public.api_gateway_requests request
  JOIN public.api_routes route ON route.id = request.route_id
  JOIN public.outbound_calls outbound ON outbound.id = request.outbound_call_id
  WHERE request.id = p_api_gateway_request_id
    AND request.workflow_run_id IS NOT NULL
    AND outbound.status = 'pending_edge'
  ORDER BY outbound.created_at ASC
  LIMIT 1;
$function$;

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
  v_linked_workflow_id UUID;
BEGIN
  IF p_api_gateway_request_id IS NULL OR p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'API Gateway request and workflow identifiers are required' USING ERRCODE = '23502';
  END IF;

  SELECT workflow_run_id INTO v_linked_workflow_id
  FROM public.api_gateway_requests
  WHERE id = p_api_gateway_request_id;

  IF v_linked_workflow_id IS NULL THEN
    RAISE EXCEPTION 'API Gateway request % has no linked workflow', p_api_gateway_request_id
      USING ERRCODE = '23503';
  END IF;
  IF v_linked_workflow_id IS DISTINCT FROM p_workflow_run_id THEN
    RAISE EXCEPTION 'workflow % is not linked to API Gateway request %', p_workflow_run_id, p_api_gateway_request_id
      USING ERRCODE = '42501';
  END IF;

  RETURN public.progress_workflow_run(p_workflow_run_id, COALESCE(p_input, '{}'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(p_api_gateway_request_id UUID)
RETURNS TABLE (job_id UUID, timeout_seconds INTEGER)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT * FROM public.get_api_gateway_edge_dispatch_jobs_v1(p_api_gateway_request_id);
$function$;

CREATE OR REPLACE FUNCTION api.progress_api_gateway_request_workflow_v1(
  p_api_gateway_request_id UUID,
  p_workflow_run_id UUID,
  p_input JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, workflow_handlers, extensions, pg_temp
AS $function$
  SELECT public.progress_api_gateway_request_workflow_v1(
    p_api_gateway_request_id, p_workflow_run_id, COALESCE(p_input, '{}'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO edge_api_gateway_role, service_role;
GRANT EXECUTE ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO edge_api_gateway_role, service_role;
GRANT EXECUTE ON FUNCTION api.get_api_gateway_edge_dispatch_jobs_v1(UUID) TO edge_api_gateway_role, service_role;
GRANT EXECUTE ON FUNCTION api.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) TO edge_api_gateway_role, service_role;

COMMENT ON FUNCTION public.get_api_gateway_edge_dispatch_jobs_v1(UUID) IS
  'Returns the pending edge job linked to a workflow-mode API Gateway request.';
COMMENT ON FUNCTION public.progress_api_gateway_request_workflow_v1(UUID, UUID, JSONB) IS
  'Validates API Gateway request/workflow lineage before invoking canonical progress_workflow_run.';

COMMIT;
