-- pgTAP: FieldOps Mobile policy public wrappers keep the locked-resolver boundary.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(26);

SELECT has_function(
  'public',
  'resolve_mobile_ingest_policy',
  ARRAY['jsonb'],
  'public.resolve_mobile_ingest_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_location_tracking_policy',
  ARRAY['jsonb'],
  'public.resolve_location_tracking_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_scan_policy',
  ARRAY['jsonb'],
  'public.resolve_scan_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'resolve_pod_policy',
  ARRAY['jsonb'],
  'public.resolve_pod_policy(jsonb) exists'
);

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy')
)
SELECT ok(
  p.prosecdef,
  format('public.%s(jsonb) is SECURITY DEFINER', wrappers.name)
)
FROM wrappers
JOIN pg_proc p ON p.proname = wrappers.name
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy')
)
SELECT is(
  COALESCE(array_to_string(p.proconfig, ','), ''),
  'search_path=public, extensions, pg_temp',
  format('public.%s(jsonb) pins search_path', wrappers.name)
)
FROM wrappers
JOIN pg_proc p ON p.proname = wrappers.name
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy')
)
SELECT ok(
  has_function_privilege(
    'authenticated',
    format('public.%s(jsonb)', wrappers.name),
    'EXECUTE'
  ),
  format('authenticated may execute public.%s(jsonb)', wrappers.name)
)
FROM wrappers;

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy')
)
SELECT ok(
  NOT has_function_privilege(
    'anon',
    format('public.%s(jsonb)', wrappers.name),
    'EXECUTE'
  ),
  format('anon may not execute public.%s(jsonb)', wrappers.name)
)
FROM wrappers;

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_settings_row_from_policy_context_v1(text, jsonb)',
    'EXECUTE'
  ),
  'authenticated still cannot execute the canonical public settings resolver directly'
);

DO $do$
DECLARE
  v_name TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';

  FOREACH v_name IN ARRAY ARRAY[
    'resolve_mobile_ingest_policy',
    'resolve_location_tracking_policy',
    'resolve_scan_policy',
    'resolve_pod_policy'
  ]
  LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM public.%I($1::jsonb) LIMIT 1', v_name)
        USING '{}'::jsonb;
      PERFORM pass(format('authenticated can call public.%s through definer wrapper', v_name));
    EXCEPTION WHEN OTHERS THEN
      PERFORM fail(format('authenticated cannot call public.%s: %s %s', v_name, SQLSTATE, SQLERRM));
    END;
  END LOOP;

  EXECUTE 'RESET ROLE';
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  RAISE;
END;
$do$;

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_settings_row_from_policy_context_v1(text, jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute the canonical public settings resolver directly'
);

SELECT * FROM finish();

ROLLBACK;
