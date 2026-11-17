-- Source-only boundary cases; positive workflow/session cases remain required.
BEGIN;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(6);
SELECT ok(NOT has_function_privilege('anon','api.ui_get_financial_task_context_v1(uuid)','EXECUTE'),'context is not anonymous');
SELECT ok(NOT has_function_privilege('anon','api.ui_get_financial_task_readback_v1(uuid,uuid)','EXECUTE'),'financial readback is not anonymous');
SELECT ok(has_function_privilege('authenticated','api.ui_get_financial_task_context_v1(uuid)','EXECUTE'),'context API has authenticated grant');
SELECT ok(has_function_privilege('authenticated','api.ui_get_financial_task_readback_v1(uuid,uuid)','EXECUTE'),'readback API has authenticated grant');
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT throws_ok('SELECT public.ui_get_financial_task_context_v1(gen_random_uuid())','42501','Authentication required','context rejects absent actor');
SELECT throws_ok('SELECT public.ui_get_financial_task_readback_v1(gen_random_uuid(),gen_random_uuid())','42501','Authentication required','readback rejects absent actor');
SELECT * FROM finish();
ROLLBACK;
