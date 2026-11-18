-- pgTAP: api.resolve_settings_row_from_policy_context_v1 browser-safe wrapper
--
-- Closes engineering re-audit finding IMPORTANT-2
-- (docs/ops/evidence/2026-05-16/mobile-v2-fieldops-audit-cycle-2/README.md).
--
-- public.resolve_settings_row_from_policy_context_v1 is deliberately
-- service_role-locked (202601212850). The sanctioned browser-facing path is
-- the api.* wrapper, which MUST be SECURITY DEFINER so an `authenticated`
-- caller can resolve settings without holding EXECUTE on the locked public
-- function. 202605100100 regressed the wrapper to SECURITY INVOKER (which
-- fails closed with 42501 for authenticated callers); 202605161400 restored
-- DEFINER. This pack pins that contract so a future re-declaration cannot
-- silently break authenticated settings resolution again.
--
-- All catalog reads; no writes.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- 1) The api wrapper exists with the canonical (text, jsonb) signature.
SELECT has_function(
  'api', 'resolve_settings_row_from_policy_context_v1', ARRAY['text', 'jsonb'],
  'api.resolve_settings_row_from_policy_context_v1(text,jsonb) exists'
);

-- 2) The wrapper is SECURITY DEFINER — required because the underlying
--    public resolver is service_role-locked.
SELECT ok(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'api'
      AND p.proname = 'resolve_settings_row_from_policy_context_v1'
    LIMIT 1),
  'api.resolve_settings_row_from_policy_context_v1 is SECURITY DEFINER (browser-safe)'
);

-- 3) `authenticated` may EXECUTE the api wrapper (the browser path works).
SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.resolve_settings_row_from_policy_context_v1(text, jsonb)',
    'EXECUTE'
  ),
  'authenticated may EXECUTE the api settings-resolver wrapper'
);

-- 4) The underlying public resolver stays locked away from `authenticated`
--    (the lock-the-raw-function / expose-via-api-wrapper pattern is intact).
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.resolve_settings_row_from_policy_context_v1(text, jsonb)',
    'EXECUTE'
  ),
  'public.resolve_settings_row_from_policy_context_v1 stays service_role-locked'
);

SELECT * FROM finish();
ROLLBACK;
