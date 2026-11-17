-- Test Suite: UI access policy RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);
SELECT has_function('public', 'ui_access_policy_v1', ARRAY['text','uuid'], 'ui_access_policy_v1 exists');
SELECT ok(
  has_function_privilege('authenticated', 'public.ui_access_policy_v1(text,uuid)', 'EXECUTE'),
  'authenticated can execute ui_access_policy_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.ui_access_policy_v1(text,uuid)', 'EXECUTE'),
  'anon cannot execute ui_access_policy_v1'
);
SELECT has_function(
  'public',
  'ui_request_access_policy_change_v1',
  ARRAY['jsonb','text','uuid','text','timestamptz'],
  'ui_request_access_policy_change_v1 exists'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_request_access_policy_change_v1(jsonb,text,uuid,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated can execute ui_request_access_policy_change_v1'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_request_access_policy_change_v1(jsonb,text,uuid,text,timestamptz)',
    'EXECUTE'
  ),
  'anon cannot execute ui_request_access_policy_change_v1'
);
SELECT finish();
ROLLBACK;
