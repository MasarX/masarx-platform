-- Plan: B09 Exception, reattempt & returns loop
-- pgTAP: UC114 NDR owner + SLA queue contract v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(23);

CREATE OR REPLACE FUNCTION pg_temp.test_uc114_ndr_queue_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function(
    'public',
    'ui_execute_task_claim_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'public.ui_execute_task_claim_v1(text, text, text[], text, integer, jsonb) exists'
  );
  RETURN NEXT has_function(
    'api',
    'ui_execute_task_claim_v1',
    ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
    'api.ui_execute_task_claim_v1(text, text, text[], text, integer, jsonb) exists'
  );
  RETURN NEXT ok(
    has_function_privilege(
      'authenticated',
      'api.ui_execute_task_claim_v1(text, text, text[], text, integer, jsonb)',
      'EXECUTE'
    ),
    'authenticated can execute api.ui_execute_task_claim_v1'
  );
  RETURN NEXT has_function(
    'public',
    'ops_sweeper_dispatch_exception_review_sla_breaches',
    ARRAY['jsonb'],
    'public.ops_sweeper_dispatch_exception_review_sla_breaches(jsonb) exists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.operation_handlers
      WHERE handler_key = 'ops_sweeper_dispatch_exception_review_sla_breaches'
        AND is_active IS TRUE
    ),
    'operation_handlers registers the dispatch exception SLA sweeper'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'tasks', '[]'::jsonb)) AS item
      WHERE s.category = 'ops_sweeper_policy'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'task_key' = 'dispatch_exception_review_sla_breach_scan'
        AND item->>'handler_key' = 'ops_sweeper_dispatch_exception_review_sla_breaches'
    ),
    'ops_sweeper_policy includes the dispatch exception SLA breach scan task'
  );
  RETURN NEXT has_view(
    'public',
    'dispatch_exception_review_backlog_v',
    'public.dispatch_exception_review_backlog_v exists'
  );
  RETURN NEXT has_view(
    'public',
    'dispatch_exception_review_sla_breaches_v',
    'public.dispatch_exception_review_sla_breaches_v exists'
  );
  RETURN NEXT has_view(
    'api',
    'dispatch_exception_review_backlog_v',
    'api.dispatch_exception_review_backlog_v exists'
  );
  RETURN NEXT has_view(
    'api',
    'dispatch_exception_review_sla_breaches_v',
    'api.dispatch_exception_review_sla_breaches_v exists'
  );
  RETURN NEXT has_column(
    'public',
    'dispatch_exception_review_sla_breaches_v',
    'dispatch_exception_reason',
    'public.dispatch_exception_review_sla_breaches_v exposes dispatch_exception_reason'
  );
  RETURN NEXT col_type_is(
    'public',
    'dispatch_exception_review_sla_breaches_v',
    'dispatch_exception_reason',
    'text',
    'dispatch_exception_review_sla_breaches_v.dispatch_exception_reason is text'
  );
  RETURN NEXT has_column(
    'api',
    'dispatch_exception_review_sla_breaches_v',
    'dispatch_exception_reason',
    'api.dispatch_exception_review_sla_breaches_v exposes dispatch_exception_reason'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'dispatch_exception_review'
        AND jsonb_typeof(item->'base_filter') = 'object'
        AND item#>>'{column_labels,status_reason}' = 'Dispatch exception reason'
    ),
    'ui_read_registry exposes dispatch_exception_review with a base filter and dispatch exception reason label'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'dispatch_exception_review_mine'
        AND jsonb_typeof(item->'base_filter') = 'object'
    ),
    'ui_read_registry exposes dispatch_exception_review_mine with a base filter'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'unassigned_exceptions'
        AND jsonb_typeof(item->'base_filter') = 'object'
    ),
    'ui_read_registry exposes unassigned_exceptions with a base filter'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'sla_deadline_alerts'
        AND jsonb_typeof(item->'base_filter') = 'object'
    ),
    'ui_read_registry exposes sla_deadline_alerts with a base filter'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_command_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'unassigned_exceptions.claim'
        AND item#>>'{execution,rpc}' = 'ui_execute_task_claim_v1'
    ),
    'ui_command_registry exposes the unassigned_exceptions.claim RPC command'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_command_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'key' = 'dispatch_exception_review.complete'
    ),
    'ui_command_registry exposes dispatch_exception_review.complete'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'roles', '[]'::jsonb)) AS role
      WHERE s.category = 'access_control_policy'
        AND role->>'key' = 'ops_admin'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS capability
          WHERE capability = '*'
             OR capability = 'tasks.write'
        )
    ),
    'access_control_policy grants tasks.write to every ops_admin role map'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'access_control_policy'
        AND COALESCE(s.cached_value#>>'{resource_map,tasks,write}', '') <> 'tasks.write'
    ),
    'access_control_policy resource_map.tasks.write resolves to tasks.write'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,console,sections}', '[]'::jsonb)) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_navigation'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'resource' = 'dispatch_exception_review'
    ),
    'ui_navigation exposes the console dispatch exception review lane'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value#>'{apps,portal,sections}', '[]'::jsonb)) AS section
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
      WHERE s.category = 'ui_navigation'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND item->>'resource' = 'dispatch_exception_review_mine'
    ),
    'ui_navigation exposes the portal my-exception-reviews lane'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_uc114_ndr_queue_contract_v1();

SELECT * FROM finish();

ROLLBACK;
