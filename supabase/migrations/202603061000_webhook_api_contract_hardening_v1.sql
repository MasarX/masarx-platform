-- Plan: PLAN-202603-webhook-api-hardening-remediation / Step: S04
-- Migration: Webhook/API contract hardening v1
-- Purpose:
--   - Add canonical shipment intent normalization helpers.
--   - Seed shipment_operation_policy and outbound_egress_policy as row-driven categories.
--   - Replace resolve_api_route_v1 hardcoded precedence with registry-driven scope resolution.
--   - Harden reserve_identifiers and workflow_intake_webhook semantics.

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
VALUES
  (
    'shipment_operation_policy',
    'Shipment mutation policy resolved via ladder for modify/delete/address/geocode/driver/action/attachment intents.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant","client","sender","source"]'::jsonb
  ),
  (
    'outbound_egress_policy',
    'Universal outbound egress policy resolved via ladder for provider_api, client_webhook, comms_*, and plugin-managed jobs.',
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
VALUES
  (
    'shipment_operation_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', FALSE,
      'required', jsonb_build_array('version'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'modify', jsonb_build_object('type', 'object'),
        'delete', jsonb_build_object('type', 'object'),
        'address', jsonb_build_object('type', 'object'),
        'geocode', jsonb_build_object('type', 'object'),
        'driver', jsonb_build_object('type', 'object'),
        'action', jsonb_build_object('type', 'object'),
        'attachment', jsonb_build_object('type', 'object')
      )
    ),
    'Shipment mutation policy defaults and guardrails resolved via ladder.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'modify', jsonb_build_object(
          'allowed_fields', jsonb_build_array(
            'carrier_reference_number',
            'client_reference_number',
            'cod_amount',
            'metadata',
            'references',
            'service_level',
            'service_type',
            'special_instructions'
          ),
          'allowed_statuses', jsonb_build_array('pending', 'created')
        ),
        'delete', jsonb_build_object(
          'mode', 'soft_cancel',
          'target_status', 'cancelled',
          'allowed_statuses', jsonb_build_array('pending', 'created'),
          'window_hours', 24
        ),
        'address', jsonb_build_object(
          'allowed_statuses', jsonb_build_array('pending', 'created', 'delivery_failed', 'postponed_delivery'),
          'validation_status', 'pending',
          're_geocode', TRUE,
          'geocode_template_name', 'workflow_geocoding_standard'
        ),
        'geocode', jsonb_build_object(
          'workflow_template_name', 'workflow_geocoding_standard'
        ),
        'driver', jsonb_build_object(
          'allow_unassign', TRUE,
          'allowed_statuses', jsonb_build_array('pending', 'created', 'out_for_delivery')
        ),
        'action', jsonb_build_object(
          'default_action_type', 'note',
          'default_action_category', 'operational'
        ),
        'attachment', jsonb_build_object(
          'max_items_per_event', 10,
          'max_size_bytes', 10485760,
          'allowed_mime_types', jsonb_build_array('image/jpeg', 'image/png', 'application/pdf'),
          'relation_type', 'evidence'
        )
      )
    ),
    TRUE
  ),
  (
    'outbound_egress_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', FALSE,
      'required', jsonb_build_array('version', 'policy'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'policy', jsonb_build_object('type', 'object')
      )
    ),
    'Universal outbound egress policy resolved via ladder and merged with plugin restrictions.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'policy', jsonb_build_object(
          'enforce_https_only', TRUE,
          'block_private_networks', TRUE,
          'domain_allowlist', jsonb_build_array(),
          'domain_denylist', jsonb_build_array(),
          'allowed_methods', jsonb_build_array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
          'max_payload_bytes', 262144,
          'max_timeout_seconds', 60,
          'follow_redirects', FALSE,
          'header_allowlist', jsonb_build_array('accept', 'content-type', 'authorization', 'x-api-key', 'api-key', 'user-agent')
        )
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
    'modify', jsonb_build_object(
      'allowed_fields', jsonb_build_array(
        'carrier_reference_number',
        'client_reference_number',
        'cod_amount',
        'metadata',
        'references',
        'service_level',
        'service_type',
        'special_instructions'
      ),
      'allowed_statuses', jsonb_build_array('pending', 'created')
    ),
    'delete', jsonb_build_object(
      'mode', 'soft_cancel',
      'target_status', 'cancelled',
      'allowed_statuses', jsonb_build_array('pending', 'created'),
      'window_hours', 24
    ),
    'address', jsonb_build_object(
      'allowed_statuses', jsonb_build_array('pending', 'created', 'delivery_failed', 'postponed_delivery'),
      'validation_status', 'pending',
      're_geocode', TRUE,
      'geocode_template_name', 'workflow_geocoding_standard'
    ),
    'geocode', jsonb_build_object(
      'workflow_template_name', 'workflow_geocoding_standard'
    ),
    'driver', jsonb_build_object(
      'allow_unassign', TRUE,
      'allowed_statuses', jsonb_build_array('pending', 'created', 'out_for_delivery')
    ),
    'action', jsonb_build_object(
      'default_action_type', 'note',
      'default_action_category', 'operational'
    ),
    'attachment', jsonb_build_object(
      'max_items_per_event', 10,
      'max_size_bytes', 10485760,
      'allowed_mime_types', jsonb_build_array('image/jpeg', 'image/png', 'application/pdf'),
      'relation_type', 'evidence'
    )
  );
  PERFORM 1 FROM public.upsert_settings_value_v1(
    'shipment_operation_policy',
    'global',
    NULL,
    v_value,
    1,
    'Seed global shipment_operation_policy default'
  );

  v_value := jsonb_build_object(
    'version', 1,
    'policy', jsonb_build_object(
      'enforce_https_only', TRUE,
      'block_private_networks', TRUE,
      'domain_allowlist', jsonb_build_array(),
      'domain_denylist', jsonb_build_array(),
      'allowed_methods', jsonb_build_array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
      'max_payload_bytes', 262144,
      'max_timeout_seconds', 60,
      'follow_redirects', FALSE,
      'header_allowlist', jsonb_build_array('accept', 'content-type', 'authorization', 'x-api-key', 'api-key', 'user-agent')
    )
  );
  PERFORM 1 FROM public.upsert_settings_value_v1(
    'outbound_egress_policy',
    'global',
    NULL,
    v_value,
    1,
    'Seed global outbound_egress_policy default'
  );
