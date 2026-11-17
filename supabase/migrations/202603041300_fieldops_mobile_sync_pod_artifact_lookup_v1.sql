-- Plan: PLAN-202603-fieldops-mobile-ux-connectivity-feature-completion-v1 / Step: S04
-- Migration: FieldOps mobile sync policy + POD v2 + mobile artifact/lookup RPCs + exception enforcement
-- Date: 2026-03-04

BEGIN;
SELECT pg_advisory_lock(hashtext('202603041300_fieldops_mobile_sync_pod_artifact_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) mobile_sync_policy category + schema + default + resolver
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'mobile_sync_policy',
  'Mobile sync/offline policy (retry/backoff/batching/connectivity degradation thresholds) resolved via ladder; branch-aware via resource scope.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_sync_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Mobile Sync Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'degraded_pending_threshold', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'stale_sync_after_seconds', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'max_retry_attempts', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'retry_base_delay_seconds', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'retry_max_delay_seconds', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'sync_batch_size', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
      'auto_sync_on_reconnect', jsonb_build_object('type', jsonb_build_array('boolean','null')),
      'show_degraded_banner', jsonb_build_object('type', jsonb_build_array('boolean','null'))
    )
  ),
  'FieldOps mobile sync policy controlling retry/backoff and degraded/offline thresholds.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'degraded_pending_threshold', 10,
      'stale_sync_after_seconds', 180,
      'max_retry_attempts', 5,
      'retry_base_delay_seconds', 5,
      'retry_max_delay_seconds', 120,
      'sync_batch_size', 50,
      'auto_sync_on_reconnect', TRUE,
      'show_degraded_banner', TRUE
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

WITH sync_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'degraded_pending_threshold', 10,
    'stale_sync_after_seconds', 180,
    'max_retry_attempts', 5,
    'retry_base_delay_seconds', 5,
    'retry_max_delay_seconds', 120,
    'sync_batch_size', 50,
    'auto_sync_on_reconnect', TRUE,
    'show_degraded_banner', TRUE
  ) AS body
),
inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'mobile_sync_policy', 'global', NULL, 1, sync_upsert.body, 1, now() FROM sync_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM inserted sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

CREATE OR REPLACE FUNCTION public.resolve_mobile_sync_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_sync_policy', p_context);
$function$;

COMMENT ON FUNCTION public.resolve_mobile_sync_policy(JSONB)
  IS 'Resolve mobile_sync_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';
