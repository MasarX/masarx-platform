BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(43);

SELECT has_table('public', 'tabular_import_runs', 'tabular_import_runs table exists');
SELECT has_table('public', 'tabular_import_run_rows', 'tabular_import_run_rows table exists');

SELECT ok(
  COALESCE(
    (SELECT rowsecurity
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'tabular_import_runs'),
    false
  ),
  'tabular_import_runs has RLS enabled'
);

SELECT ok(
  COALESCE(
    (SELECT rowsecurity
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'tabular_import_run_rows'),
    false
  ),
  'tabular_import_run_rows has RLS enabled'
);

SELECT ok(
  EXISTS(
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.tabular_import_run_rows'::regclass
      AND conname = 'tabular_import_run_rows_unique_row'
      AND contype = 'u'
  ),
  'tabular_import_run_rows keeps canonical unique row constraint'
);

SELECT ok(
  NOT EXISTS(
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tabular_import_run_rows'
      AND indexname = 'idx_tabular_import_run_rows_run_row'
  ),
  'tabular_import_run_rows does not keep redundant run_id/row_number index'
);

SELECT has_column('public', 'mapping_operation_reports', 'operation_kind', 'mapping_operation_reports.operation_kind exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_runs'
       AND c.column_name = 'write_mode'
       AND c.lookup_category = 'tabular_import_write_mode'
  ),
  'tabular_import_runs.write_mode is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_runs'
       AND c.column_name = 'status'
       AND c.lookup_category = 'tabular_import_run_status'
  ),
  'tabular_import_runs.status is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_run_rows'
       AND c.column_name = 'action'
       AND c.lookup_category = 'tabular_import_row_action'
  ),
  'tabular_import_run_rows.action is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_column_contracts c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'tabular_import_run_rows'
       AND c.column_name = 'execution_status'
       AND c.lookup_category = 'tabular_import_row_execution_status'
  ),
  'tabular_import_run_rows.execution_status is governed by lookup contracts'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'tabular_import_run_status'
       AND lv.value = 'completed_with_errors'
  ),
  'tabular_import_run_status lookup includes completed_with_errors'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM (VALUES ('prepared'), ('queued'), ('processing')) AS required_status(value)
      LEFT JOIN public.lookup_definitions ld
        ON ld.category = 'tabular_import_run_status'
      LEFT JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
       AND lv.value = required_status.value
     WHERE COALESCE(lv.metadata->>'is_cancellable', 'false') <> 'true'
        OR COALESCE(lv.metadata->>'is_terminal', 'true') <> 'false'
  ),
  'active tabular_import_run_status values are marked cancellable in lookup metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM (VALUES ('completed'), ('completed_with_errors'), ('failed'), ('canceled')) AS terminal_status(value)
      LEFT JOIN public.lookup_definitions ld
        ON ld.category = 'tabular_import_run_status'
      LEFT JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
       AND lv.value = terminal_status.value
     WHERE COALESCE(lv.metadata->>'is_terminal', 'false') <> 'true'
        OR COALESCE(lv.metadata->>'is_cancellable', 'true') <> 'false'
  ),
  'terminal tabular_import_run_status values are marked terminal and not cancellable'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'tabular_import_run_status'
       AND lv.value = 'canceled'
       AND lv.metadata->>'is_active' = 'false'
  ),
  'tabular_import_run_status canceled metadata is canonical and inactive'
);

