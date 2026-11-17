-- Plan: PLAN-202601-demo-speed-here-failfast / Step: S04
-- Purpose: run_outbound_worker marks outbound_calls as pending_edge when call_api returns edge_dispatch.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_policy JSONB;
  v_version INTEGER;
  v_settings_version_id UUID;
BEGIN
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) INTO v_policy;

  IF NULLIF((v_policy->>'endpoint_url')::text, '') IS NULL THEN
    v_version := COALESCE((
      SELECT MAX(version)
      FROM public.settings_versions
      WHERE category = 'edge_dispatch_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ), 0) + 1;

    v_settings_version_id := gen_random_uuid();
    v_policy := jsonb_build_object(
      'enabled', true,
      'endpoint_url', 'https://edge-dispatch.example.invalid/functions/v1/api-caller',
      'batch_size', 10,
      'dispatch_timeout_ms', 3000
    );

    INSERT INTO public.settings_versions (
      id, category, scope_type, scope_id, version, value, approved_at, change_reason
    )
    VALUES (
      v_settings_version_id,
      'edge_dispatch_policy',
      'global',
      NULL,
      v_version,
      v_policy,
      now(),
      'pgtap fixture: edge dispatch policy'
    );

    INSERT INTO public.settings (
      id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated
    )
    VALUES (
      gen_random_uuid(),
      'edge_dispatch_policy',
      'global',
      NULL,
      v_settings_version_id,
      v_policy,
      now()
    )
    ON CONFLICT (category, scope_type, scope_hash)
    DO UPDATE
      SET settings_version_id = EXCLUDED.settings_version_id,
          cached_value = EXCLUDED.cached_value,
          last_updated = now();
  END IF;
END $$;

WITH policy AS (
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
)
SELECT ok(
  NULLIF((value->>'endpoint_url')::text, '') IS NOT NULL,
  'edge_dispatch_policy endpoint_url configured'
)
FROM policy;

WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
SELECT ok(
  id IS NOT NULL,
  'client available for outbound call test'
)
FROM target;

SELECT set_config('app.workflow_run_id', 'd8300000-0000-0000-0000-000000000084', true);
SELECT set_config('app.workflow_run_step_id', 'd8300000-0000-0000-0000-000000000085', true);
SELECT set_config('masarx.workflow_engine', '1', true);
SELECT set_config('masarx.workflow_run_step_id', 'd8300000-0000-0000-0000-000000000085', true);
SELECT set_config('app.force_worker', 'outbound_worker', true);

INSERT INTO workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
)
VALUES (
  'd8300000-0000-0000-0000-000000000083',
  'pgtap_outbound_edge_dispatch',
  'Fixture workflow for outbound edge dispatch test',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
)
VALUES (
  'd8300000-0000-0000-0000-000000000085',
  'd8300000-0000-0000-0000-000000000083',
  1,
  'outbound_http',
  'always',
  'outbound_http',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'd8300000-0000-0000-0000-000000000084',
  'd8300000-0000-0000-0000-000000000083',
  1,
  'test',
  'pending',
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
)
VALUES (
  'd8300000-0000-0000-0000-000000000085',
  'd8300000-0000-0000-0000-000000000084',
  'd8300000-0000-0000-0000-000000000085',
  1,
  'pending',
  'outbound_http',
  'outbound_http',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

WITH target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
)
INSERT INTO outbound_calls (
  id,
  call_type,
  target_type,
  target_id,
  method,
  url,
  headers,
  body,
  status,
  priority,
  max_retries,
  scheduled_at,
  workflow_run_step_id
)
SELECT
  'd8300000-0000-0000-0000-000000000086',
  'provider_api',
  'client',
  target.id,
  'GET',
  'https://example.com',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending',
  1000000,
  1,
  now() - interval '1 minute',
  'd8300000-0000-0000-0000-000000000085'
FROM target
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    scheduled_at = EXCLUDED.scheduled_at,
    workflow_run_step_id = EXCLUDED.workflow_run_step_id;

DO $$
BEGIN
  IF NULLIF((resolve_settings('edge_dispatch_policy', 'global', NULL)->>'endpoint_url')::text, '') IS NOT NULL
     AND (SELECT id FROM clients ORDER BY created_at ASC LIMIT 1) IS NOT NULL THEN
    PERFORM public.run_outbound_worker();
  END IF;
END $$;

WITH policy AS (
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
), target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
), readiness AS (
  SELECT
    value,
    target.id AS target_id,
    NULLIF((value->>'endpoint_url')::text, '') IS NOT NULL AS has_endpoint,
    COALESCE((value->>'enabled')::boolean, TRUE) AS edge_enabled
  FROM policy, target
)
SELECT CASE
  WHEN target_id IS NULL OR NOT (has_endpoint AND edge_enabled) THEN
    skip('edge dispatch disabled or client missing', 1)
  ELSE
    is(
      (SELECT status FROM outbound_calls WHERE id = 'd8300000-0000-0000-0000-000000000086'),
      'pending_edge',
      'run_outbound_worker sets pending_edge'
    )
END
FROM readiness;

WITH policy AS (
  SELECT resolve_settings('edge_dispatch_policy', 'global', NULL) AS value
), target AS (
  SELECT id FROM clients ORDER BY created_at ASC LIMIT 1
), readiness AS (
  SELECT
    value,
    target.id AS target_id,
    NULLIF((value->>'endpoint_url')::text, '') IS NOT NULL AS has_endpoint,
    COALESCE((value->>'enabled')::boolean, TRUE) AS edge_enabled
  FROM policy, target
)
SELECT CASE
  WHEN target_id IS NULL OR NOT (has_endpoint AND edge_enabled) THEN
    skip('edge dispatch disabled or client missing', 1)
  ELSE
    ok(
      EXISTS (
        SELECT 1
        FROM outbound_calls
        WHERE id = 'd8300000-0000-0000-0000-000000000086'
          AND context ? 'edge_dispatch'
      ),
      'edge dispatch context recorded'
    )
END
FROM readiness;

SELECT * FROM finish();
ROLLBACK;
