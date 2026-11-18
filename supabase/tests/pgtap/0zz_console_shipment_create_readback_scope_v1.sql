BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(7);

-- Keep real relation shapes while isolating lineage from unrelated triggers and fixtures.
CREATE TEMP TABLE readback_scope_runs AS SELECT id, context, triggered_by_request_id
  FROM public.workflow_runs WITH NO DATA;
CREATE TEMP TABLE readback_scope_steps AS SELECT workflow_run_id, operation_result
  FROM public.workflow_run_steps WITH NO DATA;
CREATE TEMP TABLE readback_scope_decisions AS SELECT organization_id, resource_type, resource_id, correlation_id
  FROM public.decision_log WITH NO DATA;
CREATE TEMP TABLE readback_scope_audit AS SELECT organization_id, table_name, pk
  FROM public.audit_table_changes WITH NO DATA;
CREATE TEMP TABLE readback_scope_actions AS SELECT organization_id, shipment_id
  FROM public.shipment_actions WITH NO DATA;
CREATE FUNCTION pg_temp.readback_shipment_scope(TEXT, UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN $1 = 'shipments' AND $2 = '81000000-0000-4000-8000-000000000001'::UUID
    THEN '{"organization_id":"81000000-0000-4000-8000-000000000002"}'::JSONB ELSE NULL END;
$$;
DO $$
DECLARE definition TEXT := pg_get_functiondef('public.ui_shipment_create_readback_v1(uuid,uuid,uuid)'::regprocedure);
BEGIN
  definition := replace(definition, 'public.ui_shipment_create_readback_v1', 'pg_temp.readback_scope');
  definition := replace(definition, 'public.ui_get_resource_v1', 'pg_temp.readback_shipment_scope');
  definition := replace(definition, 'public.workflow_runs', 'pg_temp.readback_scope_runs');
  definition := replace(definition, 'public.workflow_run_steps', 'pg_temp.readback_scope_steps');
  definition := replace(definition, 'public.decision_log', 'pg_temp.readback_scope_decisions');
  definition := replace(definition, 'public.audit_table_changes', 'pg_temp.readback_scope_audit');
  definition := replace(definition, 'public.shipment_actions', 'pg_temp.readback_scope_actions');
  EXECUTE definition;
  definition := pg_get_functiondef('api.ui_shipment_create_readback_v1(uuid,uuid,uuid)'::regprocedure);
  definition := replace(definition, 'api.ui_shipment_create_readback_v1', 'pg_temp.readback_scope_api');
  definition := replace(definition, 'public.ui_shipment_create_readback_v1', 'pg_temp.readback_scope');
  EXECUTE definition;
END $$;

INSERT INTO readback_scope_runs VALUES ('81000000-0000-4000-8000-000000000003',
  '{"organization_id":"81000000-0000-4000-8000-000000000002","shipment":{"id":"81000000-0000-4000-8000-000000000001"}}',
  '81000000-0000-4000-8000-000000000004');
-- Only workflow lineage can satisfy this decision; a direct shipment decision cannot mask a scope error.
INSERT INTO readback_scope_decisions VALUES ('81000000-0000-4000-8000-000000000002', 'workflow_run',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004');
INSERT INTO readback_scope_actions VALUES ('81000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001');

SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":true}'::JSONB, 'matching workflow organization confirms through the API wrapper body');
UPDATE readback_scope_runs SET context = jsonb_set(context, '{organization_id}',
  '"81000000-0000-4000-8000-000000000099"');
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":false}'::JSONB, 'another organization workflow cannot confirm despite matching shipment and correlation');
UPDATE readback_scope_runs SET context = context - 'organization_id';
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":false}'::JSONB, 'missing workflow organization fails closed');
UPDATE readback_scope_runs SET context = jsonb_set(context, '{organization_id}', 'null');
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":false}'::JSONB, 'null workflow organization fails closed');
UPDATE readback_scope_runs SET context = jsonb_set(context, '{organization_id}', '"invalid-organization"');
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":false}'::JSONB, 'malformed workflow organization fails closed without a UUID cast error');
UPDATE readback_scope_runs SET context =
  '{"organization_id":"81000000-0000-4000-8000-000000000002","workflow":{"context_patch":{"shipment":{"id":"81000000-0000-4000-8000-000000000001"}}}}';
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":true}'::JSONB, 'same-organization context-patch shipment lineage still confirms');
UPDATE readback_scope_runs SET context = '{"organization_id":"81000000-0000-4000-8000-000000000002"}';
INSERT INTO readback_scope_steps VALUES ('81000000-0000-4000-8000-000000000003',
  '{"shipment_id":"81000000-0000-4000-8000-000000000001"}');
SELECT is(pg_temp.readback_scope_api('81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004'),
  '{"visible":true}'::JSONB, 'same-organization step-result shipment lineage still confirms');
SELECT * FROM finish();
ROLLBACK;
