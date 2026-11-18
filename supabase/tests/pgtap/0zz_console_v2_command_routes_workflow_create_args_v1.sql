-- Console V2 command routes and workflow create p_args contract.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(41);

SELECT ok(
  to_regprocedure('public.ui_create_workflow_template_v1(jsonb)') IS NOT NULL,
  'public workflow template create p_args wrapper exists'
);

SELECT ok(
  to_regprocedure('api.ui_create_workflow_template_v1(jsonb)') IS NOT NULL,
  'api workflow template create p_args wrapper exists'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('api.ui_create_workflow_template_v1(jsonb)')) LIKE '%public.ui_create_workflow_template_v1%',
  'api workflow template create wrapper delegates to public wrapper'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_create_workflow_template_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute workflow template create p_args wrapper'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_create_workflow_template_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute workflow template create p_args wrapper'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%v_args->>''name''%',
  'public workflow template create wrapper reads name from p_args'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%assert_capability_v1(''workflows.write'')%',
  'public workflow template create wrapper aligns with Console V2 workflows.write capability'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) NOT LIKE '%workflow_runs.write%',
  'public workflow template create wrapper does not require legacy workflow_runs.write'
);

SELECT ok(
  to_regprocedure('public.ui_create_workflow_template_v1(text,text,uuid)') IS NOT NULL,
  'legacy positional workflow template create overload still exists for internal callers'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(text,text,uuid)'))
    LIKE '%v_scope_type := public.get_root_scope_type_key_v1()%',
  'native workflow template creation maps platform actors to root scope'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(text,text,uuid)'))
    LIKE '%assert_capability_v1(''workflow_runs.write'', v_scope_type, v_scope_id)%',
  'native workflow template creation keeps its scoped capability guard'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_create_workflow_template_v1(text,text,uuid)', 'EXECUTE'),
  'authenticated compatibility callers can execute the aligned positional overload'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%trigger_event%',
  'public workflow template create wrapper persists trigger event metadata'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%v_args->>''scope_type''%',
  'public workflow template create wrapper reads requested scope_type from p_args'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%v_args->>''scope_id''%',
  'public workflow template create wrapper reads requested scope_id from p_args'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%v_scope_type = ''platform''%',
  'public workflow template create wrapper normalizes hidden platform scope before insert'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.ui_create_workflow_template_v1(jsonb)')) LIKE '%scope_id'', v_scope_id::text%',
  'public workflow template create wrapper returns scope readback evidence'
);

SELECT ok(
  to_regprocedure('api.ui_create_workflow_template_step_v1(jsonb)') IS NOT NULL
  AND pg_get_functiondef(to_regprocedure('api.ui_create_workflow_template_step_v1(jsonb)')) LIKE '%public.ui_create_workflow_template_step_v1%',
  'api workflow template step create p_args wrapper exists and delegates'
);

