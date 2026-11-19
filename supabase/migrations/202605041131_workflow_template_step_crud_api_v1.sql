-- Console V2 Workflow Studio step CRUD closure.
-- Adds browser-safe api-schema wrappers plus canonical jsonb RPCs for
-- workflow_template_steps create/update/duplicate/delete.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605041131_workflow_template_step_crud_api_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', FALSE),
  ('decision_outcome', 'Decision outcomes for decision_log', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

WITH categories(value, label, description, sort_order) AS (
  VALUES
    ('workflows.template_step_create', 'Workflows Template Step Create', 'Workflow template step create decisions emitted by canonical RPCs.', 2290),
    ('workflows.template_step_update', 'Workflows Template Step Update', 'Workflow template step update decisions emitted by canonical RPCs.', 2300),
    ('workflows.template_step_duplicate', 'Workflows Template Step Duplicate', 'Workflow template step duplicate decisions emitted by canonical RPCs.', 2310),
    ('workflows.template_step_delete', 'Workflows Template Step Delete', 'Workflow template step delete decisions emitted by canonical RPCs.', 2320)
),
definition AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'decision_category' LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, status, metadata
)
SELECT
  d.id,
  c.value,
  c.label,
  c.description,
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'workflow_template_step_crud_api_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, description, sort_order) AS (
  VALUES
    ('created', 'Created', 'Resource creation decision outcome.', 2330),
    ('updated', 'Updated', 'Resource update decision outcome.', 2340),
    ('duplicated', 'Duplicated', 'Resource duplicate decision outcome.', 2350),
    ('deleted', 'Deleted', 'Resource deletion decision outcome.', 2360),
    ('soft_deleted', 'Soft Deleted', 'Referenced resource was disabled instead of physically deleted.', 2370)
),
definition AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'decision_outcome' LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, status, metadata
)
SELECT
  d.id,
  o.value,
  o.label,
  o.description,
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'workflow_template_step_crud_api_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.workflow_template_step_recompute_checksum_v1(
  p_workflow_template_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_checksum text;
BEGIN
  SELECT md5(
           string_agg(
             concat_ws(
               '|',
               s.sequence_order,
               s.operation_name,
               COALESCE(s.next_operation_name, ''),
               COALESCE(s.operation_settings_category, ''),
               COALESCE(s.transition_condition, ''),
               COALESCE(s.metadata::text, '')
             ),
             '||' ORDER BY s.sequence_order
           )
         )
    INTO v_checksum
    FROM public.workflow_template_steps s
   WHERE s.workflow_template_id = p_workflow_template_id
     AND COALESCE(s.enabled, TRUE) = TRUE;

  UPDATE public.workflow_templates
     SET steps_checksum = v_checksum
   WHERE id = p_workflow_template_id;

  RETURN v_checksum;
END;
$function$;