END;
$do$;

CREATE OR REPLACE FUNCTION public.normalize_shipment_intent_v1(
  p_intent TEXT,
  p_event_type TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(p_intent, '')), ''));
  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(p_event_type, '')), ''));
BEGIN
  IF v_intent IN (
    'shipment.create',
    'shipment.swap',
    'shipment.return',
    'shipment.modify',
    'shipment.delete',
    'update.status',
    'update.geocode',
    'update.address',
    'update.driver',
    'update.action',
    'update.attachment'
  ) THEN
    RETURN v_intent;
  END IF;

  CASE COALESCE(v_intent, v_event_type)
    WHEN 'shipment_create' THEN RETURN 'shipment.create';
    WHEN 'shipment_swap' THEN RETURN 'shipment.swap';
    WHEN 'shipment_return' THEN RETURN 'shipment.return';
    WHEN 'shipment_modify' THEN RETURN 'shipment.modify';
    WHEN 'shipment_delete' THEN RETURN 'shipment.delete';
    WHEN 'status_update' THEN RETURN 'update.status';
    WHEN 'shipment_status_update' THEN RETURN 'update.status';
    WHEN 'shipment_update_status' THEN RETURN 'update.status';
    WHEN 'shipment_update_geocode' THEN RETURN 'update.geocode';
    WHEN 'shipment_update_address' THEN RETURN 'update.address';
    WHEN 'shipment_update_driver' THEN RETURN 'update.driver';
    WHEN 'shipment_update_action' THEN RETURN 'update.action';
    WHEN 'shipment_update_attachment' THEN RETURN 'update.attachment';
    WHEN 'shipment.created' THEN RETURN 'shipment.create';
    WHEN 'shipment.updated' THEN RETURN 'update.status';
    WHEN 'shipment.canceled' THEN RETURN 'shipment.delete';
    WHEN 'shipment.cancelled' THEN RETURN 'shipment.delete';
    ELSE
      RETURN COALESCE(v_intent, v_event_type);
  END CASE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.should_reserve_identifiers_for_shipment_intent_v1(
  p_canonical_intent TEXT,
  p_policy JSONB DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_intent TEXT := lower(NULLIF(btrim(COALESCE(p_canonical_intent, '')), ''));
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_workflow JSONB := COALESCE(v_policy->'workflow', '{}'::jsonb);
  v_flag TEXT;
BEGIN
  CASE v_intent
    WHEN 'shipment.create' THEN
      RETURN TRUE;
    WHEN 'shipment.return' THEN
      v_flag := lower(COALESCE(v_workflow->>'reserve_identifiers', v_workflow->>'reserve_new_tracking', 'true'));
      RETURN v_flag NOT IN ('0', 'false', 'no');
    WHEN 'shipment.swap' THEN
      v_flag := lower(COALESCE(v_workflow->>'reserve_new_tracking', v_workflow->>'reserve_identifiers', 'false'));
      RETURN v_flag IN ('1', 'true', 'yes');
    ELSE
      RETURN FALSE;
  END CASE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.jsonb_text_array_union_v1(
  p_left JSONB,
  p_right JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(to_jsonb(v.val) ORDER BY v.val),
    '[]'::jsonb
  )
  FROM (
    SELECT DISTINCT lower(btrim(value)) AS val
    FROM (
      SELECT jsonb_array_elements_text(COALESCE(CASE WHEN jsonb_typeof(p_left) = 'array' THEN p_left ELSE '[]'::jsonb END, '[]'::jsonb)) AS value
      UNION ALL
      SELECT jsonb_array_elements_text(COALESCE(CASE WHEN jsonb_typeof(p_right) = 'array' THEN p_right ELSE '[]'::jsonb END, '[]'::jsonb)) AS value
    ) src
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) v;
$$;

CREATE OR REPLACE FUNCTION public.jsonb_text_array_intersection_v1(
  p_left JSONB,
  p_right JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  WITH left_vals AS (
    SELECT DISTINCT lower(btrim(value)) AS val
    FROM jsonb_array_elements_text(COALESCE(CASE WHEN jsonb_typeof(p_left) = 'array' THEN p_left ELSE '[]'::jsonb END, '[]'::jsonb)) value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ),
  right_vals AS (
    SELECT DISTINCT lower(btrim(value)) AS val
    FROM jsonb_array_elements_text(COALESCE(CASE WHEN jsonb_typeof(p_right) = 'array' THEN p_right ELSE '[]'::jsonb END, '[]'::jsonb)) value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  )
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM left_vals) = 0 THEN COALESCE((SELECT jsonb_agg(to_jsonb(val) ORDER BY val) FROM right_vals), '[]'::jsonb)
    WHEN (SELECT COUNT(*) FROM right_vals) = 0 THEN COALESCE((SELECT jsonb_agg(to_jsonb(val) ORDER BY val) FROM left_vals), '[]'::jsonb)
    ELSE COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(val) ORDER BY val)
        FROM (
          SELECT l.val
          FROM left_vals l
          JOIN right_vals r ON r.val = l.val
        ) x
      ),
      '[]'::jsonb
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_shipment_operation_policy_v1(
  p_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
BEGIN
  SELECT value
    INTO v_policy
    FROM public.resolve_settings_row_from_context(
      'shipment_operation_policy',
      jsonb_strip_nulls(COALESCE(p_context, '{}'::jsonb))
    )
    LIMIT 1;

  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'Missing shipment_operation_policy'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_policy;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_effective_outbound_egress_policy_v1(
  p_job_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
  v_org_id UUID;
  v_context JSONB;
  v_base_row RECORD;
  v_base_policy JSONB;
  v_plugin JSONB;
  v_plugin_policy JSONB;
  v_effective JSONB;
  v_settings_resolution_id UUID;
BEGIN
  SELECT *
    INTO v_job
    FROM public.outbound_calls
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_effective_outbound_egress_policy_v1: outbound_call % not found', p_job_id
      USING ERRCODE = '23503';
  END IF;

  v_org_id := public.resolve_organization_id_strict('outbound_call', p_job_id);
  v_context := jsonb_strip_nulls(COALESCE(v_job.context, '{}'::jsonb) || jsonb_build_object(
    'organization_id', v_org_id,
    'call_type', v_job.call_type
  ));

  SELECT *
    INTO v_base_row
    FROM public.resolve_settings_row_from_context('outbound_egress_policy', v_context)
    LIMIT 1;

  IF NOT FOUND OR v_base_row.value IS NULL THEN
    RAISE EXCEPTION 'outbound_egress_policy_missing'
      USING ERRCODE = '23514';
  END IF;

  v_base_policy := COALESCE(v_base_row.value->'policy', '{}'::jsonb);

  v_settings_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org_id,
    p_category := 'outbound_egress_policy',
    p_winning_scope_type := v_base_row.scope_type,
    p_winning_scope_id := v_base_row.scope_id,
    p_winning_settings_id := v_base_row.settings_id,
    p_winning_settings_version_id := v_base_row.settings_version_id,
    p_winning_version := v_base_row.version,
    p_scope_path := COALESCE(v_base_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'call_type', v_job.call_type,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id
    )),
    p_merge_notes := NULL
  );

  BEGIN
    SELECT public.resolve_integration_plugin_egress_policy_for_job_v1(p_job_id)
      INTO v_plugin;
  EXCEPTION
    WHEN undefined_function THEN
      v_plugin := NULL;
  END;

  v_plugin_policy := COALESCE(v_plugin->'policy', '{}'::jsonb);
  v_effective := v_base_policy;

  IF COALESCE((v_plugin->>'enforce')::BOOLEAN, FALSE) THEN
    v_effective := jsonb_strip_nulls(v_effective || jsonb_build_object(
      'enforce_https_only', COALESCE((v_base_policy->>'enforce_https_only')::BOOLEAN, TRUE)
        OR COALESCE((v_plugin_policy->>'enforce_https_only')::BOOLEAN, FALSE),
      'block_private_networks', COALESCE((v_base_policy->>'block_private_networks')::BOOLEAN, TRUE)
        OR COALESCE((v_plugin_policy->>'block_private_networks')::BOOLEAN, FALSE),
      'follow_redirects', COALESCE((v_base_policy->>'follow_redirects')::BOOLEAN, FALSE)
        AND COALESCE((v_plugin_policy->>'follow_redirects')::BOOLEAN, FALSE),
      'max_payload_bytes', LEAST(
        COALESCE(NULLIF(v_base_policy->>'max_payload_bytes', '')::INT, 262144),
        COALESCE(NULLIF(v_plugin_policy->>'max_payload_bytes', '')::INT, 262144)
      ),
      'max_timeout_seconds', LEAST(
        COALESCE(NULLIF(v_base_policy->>'max_timeout_seconds', '')::INT, 60),
        COALESCE(NULLIF(v_plugin_policy->>'max_timeout_seconds', '')::INT, 60)
      ),
      'domain_denylist', public.jsonb_text_array_union_v1(v_base_policy->'domain_denylist', v_plugin_policy->'domain_denylist')
    ));
    v_effective := jsonb_set(v_effective, '{domain_allowlist}', public.jsonb_text_array_intersection_v1(v_base_policy->'domain_allowlist', v_plugin_policy->'domain_allowlist'), TRUE);
    v_effective := jsonb_set(v_effective, '{allowed_methods}', public.jsonb_text_array_intersection_v1(v_base_policy->'allowed_methods', v_plugin_policy->'allowed_methods'), TRUE);
    v_effective := jsonb_set(v_effective, '{header_allowlist}', public.jsonb_text_array_intersection_v1(v_base_policy->'header_allowlist', v_plugin_policy->'header_allowlist'), TRUE);
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'enforce', TRUE,
    'managed_by', COALESCE(v_plugin->>'managed_by', v_job.context->>'managed_by'),
    'organization_id', v_org_id,
    'settings_resolution_id', v_settings_resolution_id,
    'policy', v_effective
  ));
