BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_function(
  'workflow_handlers',
  'execute_shipment_create_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'workflow_handlers.execute_shipment_create_v1 exists'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_create_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'anon',
  ARRAY[]::text[],
  'execute_shipment_create_v1 is not executable by anon'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_create_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'authenticated',
  ARRAY[]::text[],
  'execute_shipment_create_v1 is not executable by authenticated'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_create_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'service_role',
  ARRAY['EXECUTE'],
  'execute_shipment_create_v1 is executable by service_role'
);

SELECT has_function(
  'workflow_handlers',
  'execute_shipment_update_address_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'workflow_handlers.execute_shipment_update_address_v1 exists'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_update_address_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'anon',
  ARRAY[]::text[],
  'execute_shipment_update_address_v1 is not executable by anon'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_update_address_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'authenticated',
  ARRAY[]::text[],
  'execute_shipment_update_address_v1 is not executable by authenticated'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_shipment_update_address_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'service_role',
  ARRAY['EXECUTE'],
  'execute_shipment_update_address_v1 is executable by service_role'
);

SELECT has_function(
  'workflow_handlers',
  'execute_address_intake_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'workflow_handlers.execute_address_intake_v1 exists'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_address_intake_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'anon',
  ARRAY[]::text[],
  'execute_address_intake_v1 is not executable by anon'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_address_intake_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'authenticated',
  ARRAY[]::text[],
  'execute_address_intake_v1 is not executable by authenticated'
);

SELECT function_privs_are(
  'workflow_handlers',
  'execute_address_intake_v1',
  ARRAY['public.workflow_run_steps', 'public.workflow_runs', 'jsonb'],
  'service_role',
  ARRAY['EXECUTE'],
  'execute_address_intake_v1 is executable by service_role'
);

SELECT * FROM finish();

ROLLBACK;