SELECT has_function('public', 'tabular_import_prepare_v1', ARRAY['jsonb'], 'public.tabular_import_prepare_v1 exists');
SELECT has_function('public', 'ui_tabular_import_profiles_v1', ARRAY['text'], 'public.ui_tabular_import_profiles_v1 exists');
SELECT has_function('public', 'ui_tabular_import_profiles_v1', ARRAY['text', 'jsonb'], 'public.ui_tabular_import_profiles_v1 scoped overload exists');
SELECT has_function('public', 'ui_get_tabular_import_run_v1', ARRAY['uuid'], 'public.ui_get_tabular_import_run_v1 exists');
SELECT has_function('public', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid'], 'public.ui_cancel_tabular_import_run_v1 exists');
SELECT has_function('public', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid', 'text'], 'public.ui_cancel_tabular_import_run_v1 requires cancel reason signature');
SELECT has_function('public', 'ui_start_tabular_import_run_v1', ARRAY['uuid', 'jsonb'], 'public.ui_start_tabular_import_run_v1 exists');
SELECT has_function('public', 'claim_next_tabular_import_task_v1', ARRAY['text'], 'public.claim_next_tabular_import_task_v1 exists');
SELECT has_function('public', 'process_tabular_import_run_v1', ARRAY['uuid', 'integer'], 'public.process_tabular_import_run_v1 exists');

SELECT has_function('api', 'tabular_import_prepare_v1', ARRAY['jsonb'], 'api.tabular_import_prepare_v1 exists');
SELECT has_function('api', 'ui_tabular_import_profiles_v1', ARRAY['text'], 'api.ui_tabular_import_profiles_v1 exists');
SELECT has_function('api', 'ui_tabular_import_profiles_v1', ARRAY['text', 'jsonb'], 'api.ui_tabular_import_profiles_v1 scoped overload exists');
SELECT has_function('api', 'ui_get_tabular_import_run_v1', ARRAY['uuid'], 'api.ui_get_tabular_import_run_v1 exists');
SELECT has_function('api', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid'], 'api.ui_cancel_tabular_import_run_v1 exists');
SELECT has_function('api', 'ui_cancel_tabular_import_run_v1', ARRAY['uuid', 'text'], 'api.ui_cancel_tabular_import_run_v1 requires cancel reason signature');
SELECT has_function('api', 'ui_start_tabular_import_run_v1', ARRAY['uuid', 'jsonb'], 'api.ui_start_tabular_import_run_v1 exists');

SELECT throws_ok(
  $$ SELECT public.ui_cancel_tabular_import_run_v1(gen_random_uuid()) $$,
  '22023',
  'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason',
  'public.ui_cancel_tabular_import_run_v1 one-arg compatibility path fails closed'
);

SELECT throws_ok(
  $$ SELECT public.ui_cancel_tabular_import_run_v1(gen_random_uuid(), '   ') $$,
  '22023',
  'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason',
  'public.ui_cancel_tabular_import_run_v1 requires non-empty cancel reason'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '00000000-0000-0000-0000-000143000001',
  'Tabular Import Terminal Cancel Guard Org',
  'tabular-import-terminal-cancel-guard-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
VALUES (
  '00000000-0000-0000-0000-000143000002',
  '00000000-0000-0000-0000-000143000001',
  'tabular-import-terminal-cancel-guard@example.test',
  'Tabular Import Terminal Cancel Guard',
  'ops_admin',
  'active',
  'tenant',
  NULL
)
ON CONFLICT (id) DO UPDATE
   SET organization_id = EXCLUDED.organization_id,
       user_type = EXCLUDED.user_type,
       status = EXCLUDED.status,
       access_scope_type = EXCLUDED.access_scope_type,
       access_scope_id = EXCLUDED.access_scope_id;

INSERT INTO public.tabular_import_runs (
  id,
  organization_id,
  resource_key,
  relation_name,
  write_mode,
  status,
  source_format,
  source_file_name,
  total_rows,
  summary,
  created_by,
  updated_by,
  completed_at,
  canceled_at
)
VALUES
  (
    '00000000-0000-0000-0000-000143000101',
    '00000000-0000-0000-0000-000143000001',
    'shipments',
    'shipments',
    'create',
    'completed',
    'csv',
    'terminal-completed.csv',
    0,
    '{}'::jsonb,
    '00000000-0000-0000-0000-000143000002',
    '00000000-0000-0000-0000-000143000002',
    now(),
    NULL
  ),
  (
    '00000000-0000-0000-0000-000143000102',
    '00000000-0000-0000-0000-000143000001',
    'shipments',
    'shipments',
    'create',
    'completed_with_errors',
    'csv',
    'terminal-completed-with-errors.csv',
    0,
    '{}'::jsonb,
    '00000000-0000-0000-0000-000143000002',
    '00000000-0000-0000-0000-000143000002',
    now(),
    NULL
  ),
  (
    '00000000-0000-0000-0000-000143000103',
    '00000000-0000-0000-0000-000143000001',
    'shipments',
    'shipments',
    'create',
    'failed',
    'csv',
    'terminal-failed.csv',
    0,
    '{}'::jsonb,
    '00000000-0000-0000-0000-000143000002',
    '00000000-0000-0000-0000-000143000002',
    now(),
    NULL
  ),
  (
    '00000000-0000-0000-0000-000143000104',
    '00000000-0000-0000-0000-000143000001',
    'shipments',
    'shipments',
    'create',
    'canceled',
    'csv',
    'terminal-canceled.csv',
    0,
    '{}'::jsonb,
    '00000000-0000-0000-0000-000143000002',
    '00000000-0000-0000-0000-000143000002',
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE
   SET status = EXCLUDED.status,
       completed_at = EXCLUDED.completed_at,
       canceled_at = EXCLUDED.canceled_at,
       updated_at = now();

SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-000143000002',
    'role', 'service_role',
    'organization_id', '00000000-0000-0000-0000-000143000001',
    'access_scope_type', 'tenant'
  )::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object(
    'sub', '00000000-0000-0000-0000-000143000002',
    'role', 'service_role',
    'organization_id', '00000000-0000-0000-0000-000143000001',
    'access_scope_type', 'tenant'
  )::text,
  true
);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000143000002', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- Terminal cancellation returns the canonical readback without changing the run.
CREATE TEMP TABLE terminal_import_snapshots AS
SELECT r.id, r.status, to_jsonb(r) AS stored, public.ui_get_tabular_import_run_v1(r.id) AS readback
FROM public.tabular_import_runs r
WHERE r.id IN (
  '00000000-0000-0000-0000-000143000101',
  '00000000-0000-0000-0000-000143000102',
  '00000000-0000-0000-0000-000143000103',
  '00000000-0000-0000-0000-000143000104'
);

SELECT is(
  public.ui_cancel_tabular_import_run_v1(id, 'terminal cancel guard'),
  readback,
  format('terminal %s import keeps its canonical readback', status)
)
FROM terminal_import_snapshots
ORDER BY id;

SELECT ok(
  pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%summary = COALESCE(summary%'
    AND pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%cancellation%'
    AND pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%reason%',
  'tabular import run cancel persists operator reason under summary.cancellation.reason'
);

SELECT ok(
  to_regprocedure('public.ui_retry_tabular_import_run_v1(uuid)') IS NULL
    AND to_regprocedure('api.ui_retry_tabular_import_run_v1(uuid)') IS NULL,
  'tabular import retry is not exposed as a hidden public/api RPC'
);

SELECT ok(
  to_regprocedure('public.ui_reopen_tabular_import_run_v1(uuid)') IS NULL
    AND to_regprocedure('api.ui_reopen_tabular_import_run_v1(uuid)') IS NULL,
  'tabular import reopen is not exposed as a hidden public/api RPC'
);

SELECT ok(
  pg_get_functiondef('public.ui_start_tabular_import_run_v1(uuid,jsonb)'::regprocedure) LIKE '%already terminal%'
    AND pg_get_functiondef('public.ui_start_tabular_import_run_v1(uuid,jsonb)'::regprocedure) LIKE '%blocked rows%'
    AND pg_get_functiondef('public.ui_start_tabular_import_run_v1(uuid,jsonb)'::regprocedure) LIKE '%unresolved targets%',
  'tabular import start fails closed for terminal, blocked, or unresolved prepared runs'
);

SELECT ok(
  pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%decision_log%'
    AND pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%domain_events%'
    AND pg_get_functiondef('public.ui_cancel_tabular_import_run_v1(uuid,text)'::regprocedure) LIKE '%tabular_import_run.canceled%',
  'tabular import cancel writes decision and domain-event evidence'
);

SELECT ok(
  (SELECT count(*) FROM terminal_import_snapshots) = 4
    AND NOT EXISTS (
      SELECT 1 FROM terminal_import_snapshots snapshot
      LEFT JOIN public.tabular_import_runs r ON r.id = snapshot.id
      WHERE to_jsonb(r) IS DISTINCT FROM snapshot.stored
    ),
  'tabular import cancel leaves every terminal run unchanged'
);

SELECT * FROM finish();

ROLLBACK;
