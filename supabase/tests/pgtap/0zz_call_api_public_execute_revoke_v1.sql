BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT has_function('public', 'call_api', ARRAY['text','text','jsonb','jsonb','integer'],
  'public.call_api exists');
SELECT has_function('public', 'call_api_wait', ARRAY['text','text','jsonb','jsonb','integer','integer'],
  'public.call_api_wait exists');
SELECT has_function('public', 'dispatch_api_request_v1', ARRAY['text','text','jsonb','jsonb','integer'],
  'public.dispatch_api_request_v1 exists');

SELECT ok(NOT has_function_privilege('anon',
  'public.call_api(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'anon cannot execute public.call_api');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.call_api(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'authenticated cannot execute public.call_api');
SELECT ok(has_function_privilege('service_role',
  'public.call_api(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'service_role can execute public.call_api');

SELECT ok(NOT has_function_privilege('anon',
  'public.call_api_wait(text,text,jsonb,jsonb,integer,integer)', 'EXECUTE'),
  'anon cannot execute public.call_api_wait');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.call_api_wait(text,text,jsonb,jsonb,integer,integer)', 'EXECUTE'),
  'authenticated cannot execute public.call_api_wait');
SELECT ok(has_function_privilege('service_role',
  'public.call_api_wait(text,text,jsonb,jsonb,integer,integer)', 'EXECUTE'),
  'service_role can execute public.call_api_wait');

SELECT ok(NOT has_function_privilege('anon',
  'public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'anon cannot execute public.dispatch_api_request_v1');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'authenticated cannot execute public.dispatch_api_request_v1');
SELECT ok(has_function_privilege('service_role',
  'public.dispatch_api_request_v1(text,text,jsonb,jsonb,integer)', 'EXECUTE'),
  'service_role can execute public.dispatch_api_request_v1');

SELECT * FROM finish();
ROLLBACK;