END;
$function$;

-- The remaining resolver/function replacements are appended below to keep this migration atomic.
CREATE OR REPLACE FUNCTION public.resolve_api_route_v1(
  p_method TEXT,
  p_path TEXT,
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_method TEXT := upper(COALESCE(p_method, ''));
  v_path TEXT := public.normalize_api_path(p_path);
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_start_scope_type TEXT := NULL;
  v_start_scope_id UUID := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_candidate RECORD;
  v_settings_resolution_id UUID;
BEGIN
  IF v_method = '' THEN
    RETURN jsonb_build_object('found', FALSE, 'reason', 'method_missing');
  END IF;

  WITH candidates AS (
    SELECT scope_type, scope_id
    FROM (
      SELECT r.scope_type, p_source_id AS scope_id
      FROM public.scope_type_registry r
      WHERE r.entity_table = 'webhook_sources'::regclass
        AND r.is_enabled = TRUE
        AND p_source_id IS NOT NULL
      UNION ALL
      SELECT r.scope_type, p_sender_id AS scope_id
      FROM public.scope_type_registry r
      WHERE r.entity_table = 'senders'::regclass
        AND r.is_enabled = TRUE
        AND p_sender_id IS NOT NULL
      UNION ALL
      SELECT r.scope_type, p_client_id AS scope_id
      FROM public.scope_type_registry r
      WHERE r.entity_table = 'clients'::regclass
        AND r.is_enabled = TRUE
        AND p_client_id IS NOT NULL
      UNION ALL
      SELECT r.scope_type, p_organization_id AS scope_id
      FROM public.scope_type_registry r
      WHERE r.entity_table = 'organizations'::regclass
        AND r.is_enabled = TRUE
        AND p_organization_id IS NOT NULL
    ) x
  )
  SELECT c.scope_type, c.scope_id
    INTO v_start_scope_type, v_start_scope_id
    FROM candidates c
    JOIN public.scope_type_registry r
      ON r.scope_type = c.scope_type
   ORDER BY COALESCE(r.ladder_rank, -1) DESC, c.scope_type
   LIMIT 1;

  IF v_start_scope_type IS NULL THEN
    v_scope_path := jsonb_build_array(jsonb_build_object('scope_type', v_root, 'scope_id', NULL));
  ELSE
    v_scope_path := public.resolve_scope_path_v1(v_start_scope_type, v_start_scope_id);
  END IF;

  SELECT
    r.*,
    public.api_extract_path_params(v_path, r.path_template) AS path_params,
    public.api_path_template_specificity_score(r.path_template) AS specificity
  INTO v_candidate
  FROM jsonb_array_elements(v_scope_path) WITH ORDINALITY AS e(elem, ord)
  JOIN public.api_routes r
    ON r.scope_type = e.elem->>'scope_type'
   AND r.scope_id IS NOT DISTINCT FROM (e.elem->>'scope_id')::UUID
  JOIN public.api_route_packs p
    ON p.id = r.pack_id
   AND p.enabled = TRUE
  WHERE r.enabled = TRUE
    AND upper(r.method) = v_method
    AND public.api_match_path_template(v_path, r.path_template)
  ORDER BY e.ord, specificity DESC, r.updated_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', FALSE, 'reason', 'route_not_found');
  END IF;

  v_settings_resolution_id := public.log_settings_resolution(
    p_organization_id := p_organization_id,
    p_category := 'api_gateway_route',
    p_winning_scope_type := v_candidate.scope_type,
    p_winning_scope_id := v_candidate.scope_id,
    p_winning_settings_id := v_candidate.id,
    p_winning_settings_version_id := NULL,
    p_winning_version := NULL,
    p_scope_path := v_scope_path,
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'method', v_method,
      'path', v_path
    )),
    p_merge_notes := NULL
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'found', TRUE,
    'route_id', v_candidate.id,
    'route_name', v_candidate.route_name,
    'scope_type', v_candidate.scope_type,
    'scope_id', v_candidate.scope_id,
    'path_params', COALESCE(v_candidate.path_params, '{}'::jsonb),
    'settings_resolution_id', v_settings_resolution_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.reserve_identifiers_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_resource_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'resource_type', ''),
        NULLIF(v_ctx->>'resource_type', ''),
        'shipment'
    );
    v_reserve_identifiers BOOLEAN := TRUE;
    v_tracking_scope_type TEXT := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_type', ''),
        NULLIF(v_ctx->>'tracking_scope_type', '')
    );
    v_tracking_scope_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'tracking_scope_id', '')::UUID,
        NULLIF(v_ctx->>'tracking_scope_id', '')::UUID
    );
    v_org UUID := NULLIF(v_ctx->>'organization_id', '')::UUID;
    v_client UUID := NULLIF(v_ctx->>'client_id', '')::UUID;
    v_sender UUID := NULLIF(v_ctx->>'sender_id', '')::UUID;
    v_planned_id UUID := NULLIF(v_ctx->>'planned_resource_id', '')::UUID;
    v_planned_tracking TEXT := NULLIF(v_ctx->>'planned_tracking_number', '');
    v_tracking_policy JSONB;
    v_response public.workflow_handler_response;
