-- pgTAP: dispatch route scan-out UI registry capability alignment
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(20);

SELECT is(
  (
    SELECT command.command_value->>'capability'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
     LIMIT 1
  ),
  'scan_events.write',
  'routes.scan_load requires scan_events.write in ui_command_registry'
);

SELECT is(
  (
    SELECT command.command_value->>'capability'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
     LIMIT 1
  ),
  'tasks.complete',
  'routes.confirm_departure requires tasks.complete in ui_command_registry'
);

SELECT is(
  (
    SELECT command.command_value#>>'{execution,rpc}'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
     LIMIT 1
  ),
  'ui_execute_route_run_scanout_v1',
  'routes.scan_load stays on the dedicated route scanout RPC'
);

SELECT is(
  (
    SELECT command.command_value#>>'{execution,rpc}'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
     LIMIT 1
  ),
  'ui_execute_route_run_scanout_v1',
  'routes.confirm_departure stays on the dedicated route scanout RPC'
);

SELECT is(
  (
    SELECT command.command_value->>'schema_category'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
     LIMIT 1
  ),
  'resource:routes',
  'routes.scan_load is scoped to the routes resource'
);

SELECT is(
  (
    SELECT command.command_value->>'schema_category'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
     LIMIT 1
  ),
  'resource:routes',
  'routes.confirm_departure is scoped to the routes resource'
);

SELECT ok(
  position(
    'does not match command resource' in pg_get_functiondef(
    'public.ui_execute_route_run_scanout_v1(text, text, text[], text, integer, jsonb)'::regprocedure
    )
  ) > 0,
  'route scanout executor rejects command/resource scope mismatches'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
       AND readback_field.field_value->>'key' = 'duplicate_scan_count'
     LIMIT 1
  ),
  'scan_out.duplicate_scan_count',
  'routes.scan_load readback exposes duplicate scan count'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
       AND readback_field.field_value->>'key' = 'last_load_scanned_at'
     LIMIT 1
  ),
  'scan_out.last_load_scanned_at',
  'routes.scan_load readback exposes last route-load scan timestamp'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
       AND readback_field.field_value->>'key' = 'scan_event_id'
     LIMIT 1
  ),
  'scan_event_id',
  'routes.scan_load readback exposes canonical scan event id'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.scan_load'
       AND readback_field.field_value->>'key' = 'scan_created'
     LIMIT 1
  ),
  'scan_created',
  'routes.scan_load readback exposes whether a scan event was recorded'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'ready_for_departure'
     LIMIT 1
  ),
  'scan_out.ready_for_departure',
  'routes.confirm_departure readback exposes canonical scan-out readiness'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'missing_stop_count'
     LIMIT 1
  ),
  'scan_out.missing_stop_count',
  'routes.confirm_departure readback exposes missing stop count for blocked departure'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'unexpected_scan_count'
     LIMIT 1
  ),
  'scan_out.unexpected_scan_count',
  'routes.confirm_departure readback exposes unexpected scan count for blocked departure'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'duplicate_scan_count'
     LIMIT 1
  ),
  'scan_out.duplicate_scan_count',
  'routes.confirm_departure readback exposes duplicate scan count for blocked departure'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'last_load_scanned_at'
     LIMIT 1
  ),
  'scan_out.last_load_scanned_at',
  'routes.confirm_departure readback exposes last route-load scan timestamp for blocked departure'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'confirmed_at'
     LIMIT 1
  ),
  'route_departure.confirmed_at',
  'routes.confirm_departure readback exposes canonical departure confirmation timestamp'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'status'
     LIMIT 1
  ),
  'status',
  'routes.confirm_departure readback exposes blocked or confirmed departure status'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'blocked_reason'
     LIMIT 1
  ),
  'blocked_reason',
  'routes.confirm_departure readback exposes route-load reconciliation block reason'
);

SELECT is(
  (
    SELECT readback_field.field_value->>'path'
      FROM public.settings
      CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command(command_value)
      CROSS JOIN LATERAL jsonb_array_elements(command.command_value#>'{execution,readback_schema,fields}') AS readback_field(field_value)
     WHERE category = 'ui_command_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND command.command_value->>'key' = 'routes.confirm_departure'
       AND readback_field.field_value->>'key' = 'error_message'
     LIMIT 1
  ),
  'error.message',
  'routes.confirm_departure readback exposes the canonical blocked departure message'
);

SELECT finish();

ROLLBACK;
