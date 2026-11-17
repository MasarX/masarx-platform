-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Workflow context guards + defaults; harden shipment_return_v1 + shipment_swap_v1 (row-driven)
-- Date: 2026-01-24
--
-- Why:
--   - return/swap templates were placeholders (context_extract + reserve_identifiers only).
--   - We need enterprise-safe behavior: create a planned shipment and enqueue a dispatch task when client context exists,
--     but avoid failing non-creation intent tests/sources that do not provide sender->client scope.
--   - Keep it dynamic: defaults + guard behavior are configured on workflow_template_steps metadata (data-defined),
--     not hardcoded in app code.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242450_workflow_context_guards_return_swap_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Generic handler: context_set_defaults (non-stomping context patch)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_context_set_defaults_v1(
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
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_mode TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'mode', '')), ''));
  v_defaults JSONB := COALESCE(v_meta->'defaults', '{}'::jsonb);
  v_patch JSONB := '{}'::jsonb;

  v_k TEXT;
  v_v JSONB;
  v_existing JSONB;
  v_missing BOOLEAN;

  v_resp public.workflow_handler_response;
BEGIN
  IF jsonb_typeof(v_defaults) IS DISTINCT FROM 'object' THEN
    v_defaults := '{}'::jsonb;
  END IF;

  v_mode := COALESCE(NULLIF(v_mode, ''), 'set_if_missing');

  FOR v_k, v_v IN
    SELECT key, value
    FROM jsonb_each(v_defaults)
  LOOP
    v_missing := TRUE;

    IF v_mode = 'overwrite' THEN
      v_missing := TRUE;
    ELSE
      IF v_ctx ? v_k THEN
        v_existing := v_ctx->v_k;
        IF v_existing IS NULL OR v_existing = 'null'::jsonb THEN
          v_missing := TRUE;
        ELSIF jsonb_typeof(v_existing) = 'string' THEN
          v_missing := (btrim(COALESCE(v_existing #>> '{}', '')) = '');
        ELSE
          v_missing := FALSE;
        END IF;
      END IF;
    END IF;

    IF v_missing THEN
      v_patch := jsonb_set(v_patch, ARRAY[v_k], v_v, TRUE);
    END IF;
  END LOOP;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.next_run_at := NULL;
  v_resp.retry_attempt := 1;
  v_resp.max_retries := 1;
  v_resp.last_error := NULL;
  v_resp.context_patch := v_patch;
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'mode', v_mode,
    'applied_defaults', v_patch
  ));
  RETURN v_resp;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_context_set_defaults_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Generic handler: apply metadata.defaults into workflow context without stomping existing keys (mode=set_if_missing|overwrite).';

INSERT INTO public.operation_handlers AS oh (
  handler_key, handler_schema, handler_name, handler_signature, handler_version,
  is_active, notes, doc_url
)
VALUES (
  'context_set_defaults',
  'workflow_handlers',
  'execute_context_set_defaults_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply metadata.defaults into workflow context (non-stomping by default).',
  NULL
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-------------------------------------------------------------------------------
-- 2) Generic handler: context_require (early-complete/fail on missing required context)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_context_require_v1(
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
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_query_ctx JSONB := jsonb_build_object(
    'context', v_ctx,
    'operation_result', COALESCE(p_operation_result, '{}'::jsonb)
  );

  v_required JSONB := COALESCE(v_meta->'required_paths', v_meta->'required', '[]'::jsonb);
  v_on_missing TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'on_missing', v_meta->>'mode', 'fail_workflow')), ''));

  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_item TEXT;
  v_value JSONB;
  v_present BOOLEAN;

  v_resp public.workflow_handler_response;
