-- pgTAP: Console V2 onboarding readiness repair RPC contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT has_function(
  'public',
  'ui_execute_onboarding_bootstrap_v1',
  ARRAY['text', 'uuid'],
  'public.ui_execute_onboarding_bootstrap_v1(text, uuid) is registered'
);

SELECT has_function(
  'api',
  'ui_execute_onboarding_bootstrap_v1',
  ARRAY['text', 'uuid'],
  'api.ui_execute_onboarding_bootstrap_v1(text, uuid) browser wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_execute_onboarding_bootstrap_v1'
    LIMIT 1),
  true,
  'public.ui_execute_onboarding_bootstrap_v1 is SECURITY DEFINER'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'api'
      AND p.proname = 'ui_execute_onboarding_bootstrap_v1'
    LIMIT 1),
  false,
  'api.ui_execute_onboarding_bootstrap_v1 is SECURITY INVOKER'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_execute_onboarding_bootstrap_v1(text, uuid)', 'EXECUTE'),
  'authenticated can execute api.ui_execute_onboarding_bootstrap_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_execute_onboarding_bootstrap_v1(text, uuid)', 'EXECUTE'),
  'anon cannot execute api.ui_execute_onboarding_bootstrap_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_execute_onboarding_bootstrap_v1('global', NULL) $$,
  '42501',
  NULL,
  'unauthenticated callers fail closed before bootstrap'
);

SELECT * FROM finish();
ROLLBACK;
