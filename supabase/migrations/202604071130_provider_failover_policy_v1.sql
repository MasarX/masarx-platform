-- Plan: UC179 provider failover / Step: S04
-- Migration: provider failover policy v1
-- Purpose:
--   - Add a row-driven provider_failover_policy category.
--   - Centralize outbound request materialization so workflow + enqueue + failover share one contract.
--   - Allow provider_api jobs to retarget to an alternate provider when the current provider is unhealthy
--     or a retryable HTTP failure occurs.
--   - Expose provider health and circuit-breaker resources in ui_read_registry for Console visibility.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'provider_failover_policy',
  'Provider failover selection, health thresholds, and queue retargeting resolved via ladder for provider_api outbound jobs.',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant","client","sender","source"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'provider_failover_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('version'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'same_provider_type_only', jsonb_build_object('type', 'boolean'),
      'current_provider_allowed_health_statuses', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string')
      ),
      'candidate_allowed_health_statuses', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'string')
      ),
      'trigger_status_codes', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object('type', 'integer')
      ),
      'trigger_status_ranges', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'array',
          'minItems', 2,
          'maxItems', 2,
          'items', jsonb_build_object('type', 'integer')
        )
      ),
      'max_failover_hops', jsonb_build_object('type', 'integer', 'minimum', 0),
      'failover_delay_seconds', jsonb_build_object('type', 'integer', 'minimum', 0),
      'open_after_failures', jsonb_build_object('type', 'integer', 'minimum', 1),
      'manual_intervention_after_failures', jsonb_build_object('type', 'integer', 'minimum', 1)
    )
  ),
  'Provider failover and provider-health thresholds for outbound provider_api jobs.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'same_provider_type_only', TRUE,
      'current_provider_allowed_health_statuses', jsonb_build_array('healthy'),
      'candidate_allowed_health_statuses', jsonb_build_array('healthy', 'degraded'),
      'trigger_status_codes', jsonb_build_array(0, 408, 409, 425, 429),
      'trigger_status_ranges', jsonb_build_array(jsonb_build_array(500, 599)),
      'max_failover_hops', 2,
      'failover_delay_seconds', 0,
      'open_after_failures', 3,
      'manual_intervention_after_failures', 6
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active;

DO $do$
DECLARE
  v_value JSONB;
BEGIN
  v_value := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'same_provider_type_only', TRUE,
    'current_provider_allowed_health_statuses', jsonb_build_array('healthy'),
    'candidate_allowed_health_statuses', jsonb_build_array('healthy', 'degraded'),
    'trigger_status_codes', jsonb_build_array(0, 408, 409, 425, 429),
    'trigger_status_ranges', jsonb_build_array(jsonb_build_array(500, 599)),
    'max_failover_hops', 2,
    'failover_delay_seconds', 0,
    'open_after_failures', 3,
    'manual_intervention_after_failures', 6
  );

  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'provider_failover_policy',
    'global',
    NULL,
    v_value,
    1,
    'Seed global provider_failover_policy default'
  );
END;
$do$;