BEGIN
  IF jsonb_typeof(v_required) IS DISTINCT FROM 'array' THEN
    v_required := '[]'::jsonb;
  END IF;

  v_on_missing := COALESCE(NULLIF(v_on_missing, ''), 'fail_workflow');

  FOR v_item IN
    SELECT jsonb_array_elements_text(v_required)
  LOOP
    v_item := NULLIF(btrim(COALESCE(v_item, '')), '');
    IF v_item IS NULL THEN
      CONTINUE;
    END IF;

    IF left(v_item, 1) = '$' THEN
      v_value := public.safe_jsonpath_query_first(v_query_ctx, v_item);
    ELSE
      v_value := v_ctx->v_item;
    END IF;

    v_present := TRUE;
    IF v_value IS NULL OR v_value = 'null'::jsonb THEN
      v_present := FALSE;
    ELSIF jsonb_typeof(v_value) = 'string' THEN
      v_present := (btrim(COALESCE(v_value #>> '{}', '')) <> '');
    ELSE
      v_present := TRUE;
    END IF;

    IF v_present IS NOT TRUE THEN
      v_missing := array_append(v_missing, v_item);
    END IF;
  END LOOP;

  v_resp.status := 'completed';
  v_resp.workflow_status := NULL;
  v_resp.next_run_at := NULL;
  v_resp.retry_attempt := 1;
  v_resp.max_retries := 1;
  v_resp.last_error := NULL;

  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'required', v_required,
    'missing', v_missing,
    'on_missing', v_on_missing
  ));

  IF array_length(v_missing, 1) IS NOT NULL THEN
    v_resp.context_patch := jsonb_build_object(
      'context_require',
      jsonb_build_object(
        'missing', to_jsonb(v_missing),
        'on_missing', v_on_missing
      )
    );

    IF v_on_missing IN ('complete', 'complete_workflow', 'workflow_complete') THEN
      v_resp.workflow_status := 'completed';
    ELSIF v_on_missing IN ('fail', 'fail_workflow', 'workflow_fail') THEN
      v_resp.status := 'failed';
      v_resp.last_error := 'missing_required_context';
    END IF;
  ELSE
    v_resp.context_patch := '{}'::jsonb;
  END IF;

  RETURN v_resp;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_context_require_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Generic handler: require context keys/paths (top-level or JSONPath). On missing, can fail or early-complete workflow via metadata.on_missing.';

INSERT INTO public.operation_handlers AS oh (
  handler_key, handler_schema, handler_name, handler_signature, handler_version,
  is_active, notes, doc_url
)
VALUES (
  'context_require',
  'workflow_handlers',
  'execute_context_require_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Require workflow context keys/paths; optionally early-complete workflow when missing (row-driven).',
  NULL
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-------------------------------------------------------------------------------
-- 3) Harden shipment_return_v1 + shipment_swap_v1: defaults + guard + create + enqueue
-------------------------------------------------------------------------------

DO $do$
DECLARE
  tpl RECORD;
  v_base INT;
  v_defaults JSONB;
  v_task_type_key TEXT;
BEGIN
  FOR tpl IN
    SELECT id, name
    FROM public.workflow_templates
    WHERE name IN ('shipment_return_v1', 'shipment_swap_v1')
  LOOP
    IF tpl.name = 'shipment_return_v1' THEN
      v_defaults := jsonb_build_object('service_type', 'pickup', 'initial_status', 'pending');
      v_task_type_key := 'dispatch_return_pickup';
    ELSE
      v_defaults := jsonb_build_object('service_type', 'swap', 'initial_status', 'pending');
      v_task_type_key := 'dispatch_swap_completion';
    END IF;

    v_base := GREATEST(
      2,
      COALESCE(
        (SELECT MAX(sequence_order) + 1 FROM public.workflow_template_steps WHERE workflow_template_id = tpl.id),
        2
      )
    );

    -- Step: context_set_defaults (after reserve_identifiers)
    IF NOT EXISTS (
      SELECT 1
      FROM public.workflow_template_steps
      WHERE workflow_template_id = tpl.id
        AND handler_key = 'context_set_defaults'
    ) THEN
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
        enabled,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        tpl.id,
        v_base,
        'context_set_defaults',
        'workflow',
        'always',
        'context_set_defaults',
        'v1',
        jsonb_build_object('mode', 'set_if_missing', 'defaults', v_defaults),
        FALSE,
        TRUE,
        now(),
        now()
      );
      v_base := v_base + 1;
    END IF;

    -- Step: context_require client_id (early-complete when missing to avoid failing non-creation sources)
    IF NOT EXISTS (
      SELECT 1
      FROM public.workflow_template_steps
      WHERE workflow_template_id = tpl.id
        AND handler_key = 'context_require'
    ) THEN
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
        enabled,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        tpl.id,
        v_base,
        'context_require_client',
        'workflow',
        'always',
        'context_require',
        'v1',
        jsonb_build_object('required', jsonb_build_array('client_id'), 'on_missing', 'complete_workflow'),
        FALSE,
        TRUE,
        now(),
        now()
      );
      v_base := v_base + 1;
    END IF;

    -- Step: shipment_create (create the planned shipment row when client_id is present)
    IF NOT EXISTS (
      SELECT 1
      FROM public.workflow_template_steps
      WHERE workflow_template_id = tpl.id
        AND handler_key = 'shipment_create'
    ) THEN
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
        enabled,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        tpl.id,
        v_base,
        'create_shipment',
        'workflow',
        'always',
        'shipment_create',
        'v1',
        '{}'::jsonb,
        FALSE,
        TRUE,
        now(),
        now()
      );
      v_base := v_base + 1;
    END IF;

    -- Step: task_enqueue (enqueue dispatch task to execute return/swap)
    IF NOT EXISTS (
      SELECT 1
      FROM public.workflow_template_steps
      WHERE workflow_template_id = tpl.id
        AND handler_key = 'task_enqueue'
    ) THEN
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
        enabled,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        tpl.id,
        v_base,
        'task_enqueue_dispatch',
        'workflow',
        'always',
        'task_enqueue',
        'v2',
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_task_type_key,
          'queue_key', 'dispatch',
          'context_key', 'dispatch_task',
          'resource_type', 'shipment',
          'resource_id_path', '$.context.shipment.id',
          'task_metadata', jsonb_build_object('source_template', tpl.name)
        )),
        FALSE,
        TRUE,
        now(),
        now()
      );
      v_base := v_base + 1;
    END IF;
  END LOOP;
END;
$do$;

-- Recalculate steps_checksum for return/swap templates (to preserve workflow invariants).
WITH recalculated AS (
  SELECT
    wts.workflow_template_id,
    md5(
      string_agg(
        concat_ws(
          '|',
          wts.sequence_order,
          COALESCE(wts.operation_name, ''),
          COALESCE(wts.operation_settings_category, ''),
          COALESCE(wts.transition_condition, ''),
          COALESCE(wts.handler_key, ''),
          COALESCE(wts.handler_version, ''),
          COALESCE(wts.metadata::TEXT, '')
        ),
        '||' ORDER BY wts.sequence_order
      )
    ) AS checksum
  FROM public.workflow_template_steps wts
  WHERE wts.workflow_template_id IN (
    SELECT id FROM public.workflow_templates WHERE name IN ('shipment_return_v1', 'shipment_swap_v1')
  )
  GROUP BY wts.workflow_template_id
)
UPDATE public.workflow_templates wt
SET steps_checksum = recalculated.checksum,
    updated_at = now()
FROM recalculated
WHERE wt.id = recalculated.workflow_template_id;

SELECT pg_advisory_unlock(hashtext('202601242450_workflow_context_guards_return_swap_v1'));
COMMIT;

