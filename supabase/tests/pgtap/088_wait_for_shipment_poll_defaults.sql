BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO extensions, public, workflow_handlers, pg_temp;

SELECT plan(1);

CREATE TEMP TABLE tmp_wait_for_shipment (
  run_id UUID,
  template_step_id UUID
) ON COMMIT DROP;

WITH current AS (
  SELECT s.id AS settings_id, s.cached_value, sv.id AS sv_id
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'workflow_defaults'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY sv.version DESC
  LIMIT 1
),
patched AS (
  SELECT
    settings_id,
    sv_id,
    (COALESCE(cached_value, '{}'::jsonb) || jsonb_build_object(
      'poll_seconds', 2,
      'poll_seconds_min', 1,
      'poll_seconds_max', 10
    )) AS value
  FROM current
),
updated_sv AS (
  UPDATE public.settings_versions sv
  SET value = p.value,
      updated_at = now()
  FROM patched p
  WHERE sv.id = p.sv_id
  RETURNING sv.id, sv.value
),
updated_settings AS (
  UPDATE public.settings s
  SET cached_value = u.value,
      last_updated = now()
  FROM updated_sv u
  JOIN current c ON c.sv_id = u.id
  WHERE s.id = c.settings_id
  RETURNING s.id
)
SELECT 1;

DO $block$
DECLARE
  v_template_id UUID := gen_random_uuid();
  v_step_id UUID := gen_random_uuid();
  v_run_id UUID;
BEGIN
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    created_at,
    updated_at
  ) VALUES (
    v_template_id,
    'pgtemp_wait_for_shipment',
    'Temp template for wait_for_shipment polling test',
    1,
    'active',
    'global',
    NULL,
    now(),
    now()
  );

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    metadata,
    handler_key,
    handler_version,
    enabled,
    created_at,
    updated_at
  ) VALUES (
    v_step_id,
    v_template_id,
    1,
    'wait_for_shipment',
    'workflow',
    'always',
    '{}'::jsonb,
    'wait_for_shipment',
    'v1',
    TRUE,
    now(),
    now()
  );

  PERFORM set_config('masarx.workflow_engine', '1', true);
  v_run_id := start_workflow_run(
    v_template_id,
    jsonb_build_object('api_gateway_request_id', concat('test-', gen_random_uuid()))
  );
  PERFORM set_config('masarx.workflow_engine', '', true);

  INSERT INTO tmp_wait_for_shipment (run_id, template_step_id)
  VALUES (v_run_id, v_step_id);
END;
$block$;

SELECT is(
  (workflow_handlers.execute_wait_for_shipment_v1(s, r, '{}'::jsonb)).operation_result->>'next_poll_seconds',
  '2',
  'wait_for_shipment uses workflow_defaults poll_seconds when metadata is absent'
)
FROM tmp_wait_for_shipment t
JOIN public.workflow_run_steps s
  ON s.workflow_run_id = t.run_id
 AND s.workflow_template_step_id = t.template_step_id
JOIN public.workflow_runs r
  ON r.id = t.run_id;

SELECT * FROM finish();
ROLLBACK;