CREATE OR REPLACE FUNCTION public.build_outbound_call_dispatch_from_operation_template_v1(
  p_operation_template_id UUID,
  p_context JSONB DEFAULT '{}'::jsonb,
  p_payload JSONB DEFAULT NULL,
  p_step_metadata JSONB DEFAULT '{}'::jsonb,
  p_override_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_operation public.operation_templates%ROWTYPE;
  v_provider_defaults JSONB := '{}'::jsonb;
  v_mapping_scope JSONB;
  v_headers JSONB;
  v_body JSONB;
  v_call_type TEXT;
  v_target_url TEXT;
  v_payload JSONB := COALESCE(
    p_payload,
    COALESCE(p_context->'payload', NULL),
    COALESCE(p_context->'transformed_payload', '{}'::jsonb),
    '{}'::jsonb
  );
  v_step_metadata JSONB := COALESCE(p_step_metadata, '{}'::jsonb);
BEGIN
  IF p_operation_template_id IS NULL THEN
    RAISE EXCEPTION 'build_outbound_call_dispatch_from_operation_template_v1: operation_template_id is required';
  END IF;

  SELECT *
  INTO v_operation
  FROM public.operation_templates
  WHERE id = p_operation_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'build_outbound_call_dispatch_from_operation_template_v1: operation_template % not found', p_operation_template_id;
  END IF;

  IF COALESCE((v_step_metadata->>'expects_provider_defaults')::BOOLEAN, FALSE) THEN
    SELECT s.cached_value
    INTO v_provider_defaults
    FROM public.settings s
    WHERE s.category = 'provider_defaults'
      AND s.scope_type = 'resource'
      AND s.scope_id = v_operation.provider_id
    ORDER BY s.last_updated DESC
    LIMIT 1;

    v_provider_defaults := COALESCE(v_provider_defaults, '{}'::jsonb);
  END IF;

  v_mapping_scope := jsonb_build_object(
    'context', COALESCE(p_context, '{}'::jsonb),
    'transformed_payload', COALESCE(p_context->'transformed_payload', '{}'::jsonb),
    'payload', COALESCE(v_payload, '{}'::jsonb),
    'provider_defaults', v_provider_defaults,
    'step', v_step_metadata,
    'operation', jsonb_build_object(
      'id', v_operation.id,
      'name', v_operation.operation_name
    )
  );

  v_headers := public.apply_request_mappings(
    COALESCE(v_operation.headers_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'headers', '{}'::jsonb),
    v_mapping_scope
  );

  v_body := public.apply_request_mappings(
    COALESCE(v_operation.body_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'body', '{}'::jsonb),
    v_mapping_scope
  );

  v_call_type := COALESCE(
    NULLIF(v_step_metadata->>'call_type', ''),
    NULLIF(v_operation.call_type, ''),
    'provider_api'
  );

  IF v_call_type NOT IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice') THEN
    RAISE EXCEPTION 'build_outbound_call_dispatch_from_operation_template_v1: unsupported call_type % for operation %', v_call_type, v_operation.id;
  END IF;

  v_target_url := COALESCE(
    NULLIF(p_override_url, ''),
    NULLIF(v_step_metadata->>'override_url', ''),
    v_operation.url_template
  );

  IF v_target_url IS NULL OR btrim(v_target_url) = '' THEN
    RAISE EXCEPTION 'build_outbound_call_dispatch_from_operation_template_v1: url_template missing for operation %', v_operation.id;
  END IF;

  RETURN jsonb_build_object(
    'provider_id', v_operation.provider_id,
    'operation_template_id', v_operation.id,
    'operation_name', v_operation.operation_name,
    'call_type', v_call_type,
    'method', v_operation.method,
    'url', v_target_url,
    'headers', COALESCE(v_headers, '{}'::jsonb),
    'body', COALESCE(v_body, '{}'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.build_outbound_call_dispatch_from_operation_template_v1(UUID, JSONB, JSONB, JSONB, TEXT)
IS 'Canonical dispatch materializer for operation_templates. Shared by workflow enqueue, direct enqueue, and failover retargeting.';

CREATE OR REPLACE FUNCTION public.resolve_outbound_failover_candidate_v1(
  p_job_id UUID,
  p_trigger TEXT DEFAULT 'http_failure',
  p_status_code INT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_org UUID;
  v_request RECORD;
  v_current_provider public.providers%ROWTYPE;
  v_current_template public.operation_templates%ROWTYPE;
  v_current_circuit public.circuit_breaker_state%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_current_allowed JSONB := '["healthy"]'::jsonb;
  v_candidate_allowed JSONB := '["healthy","degraded"]'::jsonb;
  v_trigger_codes JSONB := '[0,408,409,425,429]'::jsonb;
  v_trigger_ranges JSONB := '[[500,599]]'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_same_provider_type_only BOOLEAN := TRUE;
  v_max_failover_hops INT := 2;
  v_failover_delay_seconds INT := 0;
  v_existing_hops INT := 0;
  v_current_healthy BOOLEAN := TRUE;
  v_failure_eligible BOOLEAN := FALSE;
  v_candidate RECORD;
BEGIN
  SELECT *
  INTO v_job
  FROM public.outbound_calls
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'job_not_found');
  END IF;

  IF v_job.call_type <> 'provider_api' OR v_job.target_type <> 'provider' THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'unsupported_call_type');
  END IF;

  SELECT *
  INTO v_current_provider
  FROM public.providers
  WHERE id = v_job.target_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'provider_not_found');
  END IF;

  BEGIN
    SELECT *
    INTO v_current_template
    FROM public.operation_templates
    WHERE id = NULLIF(v_job.context->>'operation_template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_current_template := NULL;
  END;

  IF v_current_template.id IS NULL THEN
    SELECT *
    INTO v_current_template
    FROM public.operation_templates
    WHERE provider_id = v_current_provider.id
      AND operation_name = COALESCE(NULLIF(v_job.context->>'operation_name', ''), v_job.call_type)
    ORDER BY updated_at DESC
    LIMIT 1;
  END IF;

  IF v_current_template.id IS NULL THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'operation_template_missing');
  END IF;

  v_org := public.resolve_organization_id_strict('provider', v_current_provider.id);
  v_context := jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object(
    'organization_id', v_org,
    'provider_id', v_current_provider.id,
    'provider_type', v_current_provider.provider_type,
    'operation_name', v_current_template.operation_name,
    'status_code', p_status_code,
    'trigger', COALESCE(NULLIF(btrim(p_trigger), ''), 'http_failure')
  ));

  IF v_context ? 'api_gateway_request_id' THEN
    BEGIN
      SELECT agr.organization_id, agr.client_id, agr.sender_id, agr.source_id
      INTO v_request
      FROM public.api_gateway_requests agr
      WHERE agr.id = NULLIF(v_context->>'api_gateway_request_id', '')::UUID;

      IF FOUND THEN
        v_context := jsonb_strip_nulls(v_context || jsonb_build_object(
          'organization_id', COALESCE(v_request.organization_id, v_org),
          'client_id', v_request.client_id,
          'sender_id', v_request.sender_id,
          'source_id', v_request.source_id
        ));
      END IF;
    EXCEPTION
      WHEN others THEN
        NULL;
    END;
  END IF;

  SELECT *
  INTO v_policy_row
  FROM public.resolve_settings_row_from_context('provider_failover_policy', v_context)
  LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE);
  v_same_provider_type_only := COALESCE((v_policy->>'same_provider_type_only')::BOOLEAN, TRUE);
  v_max_failover_hops := GREATEST(COALESCE((v_policy->>'max_failover_hops')::INT, 2), 0);
  v_failover_delay_seconds := GREATEST(COALESCE((v_policy->>'failover_delay_seconds')::INT, 0), 0);
  v_current_allowed := COALESCE(v_policy->'current_provider_allowed_health_statuses', v_current_allowed);
  v_candidate_allowed := COALESCE(v_policy->'candidate_allowed_health_statuses', v_candidate_allowed);
  v_trigger_codes := COALESCE(v_policy->'trigger_status_codes', v_trigger_codes);
  v_trigger_ranges := COALESCE(v_policy->'trigger_status_ranges', v_trigger_ranges);
  v_existing_hops := COALESCE(jsonb_array_length(COALESCE(v_job.context#>'{failover,history}', '[]'::jsonb)), 0);

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'policy_disabled');
  END IF;

  IF v_existing_hops >= v_max_failover_hops THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'max_failover_hops_exhausted');
  END IF;

  SELECT *
  INTO v_current_circuit
  FROM public.circuit_breaker_state
  WHERE provider_id = v_current_provider.id
    AND operation_name = v_current_template.operation_name;

  v_current_healthy := EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(v_current_allowed) AS allowed(status)
    WHERE allowed.status = COALESCE(v_current_provider.health_status, 'healthy')
  );

  IF FOUND AND (v_current_circuit.state = 'open' OR v_current_circuit.manual_intervention_required) THEN
    v_current_healthy := FALSE;
  END IF;

  IF p_status_code IS NOT NULL THEN
    v_failure_eligible := EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_trigger_codes) AS code(value)
      WHERE (code.value)::INT = p_status_code
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_trigger_ranges) AS range_row(bounds)
      WHERE jsonb_typeof(range_row.bounds) = 'array'
        AND jsonb_array_length(range_row.bounds) = 2
        AND p_status_code BETWEEN (range_row.bounds->>0)::INT AND (range_row.bounds->>1)::INT
    );
  END IF;

  IF COALESCE(NULLIF(btrim(p_trigger), ''), 'http_failure') = 'claim_pending_edge_jobs' AND v_current_healthy THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'current_provider_healthy');
  END IF;

  IF COALESCE(NULLIF(btrim(p_trigger), ''), 'http_failure') <> 'claim_pending_edge_jobs'
     AND NOT v_failure_eligible
     AND v_current_healthy THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'failure_not_eligible');
  END IF;

  SELECT
    p.id AS provider_id,
    p.name AS provider_name,
    p.health_status AS provider_health_status,
    p.priority_rank,
    ot.id AS operation_template_id,
    ot.operation_name
  INTO v_candidate
  FROM public.providers p
  JOIN public.operation_templates ot
    ON ot.provider_id = p.id
   AND ot.operation_name = v_current_template.operation_name
   AND COALESCE(ot.call_type, 'provider_api') = COALESCE(v_current_template.call_type, 'provider_api')
  LEFT JOIN public.circuit_breaker_state cbs
    ON cbs.provider_id = p.id
   AND cbs.operation_name = ot.operation_name
  WHERE p.organization_id = v_org
    AND p.enabled = TRUE
    AND p.id <> v_current_provider.id
    AND (
      NOT v_same_provider_type_only
      OR p.provider_type = v_current_provider.provider_type
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_candidate_allowed) AS allowed(status)
      WHERE allowed.status = COALESCE(p.health_status, 'healthy')
    )
    AND COALESCE(cbs.state, 'closed') <> 'open'
    AND COALESCE(cbs.manual_intervention_required, FALSE) = FALSE
  ORDER BY p.priority_rank DESC, p.updated_at DESC, ot.updated_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'no_candidate');
  END IF;

  RETURN jsonb_build_object(
    'applied', TRUE,
    'delay_seconds', v_failover_delay_seconds,
    'from_provider_id', v_current_provider.id,
    'from_provider_name', v_current_provider.name,
    'from_operation_template_id', v_current_template.id,
    'to_provider_id', v_candidate.provider_id,
    'to_provider_name', v_candidate.provider_name,
    'to_provider_health_status', v_candidate.provider_health_status,
    'to_operation_template_id', v_candidate.operation_template_id,
    'operation_name', v_candidate.operation_name,
    'trigger', COALESCE(NULLIF(btrim(p_trigger), ''), 'http_failure'),
    'status_code', p_status_code,
    'error', p_error
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_outbound_failover_candidate_v1(UUID, TEXT, INT, TEXT)
IS 'Resolve an alternate provider/template for a provider_api outbound job using provider_failover_policy, provider health, and operation_template compatibility.';

CREATE OR REPLACE FUNCTION public.apply_outbound_call_failover_v1(
  p_job_id UUID,
  p_candidate JSONB,
  p_performed_by_system TEXT DEFAULT 'system',
  p_correlation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_run public.workflow_runs%ROWTYPE;
  v_step public.workflow_run_steps%ROWTYPE;
  v_dispatch JSONB;
  v_payload JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_step_metadata JSONB := '{}'::jsonb;
  v_org UUID;
BEGIN
  IF COALESCE((p_candidate->>'applied')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', COALESCE(p_candidate->>'reason', 'candidate_not_applied'));
  END IF;

  SELECT *
  INTO v_job
  FROM public.outbound_calls
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'job_not_found');
  END IF;

  IF v_job.workflow_run_step_id IS NOT NULL THEN
    SELECT *
    INTO v_step
    FROM public.workflow_run_steps
    WHERE id = v_job.workflow_run_step_id;

    IF FOUND THEN
      SELECT *
      INTO v_run
      FROM public.workflow_runs
      WHERE id = v_step.workflow_run_id;

      v_context := COALESCE(v_run.context, '{}'::jsonb);
      v_step_metadata := COALESCE(v_step.metadata, '{}'::jsonb);
      v_payload := public.safe_jsonpath_query_first(
        jsonb_build_object(
          'context', COALESCE(v_run.context, '{}'::jsonb),
          'transformed_payload', COALESCE(v_run.context->'transformed_payload', '{}'::jsonb)
        ),
        COALESCE(v_step.metadata->>'payload_path', '$.transformed_payload')
      );
      IF v_payload IS NULL THEN
        v_payload := COALESCE(v_run.context->'transformed_payload', '{}'::jsonb);
      END IF;
    END IF;
  END IF;

  IF v_context = '{}'::jsonb THEN
    v_context := COALESCE(v_job.context, '{}'::jsonb);
  END IF;

  IF v_payload IS NULL OR v_payload = 'null'::jsonb THEN
    v_payload := COALESCE(v_job.context->'payload', v_job.body, '{}'::jsonb);
  END IF;

  v_dispatch := public.build_outbound_call_dispatch_from_operation_template_v1(
    (p_candidate->>'to_operation_template_id')::UUID,
    v_context,
    v_payload,
    v_step_metadata,
    NULL
  );

  UPDATE public.outbound_calls
  SET
    target_id = (v_dispatch->>'provider_id')::UUID,
    method = v_dispatch->>'method',
    url = v_dispatch->>'url',
    headers = COALESCE(v_dispatch->'headers', '{}'::jsonb),
    body = COALESCE(v_dispatch->'body', '{}'::jsonb),
    context = jsonb_strip_nulls(
      (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'edge_dispatch')
      || jsonb_build_object(
        'operation_template_id', v_dispatch->>'operation_template_id',
        'operation_name', v_dispatch->>'operation_name',
        'payload', v_payload,
        'failover', jsonb_build_object(
          'active_provider_id', p_candidate->>'to_provider_id',
          'active_provider_name', p_candidate->>'to_provider_name',
          'last_trigger', p_candidate->>'trigger',
          'history', COALESCE(COALESCE(public.outbound_calls.context#>'{failover,history}', '[]'::jsonb), '[]'::jsonb)
            || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
              'at', now(),
              'from_provider_id', p_candidate->>'from_provider_id',
              'from_provider_name', p_candidate->>'from_provider_name',
              'to_provider_id', p_candidate->>'to_provider_id',
              'to_provider_name', p_candidate->>'to_provider_name',
              'from_operation_template_id', p_candidate->>'from_operation_template_id',
              'to_operation_template_id', p_candidate->>'to_operation_template_id',
              'trigger', p_candidate->>'trigger',
              'status_code', p_candidate->'status_code',
              'error', p_candidate->>'error'
            )))
        )
      )
    ),
    updated_at = now()
  WHERE id = p_job_id;

  v_org := public.resolve_organization_id_strict('provider', (p_candidate->>'from_provider_id')::UUID);

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'provider_selection',
    p_resource_type := 'outbound_call',
    p_resource_id := p_job_id,
    p_decision_point := 'failover_resolution',
    p_decision_outcome := 'failed_over',
    p_performed_by_system := COALESCE(NULLIF(btrim(p_performed_by_system), ''), 'system'),
    p_correlation_id := p_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'trigger', p_candidate->>'trigger',
      'status_code', p_candidate->'status_code',
      'error', p_candidate->>'error',
      'from_provider_id', p_candidate->>'from_provider_id',
      'to_provider_id', p_candidate->>'to_provider_id',
      'operation_name', p_candidate->>'operation_name'
    )),
    p_decision_reason := format(
      'Outbound call failover applied from provider %s to provider %s.',
      COALESCE(p_candidate->>'from_provider_name', p_candidate->>'from_provider_id'),
      COALESCE(p_candidate->>'to_provider_name', p_candidate->>'to_provider_id')
    )
  );

  RETURN jsonb_build_object(
    'applied', TRUE,
    'provider_id', v_dispatch->>'provider_id',
    'operation_template_id', v_dispatch->>'operation_template_id',
    'url', v_dispatch->>'url'
  );
