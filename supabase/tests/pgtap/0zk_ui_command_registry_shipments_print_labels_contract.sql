-- Plan: PLAN-202603-go-live-readiness-remediation-v4 / Step: S95
-- Purpose: enforce one-click shipments.print_labels command contract across all command-registry scopes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

CREATE TEMP TABLE _print_label_commands AS
SELECT s.scope_type,
       s.scope_id,
       command.value AS command
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command(value)
 WHERE s.category = 'ui_command_registry'
   AND command.value->>'key' = 'shipments.print_labels';

SELECT ok(
  (SELECT COUNT(*) FROM _print_label_commands) > 0,
  'shipments.print_labels exists in ui_command_registry settings'
);

SELECT is(
  (
    SELECT COUNT(*)
      FROM _print_label_commands
     WHERE lower(COALESCE(command #>> '{execution,params,auto_download}', '')) <> 'true'
  ),
  0::bigint,
  'shipments.print_labels auto_download=true across all scopes'
);

SELECT is(
  (
    SELECT COUNT(*)
      FROM _print_label_commands
     WHERE NOT (
       jsonb_typeof(command #> '{execution,params,output_url_paths}') = 'array'
       AND jsonb_array_length(command #> '{execution,params,output_url_paths}') > 0
     )
  ),
  0::bigint,
  'shipments.print_labels output_url_paths is a non-empty array across all scopes'
);

SELECT is(
  (
    SELECT COUNT(*)
      FROM _print_label_commands
     WHERE COALESCE(command #>> '{execution,params,fallback_mode}', '') <> 'none'
  ),
  0::bigint,
  'shipments.print_labels fallback_mode=none across all scopes'
);

SELECT is(
  (
    SELECT COUNT(*)
      FROM _print_label_commands
     WHERE COALESCE(command #>> '{execution,type}', '') <> 'print'
  ),
  0::bigint,
  'shipments.print_labels execution.type=print across all scopes'
);

SELECT is(
  (
    SELECT COUNT(*)
      FROM _print_label_commands
     WHERE COALESCE(command #>> '{execution,rpc}', '') <> 'ui_execute_command_v1'
  ),
  0::bigint,
  'shipments.print_labels execution.rpc=ui_execute_command_v1 across all scopes'
);

SELECT * FROM finish();

ROLLBACK;
