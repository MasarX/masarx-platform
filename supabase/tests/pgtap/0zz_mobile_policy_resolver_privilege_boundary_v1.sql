-- pgTAP: Mobile/FieldOps policy wrappers cross the locked settings boundary safely.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.authenticated_mobile_policy_resolvers_work()
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated')::text,
    true
  );

  PERFORM 1 FROM api.resolve_location_tracking_policy('{}'::jsonb) LIMIT 1;
  PERFORM 1 FROM api.resolve_scan_policy('{}'::jsonb) LIMIT 1;
  PERFORM 1 FROM api.resolve_pod_policy('{}'::jsonb) LIMIT 1;
  PERFORM 1 FROM api.resolve_mobile_sync_policy('{}'::jsonb) LIMIT 1;

  EXECUTE 'RESET ROLE';
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  RAISE;
END;
$function$;

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (WHERE p.prosecdef),
  4::bigint,
  'all four browser-readable Mobile/FieldOps policy wrappers are SECURITY DEFINER'
)
FROM wrappers
JOIN pg_proc p ON p.proname = wrappers.name
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE pg_get_function_identity_arguments(p.oid) = 'p_context jsonb';

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE 'search_path=public, extensions, pg_temp' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
  ),
  4::bigint,
  'all four browser-readable Mobile/FieldOps policy wrappers pin a safe search_path'
)
FROM wrappers
JOIN pg_proc p ON p.proname = wrappers.name
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE pg_get_function_identity_arguments(p.oid) = 'p_context jsonb';

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE has_function_privilege('authenticated', format('public.%s(jsonb)', wrappers.name), 'EXECUTE')
  ),
  4::bigint,
  'authenticated can execute all four browser-readable public category wrappers'
)
FROM wrappers;

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_mobile_ingest_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute the internal Mobile ingest policy wrapper'
);

SELECT ok(
  NOT (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_mobile_ingest_policy'
      AND pg_get_function_identity_arguments(p.oid) = 'p_context jsonb'
  ),
  'the internal Mobile ingest policy wrapper remains SECURITY INVOKER'
);

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE has_function_privilege('service_role', format('public.%s(jsonb)', wrappers.name), 'EXECUTE')
  ),
  5::bigint,
  'service_role can execute all five public category wrappers'
)
FROM wrappers;

WITH wrappers(name) AS (
  VALUES
    ('resolve_mobile_ingest_policy'),
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE has_function_privilege('anon', format('public.%s(jsonb)', wrappers.name), 'EXECUTE')
  ),
  0::bigint,
  'anon cannot execute any public Mobile/FieldOps policy wrapper'
)
FROM wrappers;

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_settings_row_from_policy_context_v1(text,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot execute the canonical generic settings resolver'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_settings_row_from_policy_context_v1(text,jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute the canonical generic settings resolver'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.resolve_settings_row_from_policy_context_v1(text,jsonb)',
    'EXECUTE'
  ),
  'service_role retains access to the canonical generic settings resolver'
);

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (WHERE to_regprocedure(format('api.%s(jsonb)', wrappers.name)) IS NOT NULL),
  4::bigint,
  'all four browser-facing api policy wrappers exist'
)
FROM wrappers;

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE has_function_privilege('authenticated', format('api.%s(jsonb)', wrappers.name), 'EXECUTE')
  ),
  4::bigint,
  'authenticated can execute all four browser-facing api policy wrappers'
)
FROM wrappers;

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (
    WHERE has_function_privilege('anon', format('api.%s(jsonb)', wrappers.name), 'EXECUTE')
  ),
  0::bigint,
  'anon cannot execute any browser-facing api policy wrapper'
)
FROM wrappers;

WITH wrappers(name) AS (
  VALUES
    ('resolve_location_tracking_policy'),
    ('resolve_scan_policy'),
    ('resolve_pod_policy'),
    ('resolve_mobile_sync_policy')
)
SELECT is(
  COUNT(*) FILTER (WHERE NOT p.prosecdef),
  4::bigint,
  'all four browser-facing api policy wrappers remain SECURITY INVOKER'
)
FROM wrappers
JOIN pg_proc p ON p.proname = wrappers.name
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'api'
WHERE pg_get_function_identity_arguments(p.oid) = 'p_context jsonb';

SELECT ok(
  pg_temp.authenticated_mobile_policy_resolvers_work(),
  'authenticated callers cross each intended API category wrapper without generic resolver privilege errors'
);

SELECT is(
  (
    SELECT COUNT(*)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'resolve_location_tracking_policy',
        'resolve_scan_policy',
        'resolve_pod_policy',
        'resolve_mobile_sync_policy'
      )
      AND r.rolname = 'postgres'
      AND pg_get_function_identity_arguments(p.oid) = 'p_context jsonb'
  ),
  4::bigint,
  'all four definer wrappers retain the canonical postgres owner'
);

SELECT * FROM finish();

ROLLBACK;