END;
$function$;

COMMENT ON FUNCTION public.apply_outbound_call_failover_v1(UUID, JSONB, TEXT, UUID)
IS 'Retarget an outbound_call to a resolved alternate provider/template and persist failover history on the job context.';

CREATE OR REPLACE FUNCTION public.record_outbound_call_provider_failure_v1(
  p_job_id UUID,
  p_status_code INT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_performed_by_system TEXT DEFAULT 'system',
  p_correlation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_provider public.providers%ROWTYPE;
  v_template public.operation_templates%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_open_after_failures INT := 3;
  v_manual_after_failures INT := 6;
  v_circuit public.circuit_breaker_state%ROWTYPE;
  v_new_failure_count INT;
  v_new_state TEXT;
  v_status TEXT;
  v_org UUID;
BEGIN
  SELECT *
  INTO v_job
  FROM public.outbound_calls
  WHERE id = p_job_id;

  IF NOT FOUND OR v_job.target_type <> 'provider' THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'job_not_found');
  END IF;

  SELECT *
  INTO v_provider
  FROM public.providers
  WHERE id = v_job.target_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'provider_not_found');
  END IF;

  SELECT *
  INTO v_template
  FROM public.operation_templates
  WHERE id = NULLIF(v_job.context->>'operation_template_id', '')::UUID;

  IF v_template.id IS NULL THEN
    RETURN jsonb_build_object('applied', FALSE, 'reason', 'operation_template_missing');
  END IF;

  v_org := public.resolve_organization_id_strict('provider', v_provider.id);
  v_context := jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object(
    'organization_id', v_org,
    'provider_id', v_provider.id,
    'provider_type', v_provider.provider_type,
    'operation_name', v_template.operation_name
  ));

  SELECT *
  INTO v_policy_row
  FROM public.resolve_settings_row_from_context('provider_failover_policy', v_context)
  LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  v_open_after_failures := GREATEST(COALESCE((v_policy->>'open_after_failures')::INT, 3), 1);
  v_manual_after_failures := GREATEST(COALESCE((v_policy->>'manual_intervention_after_failures')::INT, 6), v_open_after_failures);

  SELECT *
  INTO v_circuit
  FROM public.circuit_breaker_state
  WHERE provider_id = v_provider.id
    AND operation_name = v_template.operation_name
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.circuit_breaker_state (
      provider_id,
      operation_name,
      state,
      failure_count,
      success_count,
      last_failure_at,
      opened_at,
      manual_intervention_required,
      updated_at
    )
    VALUES (
      v_provider.id,
      v_template.operation_name,
      'closed',
      0,
      0,
      NULL,
      NULL,
      FALSE,
      now()
    )
    RETURNING * INTO v_circuit;
  END IF;

  v_new_failure_count := COALESCE(v_circuit.failure_count, 0) + 1;
  v_new_state := CASE
    WHEN v_new_failure_count >= v_open_after_failures THEN 'open'
    ELSE 'closed'
  END;

  UPDATE public.circuit_breaker_state
  SET
    failure_count = v_new_failure_count,
    last_failure_at = now(),
    state = v_new_state,
    opened_at = CASE
      WHEN v_new_state = 'open' AND public.circuit_breaker_state.opened_at IS NULL THEN now()
      ELSE public.circuit_breaker_state.opened_at
    END,
    manual_intervention_required = v_new_failure_count >= v_manual_after_failures,
    updated_at = now()
  WHERE id = v_circuit.id;

  v_status := CASE WHEN v_new_state = 'open' THEN 'down' ELSE 'degraded' END;

  UPDATE public.providers
  SET
    health_status = v_status,
    updated_at = now()
  WHERE id = v_provider.id;

  IF v_new_state <> 'open' THEN
    INSERT INTO public.provider_health_logs (
      organization_id,
      provider_id,
      status,
      error_message,
      metadata,
      decision_log_id,
      correlation_id,
      created_at
    )
    VALUES (
      v_org,
      v_provider.id,
      'degraded',
      COALESCE(p_error, format('provider failure status=%s', COALESCE(p_status_code::TEXT, 'unknown'))),
      jsonb_strip_nulls(jsonb_build_object(
        'operation_name', v_template.operation_name,
        'failure_count', v_new_failure_count,
        'status_code', p_status_code
      )),
      NULL,
      p_correlation_id,
      now()
    );
  END IF;

  RETURN jsonb_build_object(
    'applied', TRUE,
    'provider_id', v_provider.id,
    'health_status', v_status,
    'failure_count', v_new_failure_count,
    'circuit_state', v_new_state
  );