SELECT ok(
  to_regprocedure('api.ui_update_workflow_template_step_v1(jsonb)') IS NOT NULL
  AND pg_get_functiondef(to_regprocedure('api.ui_update_workflow_template_step_v1(jsonb)')) LIKE '%public.ui_update_workflow_template_step_v1%',
  'api workflow template step update p_args wrapper exists and delegates'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_create_workflow_template_step_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.ui_update_workflow_template_step_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute workflow step create/update p_args wrappers'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'route_runs.assign'
       AND command#>>'{route_targets,console,path}' = '/operate/dispatch'
  ),
  'route run assign command opens the dispatch workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'route_runs.confirm_departure'
       AND command#>>'{route_targets,console,path}' = '/operate/dispatch'
  ),
  'route run departure command opens the dispatch workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'route_stops.reassign'
       AND command#>>'{route_targets,console,path}' = '/operate/dispatch'
  ),
  'route stop reassignment command opens the dispatch workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'tasks.transition'
       AND command#>>'{route_targets,console,path}' = '/workflows/review-queue'
  ),
  'task transition command opens the workflow review queue'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'service_offerings.create'
       AND command#>>'{route_targets,console,path}' = '/catalog/service-offerings'
  ),
  'service offering commands open the service offerings workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'webhooks.upsert_source'
       AND command#>>'{route_targets,console,path}' = '/integrations/sources'
  ),
  'webhook source commands open the webhook sources workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'webhooks.toggle_rule'
       AND command#>>'{route_targets,console,path}' = '/integrations/rules'
  ),
  'webhook rule commands open the webhook rules workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'mappings.upsert'
       AND command#>>'{route_targets,console,path}' = '/integrations/mapping'
  ),
  'mapping commands open the mapping studio workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'integrations.create_credential'
       AND command#>>'{route_targets,console,path}' = '/integrations/credentials'
  ),
  'credential commands open the provider credentials workbench'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' IN (
       'integrations.create_credential',
       'integrations.update_credential',
       'integrations.rotate_credential',
       'integrations.revoke_credential'
     )
       AND command->>'capability' IS DISTINCT FROM 'integration_plugins.write'
  ),
  'credential commands use the backend provider credential write capability'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'integrations.create_plugin'
       AND command#>>'{route_targets,console,path}' = '/integrations/plugin-studio'
  ),
  'plugin creation commands open the plugin studio workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'integrations.retry_inbox'
       AND command#>>'{route_targets,console,path}' = '/integrations/intake'
  ),
  'inbox replay commands open the inbound intake workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'workflow_templates.create'
       AND command#>>'{route_targets,console,path}' = '/workflows/templates'
  ),
  'workflow template commands open the template workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'workflow_runs.replay'
       AND command#>>'{route_targets,console,path}' = '/workflows/runs'
  ),
  'workflow run commands open the runs workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'drivers.create'
       AND command#>>'{route_targets,console,path}' = '/operate/fleet/drivers'
  ),
  'driver commands open the driver roster workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'invoices.send'
       AND command#>>'{route_targets,console,path}' = '/finance/billing'
  ),
  'invoice commands open the billing workbench'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'invoices.void'
       AND command->>'capability' = 'billing.write'
       AND command#>>'{route_targets,console,path}' = '/finance/billing'
  )
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'invoices.record_refund'
       AND command->>'capability' = 'invoices.refund'
       AND command#>>'{route_targets,console,path}' = '/finance/billing'
  ),
  'billing command palette capabilities align with void and refund action contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'labels.reprint'
       AND command->>'target' = 'request_label_reprint'
       AND command->>'capability' = 'labels.reprint'
       AND command#>>'{route_targets,console,path}' = '/platform/labels'
  ),
  'label reprint command palette capability aligns with dedicated reprint permission'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands') AS command
     WHERE command->>'key' = 'marketplace.award_offer'
       AND command#>>'{route_targets,console,path}' = '/network/marketplace'
  ),
  'marketplace commands open the marketplace workbench'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command
          WHERE command->>'key' = 'service_offerings.create'
            AND command#>>'{route_targets,console,path}' = '/catalog/service-offerings'
       )
  ),
  'scoped command registries inherit Console V2 route targets for command palette discovery'
);

SELECT ok(
  NOT EXISTS (
    WITH global_routes AS (
      SELECT
        global_item.command->>'key' AS key,
        global_item.command#>>'{route_targets,console,path}' AS path
      FROM jsonb_array_elements(
        COALESCE(public.resolve_settings_merged('ui_command_registry', 'global', NULL)->'commands', '[]'::jsonb)
      ) AS global_item(command)
      WHERE global_item.command#>>'{route_targets,console,path}' IS NOT NULL
    ),
    scoped_routes AS (
      SELECT
        s.scope_type,
        s.scope_id,
        scoped_item.command->>'key' AS key,
        scoped_item.command#>>'{route_targets,console,path}' AS path
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS scoped_item(command)
      WHERE s.category = 'ui_command_registry'
        AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
    )
    SELECT 1
      FROM scoped_routes sr
      JOIN global_routes gr ON gr.key = sr.key
     WHERE sr.path IS DISTINCT FROM gr.path
  ),
  'every scoped command row with a global Console V2 route target keeps the same owner route'
);

SELECT * FROM finish();

ROLLBACK;
