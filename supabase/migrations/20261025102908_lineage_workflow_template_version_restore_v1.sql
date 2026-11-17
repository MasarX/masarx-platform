-- Forward port of a820fa999c1be9ee48e3fded44320b469e9277ff / blob 5edc97418060c79bb5757dcbe60996e3be7b1289.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('lineage_workflow_template_version_restore_v1', 0));

WITH definition AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'decision_category' LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, status, metadata
)
SELECT
  d.id,
  'workflows.template_restore',
  'Workflow template restore',
  'Workflow template version restore decision category',
  640,
  FALSE,
  'active',
  jsonb_build_object('source', 'workflow_template_version_diff_restore_v1')
FROM definition d
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH definition AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'decision_outcome' LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, status, metadata
)
SELECT
  d.id,
  'restored',
  'Restored',
  'Workflow template restored from canonical source version',
  640,
  FALSE,
  'active',
  jsonb_build_object('source', 'workflow_template_version_diff_restore_v1')
FROM definition d
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.workflow_template_version_diff_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_template_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id'), '')::uuid;
  v_source_template_id uuid := NULLIF(COALESCE(
    v_args->>'source_workflow_template_id',
    v_args->>'source_template_id',
    v_args->>'restore_from_workflow_template_id'
  ), '')::uuid;
  v_template public.workflow_templates%ROWTYPE;
  v_source public.workflow_templates%ROWTYPE;
  v_added jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_modified jsonb := '[]'::jsonb;
  v_unchanged jsonb := '[]'::jsonb;
  v_source_count integer := 0;
  v_current_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.read');

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 requires workflow_template_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_template_id
   LIMIT 1;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 workflow_template % not found', v_template_id
      USING ERRCODE = '23503';
  END IF;

  IF v_source_template_id IS NULL THEN
    v_source_template_id := NULLIF(v_template.metadata->>'source_template_id', '')::uuid;
  END IF;

  IF v_source_template_id IS NULL THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 requires source_workflow_template_id or template source lineage'
      USING ERRCODE = '23502';
  END IF;

  IF v_source_template_id = v_template_id THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 source template must differ from target template'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_source
    FROM public.workflow_templates
   WHERE id = v_source_template_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 source workflow_template % not found', v_source_template_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT COALESCE(public.is_platform_user(), FALSE)
     AND NOT COALESCE(public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id), FALSE) THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 workflow_template % outside caller scope', v_template_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(public.is_platform_user(), FALSE)
     AND NOT COALESCE(public.workflow_template_scope_allowed(v_source.scope_type, v_source.scope_id), FALSE) THEN
    RAISE EXCEPTION 'workflow_template_version_diff_v1 source workflow_template % outside caller scope', v_source_template_id
      USING ERRCODE = '42501';
  END IF;

  WITH source_steps AS (
    SELECT
      s.sequence_order,
      jsonb_strip_nulls(jsonb_build_object(
        'id', s.id,
        'sequence_order', s.sequence_order,
        'operation_name', s.operation_name,
        'label', COALESCE(s.metadata->>'label', s.operation_name),
        'handler_key', s.handler_key,
        'handler_version', s.handler_version
      )) AS step,
      jsonb_build_object(
        'sequence_order', s.sequence_order,
        'operation_name', s.operation_name,
        'operation_settings_category', s.operation_settings_category,
        'transition_condition', s.transition_condition,
        'condition_jsonlogic', s.condition_jsonlogic,
        'next_operation_name', s.next_operation_name,
        'next_operation_priority', s.next_operation_priority,
        'next_operation_delay_seconds', s.next_operation_delay_seconds,
        'manual_action_required', s.manual_action_required,
        'metadata', COALESCE(s.metadata, '{}'::jsonb) - 'restored_from_template_step_id' - 'restore_correlation_id',
        'enabled', COALESCE(s.enabled, TRUE),
        'handler_key', s.handler_key,
        'handler_version', s.handler_version
      ) AS signature
    FROM public.workflow_template_steps s
    WHERE s.workflow_template_id = v_source_template_id
      AND COALESCE(s.enabled, TRUE) = TRUE
  ),
  current_steps AS (
    SELECT
      s.sequence_order,
      jsonb_strip_nulls(jsonb_build_object(
        'id', s.id,
        'sequence_order', s.sequence_order,
        'operation_name', s.operation_name,
        'label', COALESCE(s.metadata->>'label', s.operation_name),
        'handler_key', s.handler_key,
        'handler_version', s.handler_version
      )) AS step,
      jsonb_build_object(
        'sequence_order', s.sequence_order,
        'operation_name', s.operation_name,
        'operation_settings_category', s.operation_settings_category,
        'transition_condition', s.transition_condition,
        'condition_jsonlogic', s.condition_jsonlogic,
        'next_operation_name', s.next_operation_name,
        'next_operation_priority', s.next_operation_priority,
        'next_operation_delay_seconds', s.next_operation_delay_seconds,
        'manual_action_required', s.manual_action_required,
        'metadata', COALESCE(s.metadata, '{}'::jsonb) - 'restored_from_template_step_id' - 'restore_correlation_id',
        'enabled', COALESCE(s.enabled, TRUE),
        'handler_key', s.handler_key,
        'handler_version', s.handler_version
      ) AS signature
    FROM public.workflow_template_steps s
    WHERE s.workflow_template_id = v_template_id
      AND COALESCE(s.enabled, TRUE) = TRUE
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(c.step ORDER BY c.sequence_order)
      FROM current_steps c
      LEFT JOIN source_steps s ON s.sequence_order = c.sequence_order
      WHERE s.sequence_order IS NULL
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(s.step ORDER BY s.sequence_order)
      FROM source_steps s
      LEFT JOIN current_steps c ON c.sequence_order = s.sequence_order
      WHERE c.sequence_order IS NULL
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'sequence_order', c.sequence_order,
          'source', s.step,
          'current', c.step
        )
        ORDER BY c.sequence_order
      )
      FROM current_steps c
      JOIN source_steps s ON s.sequence_order = c.sequence_order
      WHERE s.signature IS DISTINCT FROM c.signature
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(c.step ORDER BY c.sequence_order)
      FROM current_steps c
      JOIN source_steps s ON s.sequence_order = c.sequence_order
      WHERE s.signature IS NOT DISTINCT FROM c.signature
    ), '[]'::jsonb),
    (SELECT count(*)::integer FROM source_steps),
    (SELECT count(*)::integer FROM current_steps)
  INTO v_added, v_removed, v_modified, v_unchanged, v_source_count, v_current_count;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_template_id::text,
    'source_workflow_template_id', v_source_template_id::text,
    'current_version', v_template.version::text,
    'source_version', v_source.version::text,
    'current_step_count', v_current_count,
    'source_step_count', v_source_count,
    'added_steps', v_added,
    'removed_steps', v_removed,
    'modified_steps', v_modified,
    'unchanged_steps', v_unchanged
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_template_id uuid := NULLIF(COALESCE(v_args->>'workflow_template_id', v_args->>'template_id'), '')::uuid;
  v_source_template_id uuid := NULLIF(COALESCE(
    v_args->>'source_workflow_template_id',
    v_args->>'source_template_id',
    v_args->>'restore_from_workflow_template_id'
  ), '')::uuid;
  v_reason text := NULLIF(btrim(COALESCE(v_args->>'reason', '')), '');
  v_template public.workflow_templates%ROWTYPE;
  v_source public.workflow_templates%ROWTYPE;
  v_template_org uuid;
  v_prior_version integer;
  v_next_version integer;
  v_final_version integer;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := gen_random_uuid();
  v_restored_step_count integer := 0;
  v_checksum text;
  v_previous_correlation text := current_setting('request.correlation_id', TRUE);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write');

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 requires workflow_template_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = v_template_id
   FOR UPDATE;

  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 workflow_template % not found', v_template_id
      USING ERRCODE = '23503';
  END IF;

  IF v_source_template_id IS NULL THEN
    v_source_template_id := NULLIF(v_template.metadata->>'source_template_id', '')::uuid;
  END IF;

  IF v_source_template_id IS NULL THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 requires source_workflow_template_id or template source lineage'
      USING ERRCODE = '23502';
  END IF;

  IF v_source_template_id = v_template_id THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 source template must differ from target template'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_source
    FROM public.workflow_templates
   WHERE id = v_source_template_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 source workflow_template % not found', v_source_template_id
      USING ERRCODE = '23503';
  END IF;

  IF lower(COALESCE(v_template.scope_type, 'global')) = 'global'
     AND NOT COALESCE(public.is_platform_user(), FALSE) THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 global template restore requires platform user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(public.is_platform_user(), FALSE)
     AND NOT COALESCE(public.workflow_template_scope_allowed(v_template.scope_type, v_template.scope_id), FALSE) THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 workflow_template % outside caller scope', v_template_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(public.is_platform_user(), FALSE)
     AND NOT COALESCE(public.workflow_template_scope_allowed(v_source.scope_type, v_source.scope_id), FALSE) THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 source workflow_template % outside caller scope', v_source_template_id
      USING ERRCODE = '42501';
  END IF;

  IF v_template.status = 'active' THEN
    PERFORM public.assert_capability_v1('system.write');
  END IF;
  -- Keep live executions on their original graph; the insert trigger serializes new starts.
  IF EXISTS (
    SELECT 1 FROM public.workflow_runs r
    WHERE r.workflow_template_id = v_template_id
      AND r.workflow_status NOT IN ('completed','failed','cancelled','stopped')
  ) THEN
    RAISE EXCEPTION 'restore_workflow_template_v1 template has active runs' USING ERRCODE='23514';
  END IF;

  PERFORM set_config('request.correlation_id', v_correlation_id::text, TRUE);
  v_prior_version := COALESCE(v_template.version, 0);
  v_next_version := v_prior_version + 1;
  v_template_org := CASE
    WHEN lower(COALESCE(v_template.scope_type, '')) = 'tenant' THEN v_template.scope_id
    WHEN lower(v_template.scope_type) = 'client' THEN (SELECT organization_id FROM public.clients WHERE id=v_template.scope_id)
    WHEN lower(v_template.scope_type) = 'sender' THEN (SELECT c.organization_id FROM public.senders s JOIN public.clients c ON c.id=s.client_id WHERE s.id=v_template.scope_id)
    ELSE v_org_id
  END;

  UPDATE public.workflow_template_steps
     SET enabled = FALSE,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'disabled_by_restore', true,
           'disabled_by_restore_correlation_id', v_correlation_id::text,
           'disabled_by_restore_at', now()
         ),
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND COALESCE(enabled, TRUE) = TRUE;

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
    COALESCE(step.metadata, '{}'::jsonb) || jsonb_build_object(
      'restored_from_template_step_id', step.id::text,
      'restore_correlation_id', v_correlation_id::text
    ),
    COALESCE(step.enabled, TRUE),
    step.handler_key,
    step.handler_version
  FROM public.workflow_template_steps step
  WHERE step.workflow_template_id = v_source_template_id
    AND COALESCE(step.enabled, TRUE) = TRUE
  ORDER BY step.sequence_order ASC, step.created_at ASC, step.id ASC;

  GET DIAGNOSTICS v_restored_step_count = ROW_COUNT;

  UPDATE public.workflow_templates
     SET version = v_next_version,
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object(
             'source_template_id', v_source_template_id::text,
             'source_version', v_source.version::text,
             'source_template_name', v_source.name,
             'restored_from_template_id', v_source_template_id::text,
             'restored_from_version', v_source.version::text,
             'restore_reason', v_reason,
             'restore_correlation_id', v_correlation_id::text,
             'restored_at', now(),
             'prior_version', v_prior_version,
             'restored_step_count', v_restored_step_count
           ),
         updated_at = now()
   WHERE id = v_template_id;

  v_checksum := public.workflow_refresh_steps_checksum(v_template_id, FALSE);
  SELECT version, steps_checksum
    INTO v_final_version, v_checksum
    FROM public.workflow_templates
   WHERE id = v_template_id;

  UPDATE public.workflow_templates
     SET metadata = COALESCE(metadata, '{}'::jsonb)
       || jsonb_build_object('restored_version', v_final_version::text),
         updated_at = now()
   WHERE id = v_template_id;

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id
  ) VALUES (
    v_decision_id,
    COALESCE(v_template_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_restore',
    'workflow_template',
    v_template_id,
    'restore_workflow_template_v1',
    'restored',
    jsonb_build_object(
      'actor_user_id', v_user_id,
      'workflow_template_id', v_template_id,
      'source_template_id', v_source_template_id,
      'prior_version', v_prior_version,
      'new_version', v_final_version,
      'source_version', v_source.version,
      'restored_step_count', v_restored_step_count,
      'reason', v_reason,
      'checksum', v_checksum
    ),
    v_reason,
    'restore_workflow_template_v1',
    v_correlation_id
  );

  IF v_template_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id,
      event_type,
      resource_type,
      resource_id,
      payload,
      correlation_id,
      status
    ) VALUES (
      v_template_org,
      'workflow_template.restored',
      'workflow_template',
      v_template_id,
      jsonb_build_object(
        'source_template_id', v_source_template_id,
        'prior_version', v_prior_version,
        'new_version', v_final_version,
        'source_version', v_source.version,
        'restored_step_count', v_restored_step_count,
        'checksum', v_checksum
      ),
      v_correlation_id,
      'pending'
    );
  END IF;

  PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_template_id::text,
    'source_workflow_template_id', v_source_template_id::text,
    'prior_version', v_prior_version::text,
    'restored_version', v_final_version::text,
    'current_version', v_final_version::text,
    'source_version', v_source.version::text,
    'restored_step_count', v_restored_step_count,
    'steps_checksum', v_checksum,
    'correlation_id', v_correlation_id::text,
    'settings_resolution_id', v_decision_id::text
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION api.workflow_template_version_diff_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.workflow_template_version_diff_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.restore_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.restore_workflow_template_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.workflow_template_version_diff_v1(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_workflow_template_v1(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.workflow_template_version_diff_v1(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.restore_workflow_template_v1(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.workflow_template_version_diff_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.restore_workflow_template_v1(jsonb) FROM anon;

GRANT EXECUTE ON FUNCTION public.workflow_template_version_diff_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restore_workflow_template_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.workflow_template_version_diff_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.restore_workflow_template_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.workflow_template_version_diff_v1(jsonb)
  IS 'Console V2 Workflow Template Studio canonical version diff RPC. Compares active workflow_template_steps for target and source lineage. Capability: workflow_runs.read.';
COMMENT ON FUNCTION public.restore_workflow_template_v1(jsonb)
  IS 'Console V2 Workflow Template Studio canonical restore RPC. Replaces active workflow_template_steps from a source template, recomputes checksum, and writes decision/event lineage. Capability: workflow_runs.write.';
COMMENT ON FUNCTION api.workflow_template_version_diff_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.workflow_template_version_diff_v1(jsonb).';
COMMENT ON FUNCTION api.restore_workflow_template_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.restore_workflow_template_v1(jsonb).';

CREATE OR REPLACE FUNCTION public.workflow_runs_lock_restored_template_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_version integer;
  v_restored boolean;
BEGIN
  -- Hold the same template row against restore until this start commits.
  SELECT wt.version, COALESCE(wt.metadata ? 'restore_correlation_id', FALSE)
    INTO v_version, v_restored
    FROM public.workflow_templates wt WHERE wt.id=NEW.workflow_template_id FOR KEY SHARE;
  IF v_restored AND NEW.workflow_template_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'Workflow template changed during start; restart the transaction' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.workflow_runs_lock_restored_template_v1() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS workflow_runs_lock_restored_template_v1 ON public.workflow_runs;
CREATE TRIGGER workflow_runs_lock_restored_template_v1 BEFORE INSERT ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.workflow_runs_lock_restored_template_v1();

COMMIT;
