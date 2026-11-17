-- Test Suite: UI settings preview RPC
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT has_function(
  'public',
  'ui_settings_preview_v1',
  ARRAY['text','text','uuid'],
  'ui_settings_preview_v1 exists'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_settings_preview_v1(text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated can execute ui_settings_preview_v1'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_settings_preview_v1(text,text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute ui_settings_preview_v1'
);

SELECT finish();
ROLLBACK;