REVOKE ALL ON FUNCTION public.resolve_mobile_sync_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_sync_policy(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_sync_policy(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) pod_policy schema v2 (binary evidence + exception requirements)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'pod_policy',
  2,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'POD Policy v2',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'requirements', jsonb_build_object(
        'type', jsonb_build_array('object','null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'completed', jsonb_build_object(
            'type', jsonb_build_array('object','null'),
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'photo_required', jsonb_build_object('type', jsonb_build_array('boolean','null')),
              'signature_required', jsonb_build_object('type', jsonb_build_array('boolean','null')),
              'otp_required', jsonb_build_object('type', jsonb_build_array('boolean','null')),
              'min_artifact_count', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
            )
          ),
          'exception', jsonb_build_object(
            'type', jsonb_build_array('object','null'),
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'exception_reason_required', jsonb_build_object('type', jsonb_build_array('boolean','null')),
              'notes_required_for_other', jsonb_build_object('type', jsonb_build_array('boolean','null')),
              'min_artifact_count', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
            )
          )
        )
      ),
      'binary_evidence', jsonb_build_object(
        'type', jsonb_build_array('object','null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'bucket_id', jsonb_build_object('type', jsonb_build_array('string','null')),
          'allowed_mime_types', jsonb_build_object(
            'type', jsonb_build_array('array','null'),
            'items', jsonb_build_object('type', 'string'),
            'uniqueItems', TRUE
          ),
          'max_file_bytes', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1),
          'max_items', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 1)
        )
      ),
      'redaction', jsonb_build_object('type', jsonb_build_array('object','null'), 'additionalProperties', TRUE),
      'retention_days', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
    )
  ),
  'Proof-of-delivery requirements v2 with explicit binary evidence controls and exception requirements.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 2,
      'enabled', TRUE,
      'requirements', jsonb_build_object(
        'completed', jsonb_build_object(
          'photo_required', TRUE,
          'signature_required', FALSE,
          'otp_required', FALSE,
          'min_artifact_count', 1
        ),
        'exception', jsonb_build_object(
          'exception_reason_required', TRUE,
          'notes_required_for_other', TRUE,
          'min_artifact_count', 0
        )
      ),
      'binary_evidence', jsonb_build_object(
        'bucket_id', 'fieldops-evidence',
        'allowed_mime_types', jsonb_build_array('image/jpeg', 'image/png', 'application/pdf'),
        'max_file_bytes', 5242880,
        'max_items', 6
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
  is_active = EXCLUDED.is_active,
  updated_at = now();

WITH current_global AS (
  SELECT s.settings_version_id,
         sv.value,
         sv.version,
         sv.schema_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'pod_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
merged AS (
  SELECT
    settings_version_id,
    version,
    jsonb_strip_nulls(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(value, '{}'::jsonb),
            '{version}',
            '2'::jsonb,
            TRUE
          ),
          '{requirements,exception}',
          COALESCE(value->'requirements'->'exception', '{}'::jsonb)
            || jsonb_build_object(
              'exception_reason_required', COALESCE((value->'requirements'->'exception'->>'exception_reason_required')::boolean, TRUE),
              'notes_required_for_other', COALESCE((value->'requirements'->'exception'->>'notes_required_for_other')::boolean, TRUE),
              'min_artifact_count', COALESCE((value->'requirements'->'exception'->>'min_artifact_count')::int, 0)
            ),
          TRUE
        ),
        '{binary_evidence}',
        COALESCE(value->'binary_evidence', '{}'::jsonb)
          || jsonb_build_object(
            'bucket_id', COALESCE(NULLIF(value->'binary_evidence'->>'bucket_id', ''), 'fieldops-evidence'),
            'allowed_mime_types', COALESCE(value->'binary_evidence'->'allowed_mime_types', '["image/jpeg","image/png","application/pdf"]'::jsonb),
            'max_file_bytes', COALESCE((value->'binary_evidence'->>'max_file_bytes')::bigint, 5242880),
            'max_items', COALESCE((value->'binary_evidence'->>'max_items')::int, 6)
          ),
        TRUE
      )
    ) AS next_value
  FROM current_global
)
UPDATE public.settings_versions sv
SET value = merged.next_value,
    schema_version = 2,
    version = GREATEST(sv.version, merged.version),
    change_reason = COALESCE(NULLIF(sv.change_reason, ''), 'pod_policy v2 binary evidence defaults'),
    updated_at = now()
FROM merged
WHERE sv.id = merged.settings_version_id;

-------------------------------------------------------------------------------
-- 3) Authenticated mobile artifact registration (service path remains unchanged)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_mobile_artifact_v1(
  p_artifact JSONB
)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_artifact, '{}'::jsonb);
  v_org UUID := public.current_user_org_id();
  v_actor UUID := auth.uid();
  v_requested_org UUID := NULL;
  v_bucket TEXT := NULL;
  v_key TEXT := NULL;
  v_allowed_bucket TEXT := 'fieldops-evidence';
  v_result RECORD;
