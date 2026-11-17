BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(49);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
  ),
  'shipments.print_labels command exists in global ui_command_registry'
);

SELECT is(
  (
    SELECT command->'execution'->>'type'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'print',
  'shipments.print_labels uses print execution type'
);

SELECT is(
  (
    SELECT command->'execution'->>'rpc'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'ui_execute_command_v1',
  'shipments.print_labels keeps ui_execute_command_v1 contract'
);

SELECT is(
  (
    SELECT command->'execution'->'params'->>'fallback_mode'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'none',
  'shipments.print_labels fallback_mode is none (no redirect fallback)'
);

SELECT ok(
  (
    SELECT jsonb_typeof(command->'execution'->'params'->'poll_schedule_ms') = 'array'
       AND jsonb_array_length(command->'execution'->'params'->'poll_schedule_ms') > 0
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'shipments.print_labels poll_schedule_ms is configured'
);

SELECT is(
  (
    SELECT COALESCE((command->'execution'->'params'->'poll_schedule_ms'->>0)::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  25,
  'shipments.print_labels poll_schedule_ms starts at 25ms'
);

SELECT ok(
  (
    SELECT jsonb_typeof(command->'execution'->'params'->'output_url_paths') = 'array'
       AND (command->'execution'->'params'->'output_url_paths') ? 'context.label_print.execute_response.bundle.signed_url'
       AND (command->'execution'->'params'->'output_url_paths') ? 'context.label_print.bundle_response.signed_url'
       AND (command->'execution'->'params'->'output_url_paths') ? 'step_result.execute.bundle.signed_url'
       AND (command->'execution'->'params'->'output_url_paths') ? 'step_result.bundle.signed_url'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'shipments.print_labels output_url_paths includes execute_response, bundle_response, and step_result fallback paths'
);

SELECT is(
  (
    SELECT command->>'workflow_key'
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'labels_print_workflow_v2',
  'shipments.print_labels active workflow_key is labels_print_workflow_v2'
);

SELECT is(
  (
    SELECT (command->'execution'->'params'->>'target_download_ms')::INT
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  100,
  'shipments.print_labels target_download_ms is 100ms KPI target'
);

SELECT ok(
  (
    SELECT COALESCE((command->'execution'->'params'->>'poll_progress_enabled')::BOOLEAN, FALSE)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'shipments.print_labels enables row-driven poll progression'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((command->'execution'->'params'->>'poll_progress_budget_ms')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  '>=',
  25,
  'shipments.print_labels poll_progress_budget_ms is configured'
);

SELECT is(
  (
    SELECT COALESCE((command->'execution'->'params'->>'poll_progress_budget_ms')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  1500,
  'shipments.print_labels poll_progress_budget_ms is retuned to 1500ms'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((command->'execution'->'params'->>'poll_progress_max_steps')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  '>=',
  1,
  'shipments.print_labels poll_progress_max_steps is configured'
);

SELECT is(
  (
    SELECT COALESCE((command->'execution'->'params'->>'poll_progress_max_steps')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  16,
  'shipments.print_labels poll_progress_max_steps is retuned to 16'
);

SELECT ok(
  (
    SELECT COALESCE((command->'execution'->'params'->'workflow_start'->>'inline_kick_enabled')::BOOLEAN, FALSE)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  'shipments.print_labels inline kick is enabled through workflow_start params'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((command->'execution'->'params'->'workflow_start'->>'inline_kick_max_attempts')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  '>=',
  1,
  'shipments.print_labels inline kick max attempts configured'
);

SELECT is(
  (
    SELECT COALESCE((command->'execution'->'params'->'workflow_start'->>'inline_kick_max_attempts')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  1,
  'shipments.print_labels inline kick max attempts is tightened to 1'
);

SELECT is(
  (
    SELECT COALESCE((command->'execution'->'params'->'workflow_start'->>'inline_kick_budget_ms')::INT, 0)
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS command
    WHERE s.category = 'ui_command_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND command->>'key' = 'shipments.print_labels'
    LIMIT 1
  ),
  200,
  'shipments.print_labels inline kick budget is tightened to 200ms'
);

SELECT is(
  (SELECT handler_version FROM public.operation_handlers WHERE handler_key = 'label_print_prepare'),
  'v4',
  'label_print_prepare operation handler upgraded to v4'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'labels_print_workflow_v1'
      AND wts.handler_key = 'label_print_prepare'
      AND wts.handler_version = 'v4'
      AND COALESCE(NULLIF(wts.metadata->>'poll_interval_seconds', '')::INT, 0) <= 1
  ),
  'labels_print_workflow_v1 uses label_print_prepare v4 with <=1s poll interval'
);

SELECT ok(
  (
    SELECT COALESCE((s.cached_value->>'render_invoke_enabled')::BOOLEAN, FALSE)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'label_print_policy render_invoke_enabled default is true'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'render_max_calls')::INT, 0)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '>=',
  1,
  'label_print_policy render_max_calls is configured for bounded async dispatch fan-out'
);

SELECT ok(
  (
    SELECT COALESCE((s.cached_value->>'fresh_generation_required')::BOOLEAN, FALSE)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'label_print_policy fresh_generation_required default is true'
);

SELECT is(
  (
    SELECT COALESCE(s.cached_value->>'workflow_mode', '')
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'print_sync_execute',
  'label_print_policy workflow_mode defaults to print_sync_execute'
);

SELECT is(
  (
    SELECT COALESCE(s.cached_value->>'fresh_resolve_mode', '')
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'workflow_scope_only',
  'label_print_policy fresh_resolve_mode is workflow_scope_only'
);

SELECT ok(
  (
    SELECT COALESCE((s.cached_value->>'prepare_inline_progress_enabled')::BOOLEAN, FALSE)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'label_print_policy prepare_inline_progress_enabled default is true'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'prepare_inline_progress_budget_ms')::INT, 0)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '>=',
  1250,
  'label_print_policy prepare_inline_progress_budget_ms default bridges 1s waits'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'prepare_inline_progress_max_steps')::INT, 0)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '>=',
  12,
  'label_print_policy prepare_inline_progress_max_steps default supports repeated due-wait bridges'
);

SELECT ok(
  (
    SELECT COALESCE((s.cached_value->>'print_sync_compact_enabled')::BOOLEAN, FALSE)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'label_print_policy print_sync_compact_enabled default is true'
);

SELECT is(
  (
    SELECT COALESCE(s.cached_value->>'print_sync_bundle_return_mode', '')
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'file_path_only',
  'label_print_policy print_sync_bundle_return_mode defaults to file_path_only'
);

SELECT is(
  (
    SELECT COALESCE(s.cached_value->>'edge_db_mode', '')
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  'rest_rpc',
  'label_print_policy edge_db_mode defaults to rest_rpc'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'quick_poll_attempts')::INT, -1)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '>=',
  0,
  'label_print_policy quick_poll_attempts configured'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'quick_poll_interval_ms')::INT, 0)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '>=',
  25,
  'label_print_policy quick_poll_interval_ms is at least 25ms'
);

SELECT cmp_ok(
  (
    SELECT COALESCE((s.cached_value->>'quick_poll_interval_ms')::INT, 0)
    FROM public.settings s
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY s.last_updated DESC
    LIMIT 1
  ),
  '<=',
  2000,
  'label_print_policy quick_poll_interval_ms is bounded'
);

SELECT has_function(
  'api',
  'lease_and_compose_label_payloads_compact',
  ARRAY['uuid[]', 'integer', 'integer'],
  'api.lease_and_compose_label_payloads_compact wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.lease_and_compose_label_payloads_compact(uuid[],integer,integer)',
    'EXECUTE'
  ),
  'service_role can execute api.lease_and_compose_label_payloads_compact'
);

SELECT ok(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role')
      THEN has_function_privilege(
        'edge_label_renderer_role',
        'api.lease_and_compose_label_payloads_compact(uuid[],integer,integer)',
        'EXECUTE'
      )
    ELSE TRUE
  END,
  'edge_label_renderer_role can execute api.lease_and_compose_label_payloads_compact when role exists'
);

SELECT has_function(
  'public',
  'request_label_generation_bulk_v1',
  ARRAY['jsonb', 'text', 'uuid', 'text', 'text'],
  'request_label_generation_bulk_v1 exists'
);

SELECT has_function(
  'public',
  'request_label_generation_bulk_for_step_v1',
  ARRAY['uuid', 'jsonb', 'text', 'uuid', 'text', 'text'],
  'request_label_generation_bulk_for_step_v1 exists'
);

SELECT has_function(
  'public',
  'invoke_label_renderer_print_sync_v1',
  ARRAY['uuid', 'uuid', 'jsonb'],
  'invoke_label_renderer_print_sync_v1 exists'
);

SELECT has_function(
  'public',
  'progress_workflow_run_until_wait_v1',
  ARRAY['uuid', 'jsonb', 'integer', 'integer'],
  'progress_workflow_run_until_wait_v1 exists'
);

SELECT has_function(
  'public',
  'progress_workflow_run_step_result_v1',
  ARRAY['uuid', 'uuid', 'jsonb', 'integer', 'integer'],
  'progress_workflow_run_step_result_v1 exists'
);

SELECT has_function(
  'api',
  'progress_workflow_run_step_result_v1',
  ARRAY['uuid', 'uuid', 'jsonb', 'integer', 'integer'],
  'api.progress_workflow_run_step_result_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.progress_workflow_run_step_result_v1(uuid,uuid,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'service_role can execute api.progress_workflow_run_step_result_v1'
);

SELECT ok(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role')
      THEN has_function_privilege(
        'edge_label_renderer_role',
        'api.progress_workflow_run_step_result_v1(uuid,uuid,jsonb,integer,integer)',
        'EXECUTE'
      )
    ELSE TRUE
  END,
  'edge_label_renderer_role can execute api.progress_workflow_run_step_result_v1 when role exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'label_print_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND COALESCE((sv.value->>'bundle_inline_progress_enabled')::boolean, false) = true
      AND COALESCE((sv.value->>'bundle_inline_progress_budget_ms')::int, 0) >= 25
      AND COALESCE((sv.value->>'bundle_inline_progress_max_steps')::int, 0) >= 1
  ),
  'label_print_policy global defaults include bundle inline progression knobs'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'labels_print_workflow_v1'
      AND wts.operation_name IN ('generate_barcodes', 'render_labels_pdf')
      AND COALESCE(wts.enabled, TRUE) = FALSE
  ),
  'redundant generate_barcodes/render_labels_pdf steps are disabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'labels_print_workflow_v2'
      AND wts.sequence_order = 1
      AND wts.handler_key = 'label_print_execute'
      AND COALESCE(wts.enabled, TRUE) = TRUE
  ),
  'labels_print_workflow_v2 starts with label_print_execute'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_template_steps wts
    JOIN public.workflow_templates wt ON wt.id = wts.workflow_template_id
    WHERE wt.name = 'labels_print_workflow_v2'
      AND wts.sequence_order = 2
      AND wts.handler_key = 'label_print_finalize'
      AND COALESCE(wts.enabled, TRUE) = TRUE
  ),
  'labels_print_workflow_v2 keeps canonical label_print_finalize audit step'
);

SELECT * FROM finish();
ROLLBACK;
