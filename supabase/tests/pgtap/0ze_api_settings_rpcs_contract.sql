-- Test Suite: api settings rpcs contract wrappers
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT has_function(
  'api',
  'request_settings_change_v1',
  ARRAY['text', 'text', 'uuid', 'jsonb', 'text', 'timestamptz'],
  'api.request_settings_change_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.request_settings_change_v1(text,text,uuid,jsonb,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated can execute api.request_settings_change_v1'
);

SELECT has_function(
  'api',
  'resolve_manual_review_task_v1',
  ARRAY['uuid', 'text', 'text'],
  'api.resolve_manual_review_task_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.resolve_manual_review_task_v1(uuid,text,text)',
    'EXECUTE'
  ),
  'authenticated can execute api.resolve_manual_review_task_v1'
);

SELECT * FROM finish();
ROLLBACK;