END;
$function$;

COMMENT ON FUNCTION public.record_outbound_call_provider_failure_v1(UUID, INT, TEXT, TEXT, UUID)
IS 'Update provider health and circuit-breaker state for a failed provider_api outbound job using provider_failover_policy thresholds.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_outbound_http_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_operation public.operation_templates%ROWTYPE;
  v_payload JSONB;
  v_dispatch JSONB;
  v_priority INT;
  v_outbound_id UUID;
  v_response workflow_handler_response;
  v_context JSONB;
BEGIN
  IF NOT (p_step.metadata ? 'operation_template_id') THEN
    RAISE EXCEPTION 'execute_outbound_http_v1: metadata missing operation_template_id for step %', p_step.id;
  END IF;

  SELECT *
  INTO v_operation
  FROM public.operation_templates
  WHERE id = (p_step.metadata->>'operation_template_id')::UUID;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'execute_outbound_http_v1: operation template % not found for step %',
      p_step.metadata->>'operation_template_id',
      p_step.id;
  END IF;

  v_payload := public.safe_jsonpath_query_first(
    jsonb_build_object(
      'context', COALESCE(p_run.context, '{}'::jsonb),
      'transformed_payload', COALESCE(p_run.context->'transformed_payload', '{}'::jsonb)
    ),
    COALESCE(p_step.metadata->>'payload_path', '$.transformed_payload')
  );

  IF v_payload IS NULL THEN
    v_payload := COALESCE(p_run.context->'transformed_payload', '{}'::jsonb);
  END IF;

  v_dispatch := public.build_outbound_call_dispatch_from_operation_template_v1(
    v_operation.id,
    COALESCE(p_run.context, '{}'::jsonb),
    v_payload,
    COALESCE(p_step.metadata, '{}'::jsonb),
    NULL
  );

  v_priority := COALESCE(NULLIF(p_step.metadata->>'priority', '')::INT, 90);

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'workflow_run_id', p_step.workflow_run_id,
      'workflow_run_step_id', p_step.id,
      'operation_template_id', v_dispatch->>'operation_template_id',
      'operation_name', v_dispatch->>'operation_name',
      'organization_id', COALESCE(p_run.context->>'organization_id', NULL),
      'client_id', COALESCE(p_run.context->>'client_id', NULL),
      'sender_id', COALESCE(p_run.context->>'sender_id', NULL),
      'source_id', COALESCE(p_run.context->>'source_id', NULL),
      'payload', v_payload
    )
  );

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id,
    workflow_run_step_id
  )
  VALUES (
    v_dispatch->>'call_type',
    'provider',
    (v_dispatch->>'provider_id')::UUID,
    v_dispatch->>'method',
    v_dispatch->>'url',
    COALESCE(v_dispatch->'headers', '{}'::jsonb),
    COALESCE(v_dispatch->'body', '{}'::jsonb),
    v_priority,
    p_step.max_retries,
    v_context,
    CASE
      WHEN p_run.context ? 'correlation_id' THEN (p_run.context->>'correlation_id')::UUID
      ELSE NULL
    END,
    p_step.id
  )
  RETURNING id INTO v_outbound_id;

  UPDATE public.workflow_run_steps
  SET operation_result = jsonb_build_object(
      'outbound_call_id', v_outbound_id,
      'headers', COALESCE(v_dispatch->'headers', '{}'::jsonb),
      'body', COALESCE(v_dispatch->'body', '{}'::jsonb)
    ),
    updated_at = now()
  WHERE id = p_step.id;

  v_response.status := 'in_progress';
  v_response.operation_result := jsonb_build_object(
    'outbound_call_id', v_outbound_id,
    'headers', COALESCE(v_dispatch->'headers', '{}'::jsonb),
    'body', COALESCE(v_dispatch->'body', '{}'::jsonb)
  );
  v_response.context_patch := jsonb_build_object('last_outbound_call_id', v_outbound_id);

  RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_outbound_call_from_operation_template_v1(
  p_operation_template_id UUID,
  p_payload JSONB,
  p_job_context JSONB,
  p_correlation_id UUID,
  p_priority INT DEFAULT 90,
  p_max_retries INT DEFAULT 3,
  p_override_url TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_dispatch JSONB;
  v_outbound_id UUID;
BEGIN
  v_dispatch := public.build_outbound_call_dispatch_from_operation_template_v1(
    p_operation_template_id,
    COALESCE(p_job_context, '{}'::jsonb),
    COALESCE(p_payload, '{}'::jsonb),
    '{}'::jsonb,
    p_override_url
  );

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id
  )
  VALUES (
    v_dispatch->>'call_type',
    'provider',
    (v_dispatch->>'provider_id')::UUID,
    v_dispatch->>'method',
    v_dispatch->>'url',
    COALESCE(v_dispatch->'headers', '{}'::jsonb),
    COALESCE(v_dispatch->'body', '{}'::jsonb),
    COALESCE(p_priority, 90),
    GREATEST(COALESCE(p_max_retries, 3), 1),
    jsonb_strip_nulls(COALESCE(p_job_context, '{}'::jsonb) || jsonb_build_object(
      'operation_template_id', v_dispatch->>'operation_template_id',
      'operation_name', v_dispatch->>'operation_name',
      'payload', COALESCE(p_payload, '{}'::jsonb)
    )),
    p_correlation_id
  )
  RETURNING id INTO v_outbound_id;

  RETURN v_outbound_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_outbound_call_failure_v2(
  p_job_id UUID,
  p_status_code INT,
  p_headers JSONB,
  p_body JSONB,
  p_error TEXT,
  p_performed_by_system TEXT,
  p_correlation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_org UUID;
  v_next_retry_count INT;
  v_new_status TEXT;
  v_headers_norm JSONB := public.normalize_headers(COALESCE(p_headers, '{}'::jsonb));

  v_provider_id UUID := NULL;
  v_attempt_number INT := NULL;

  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_policy_scope_type TEXT;
  v_policy_scope_id UUID;
  v_policy_settings_id UUID;
  v_policy_settings_version_id UUID;
  v_policy_version INT;
  v_scope_path JSONB := '[]'::jsonb;
  v_settings_resolution_id UUID;

  v_retryable_codes JSONB := NULL;
  v_retryable_ranges JSONB := NULL;
  v_permanent_ranges JSONB := NULL;
  v_retry_after_header TEXT;
  v_respect_retry_after BOOLEAN := NULL;
  v_backoff JSONB := NULL;
  v_max_delay_seconds INT := NULL;

  v_is_permanent BOOLEAN := FALSE;
  v_is_retryable BOOLEAN := FALSE;
  v_should_retry BOOLEAN := FALSE;
  v_backoff_seconds INT := 0;
  v_retry_after_seconds INT := NULL;
  v_delay_seconds INT := 0;
  v_retry_reason TEXT := NULL;

  v_executor TEXT := NULLIF(btrim(COALESCE(p_performed_by_system, '')), '');
  v_failover_candidate JSONB := NULL;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  IF v_executor IS NULL THEN
    v_executor := 'unknown_executor';
  END IF;

  SELECT *
  INTO v_job
  FROM public.outbound_calls
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Outbound call % not found', p_job_id;
  END IF;

  v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

  IF v_job.target_type = 'provider' THEN
    v_provider_id := v_job.target_id;
  END IF;

  SELECT *
  INTO v_policy_row
  FROM public.resolve_settings_row_from_context(
    'outbound_retry_policy',
    jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org))
  )
  LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing';
  END IF;

  v_policy := v_policy_row.value;
  v_policy_scope_type := v_policy_row.scope_type;
  v_policy_scope_id := v_policy_row.scope_id;
  v_policy_settings_id := v_policy_row.settings_id;
  v_policy_settings_version_id := v_policy_row.settings_version_id;
  v_policy_version := v_policy_row.version;
  v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

  IF v_policy ? 'call_type_overrides' AND jsonb_typeof(v_policy->'call_type_overrides') = 'object' THEN
    v_policy := public.jsonb_deep_merge(
      v_policy,
      COALESCE(v_policy->'call_type_overrides'->v_job.call_type, '{}'::jsonb)
    );
  END IF;

  v_settings_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org,
    p_category := 'outbound_retry_policy',
    p_winning_scope_type := v_policy_scope_type,
    p_winning_scope_id := v_policy_scope_id,
    p_winning_settings_id := v_policy_settings_id,
    p_winning_settings_version_id := v_policy_settings_version_id,
    p_winning_version := v_policy_version,
    p_scope_path := v_scope_path,
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'job_id', p_job_id,
      'call_type', v_job.call_type,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id,
      'status_code', p_status_code,
      'executor', v_executor
    )),
    p_merge_notes := NULL
  );

  v_retryable_codes := v_policy#>'{http,retryable_status_codes}';
  v_retryable_ranges := v_policy#>'{http,retryable_status_ranges}';
  v_permanent_ranges := v_policy#>'{http,permanent_status_ranges}';
  v_retry_after_header := lower(NULLIF(v_policy#>>'{http,retry_after_header}', ''));
  v_respect_retry_after := NULLIF(v_policy->>'respect_retry_after', '')::BOOLEAN;
  v_backoff := v_policy->'backoff_seconds';
  v_max_delay_seconds := NULLIF(v_policy->>'max_retry_delay_seconds', '')::INT;

  IF v_retry_after_header IS NULL THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_retry_after_header';
  END IF;
  IF v_retryable_codes IS NULL OR jsonb_typeof(v_retryable_codes) <> 'array' THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_codes';
  END IF;
  IF v_retryable_ranges IS NULL OR jsonb_typeof(v_retryable_ranges) <> 'array' THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_retryable_status_ranges';
  END IF;
  IF v_permanent_ranges IS NULL OR jsonb_typeof(v_permanent_ranges) <> 'array' THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_permanent_status_ranges';
  END IF;
  IF v_respect_retry_after IS NULL THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_respect_retry_after';
  END IF;
  IF jsonb_typeof(v_backoff) <> 'array' OR jsonb_array_length(v_backoff) = 0 THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_backoff_seconds';
  END IF;
  IF v_max_delay_seconds IS NULL OR v_max_delay_seconds < 0 THEN
    RAISE EXCEPTION 'outbound_retry_policy_missing_max_retry_delay_seconds';
  END IF;

  v_next_retry_count := v_job.retry_count + 1;
  v_attempt_number := v_next_retry_count;

  v_is_retryable := EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(v_retryable_codes) AS c(val)
    WHERE (c.val)::INT = p_status_code
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_retryable_ranges) AS r(elem)
    WHERE jsonb_typeof(r.elem) = 'array'
      AND jsonb_array_length(r.elem) = 2
      AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
  );

  v_is_permanent := (NOT v_is_retryable) AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_permanent_ranges) AS r(elem)
    WHERE jsonb_typeof(r.elem) = 'array'
      AND jsonb_array_length(r.elem) = 2
      AND p_status_code BETWEEN (r.elem->>0)::INT AND (r.elem->>1)::INT
  );

  v_should_retry := v_is_retryable AND (v_next_retry_count < v_job.max_retries);

  SELECT COALESCE(NULLIF(value, '')::INT, 0)
  INTO v_backoff_seconds
  FROM jsonb_array_elements_text(v_backoff) WITH ORDINALITY AS arr(value, idx)
  WHERE idx = LEAST(jsonb_array_length(v_backoff), GREATEST(1, v_next_retry_count))
  LIMIT 1;

  v_delay_seconds := GREATEST(COALESCE(v_backoff_seconds, 0), 0);

  IF v_respect_retry_after THEN
    BEGIN
      v_retry_after_seconds := NULLIF(v_headers_norm->>v_retry_after_header, '')::INT;
    EXCEPTION
      WHEN others THEN
        v_retry_after_seconds := NULL;
    END;
    IF v_retry_after_seconds IS NOT NULL AND v_retry_after_seconds > v_delay_seconds THEN
      v_delay_seconds := v_retry_after_seconds;
    END IF;
  END IF;

  IF v_max_delay_seconds IS NOT NULL AND v_max_delay_seconds > 0 THEN
    v_delay_seconds := LEAST(v_delay_seconds, v_max_delay_seconds);
  END IF;

  IF v_should_retry THEN
    v_failover_candidate := public.resolve_outbound_failover_candidate_v1(
      p_job_id,
      'http_failure',
      p_status_code,
      p_error
    );
  END IF;

  IF v_should_retry THEN
    v_new_status := 'failed';
    v_retry_reason := CASE
      WHEN COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN 'provider_failover_scheduled'
      ELSE 'retry_scheduled'
    END;
  ELSE
    v_new_status := 'permanently_failed';
    v_retry_reason := CASE
      WHEN v_is_permanent THEN 'permanent_status_code'
      WHEN NOT v_is_retryable THEN 'not_retryable_by_policy'
      WHEN v_next_retry_count >= v_job.max_retries THEN 'max_retries_exhausted'
      ELSE 'retry_disallowed'
    END;
  END IF;

  UPDATE public.outbound_calls
  SET
    status = v_new_status,
    retry_count = v_next_retry_count,
    response_status_code = p_status_code,
    response_headers = COALESCE(p_headers, '{}'::jsonb),
    response_body = COALESCE(p_body, '{}'::jsonb),
    error_message = p_error,
    scheduled_at = CASE
      WHEN v_new_status = 'failed' THEN now() + make_interval(secs => COALESCE(NULLIF(v_failover_candidate->>'delay_seconds', '')::INT, v_delay_seconds))
      ELSE public.outbound_calls.scheduled_at
    END,
    completed_at = CASE WHEN v_new_status = 'permanently_failed' THEN now() ELSE NULL END,
    lease_expires_at = NULL,
    context = CASE
      WHEN context IS NULL THEN NULL
      ELSE (context - 'edge_dispatch' - 'async_request_id')
    END
  WHERE id = p_job_id;

  PERFORM public.record_outbound_call_provider_failure_v1(
    p_job_id,
    p_status_code,
    p_error,
    v_executor,
    p_correlation_id
  );

  IF COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN
    PERFORM public.apply_outbound_call_failover_v1(
      p_job_id,
      v_failover_candidate,
      v_executor,
      p_correlation_id
    );
  END IF;

  IF v_job.call_type IN ('comms_whatsapp', 'comms_sms', 'comms_email', 'comms_voice')
     AND v_provider_id IS NOT NULL
     AND v_attempt_number IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.comms_attempts ca
      WHERE ca.outbound_call_id = p_job_id
        AND ca.attempt_number = v_attempt_number
    ) THEN
      INSERT INTO public.comms_attempts (
        outbound_call_id,
        provider_id,
        attempt_number,
        status,
        provider_message_id,
        error_code,
        error_message,
        cost,
        timestamp
      )
      VALUES (
        p_job_id,
        v_provider_id,
        v_attempt_number,
        'failed',
        NULL,
        v_retry_reason,
        p_error,
        v_job.cost,
        now()
      );
    END IF;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'outbound_call',
    p_resource_type := 'outbound_call',
    p_resource_id := p_job_id,
    p_decision_point := 'http_execution',
    p_decision_outcome := v_new_status,
    p_performed_by_system := v_executor,
    p_correlation_id := p_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'status', p_status_code,
      'error', p_error,
      'next_retry_count', v_next_retry_count,
      'max_retries', v_job.max_retries,
      'retryable', v_is_retryable,
      'permanent', v_is_permanent,
      'retry_after_seconds', v_retry_after_seconds,
      'delay_seconds', COALESCE(NULLIF(v_failover_candidate->>'delay_seconds', '')::INT, v_delay_seconds),
      'retry_reason', v_retry_reason,
      'failover_applied', COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE),
      'failover_to_provider_id', v_failover_candidate->>'to_provider_id'
    )),
    p_decision_reason := format('Outbound HTTP request failed (executor=%s).', v_executor),
    p_settings_resolution_id := v_settings_resolution_id
  );

  IF v_new_status = 'permanently_failed' THEN
    BEGIN
      PERFORM public.finalize_outbound_workflow_step_v1(p_job_id, v_executor);
    EXCEPTION
      WHEN others THEN
        NULL;
    END;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_edge_jobs(p_batch INT DEFAULT 10)
