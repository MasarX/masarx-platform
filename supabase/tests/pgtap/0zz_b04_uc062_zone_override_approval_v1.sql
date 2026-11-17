SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

SELECT has_table(
  'public',
  'zone_override_requests',
  'zone_override_requests ledger exists'
);

SELECT has_index(
  'public',
  'zone_override_requests',
  'uniq_zone_override_requests_open_per_shipment',
  'zone_override_requests keeps one open request per shipment'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts
        ON wts.workflow_template_id = wt.id
     WHERE wt.name = 'zone_override_approval_v1'
     GROUP BY wt.id
    HAVING array_agg(wts.handler_key ORDER BY wts.sequence_order) = ARRAY[
      'manual_review',
      'manual_review_wait',
      'zone_override_apply'
    ]::text[]
  ),
  'zone_override_approval_v1 template wires manual_review -> manual_review_wait -> zone_override_apply'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.operation_handlers oh
     WHERE oh.handler_key = 'zone_override_apply'
       AND oh.handler_name = 'execute_zone_override_apply_v1'
       AND oh.handler_schema = 'workflow_handlers'
  ),
  'operation_handlers registers zone_override_apply'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'manual_review_task_type'
       AND lv.value = 'zone_override_approval'
  ),
  'manual_review_task_type includes zone_override_approval'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'zone_override'
  ),
  'decision_category includes zone_override'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_outcome'
       AND lv.value IN ('pending_review', 'applied')
     GROUP BY ld.category
    HAVING COUNT(*) = 2
  ),
  'decision_outcome includes pending_review and applied'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'zone_override_request_status'
       AND lv.value IN ('pending', 'approved', 'rejected', 'applied', 'failed', 'cancelled')
     GROUP BY ld.category
    HAVING COUNT(*) = 6
  ),
  'zone_override_request_status lookup category seeds all request statuses'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'zone_override_request_resolution_outcome'
       AND lv.value IN ('approved', 'rejected')
     GROUP BY ld.category
    HAVING COUNT(*) = 2
  ),
  'zone_override_request_resolution_outcome lookup category seeds review outcomes'
);

SELECT ok(
  (
    SELECT COUNT(*)
      FROM public.lookup_column_contracts lcc
     WHERE lcc.table_schema = 'public'
       AND lcc.table_name = 'zone_override_requests'
       AND (
         (lcc.column_name = 'status' AND lcc.lookup_category = 'zone_override_request_status')
         OR (lcc.column_name = 'resolution_outcome' AND lcc.lookup_category = 'zone_override_request_resolution_outcome')
       )
  ) = 2,
  'zone_override_requests columns are bound through lookup_column_contracts'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'zone_override_requests'
       AND con.contype = 'c'
       AND public.constraint_has_literal_allowlist_v1(pg_get_constraintdef(con.oid))
  ),
  'zone_override_requests no longer uses literal-list CHECK constraints for status enforcement'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS command
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' = 'wrong_zone_exceptions.request_zone_override'
       AND command#>>'{execution,rpc}' = 'ui_execute_zone_override_request_v1'
       AND command#>>'{execution,input_schema,fields,0,key}' = 'override_reason'
       AND command#>>'{execution,input_schema,fields,0,type}' = 'textarea'
       AND command#>>'{execution,input_schema,fields,1,key}' = 'requested_zone_id'
  ),
  'ui_command_registry exposes wrong-zone manual override command with required input schema'
);

SELECT ok(
  to_regprocedure('public.request_zone_override_v1(uuid,jsonb)') IS NOT NULL,
  'public.request_zone_override_v1 exists'
);

SELECT ok(
  to_regprocedure('public.ui_execute_zone_override_request_v1(text,text,text[],text,integer,jsonb)') IS NOT NULL,
  'public.ui_execute_zone_override_request_v1 exists'
);

SELECT ok(
  to_regprocedure('api.ui_execute_zone_override_request_v1(text,text,text[],text,integer,jsonb)') IS NOT NULL,
  'api.ui_execute_zone_override_request_v1 exists'
);

SELECT has_view(
  'api',
  'zone_override_requests',
  'api.zone_override_requests exists'
);

SELECT has_column(
  'api',
  'zone_override_requests',
  'id',
  'api.zone_override_requests exposes id'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'zone_override_requests'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'api.zone_override_requests is security_invoker'
);

SELECT * FROM finish();

ROLLBACK;
