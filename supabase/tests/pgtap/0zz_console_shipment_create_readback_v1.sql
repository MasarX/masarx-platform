BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(14);

SELECT ok(NOT has_function_privilege('anon', 'api.ui_shipment_create_readback_v1(uuid,uuid,uuid)', 'EXECUTE'),
  'anonymous callers cannot inspect creation lineage');
SELECT ok(has_function_privilege('authenticated', 'api.ui_shipment_create_readback_v1(uuid,uuid,uuid)', 'EXECUTE'),
  'authenticated callers can use the scope-checked confirmation');
SELECT ok((SELECT proconfig @> ARRAY['row_security=on'] FROM pg_proc
  WHERE oid = 'public.ui_shipment_create_readback_v1(uuid,uuid,uuid)'::regprocedure), 'readback retains row-security setting');

-- Execute the installed function body against isolated fixtures with the real column types.
-- Only the existing scope seam is stubbed; its independent authorization tests remain authoritative.
CREATE TEMP TABLE readback_decisions AS SELECT organization_id, resource_type, resource_id, correlation_id
  FROM public.decision_log WITH NO DATA;
CREATE TEMP TABLE readback_audit AS SELECT organization_id, table_name, pk
  FROM public.audit_table_changes WITH NO DATA;
CREATE TEMP TABLE readback_actions AS SELECT organization_id, shipment_id
  FROM public.shipment_actions WITH NO DATA;
CREATE TEMP TABLE readback_runs AS SELECT id, organization_id, context, triggered_by_request_id
  FROM public.workflow_runs WITH NO DATA;
CREATE TEMP TABLE readback_steps AS SELECT workflow_run_id, operation_result
  FROM public.workflow_run_steps WITH NO DATA;
CREATE FUNCTION pg_temp.readback_scope(TEXT, UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN $1 = 'shipments' AND $2 = '80000000-0000-4000-8000-000000000001'::UUID
    THEN '{"organization_id":"80000000-0000-4000-8000-000000000002"}'::JSONB ELSE NULL END;
$$;
DO $$
DECLARE definition TEXT := pg_get_functiondef('public.ui_shipment_create_readback_v1(uuid,uuid,uuid)'::regprocedure);
BEGIN
  definition := replace(definition, 'public.ui_shipment_create_readback_v1', 'pg_temp.readback');
  definition := replace(definition, 'public.ui_get_resource_v1', 'pg_temp.readback_scope');
  definition := replace(definition, 'public.decision_log', 'pg_temp.readback_decisions');
  definition := replace(definition, 'public.audit_table_changes', 'pg_temp.readback_audit');
  definition := replace(definition, 'public.shipment_actions', 'pg_temp.readback_actions');
  definition := replace(definition, 'public.workflow_runs', 'pg_temp.readback_runs');
  definition := replace(definition, 'public.workflow_run_steps', 'pg_temp.readback_steps');
  EXECUTE definition;
END $$;
SELECT throws_ok($$SELECT pg_temp.readback(NULL, NULL, NULL)$$, '23514', 'shipment_id is required', 'null shipment is rejected');
SELECT throws_ok($$SELECT pg_temp.readback('80000000-0000-4000-8000-000000000099', NULL, NULL)$$,
  '42501', 'shipment is not visible', 'scope denial fails before lineage queries');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":false}'::JSONB, 'empty lineage fails closed');
INSERT INTO readback_decisions VALUES ('80000000-0000-4000-8000-000000000002', 'shipment',
  '80000000-0000-4000-8000-000000000001', NULL);
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":false}'::JSONB, 'decision without audit lineage is insufficient');
INSERT INTO readback_audit VALUES ('80000000-0000-4000-8000-000000000002', 'shipments',
  '{"id":"80000000-0000-4000-8000-000000000099"}');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":false}'::JSONB, 'an unrelated audit record is insufficient');
INSERT INTO readback_audit VALUES ('80000000-0000-4000-8000-000000000002', 'shipments',
  '{"id":"80000000-0000-4000-8000-000000000001"}');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":true}'::JSONB, 'matching decision and persisted audit confirm without exposing rows');
TRUNCATE readback_audit, readback_decisions;
INSERT INTO readback_actions VALUES ('80000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001');
INSERT INTO readback_decisions VALUES ('80000000-0000-4000-8000-000000000099', 'shipment',
  '80000000-0000-4000-8000-000000000001', NULL);
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":false}'::JSONB, 'another tenant decision cannot confirm this shipment');
TRUNCATE readback_decisions;
INSERT INTO readback_decisions VALUES ('80000000-0000-4000-8000-000000000002', 'workflow_run',
  '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004'),
  '{"visible":false}'::JSONB, 'caller-supplied unrelated workflow/correlation cannot confirm');
INSERT INTO readback_runs VALUES ('80000000-0000-4000-8000-000000000003',
  '80000000-0000-4000-8000-000000000002',
  '{"shipment":{"id":"80000000-0000-4000-8000-000000000001"}}',
  '80000000-0000-4000-8000-000000000004');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004'),
  '{"visible":true}'::JSONB, 'canonical workflow lineage plus shipment action confirms');
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000099'),
  '{"visible":false}'::JSONB, 'unrelated correlation fails closed');
TRUNCATE readback_decisions;
INSERT INTO readback_decisions VALUES ('80000000-0000-4000-8000-000000000002', 'shipment',
  '80000000-0000-4000-8000-000000000001', NULL);
SELECT is(pg_temp.readback('80000000-0000-4000-8000-000000000001', NULL, NULL),
  '{"visible":true}'::JSONB, 'direct shipment decision and action lineage confirms');
SELECT * FROM finish();
ROLLBACK;
