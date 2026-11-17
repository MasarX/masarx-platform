BEGIN;
SELECT plan(5);
SELECT has_function('public','upsert_settings_value_v1',ARRAY['text','text','uuid','jsonb','integer','text'],
  'canonical six-argument settings upsert remains');
SELECT hasnt_function('public','upsert_settings_value_v1',ARRAY['text','text','uuid','jsonb','integer','text','text'],
  'temporary seven-argument overload is absent after replay');
SELECT ok(has_function_privilege('service_role',
  'public.upsert_settings_value_v1(text,text,uuid,jsonb,integer,text)','EXECUTE'),
  'canonical service-role grant remains');
SELECT ok(NOT has_function_privilege('anon',
  'public.upsert_settings_value_v1(text,text,uuid,jsonb,integer,text)','EXECUTE'),
  'anonymous callers gain no canonical upsert capability');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.upsert_settings_value_v1(text,text,uuid,jsonb,integer,text)','EXECUTE'),
  'authenticated callers gain no canonical upsert capability');
SELECT * FROM finish();
ROLLBACK;