REVOKE ALL ON FUNCTION public.workflow_template_step_recompute_checksum_v1(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_step jsonb;
  v_template_id uuid;
  v_template public.workflow_templates%ROWTYPE;
  v_template_org uuid;
  v_step_id uuid;
  v_operation_name text;
  v_transition_condition text;
  v_sequence_order integer;
  v_requested_order integer;
  v_enabled boolean;
  v_manual_action_required boolean;
  v_metadata jsonb;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  v_step := CASE
    WHEN jsonb_typeof(v_args->'step') = 'object' THEN v_args->'step'
    ELSE v_args
  END;
  v_template_id := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id', v_step->>'workflow_template_id'), '')::uuid;
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires workflow_template_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_template_id
   FOR UPDATE;
  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 workflow_template % not found', v_template_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user()
     AND NOT public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id) THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 workflow_template % outside caller scope', v_template_id
      USING ERRCODE = '42501';
  END IF;

  v_operation_name := COALESCE(NULLIF(btrim(v_step->>'operation_name'), ''), NULLIF(btrim(v_step->>'op'), ''));
  IF v_operation_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires operation_name'
      USING ERRCODE = '23502';
  END IF;

  v_transition_condition := NULLIF(btrim(v_step->>'transition_condition'), '');
  IF v_transition_condition IS NULL THEN
    SELECT lv.value
      INTO v_transition_condition
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_transition'
       AND lv.status = 'active'
       AND (lv.is_default = TRUE OR COALESCE(lv.metadata->>'is_default', 'false') = 'true')
     ORDER BY lv.sort_order NULLS LAST, lv.value
     LIMIT 1;
  END IF;
  IF v_transition_condition IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires transition_condition or a default workflow_transition lookup'
      USING ERRCODE = '23502';
  END IF;

  v_requested_order := NULLIF(v_step->>'sequence_order', '')::integer;
  IF v_requested_order IS NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1
      INTO v_sequence_order
      FROM public.workflow_template_steps
     WHERE workflow_template_id = v_template_id;
  ELSE
    v_sequence_order := GREATEST(1, v_requested_order);
    UPDATE public.workflow_template_steps
       SET sequence_order = sequence_order + 1,
           updated_at = now()
     WHERE workflow_template_id = v_template_id
       AND sequence_order >= v_sequence_order;
  END IF;

  v_enabled := COALESCE(NULLIF(v_step->>'enabled', '')::boolean, TRUE);
  v_manual_action_required := COALESCE(NULLIF(v_step->>'manual_action_required', '')::boolean, FALSE);
  v_metadata :=
    COALESCE(
      CASE WHEN jsonb_typeof(v_step->'metadata') = 'object' THEN v_step->'metadata' ELSE '{}'::jsonb END,
      '{}'::jsonb
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'kind', NULLIF(btrim(v_step->>'kind'), ''),
      'label', NULLIF(btrim(v_step->>'label'), ''),
      'sub', NULLIF(btrim(v_step->>'sub'), ''),
      'icon', NULLIF(btrim(v_step->>'icon'), ''),
      'branch', NULLIF(btrim(v_step->>'branch'), ''),
      'error_path', NULLIF(btrim(v_step->>'error_path'), ''),
      'manual_path', NULLIF(btrim(v_step->>'manual_path'), '')
    ));

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    condition_jsonlogic,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    handler_key
  )
  VALUES (
    v_template_id,
    v_sequence_order,
    v_operation_name,
    NULLIF(btrim(v_step->>'operation_settings_category'), ''),
    v_transition_condition,
    CASE WHEN jsonb_typeof(v_step->'condition_jsonlogic') = 'object' THEN v_step->'condition_jsonlogic' ELSE NULL END,
    NULLIF(btrim(v_step->>'next_operation_name'), ''),
    NULLIF(v_step->>'next_operation_priority', '')::integer,
    NULLIF(v_step->>'next_operation_delay_seconds', '')::integer,
    v_manual_action_required,
    NULLIF(v_metadata, '{}'::jsonb),
    v_enabled,
    NULLIF(btrim(v_step->>'handler_key'), '')
  )
  RETURNING id INTO v_step_id;

  PERFORM public.workflow_template_step_recompute_checksum_v1(v_template_id);

  v_template_org := CASE WHEN v_template.scope_type = 'tenant' THEN v_template.scope_id ELSE NULL END;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_template_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_step_create', 'workflow_template_step', v_step_id,
    'ui_create_workflow_template_step_v1', 'created',
    jsonb_build_object('workflow_template_id', v_template_id, 'sequence_order', v_sequence_order, 'operation_name', v_operation_name),
    'ui_create_workflow_template_step_v1', v_correlation_id
  );

  IF COALESCE(v_template_org, v_org_id) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_template_org, v_org_id),
      'workflow_template_step.created', 'workflow_template_step', v_step_id,
      jsonb_build_object('workflow_template_id', v_template_id, 'sequence_order', v_sequence_order),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_template_id,
    'workflow_template_step_id', v_step_id,
    'sequence_order', v_sequence_order,
    'action', 'created',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_update_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_patch jsonb;
  v_step_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_step_id', v_args->>'step_id'), '')::uuid;
  v_expected_template_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id'), '')::uuid;
  v_before public.workflow_template_steps%ROWTYPE;
  v_template public.workflow_templates%ROWTYPE;
  v_template_org uuid;
  v_metadata jsonb;
  v_metadata_patch jsonb;
  v_operation_name text;
  v_transition_condition text;
  v_after jsonb;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
  v_remove_key text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_step_id IS NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 requires step_id'
      USING ERRCODE = '23502';
  END IF;

  v_patch := CASE
    WHEN jsonb_typeof(v_args->'patch') = 'object' THEN v_args->'patch'
    ELSE v_args - 'workflow_template_step_id' - 'step_id' - 'workflow_template_id' - 'template_id' - 'reason'
  END;
  IF jsonb_typeof(v_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 requires patch object'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before
    FROM public.workflow_template_steps
   WHERE id = v_step_id
   FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 step % not found', v_step_id
      USING ERRCODE = '23503';
  END IF;
  IF v_expected_template_id IS NOT NULL AND v_expected_template_id <> v_before.workflow_template_id THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 step % is not in template %', v_step_id, v_expected_template_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_before.workflow_template_id
   FOR UPDATE;
  IF NOT public.is_platform_user()
     AND NOT public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_template_step_v1 workflow_template % outside caller scope', v_before.workflow_template_id
      USING ERRCODE = '42501';
  END IF;

  v_operation_name := COALESCE(NULLIF(btrim(v_patch->>'operation_name'), ''), NULLIF(btrim(v_patch->>'op'), ''));
  v_transition_condition := NULLIF(btrim(v_patch->>'transition_condition'), '');
  v_metadata_patch := COALESCE(
    CASE WHEN jsonb_typeof(v_patch->'metadata') = 'object' THEN v_patch->'metadata' ELSE '{}'::jsonb END,
    '{}'::jsonb
  );
  v_metadata :=
    COALESCE(v_before.metadata, '{}'::jsonb)
    || v_metadata_patch
    || jsonb_strip_nulls(jsonb_build_object(
      'kind', NULLIF(btrim(v_patch->>'kind'), ''),
      'label', NULLIF(btrim(v_patch->>'label'), ''),
      'sub', NULLIF(btrim(v_patch->>'sub'), ''),
      'icon', NULLIF(btrim(v_patch->>'icon'), ''),
      'branch', NULLIF(btrim(v_patch->>'branch'), ''),
      'error_path', NULLIF(btrim(v_patch->>'error_path'), ''),
      'manual_path', NULLIF(btrim(v_patch->>'manual_path'), '')
    ));

  FOREACH v_remove_key IN ARRAY ARRAY['kind','label','sub','icon','branch','error_path','manual_path']
  LOOP
    IF v_patch ? v_remove_key AND v_patch->v_remove_key = 'null'::jsonb THEN
      v_metadata := v_metadata - v_remove_key;
    END IF;
  END LOOP;

  UPDATE public.workflow_template_steps AS s
     SET operation_name = COALESCE(v_operation_name, s.operation_name),
         operation_settings_category = CASE
           WHEN v_patch ? 'operation_settings_category' THEN NULLIF(btrim(v_patch->>'operation_settings_category'), '')
           ELSE s.operation_settings_category
         END,
         transition_condition = COALESCE(v_transition_condition, s.transition_condition),
         condition_jsonlogic = CASE
           WHEN v_patch ? 'condition_jsonlogic' AND jsonb_typeof(v_patch->'condition_jsonlogic') = 'object' THEN v_patch->'condition_jsonlogic'
           WHEN v_patch ? 'condition_jsonlogic' THEN NULL
           ELSE s.condition_jsonlogic
         END,
         next_operation_name = CASE
           WHEN v_patch ? 'next_operation_name' THEN NULLIF(btrim(v_patch->>'next_operation_name'), '')
           ELSE s.next_operation_name
         END,
         next_operation_priority = CASE
           WHEN v_patch ? 'next_operation_priority' AND v_patch->>'next_operation_priority' IS NOT NULL THEN (v_patch->>'next_operation_priority')::integer
           WHEN v_patch ? 'next_operation_priority' THEN NULL
           ELSE s.next_operation_priority
         END,
         next_operation_delay_seconds = CASE
           WHEN v_patch ? 'next_operation_delay_seconds' AND v_patch->>'next_operation_delay_seconds' IS NOT NULL THEN (v_patch->>'next_operation_delay_seconds')::integer
           WHEN v_patch ? 'next_operation_delay_seconds' THEN NULL
           ELSE s.next_operation_delay_seconds
         END,
         manual_action_required = CASE
           WHEN v_patch ? 'manual_action_required' THEN COALESCE(NULLIF(v_patch->>'manual_action_required', '')::boolean, FALSE)
           ELSE s.manual_action_required
         END,
         enabled = CASE
           WHEN v_patch ? 'enabled' THEN COALESCE(NULLIF(v_patch->>'enabled', '')::boolean, TRUE)
           ELSE s.enabled
         END,
         metadata = NULLIF(v_metadata, '{}'::jsonb),
         handler_key = CASE
           WHEN v_patch ? 'handler_key' THEN NULLIF(btrim(v_patch->>'handler_key'), '')
           ELSE s.handler_key
         END,
         handler_version = CASE
           WHEN v_patch ? 'handler_version' AND NULLIF(btrim(v_patch->>'handler_version'), '') IS NOT NULL THEN NULLIF(btrim(v_patch->>'handler_version'), '')
           ELSE s.handler_version
         END,
         updated_at = now()
   WHERE s.id = v_step_id
  RETURNING to_jsonb(s.*) INTO v_after;

  PERFORM public.workflow_template_step_recompute_checksum_v1(v_before.workflow_template_id);
  v_template_org := CASE WHEN v_template.scope_type = 'tenant' THEN v_template.scope_id ELSE NULL END;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_template_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_step_update', 'workflow_template_step', v_step_id,
    'ui_update_workflow_template_step_v1', 'updated',
    jsonb_build_object(
      'workflow_template_id', v_before.workflow_template_id,
      'patch', v_patch,
      'before', to_jsonb(v_before),
      'after', v_after,
      'reason', NULLIF(btrim(v_args->>'reason'), '')
    ),
    'ui_update_workflow_template_step_v1', v_correlation_id
  );

  IF COALESCE(v_template_org, v_org_id) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_template_org, v_org_id),
      'workflow_template_step.updated', 'workflow_template_step', v_step_id,
      jsonb_build_object('workflow_template_id', v_before.workflow_template_id, 'patch', v_patch),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_before.workflow_template_id,
    'workflow_template_step_id', v_step_id,
    'action', 'updated',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_duplicate_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_step_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_step_id', v_args->>'step_id'), '')::uuid;
  v_expected_template_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id'), '')::uuid;
  v_before public.workflow_template_steps%ROWTYPE;
  v_template public.workflow_templates%ROWTYPE;
  v_template_org uuid;
  v_new_step_id uuid;
  v_sequence_order integer;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_duplicate_workflow_template_step_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_step_id IS NULL THEN
    RAISE EXCEPTION 'ui_duplicate_workflow_template_step_v1 requires step_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
    FROM public.workflow_template_steps
   WHERE id = v_step_id
   FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_duplicate_workflow_template_step_v1 step % not found', v_step_id
      USING ERRCODE = '23503';
  END IF;
  IF v_expected_template_id IS NOT NULL AND v_expected_template_id <> v_before.workflow_template_id THEN
    RAISE EXCEPTION 'ui_duplicate_workflow_template_step_v1 step % is not in template %', v_step_id, v_expected_template_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_before.workflow_template_id
   FOR UPDATE;
  IF NOT public.is_platform_user()
     AND NOT public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id) THEN
    RAISE EXCEPTION 'ui_duplicate_workflow_template_step_v1 workflow_template % outside caller scope', v_before.workflow_template_id
      USING ERRCODE = '42501';
  END IF;

  v_sequence_order := v_before.sequence_order + 1;
  UPDATE public.workflow_template_steps
     SET sequence_order = sequence_order + 1,
         updated_at = now()
   WHERE workflow_template_id = v_before.workflow_template_id
     AND sequence_order >= v_sequence_order;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    condition_jsonlogic,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES (
    v_before.workflow_template_id,
    v_sequence_order,
    v_before.operation_name,
    v_before.operation_settings_category,
    v_before.transition_condition,
    v_before.condition_jsonlogic,
    v_before.next_operation_name,
    v_before.next_operation_priority,
    v_before.next_operation_delay_seconds,
    v_before.manual_action_required,
    jsonb_strip_nulls(COALESCE(v_before.metadata, '{}'::jsonb) || jsonb_build_object('duplicated_from_step_id', v_before.id)),
    v_before.enabled,
    v_before.handler_key,
    v_before.handler_version
  )
  RETURNING id INTO v_new_step_id;

  PERFORM public.workflow_template_step_recompute_checksum_v1(v_before.workflow_template_id);
  v_template_org := CASE WHEN v_template.scope_type = 'tenant' THEN v_template.scope_id ELSE NULL END;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_template_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_step_duplicate', 'workflow_template_step', v_new_step_id,
    'ui_duplicate_workflow_template_step_v1', 'duplicated',
    jsonb_build_object('workflow_template_id', v_before.workflow_template_id, 'source_step_id', v_before.id, 'sequence_order', v_sequence_order),
    'ui_duplicate_workflow_template_step_v1', v_correlation_id
  );

  IF COALESCE(v_template_org, v_org_id) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_template_org, v_org_id),
      'workflow_template_step.duplicated', 'workflow_template_step', v_new_step_id,
      jsonb_build_object('workflow_template_id', v_before.workflow_template_id, 'source_step_id', v_before.id),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_before.workflow_template_id,
    'workflow_template_step_id', v_new_step_id,
    'source_workflow_template_step_id', v_before.id,
    'sequence_order', v_sequence_order,
    'action', 'duplicated',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_delete_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_step_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_step_id', v_args->>'step_id'), '')::uuid;
  v_expected_template_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id'), '')::uuid;
  v_before public.workflow_template_steps%ROWTYPE;
  v_template public.workflow_templates%ROWTYPE;
  v_template_org uuid;
  v_has_references boolean;
  v_action text;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_delete_workflow_template_step_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_step_id IS NULL THEN
    RAISE EXCEPTION 'ui_delete_workflow_template_step_v1 requires step_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
    FROM public.workflow_template_steps
   WHERE id = v_step_id
   FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_delete_workflow_template_step_v1 step % not found', v_step_id
      USING ERRCODE = '23503';
  END IF;
  IF v_expected_template_id IS NOT NULL AND v_expected_template_id <> v_before.workflow_template_id THEN
    RAISE EXCEPTION 'ui_delete_workflow_template_step_v1 step % is not in template %', v_step_id, v_expected_template_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_before.workflow_template_id
   FOR UPDATE;
  IF NOT public.is_platform_user()
     AND NOT public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id) THEN
    RAISE EXCEPTION 'ui_delete_workflow_template_step_v1 workflow_template % outside caller scope', v_before.workflow_template_id
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.workflow_run_steps wrs
            WHERE wrs.workflow_template_step_id = v_step_id
         )
         OR EXISTS (
           SELECT 1 FROM public.workflow_runs wr
            WHERE wr.current_step_id = v_step_id
         )
    INTO v_has_references;

  IF v_has_references THEN
    UPDATE public.workflow_template_steps
       SET enabled = FALSE,
           metadata = jsonb_strip_nulls(
             COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
               'lifecycle', 'deleted',
               'deleted_at', now(),
               'deleted_by', v_user_id,
               'delete_reason', NULLIF(btrim(v_args->>'reason'), '')
             )
           ),
           updated_at = now()
     WHERE id = v_step_id;
    v_action := 'soft_deleted';
  ELSE
    DELETE FROM public.workflow_template_steps
     WHERE id = v_step_id;

    WITH ordered AS (
      SELECT id, row_number() OVER (ORDER BY sequence_order, created_at, id)::integer AS next_order
        FROM public.workflow_template_steps
       WHERE workflow_template_id = v_before.workflow_template_id
    )
    UPDATE public.workflow_template_steps s
       SET sequence_order = ordered.next_order,
           updated_at = now()
      FROM ordered
     WHERE s.id = ordered.id
       AND s.sequence_order IS DISTINCT FROM ordered.next_order;

    v_action := 'deleted';
  END IF;

  PERFORM public.workflow_template_step_recompute_checksum_v1(v_before.workflow_template_id);
  v_template_org := CASE WHEN v_template.scope_type = 'tenant' THEN v_template.scope_id ELSE NULL END;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_template_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_step_delete', 'workflow_template_step', v_step_id,
    'ui_delete_workflow_template_step_v1', v_action,
    jsonb_build_object(
      'workflow_template_id', v_before.workflow_template_id,
      'had_runtime_references', v_has_references,
      'before', to_jsonb(v_before),
      'reason', NULLIF(btrim(v_args->>'reason'), '')
    ),
    'ui_delete_workflow_template_step_v1', v_correlation_id
  );

  IF COALESCE(v_template_org, v_org_id) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_template_org, v_org_id),
      CASE WHEN v_action = 'soft_deleted' THEN 'workflow_template_step.soft_deleted' ELSE 'workflow_template_step.deleted' END,
      'workflow_template_step', v_step_id,
      jsonb_build_object('workflow_template_id', v_before.workflow_template_id, 'had_runtime_references', v_has_references),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_before.workflow_template_id,
    'workflow_template_step_id', v_step_id,
    'deleted', NOT v_has_references,
    'soft_deleted', v_has_references,
    'action', v_action,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_create_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_create_workflow_template_step_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.ui_update_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_update_workflow_template_step_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.ui_duplicate_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_duplicate_workflow_template_step_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.ui_delete_workflow_template_step_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_delete_workflow_template_step_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_update_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_duplicate_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_delete_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_update_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_duplicate_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_delete_workflow_template_step_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_create_workflow_template_step_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_update_workflow_template_step_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_duplicate_workflow_template_step_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_delete_workflow_template_step_v1(jsonb) FROM anon;

