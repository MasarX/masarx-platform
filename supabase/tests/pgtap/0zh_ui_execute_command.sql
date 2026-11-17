-- Test Suite: UI command execute RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT has_function(
  'public',
  'ui_execute_command_v1',
  ARRAY['text','text','text[]','text','integer','jsonb'],
  'ui_execute_command_v1 exists'
);

SELECT has_function(
  'public',
  'ui_delete_resource_v1',
  ARRAY['text','text'],
  'ui_delete_resource_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute ui_execute_command_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute ui_execute_command_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_delete_resource_v1(text,text)',
    'EXECUTE'
  ),
  'authenticated can execute ui_delete_resource_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_delete_resource_v1(text,text)',
    'EXECUTE'
  ),
  'anon cannot execute ui_delete_resource_v1'
);

SELECT * FROM finish();
ROLLBACK;
