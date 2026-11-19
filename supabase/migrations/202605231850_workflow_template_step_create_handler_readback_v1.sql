-- Resolve workflow step handler metadata from the canonical operation catalog
-- during Console V2 step creation. The browser sends the selected operation
-- name; the backend owns handler_key / handler_version truth.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605231850_workflow_template_step_create_handler_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_operation_handler_key text;
  v_operation_handler_version text;
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

  SELECT ot.handler_key, ot.handler_version
    INTO v_operation_handler_key, v_operation_handler_version
    FROM public.operation_templates ot
   WHERE ot.operation_name = v_operation_name
   ORDER BY
     CASE WHEN ot.provider_id = '99990000-0000-0000-0000-000000460000'::uuid THEN 0 ELSE 1 END,
     ot.updated_at DESC NULLS LAST,
     ot.id
   LIMIT 1;

  v_operation_handler_key := COALESCE(NULLIF(btrim(v_step->>'handler_key'), ''), v_operation_handler_key);
  v_operation_handler_version := COALESCE(NULLIF(btrim(v_step->>'handler_version'), ''), v_operation_handler_version, 'v1');

  IF v_operation_handler_key IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 operation % has no handler_key in operation_templates', v_operation_name
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
    handler_key,
    handler_version
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
    v_operation_handler_key,
    v_operation_handler_version
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
    jsonb_build_object(
      'workflow_template_id', v_template_id,
      'sequence_order', v_sequence_order,
      'operation_name', v_operation_name,
      'handler_key', v_operation_handler_key,
      'handler_version', v_operation_handler_version
    ),
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
    'handler_key', v_operation_handler_key,
    'handler_version', v_operation_handler_version,
    'action', 'created',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202605231850_workflow_template_step_create_handler_readback_v1'));
COMMIT;