GRANT EXECUTE ON FUNCTION public.ui_create_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_update_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_duplicate_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_delete_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_update_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_duplicate_workflow_template_step_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_delete_workflow_template_step_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_workflow_template_step_v1(jsonb)
  IS 'Console V2 Workflow Studio canonical create RPC for public.workflow_template_steps. Capability: workflows.write.';
COMMENT ON FUNCTION public.ui_update_workflow_template_step_v1(jsonb)
  IS 'Console V2 Workflow Studio canonical update RPC for public.workflow_template_steps. Capability: workflows.write.';
COMMENT ON FUNCTION public.ui_duplicate_workflow_template_step_v1(jsonb)
  IS 'Console V2 Workflow Studio canonical duplicate RPC for public.workflow_template_steps. Capability: workflows.write.';
COMMENT ON FUNCTION public.ui_delete_workflow_template_step_v1(jsonb)
  IS 'Console V2 Workflow Studio canonical delete RPC for public.workflow_template_steps. Hard-deletes unreferenced draft steps and soft-deletes referenced steps by disabling them. Capability: workflows.write.';
COMMENT ON FUNCTION api.ui_create_workflow_template_step_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_create_workflow_template_step_v1(jsonb).';
COMMENT ON FUNCTION api.ui_update_workflow_template_step_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_update_workflow_template_step_v1(jsonb).';
COMMENT ON FUNCTION api.ui_duplicate_workflow_template_step_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_duplicate_workflow_template_step_v1(jsonb).';
COMMENT ON FUNCTION api.ui_delete_workflow_template_step_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_delete_workflow_template_step_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202605041131_workflow_template_step_crud_api_v1'));
COMMIT;