RETURNS TABLE (
  job_id UUID,
  dispatch JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_limit INT := GREATEST(COALESCE(p_batch, 10), 1);
  v_candidate RECORD;
  v_optout JSONB;
  v_effective_context JSONB := '{}'::jsonb;
  v_org_text TEXT;
  v_org_id UUID;
  v_spec JSONB;
  v_dispatch JSONB;
  v_error TEXT;
  v_failover_candidate JSONB;
BEGIN
  IF to_regclass('public.outbound_calls') IS NULL THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT
      oc.id,
      oc.call_type,
      oc.shipment_id,
      oc.context
    FROM public.outbound_calls oc
    WHERE oc.status IN ('pending_edge', 'failed')
      AND oc.scheduled_at <= now()
      AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
      AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
    ORDER BY oc.priority DESC, oc.scheduled_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_candidate.call_type = 'provider_api' THEN
      v_failover_candidate := public.resolve_outbound_failover_candidate_v1(
        v_candidate.id,
        'claim_pending_edge_jobs',
        NULL,
        NULL
      );
      IF COALESCE((v_failover_candidate->>'applied')::BOOLEAN, FALSE) THEN
        PERFORM public.apply_outbound_call_failover_v1(
          v_candidate.id,
          v_failover_candidate,
          'claim_pending_edge_jobs',
          NULL
        );
      END IF;
    END IF;

    SELECT COALESCE(oc.context, '{}'::jsonb)
    INTO v_effective_context
    FROM public.outbound_calls oc
    WHERE oc.id = v_candidate.id;

    v_optout := public.should_skip_outbound_call_for_opt_out(
      v_candidate.call_type,
      v_candidate.shipment_id,
      v_effective_context
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
      UPDATE public.outbound_calls oc
      SET
        status = 'skipped',
        error_message = COALESCE(v_optout->>'reason', 'skipped'),
        completed_at = now(),
        lease_expires_at = NULL
      WHERE oc.id = v_candidate.id;

      v_org_text := COALESCE(v_effective_context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM public.log_decision(
          p_organization_id := v_org_text::UUID,
          p_decision_category := 'outbound_call',
          p_resource_type := 'outbound_call',
          p_resource_id := v_candidate.id,
          p_decision_point := 'opt_out_enforcement',
          p_decision_outcome := 'skipped',
          p_performed_by_system := 'claim_pending_edge_jobs',
          p_correlation_id := NULL,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'reason', v_optout->>'reason',
            'recipient_id', v_optout->>'recipient_id',
            'channel', v_optout->>'channel'
          )),
          p_decision_reason := 'Outbound call suppressed by opt-out policy.'
        );
      END IF;

      CONTINUE;
    END IF;

    BEGIN
      v_spec := public.get_job_call_spec(v_candidate.id);
    EXCEPTION
      WHEN others THEN
        v_error := SQLERRM;

        UPDATE public.outbound_calls oc
        SET
          status = 'permanently_failed',
          error_message = v_error,
          completed_at = now(),
          lease_expires_at = NULL
        WHERE oc.id = v_candidate.id;

        v_org_id := NULL;
        v_org_text := COALESCE(v_effective_context->>'organization_id', '');
        IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_org_id := v_org_text::UUID;
        END IF;

        IF v_org_id IS NOT NULL THEN
          PERFORM public.log_decision(
            p_organization_id := v_org_id,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := v_candidate.id,
            p_decision_point := 'edge_claim_spec',
            p_decision_outcome := 'permanently_failed',
            p_performed_by_system := 'claim_pending_edge_jobs',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'call_type', v_candidate.call_type,
              'reason', 'spec_resolution_failed',
              'error', v_error
            )),
            p_decision_reason := 'Edge claim skipped due to invalid job spec (get_job_call_spec failure).'
          );
        END IF;

        CONTINUE;
    END;

    UPDATE public.outbound_calls oc
    SET
      status = 'in_progress_edge',
      lease_expires_at = now() + interval '5 minutes'
    WHERE oc.id = v_candidate.id;

    v_dispatch := jsonb_build_object(
      'url', COALESCE((v_effective_context->'edge_dispatch')->>'url', v_spec->>'url'),
      'method', COALESCE(upper((v_effective_context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
      'headers', COALESCE((v_effective_context->'edge_dispatch')->'headers', v_spec->'headers', '{}'::jsonb),
      'body', COALESCE((v_effective_context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
      'timeout_seconds', COALESCE(
        NULLIF((v_effective_context->'edge_dispatch')->>'timeout_seconds', '')::INT,
        NULLIF(v_spec->>'timeout_seconds', '')::INT,
        30
      )
    );

    job_id := v_candidate.id;
    dispatch := v_dispatch;
    RETURN NEXT;
  END LOOP;
END;
$function$;

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_new_entries JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'provider_health_latest',
      'label', 'Provider health',
      'relation', 'public.provider_health_latest_v',
      'id_column', 'provider_id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'integrations.read',
      'select', jsonb_build_array(
        'organization_id', 'provider_id', 'provider_name', 'status', 'error_message', 'metadata', 'decision_log_id', 'correlation_id', 'created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'provider_id', 'column', 'provider_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'provider_name', 'column', 'provider_name', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'circuit_breaker_dashboard',
      'label', 'Circuit breaker',
      'relation', 'public.circuit_breaker_dashboard_v',
      'id_column', 'provider_id',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'capability_read', 'integrations.read',
      'select', jsonb_build_array(
        'organization_id', 'provider_id', 'provider_name', 'operation_name', 'state', 'failure_count', 'success_count', 'reopen_count', 'manual_intervention_required', 'last_failure_at', 'last_success_at', 'opened_at', 'half_open_test_at', 'last_recovery_attempt_at', 'updated_at', 'last_health_status', 'last_health_error', 'last_health_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'provider_id', 'column', 'provider_id', 'op', 'eq'),
        jsonb_build_object('key', 'state', 'column', 'state', 'op', 'eq'),
        jsonb_build_object('key', 'provider_name', 'column', 'provider_name', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    )
  );
BEGIN
  SELECT cached_value
  INTO v_current
  FROM public.settings
  WHERE category = 'ui_read_registry'
    AND scope_type = 'global'
    AND scope_id IS NULL
  ORDER BY last_updated DESC
  LIMIT 1;

  IF v_current IS NULL THEN
    RETURN;
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resources) AS item(entry)
    WHERE entry->>'key' = 'provider_health_latest'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_new_entries->0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resources) AS item(entry)
    WHERE entry->>'key' = 'circuit_breaker_dashboard'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_new_entries->1);
  END IF;

  PERFORM 1
  FROM public.upsert_settings_value_v1(
    'ui_read_registry',
    'global',
    NULL,
    jsonb_set(v_current, '{resources}', v_resources, TRUE),
    COALESCE((v_current->>'version')::INT, 1),
    'Add provider health + circuit breaker dashboard resources'
  );
END;
$do$;

COMMIT;