BEGIN
    IF lower(COALESCE(v_step_metadata->>'reserve_identifiers', v_ctx->>'reserve_identifiers', 'true')) IN ('0', 'false', 'no') THEN
        v_reserve_identifiers := FALSE;
    END IF;
    IF lower(COALESCE(v_step_metadata->>'reserve_new_tracking', v_ctx->>'reserve_new_tracking', 'true')) IN ('0', 'false', 'no')
       AND v_resource_type = 'shipment' THEN
        v_reserve_identifiers := FALSE;
    END IF;

    IF NOT v_reserve_identifiers THEN
        v_response.status := 'completed';
        v_response.workflow_status := NULL;
        v_response.next_run_at := NULL;
        v_response.retry_attempt := 1;
        v_response.max_retries := 1;
        v_response.last_error := NULL;
        v_response.context_patch := '{}'::jsonb;
        v_response.operation_result := jsonb_build_object(
          'resource_type', v_resource_type,
          'reserved', FALSE
        );
        RETURN v_response;
    END IF;

    IF v_tracking_scope_type IS NULL THEN
        IF v_client IS NOT NULL THEN
            v_tracking_scope_type := 'client';
        ELSIF v_sender IS NOT NULL THEN
            v_tracking_scope_type := 'sender';
        ELSE
            v_tracking_scope_type := 'tenant';
        END IF;
    END IF;

    IF v_tracking_scope_id IS NULL THEN
        IF v_tracking_scope_type = 'client' THEN
            v_tracking_scope_id := v_client;
        ELSIF v_tracking_scope_type = 'sender' THEN
            v_tracking_scope_id := v_sender;
        ELSE
            v_tracking_scope_id := v_org;
        END IF;
    END IF;

    IF v_tracking_scope_id IS NULL OR v_tracking_scope_type IS NULL THEN
        RAISE EXCEPTION 'reserve_identifiers_v1: unable to determine tracking scope (type %, id %)', v_tracking_scope_type, v_tracking_scope_id;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    IF v_resource_type = 'shipment' THEN
        IF v_planned_tracking IS NULL THEN
            v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
            v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
        END IF;
        v_response.context_patch := jsonb_build_object(
            'planned_resource_id', v_planned_id,
            'planned_tracking_number', v_planned_tracking,
            'planned_shipment_id', v_planned_id
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id,
            'planned_tracking_number', v_planned_tracking,
            'reserved', TRUE
        );
    ELSE
        v_response.context_patch := jsonb_build_object(
            'planned_resource_id', v_planned_id
        );
        v_response.operation_result := jsonb_build_object(
            'resource_type', v_resource_type,
            'tracking_scope_type', v_tracking_scope_type,
            'tracking_scope_id', v_tracking_scope_id,
            'planned_resource_id', v_planned_id,
            'reserved', TRUE
        );
    END IF;

    v_response.status := 'completed';
    v_response.workflow_status := NULL;
    v_response.next_run_at := NULL;
    v_response.retry_attempt := 1;
    v_response.max_retries := 1;
    v_response.last_error := NULL;
    RETURN v_response;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
    p_token TEXT,
    p_headers JSONB,
    p_raw_body TEXT,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
    v_payload JSONB := COALESCE(p_payload, NULL);
    v_source RECORD;
    v_policy RECORD;
    v_policy_body JSONB;
    v_mapping JSONB;
    v_validation JSONB := '{}'::jsonb;
    v_hmac_config JSONB;
    v_idempotency_config JSONB;
    v_idempotency_required BOOLEAN := TRUE;
    v_idempotency_key TEXT;
    v_existing_ack RECORD;
    v_webhook_id UUID := gen_random_uuid();
    v_correlation_id UUID := gen_random_uuid();
    v_processing_status TEXT := 'in_progress';
    v_ack_mode TEXT := 'accepted_async';
    v_ack_status INT := 202;
    v_bad_status INT := 400;
    v_ack_headers JSONB := '{}'::jsonb;
    v_ack_body JSONB;
    v_ack_outcome TEXT := 'ack_sent';
    v_ack_reason TEXT := NULL;
    v_organization_id UUID;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_version INT;
    v_context_patch JSONB := '{}'::jsonb;
    v_template_id UUID;
    v_entry_template_id UUID;
    v_followup_run_id UUID;
    v_workflow_run_id UUID;
    v_payload_for_db JSONB;
    v_raw_body_json JSONB;
    v_started TIMESTAMPTZ := clock_timestamp();
    v_processing_ms INT := 0;
    v_decision_point TEXT;
    v_planned_shipment_id UUID;
    v_planned_tracking TEXT;
    v_tracking_policy JSONB;
    v_tracking_scope_type TEXT;
    v_tracking_scope_id UUID;
    v_response_outcome TEXT;
    v_intake_settings JSONB;
    v_defaults JSONB;
    v_event_type TEXT;
    v_raw_intent TEXT;
    v_canonical_intent TEXT;
    v_should_plan BOOLEAN := FALSE;
