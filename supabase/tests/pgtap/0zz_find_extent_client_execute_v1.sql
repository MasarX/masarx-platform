BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(NOT has_function_privilege('anon',
  'public.find_extent(regclass,text)', 'EXECUTE'),
  'anon cannot execute public.find_extent');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.find_extent(regclass,text)', 'EXECUTE'),
  'authenticated cannot execute public.find_extent');

SELECT * FROM finish();
ROLLBACK;