BEGIN
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  BEGIN v_requested_org := NULLIF(btrim(COALESCE(v_payload->>'organization_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_requested_org := NULL; END;
  IF v_requested_org IS NOT NULL AND v_requested_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 organization mismatch' USING ERRCODE = '42501';
  END IF;

  v_bucket := NULLIF(btrim(COALESCE(v_payload->>'storage_bucket', '')), '');
  v_key := NULLIF(btrim(COALESCE(v_payload->>'storage_key', '')), '');

  IF v_bucket IS NULL OR lower(v_bucket) <> v_allowed_bucket THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 storage_bucket must be %', v_allowed_bucket USING ERRCODE = '23514';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 missing storage_key' USING ERRCODE = '23514';
  END IF;

  IF v_key NOT LIKE (v_org::text || '/%') THEN
    RAISE EXCEPTION 'register_mobile_artifact_v1 storage_key must start with current org prefix' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.register_artifact_v1(
      jsonb_strip_nulls(
        v_payload
        || jsonb_build_object(
          'organization_id', v_org,
          'storage_bucket', v_allowed_bucket,
          'created_by_user_id', v_actor,
          'source_system', COALESCE(NULLIF(v_payload->>'source_system', ''), 'fieldops_mobile')
        )
      )
    )
  LIMIT 1;

  RETURN QUERY SELECT v_result.artifact_id, v_result.created;
END;
$function$;

COMMENT ON FUNCTION public.register_mobile_artifact_v1(JSONB)
  IS 'Authenticated FieldOps write-path for artifact registration. Enforces current tenant scope and org-prefixed storage keys.';

REVOKE ALL ON FUNCTION public.register_mobile_artifact_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_mobile_artifact_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_mobile_artifact_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Lookup list helper for mobile action composer (taxonomy-backed)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_lookup_values_v1(
  p_category TEXT
)
RETURNS TABLE (
  value TEXT,
  label TEXT,
  description TEXT,
  sort_order INT,
  is_default BOOLEAN,
  metadata JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_category TEXT := lower(NULLIF(btrim(COALESCE(p_category, '')), ''));
  v_org UUID := public.current_user_org_id();
  v_has_lookup_read BOOLEAN := FALSE;
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'list_lookup_values_v1 requires category' USING ERRCODE = '23514';
  END IF;

  -- Allow explicit lookup access when granted, otherwise only allow dispatch_exception_reason
  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  IF NOT v_has_lookup_read THEN
    IF v_category <> 'dispatch_exception_reason' THEN
      RAISE EXCEPTION 'list_lookup_values_v1 category not allowed for current role' USING ERRCODE = '42501';
    END IF;
    IF v_org IS NULL OR NOT public.user_has_permission_v1('tasks.complete', v_org) THEN
      RAISE EXCEPTION 'list_lookup_values_v1 requires tasks.complete permission' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    lv.value,
    lv.label,
    lv.description,
    lv.sort_order,
    lv.is_default,
    COALESCE(lv.metadata, '{}'::jsonb) AS metadata
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv
    ON lv.lookup_definition_id = ld.id
  WHERE ld.category = v_category
    AND lv.status = 'active'
    AND (lv.effective_from IS NULL OR lv.effective_from <= now())
    AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ORDER BY lv.sort_order NULLS LAST, lv.label, lv.value;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_v1(TEXT)
  IS 'List active lookup values for a category. Intended for UI action composers and taxonomy-backed selects.';

REVOKE ALL ON FUNCTION public.list_lookup_values_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_lookup_values_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_lookup_values_v1(TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) ui_execute_command_v1 hardening for tasks.exception reason enforcement
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_command_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_execution JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_handler TEXT;
  v_static_params JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;

  -- task_transition handler fields
  v_to_status TEXT;
  v_status_reason TEXT;
  v_idempotency_key TEXT;
  v_transition_payload JSONB;
  v_transition_row RECORD;
  v_task RECORD;
  v_policy_row RECORD;
  v_exception_reason TEXT;
  v_reason_required BOOLEAN;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_command_v1 requires action key';
  END IF;

  SELECT value INTO v_command
    FROM jsonb_array_elements(v_registry->'commands') AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_command_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := v_command->'selection';
  v_mode := lower(COALESCE(v_selection->>'mode', ''));
  v_min := COALESCE(NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END);
  v_max := COALESCE(NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END);

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_static_params := COALESCE(v_execution->'params', '{}'::jsonb);
  v_params := v_static_params || COALESCE(p_params, '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(v_static_params->>'handler', ''), NULLIF(v_params->>'handler', ''), ''));
  v_patch := COALESCE(v_params->'patch', '{}'::jsonb);

  IF COALESCE(v_command->>'workflow_key', '') <> '' OR (v_execution->>'type') = 'workflow' THEN
    IF COALESCE(v_command->>'workflow_key', '') = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow key missing for %', p_action_key;
    END IF;

    SELECT id INTO v_template_id
      FROM public.workflow_templates
     WHERE name = v_command->>'workflow_key'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    v_payload_key := NULLIF(v_params->>'payload_key', '');
    v_selection_key := NULLIF(v_params->>'selection_id_key', '');
    IF v_payload_key IS NULL THEN
      v_payload_key := 'selections';
    END IF;
    IF v_selection_key IS NULL THEN
      v_selection_key := 'id';
    END IF;

    v_payload := jsonb_build_object(
      v_payload_key,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(v_selection_key, value)) FROM unnest(v_ids) AS value),
        '[]'::jsonb
      ),
      'selection_ids', to_jsonb(v_ids),
      'selection_id', v_id,
      'selection_count', v_count,
      'resource_key', p_resource_key,
      'organization_id', public.current_user_org_id()
    );

    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    );

    v_run_id := public.start_workflow_run(v_template_id, v_context);

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id
    );
  END IF;

  IF v_handler = 'resource_update' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 patch must be object';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_update_resource_v1(p_resource_key, v_id, v_patch);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'updated',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'resource_delete' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_delete_resource_v1(p_resource_key, v_id);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'deleted',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'task_transition' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    v_to_status := lower(COALESCE(NULLIF(v_static_params->>'to_status', ''), NULLIF(v_params->>'to_status', ''), ''));
    IF v_to_status = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 task_transition requires to_status';
    END IF;

    v_status_reason := NULLIF(COALESCE(v_static_params->>'status_reason', v_params->>'status_reason', ''), '');
    v_transition_payload := COALESCE(v_params->'payload', '{}'::jsonb);

    FOREACH v_id IN ARRAY v_ids LOOP
      -- Policy-driven exception guard: require a valid dispatch_exception_reason when required.
      IF v_to_status = 'exception' THEN
        SELECT t.id, t.organization_id, t.client_id, t.sender_id, t.resource_type, t.resource_id
          INTO v_task
          FROM public.tasks t
         WHERE t.id = v_id::uuid
         LIMIT 1;

        IF v_task.id IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 task_transition task not found: %', v_id USING ERRCODE = '23503';
        END IF;

        SELECT *
          INTO v_policy_row
          FROM public.resolve_pod_policy(
            jsonb_strip_nulls(
              jsonb_build_object(
                'organization_id', v_task.organization_id,
                'client_id', v_task.client_id,
                'sender_id', v_task.sender_id,
                'resource_type', v_task.resource_type,
                'resource_id', v_task.resource_id
              )
            )
          )
        LIMIT 1;

        v_reason_required := COALESCE(
          (v_policy_row.value->'requirements'->'exception'->>'exception_reason_required')::boolean,
          TRUE
        );

        v_exception_reason := lower(NULLIF(btrim(COALESCE(v_transition_payload->>'exception_reason', '')), ''));

        IF v_reason_required AND v_exception_reason IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 exception transition requires payload.exception_reason' USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL
           AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_exception_reason, TRUE) IS FALSE THEN
          RAISE EXCEPTION 'ui_execute_command_v1 invalid exception_reason: %', v_exception_reason USING ERRCODE = '23514';
        END IF;

        -- Persist normalized reason token into payload for deterministic downstream behavior.
        IF v_exception_reason IS NOT NULL THEN
          v_transition_payload := jsonb_set(v_transition_payload, '{exception_reason}', to_jsonb(v_exception_reason), TRUE);
        END IF;
      END IF;

      v_idempotency_key := encode(
        digest(
          format('%s|%s|%s|%s', p_action_key, v_to_status, v_id, v_transition_payload::text),
          'sha256'
        ),
        'hex'
      );

      SELECT * INTO v_transition_row
      FROM public.transition_task_v1(
        p_task_id := v_id::uuid,
        p_to_status := v_to_status,
        p_status_reason := v_status_reason,
        p_payload := v_transition_payload,
        p_idempotency_key := v_idempotency_key
      )
      LIMIT 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'task_id', v_transition_row.task_id,
          'task_event_id', v_transition_row.task_event_id
        )
      );
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'task_transitioned',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'to_status', v_to_status,
      'count', v_count,
      'items', v_results
    );
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 6) API wrappers for newly exposed mobile RPCs/resolvers
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.resolve_mobile_sync_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.resolve_mobile_sync_policy(p_context);
$fn$;

REVOKE ALL ON FUNCTION api.resolve_mobile_sync_policy(JSONB) FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_mobile_sync_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_pod_policy(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.resolve_pod_policy(p_context);
$fn$;

REVOKE ALL ON FUNCTION api.resolve_pod_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.resolve_pod_policy(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.register_mobile_artifact_v1(p_artifact JSONB)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE sql
VOLATILE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.register_mobile_artifact_v1(p_artifact);
$fn$;

REVOKE ALL ON FUNCTION api.register_mobile_artifact_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.register_mobile_artifact_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.list_lookup_values_v1(p_category TEXT)
RETURNS TABLE (
  value TEXT,
  label TEXT,
  description TEXT,
  sort_order INT,
  is_default BOOLEAN,
  metadata JSONB
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.list_lookup_values_v1(p_category);
$fn$;

REVOKE ALL ON FUNCTION api.list_lookup_values_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.list_lookup_values_v1(TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603041300_fieldops_mobile_sync_pod_artifact_lookup_v1'));
COMMIT;