BEGIN
    IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
        BEGIN
            v_raw_body_json := p_raw_body::jsonb;
            v_payload := v_raw_body_json;
        EXCEPTION
            WHEN others THEN
                v_payload := NULL;
        END;
    END IF;

    IF v_payload IS NULL THEN
        v_payload := '{}'::jsonb;
    END IF;

    IF p_token IS NULL OR btrim(p_token) = '' THEN
        RETURN jsonb_build_object(
            'status', 401,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Missing Authorization bearer token'),
            'ack_outcome', 'ack_failed',
            'response_outcome', 'response_failed',
            'response_mode', 'accepted_async'
        );
    END IF;

    SELECT * INTO v_source
    FROM get_webhook_source_by_token(p_token)
    LIMIT 1;

    IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'status', 401,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Unauthorized webhook source'),
            'ack_outcome', 'ack_failed',
            'response_outcome', 'response_failed',
            'response_mode', 'accepted_async'
        );
    END IF;

    v_organization_id := v_source.organization_id;

    SELECT * INTO v_policy
    FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Webhook ingest policy not configured'),
            'ack_outcome', 'ack_failed',
            'response_outcome', 'response_failed',
            'response_mode', 'accepted_async'
        );
    END IF;

    v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
    v_policy_scope_type := v_policy.scope_type;
    v_policy_scope_id := v_policy.scope_id;
    v_policy_settings_id := v_policy.settings_id;
    v_policy_version := v_policy.policy_version;
    v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');

    v_event_type := COALESCE(
      NULLIF(v_payload#>>'{event,type}', ''),
      NULLIF(v_payload#>>'{event,kind}', ''),
      NULLIF(v_payload->>'type', '')
    );
    v_raw_intent := NULLIF(v_policy_body#>>'{workflow,intent}', '');
    v_canonical_intent := public.normalize_shipment_intent_v1(v_raw_intent, v_event_type);
    IF v_canonical_intent IS NULL OR btrim(v_canonical_intent) = '' THEN
      v_canonical_intent := 'shipment.create';
    END IF;
    v_policy_body := jsonb_set(v_policy_body, '{workflow,intent}', to_jsonb(v_canonical_intent), TRUE);
    v_should_plan := public.should_reserve_identifiers_for_shipment_intent_v1(v_canonical_intent, v_policy_body);

    v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
    IF v_intake_settings IS NULL THEN
        v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;
    v_defaults := COALESCE(v_intake_settings->'defaults', '{}'::jsonb);
    v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
    IF v_entry_template_id IS NULL THEN
        v_entry_template_id := '77770000-0000-0000-0000-000000770001'::UUID;
    END IF;

    v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
    v_ack_status := COALESCE(
        (CASE WHEN v_ack_mode = 'accepted_async' THEN v_defaults->>'accepted_async_status' ELSE v_defaults->>'synchronous_success_status' END)::INT,
        CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END
    );
    v_bad_status := COALESCE((v_defaults->>'bad_request_status')::INT, 400);

    v_idempotency_config := COALESCE(
      v_policy_body->'validation'->'idempotency',
      jsonb_build_object('header', 'Idempotency-Key', 'body_path', 'event.id', 'required', TRUE)
    );
    v_idempotency_required := COALESCE((v_idempotency_config->>'required')::BOOLEAN, TRUE);
    v_idempotency_key := NULLIF(v_headers->>lower(COALESCE(v_idempotency_config->>'header', 'Idempotency-Key')), '');
    IF v_idempotency_key IS NULL THEN
      v_idempotency_key := NULLIF((jsonb_resolve_path(v_payload, COALESCE(v_idempotency_config->>'body_path', 'event.id')))::TEXT, '');
    END IF;
    IF v_idempotency_key IS NOT NULL THEN
      v_idempotency_key := NULLIF(btrim(v_idempotency_key, '" '), '');
    END IF;

    v_validation := v_validation || jsonb_build_object(
      'intent', jsonb_build_object(
        'raw', v_raw_intent,
        'event_type', v_event_type,
        'canonical', v_canonical_intent
      ),
      'idempotency', jsonb_build_object(
        'status', CASE
          WHEN v_idempotency_key IS NULL AND v_idempotency_required THEN 'failed'
          WHEN v_idempotency_key IS NULL THEN 'skipped'
          ELSE 'passed'
        END,
        'key', v_idempotency_key
      )
    );

    IF v_idempotency_key IS NULL AND v_idempotency_required THEN
      RETURN jsonb_build_object(
        'status', v_bad_status,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'Missing required idempotency key'),
        'ack_outcome', 'ack_failed',
        'response_outcome', 'response_failed',
        'response_mode', v_ack_mode,
        'response_reason', 'missing_required_idempotency_key'
      );
    END IF;

    IF v_idempotency_key IS NOT NULL THEN
        SELECT webhook_inbox_id,
               ack_status_code AS status_code,
               ack_headers,
               ack_body,
               ack_outcome,
               ack_reason,
               ack_sent_at
        INTO v_existing_ack
        FROM webhook_ack_history
        WHERE webhook_source_id = v_source.id
          AND idempotency_key = v_idempotency_key
        ORDER BY ack_sent_at DESC
        LIMIT 1;

        IF v_existing_ack.ack_outcome IS NOT NULL THEN
            v_webhook_id := v_existing_ack.webhook_inbox_id;
            v_response_outcome := CASE
                WHEN v_existing_ack.ack_outcome = 'ack_failed' THEN 'response_failed'
                ELSE 'response_replayed'
            END;

            PERFORM log_decision(
                p_organization_id := v_organization_id,
                p_decision_category := 'http_response_emitted',
                p_resource_type := 'webhook_inbox',
                p_resource_id := v_webhook_id,
                p_decision_point := v_decision_point,
                p_decision_outcome := v_response_outcome,
                p_performed_by_system := 'workflow_intake_webhook',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'mode', v_ack_mode,
                    'status', COALESCE(v_existing_ack.status_code, v_ack_status),
                    'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
                    'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
                    'validation_results', COALESCE(v_validation, '{}'::jsonb),
                    'idempotency_key', v_idempotency_key,
                    'canonical_intent', v_canonical_intent
                )),
                p_decision_reason := v_existing_ack.ack_reason
            );

            RETURN jsonb_build_object(
                'status', COALESCE(v_existing_ack.status_code, v_ack_status),
                'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
                'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
                'ack_outcome', 'ack_replayed',
                'response_outcome', v_response_outcome,
                'response_mode', v_ack_mode,
                'response_reason', v_existing_ack.ack_reason,
                'webhook_id', v_webhook_id,
                'workflow_run_id', NULL,
                'followup_workflow_run_id', NULL
            );
        END IF;
    END IF;

    v_hmac_config := v_policy_body->'validation'->'hmac';
    IF v_hmac_config ? 'enabled' AND v_hmac_config->>'enabled' = 'true' THEN
        DECLARE
            v_algorithm TEXT := upper(COALESCE(v_hmac_config->>'algorithm', 'HMAC-SHA256'));
            v_signature_header TEXT := lower(COALESCE(v_hmac_config->>'header', 'x-signature'));
            v_signature_encoding TEXT := lower(COALESCE(v_hmac_config->>'signature_encoding', 'hex'));
            v_provided_signature TEXT := v_headers->>v_signature_header;
            v_auth_config_id UUID := NULLIF(v_hmac_config->>'auth_config_id', '')::UUID;
            v_secret TEXT;
            v_computed BYTEA;
            v_expected TEXT;
        BEGIN
            IF v_provided_signature IS NULL THEN
                v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message', format('Missing signature header %s', v_signature_header)));
                v_ack_outcome := 'ack_failed';
                v_ack_reason := format('Missing signature header %s', v_signature_header);
                v_ack_status := GREATEST(v_ack_status, v_bad_status);
            ELSIF v_auth_config_id IS NULL THEN
                v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','Missing auth_config reference for HMAC validation'));
                v_ack_outcome := 'ack_failed';
                v_ack_reason := 'Missing auth_config reference for HMAC validation';
                v_ack_status := GREATEST(v_ack_status, v_bad_status);
            ELSE
                SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
                  INTO v_secret
                  FROM provider_auth_configs
                 WHERE id = v_auth_config_id;
                IF v_secret IS NULL THEN
                    v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','Signing secret missing in provider_auth_configs.credentials'));
                    v_ack_outcome := 'ack_failed';
                    v_ack_reason := 'Signing secret missing';
                    v_ack_status := GREATEST(v_ack_status, v_bad_status);
                ELSE
                    v_computed := hmac(coalesce(p_raw_body, '')::bytea, v_secret::bytea, CASE WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END);
                    IF v_signature_encoding = 'base64' THEN
                        v_expected := encode(v_computed, 'base64');
                    ELSE
                        v_expected := encode(v_computed, 'hex');
                    END IF;
                    IF v_expected <> v_provided_signature THEN
                        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','failed','message','HMAC signature mismatch'));
                        v_ack_outcome := 'ack_failed';
                        v_ack_reason := 'HMAC signature mismatch';
                        v_ack_status := GREATEST(v_ack_status, v_bad_status);
                    ELSE
                        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status','passed'));
                    END IF;
                END IF;
            END IF;
        END;
    END IF;

    v_payload_for_db := COALESCE(v_payload, '{}'::jsonb);
    PERFORM insert_webhook_inbox_record(
        v_webhook_id,
        v_source.id,
        v_source.provider_type,
        v_payload_for_db,
        v_headers,
        CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END,
        v_correlation_id,
        v_idempotency_key
    );
    UPDATE webhook_inbox
       SET transformed_payload = v_payload_for_db,
           event_type = v_event_type,
           processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END
     WHERE id = v_webhook_id;

    IF v_should_plan THEN
        v_tracking_scope_type := CASE WHEN v_source.client_id IS NOT NULL THEN 'client' ELSE 'tenant' END;
        v_tracking_scope_id := COALESCE(v_source.client_id, v_organization_id);
        v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
        v_planned_shipment_id := gen_random_uuid();
        v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
    ELSE
        v_planned_shipment_id := NULL;
        v_planned_tracking := NULL;
    END IF;

    IF v_policy_body->'ack' ? 'response_mapping_id' THEN
        SELECT mapping_config INTO v_mapping
          FROM mapping_configs
         WHERE id = NULLIF(v_policy_body->'ack'->>'response_mapping_id','')::UUID;
    ELSE
        v_mapping := NULL;
    END IF;

    IF v_mapping ? 'status_code' THEN
        v_ack_status := COALESCE((v_mapping->>'status_code')::INT, v_ack_status);
    END IF;

    IF v_mapping ? 'headers' THEN
        v_ack_headers := jsonb_strip_nulls(COALESCE(v_mapping->'headers','{}'::jsonb));
    END IF;

    IF v_mapping ? 'body' THEN
        v_ack_body := render_template(
            v_mapping->'body',
            jsonb_build_object(
                'webhook', jsonb_build_object(
                    'id', v_webhook_id,
                    'correlation_id', v_correlation_id,
                    'source_identifier', v_source.source_identifier
                ),
                'payload', v_payload,
                'headers', v_headers,
                'policy', v_policy_body,
                'validation', v_validation,
                'resource', CASE
                    WHEN v_should_plan THEN jsonb_build_object(
                        'type','shipment',
                        'id', v_planned_shipment_id,
                        'tracking_number', v_planned_tracking
                    )
                    ELSE NULL
                END
            )
        );
    END IF;

    IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
        IF v_ack_mode = 'accepted_async' THEN
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted_async',
                'correlation_id', v_correlation_id,
                'resource', CASE
                    WHEN v_should_plan THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
                    ELSE NULL
                END
            ));
        ELSE
            v_ack_body := jsonb_strip_nulls(jsonb_build_object(
                'status', 'accepted',
                'resource', CASE
                    WHEN v_should_plan THEN jsonb_build_object('type','shipment','id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
                    ELSE NULL
                END
            ));
        END IF;
    END IF;

    IF v_ack_outcome = 'ack_failed' THEN
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
        v_ack_headers := COALESCE(v_ack_headers, '{}'::jsonb) || jsonb_build_object('content-type', 'application/json');
        v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));
    ELSE
        IF v_ack_headers IS NULL THEN
            v_ack_headers := '{}'::jsonb;
        END IF;
        IF NOT (v_ack_headers ? 'content-type') THEN
            v_ack_headers := v_ack_headers || jsonb_build_object('content-type', 'application/json');
        END IF;
    END IF;

    v_response_outcome := CASE
        WHEN v_ack_outcome = 'ack_failed' THEN 'response_failed'
        ELSE 'response_sent'
    END;

    UPDATE webhook_inbox
       SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'in_progress' END,
           organization_id = COALESCE(organization_id, v_organization_id),
           policy_scope_type = v_policy_scope_type,
           policy_scope_id = v_policy_scope_id,
           policy_settings_id = v_policy_settings_id,
           policy_version = v_policy_version,
           updated_at = now()
     WHERE id = v_webhook_id;

    v_template_id := NULLIF(v_policy_body#>>'{workflow,template_id}', '')::UUID;
    IF v_ack_outcome <> 'ack_failed' AND v_entry_template_id IS NOT NULL THEN
        v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
        v_context_patch := jsonb_strip_nulls(
            COALESCE(v_context_patch, '{}'::jsonb)
            || jsonb_build_object(
                'canonical_intent', v_canonical_intent,
                'reserve_identifiers', v_should_plan,
                'reserve_new_tracking', CASE WHEN v_canonical_intent = 'shipment.swap' THEN v_should_plan ELSE NULL END,
                'planned_shipment_id', v_planned_shipment_id,
                'planned_tracking_number', v_planned_tracking,
                'client_id', v_source.client_id,
                'sender_id', v_source.sender_id,
                'source_identifier', v_source.source_identifier,
                'followup_template_id', v_template_id
            )
        );
        v_context_patch := jsonb_strip_nulls(
            jsonb_build_object(
                'workflow',
                jsonb_build_object('context_patch', v_context_patch)
            ) || v_context_patch
        );

        v_workflow_run_id := start_workflow_run(
            v_entry_template_id,
            jsonb_strip_nulls(
                jsonb_build_object(
                    'webhook_id', v_webhook_id,
                    'correlation_id', v_correlation_id,
                    'organization_id', v_organization_id,
                    'payload', v_payload,
                    'headers', v_headers,
                    'policy', v_policy_body
                ) || v_context_patch
            )
        );

        UPDATE webhook_inbox
           SET workflow_run_id = v_workflow_run_id
         WHERE id = v_webhook_id;

        IF v_template_id IS NOT NULL AND v_template_id <> v_entry_template_id THEN
            v_followup_run_id := start_workflow_run(
                v_template_id,
                jsonb_strip_nulls(
                    jsonb_build_object(
                        'webhook_id', v_webhook_id,
                        'correlation_id', v_correlation_id,
                        'organization_id', v_organization_id,
                        'started_by_run_id', v_workflow_run_id
                    ) || v_context_patch
                )
            );

            UPDATE workflow_runs
               SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
             WHERE id = v_followup_run_id;
        END IF;
    END IF;

    v_ack_body := jsonb_strip_nulls(COALESCE(v_ack_body, '{}'::jsonb) || jsonb_build_object(
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id
    ));

    PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_response_outcome,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'mode', v_ack_mode,
            'status', v_ack_status,
            'headers', v_ack_headers,
            'body', v_ack_body,
            'validation_results', v_validation,
            'idempotency_key', v_idempotency_key,
            'workflow_run_id', v_workflow_run_id,
            'followup_workflow_run_id', v_followup_run_id,
            'canonical_intent', v_canonical_intent
        )),
        p_decision_reason := v_ack_reason
    );

    v_processing_ms := GREATEST(0, (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT);

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', v_ack_status,
        'headers', v_ack_headers,
        'body', v_ack_body,
        'ack_outcome', v_ack_outcome,
        'response_outcome', v_response_outcome,
        'response_mode', v_ack_mode,
        'response_reason', v_ack_reason,
        'processing_time_ms', v_processing_ms,
        'webhook_id', v_webhook_id,
        'workflow_run_id', v_workflow_run_id,
        'followup_workflow_run_id', v_followup_run_id,
        'canonical_intent', v_canonical_intent
    ));
END;
$function$;

COMMENT ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
  IS 'Workflow intake entrypoint hardened with canonical intent normalization, required-by-default idempotency, fail-closed validation, and intent-aware planning rules.';

COMMIT;
