-- pgTAP: Console V2 bank reconciliation workflow start payload guard.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT has_function(
  'public',
  'assert_workflow_start_payload_policy_v1',
  ARRAY['uuid', 'jsonb'],
  'workflow start payload policy guard exists'
);

SELECT ok(
  pg_get_functiondef('public.ui_start_workflow_run_v1(uuid,jsonb,boolean)'::regprocedure)
    LIKE '%assert_workflow_start_payload_policy_v1%',
  'ui_start_workflow_run_v1 invokes row-driven payload guard before start_workflow_run'
);

SELECT is(
  (
    SELECT metadata #>> '{required_payload_values,0,value}'
      FROM public.workflow_template_start_policy
     WHERE workflow_template_id = '99990000-0000-0000-0000-000000570004'::uuid
       AND required_capability = 'finance.write'
     LIMIT 1
  ),
  'deposit',
  'bank deposit reconciliation start policy requires deposit kind'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_start_policy p
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.metadata->'required_payload_paths', '[]'::jsonb)) req
     WHERE p.workflow_template_id = '99990000-0000-0000-0000-000000570004'::uuid
       AND p.required_capability = 'finance.write'
       AND req->>'path' = '$.branch_id'
  ),
  'bank deposit reconciliation start policy requires branch_id payload'
);

SELECT throws_ok(
  $$ SELECT public.assert_workflow_start_payload_policy_v1(
       '99990000-0000-0000-0000-000000570004'::uuid,
       jsonb_build_object(
         'bank_account_id', gen_random_uuid(),
         'bank_account_key', 'main',
         'kind', 'deposit',
         'scope_type', 'branch_day'
       )
     ) $$,
  '23514',
  NULL,
  'bank deposit reconciliation start without branch_id fails closed before workflow insertion'
);

SELECT * FROM finish();
ROLLBACK;
