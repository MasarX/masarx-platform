-- Console V2 workflow template clone readback hardening.
-- Template promotion clones must preserve step handler lineage so the cloned
-- template can be selected, activated, and read back without runtime failure.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605241735_workflow_template_clone_handler_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', FALSE),
  ('decision_outcome', 'Decision outcomes for decision_log', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

WITH categories(value, label, description, sort_order) AS (
  VALUES
    ('workflows.template_create', 'Workflows Template Create', 'Workflow template creation decisions emitted by canonical RPCs.', 2330),
    ('workflows.template_clone', 'Workflows Template Clone', 'Workflow template clone decisions emitted by canonical RPCs.', 2340)
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
  jsonb_build_object('source', 'workflow_template_clone_handler_readback_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, description, sort_order) AS (
  VALUES
    ('cloned', 'Cloned', 'Resource clone decision outcome.', 2375)
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
  jsonb_build_object('source', 'workflow_template_clone_handler_readback_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_name text := NULLIF(btrim(COALESCE(v_args->>'name', v_args->>'template_name', '')), '');
  v_description text := NULLIF(btrim(COALESCE(v_args->>'description', v_args->>'template_description', '')), '');
  v_clone_from uuid := NULLIF(COALESCE(v_args->>'clone_from', v_args->>'clone_from_template_id', v_args->>'source_template_id'), '')::uuid;
  v_trigger_event text := NULLIF(btrim(COALESCE(v_args->>'trigger', v_args->>'trigger_event', '')), '');
  v_requested_scope_type text := lower(NULLIF(btrim(COALESCE(v_args->>'scope_type', v_args->>'target_scope_type', '')), ''));
  v_requested_scope_id uuid := NULLIF(COALESCE(v_args->>'scope_id', v_args->>'target_scope_id', ''), '')::uuid;
  v_scope_type text := lower(COALESCE(v_requested_scope_type, public.current_user_scope_type(), 'global'));
  v_scope_id uuid := COALESCE(v_requested_scope_id, public.current_user_scope_id());
  v_current_org_id uuid := public.current_user_org_id();
  v_template_id uuid;
  v_decision_id uuid := gen_random_uuid();
  v_correlation_id uuid := gen_random_uuid();
  v_copied_step_count integer := 0;
  v_metadata jsonb := '{}'::jsonb;
  v_clone_metadata jsonb;
  v_clone_scope_type text;
  v_clone_scope_id uuid;
  v_clone_org_id uuid;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 requires name'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'tenant';
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
  END IF;

  IF v_scope_type NOT IN ('global', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
    IF NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 global scope requires platform user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'tenant' THEN
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 tenant scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND v_current_org_id IS DISTINCT FROM v_scope_id THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 tenant scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 client scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND NOT EXISTS (
      SELECT 1 FROM public.clients c
       WHERE c.id = v_scope_id
         AND c.organization_id = v_current_org_id
    ) THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 client scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 sender scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND NOT EXISTS (
      SELECT 1
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope_id
         AND c.organization_id = v_current_org_id
    ) THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 sender scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_clone_from IS NOT NULL THEN
    SELECT
      COALESCE(wt.metadata, '{}'::jsonb),
      lower(COALESCE(wt.scope_type, 'global')),
      wt.scope_id
      INTO v_clone_metadata, v_clone_scope_type, v_clone_scope_id
      FROM public.workflow_templates wt
     WHERE wt.id = v_clone_from
     LIMIT 1;

    IF v_clone_metadata IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 clone template not found'
        USING ERRCODE = '23503';
    END IF;

    v_clone_org_id := CASE
      WHEN v_clone_scope_type = 'tenant' THEN v_clone_scope_id
      WHEN v_clone_scope_type = 'client' THEN (
        SELECT c.organization_id FROM public.clients c WHERE c.id = v_clone_scope_id
      )
      WHEN v_clone_scope_type = 'sender' THEN (
        SELECT c.organization_id
          FROM public.senders s
          JOIN public.clients c ON c.id = s.client_id
         WHERE s.id = v_clone_scope_id
      )
      ELSE NULL
    END;

    IF NOT public.is_platform_user()
       AND v_clone_scope_type IS DISTINCT FROM 'global'
       AND v_clone_org_id IS DISTINCT FROM v_current_org_id THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 clone template outside caller organization'
        USING ERRCODE = '42501';
    END IF;

    v_metadata := v_clone_metadata || jsonb_build_object('source_template_id', v_clone_from::text);
  END IF;

  IF v_trigger_event IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object('trigger_event', v_trigger_event);
  END IF;

  INSERT INTO public.workflow_templates (
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    created_by,
    metadata
  )
  VALUES (
    v_name,
    v_description,
    'draft',
    1,
    v_scope_type,
    v_scope_id,
    auth.uid(),
    v_metadata
  )
  RETURNING id INTO v_template_id;

  IF v_clone_from IS NOT NULL THEN
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
    SELECT
      v_template_id,
      step.sequence_order,
      step.operation_name,
      step.operation_settings_category,
      step.transition_condition,
      step.condition_jsonlogic,
      step.next_operation_name,
      step.next_operation_priority,
      step.next_operation_delay_seconds,
      step.manual_action_required,
      step.metadata,
      step.enabled,
      step.handler_key,
      step.handler_version
    FROM public.workflow_template_steps step
    WHERE step.workflow_template_id = v_clone_from
    ORDER BY step.sequence_order ASC;

    GET DIAGNOSTICS v_copied_step_count = ROW_COUNT;
  END IF;

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    performed_by_system,
    correlation_id
  ) VALUES (
    v_decision_id,
    COALESCE(
      CASE WHEN v_scope_type = 'tenant' THEN v_scope_id ELSE v_current_org_id END,
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    CASE WHEN v_clone_from IS NOT NULL THEN 'workflows.template_clone' ELSE 'workflows.template_create' END,
    'workflow_template',
    v_template_id,
    'ui_create_workflow_template_v1',
    CASE WHEN v_clone_from IS NOT NULL THEN 'cloned' ELSE 'created' END,
    jsonb_build_object(
      'workflow_template_id', v_template_id,
      'source_template_id', v_clone_from,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'copied_step_count', v_copied_step_count
    ),
    'ui_create_workflow_template_v1',
    v_correlation_id
  );

  IF COALESCE(CASE WHEN v_scope_type = 'tenant' THEN v_scope_id ELSE v_current_org_id END, NULL) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id,
      event_type,
      resource_type,
      resource_id,
      payload,
      correlation_id,
      status
    ) VALUES (
      CASE WHEN v_scope_type = 'tenant' THEN v_scope_id ELSE v_current_org_id END,
      CASE WHEN v_clone_from IS NOT NULL THEN 'workflow_template.cloned' ELSE 'workflow_template.created' END,
      'workflow_template',
      v_template_id,
      jsonb_build_object(
        'source_template_id', v_clone_from,
        'scope_type', v_scope_type,
        'scope_id', v_scope_id,
        'copied_step_count', v_copied_step_count
      ),
      v_correlation_id,
      'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_template_id', v_template_id::text,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id::text,
    'correlation_id', v_correlation_id::text,
    'settings_resolution_id', v_decision_id::text
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_create_workflow_template_v1(jsonb)
  IS 'Console V2 browser-safe p_args wrapper for canonical workflow template creation. Clone mode preserves step handler lineage so active-tenant Console promotion readback remains executable.';

SELECT pg_advisory_unlock(hashtext('202605241735_workflow_template_clone_handler_readback_v1'));
COMMIT;
