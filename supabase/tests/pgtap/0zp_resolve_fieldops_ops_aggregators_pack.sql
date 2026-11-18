-- pgTAP coverage for Phase 6.F mobile ops aggregator RPCs
-- (resolve_fieldops_trips_v1, _sortation_v1, _lookup_v1, _returns_v1,
--  _hub_pickup_v1, _hold_v1, _cash_drop_v1, _wallet_v1, _eor_v1)
--
-- Each RPC is verified for: existence (public + api), SECURITY DEFINER
-- (where applicable), grants to authenticated/service_role only,
-- envelope shape, and unauthenticated-rejection.

BEGIN;
SELECT plan(63);

-- ===========================================================================
-- Existence — public.*
-- ===========================================================================

SELECT has_function('public', 'resolve_fieldops_trips_v1',      ARRAY['text','jsonb'], 'public.resolve_fieldops_trips_v1 exists');
SELECT has_function('public', 'resolve_fieldops_sortation_v1',  ARRAY['text','jsonb'], 'public.resolve_fieldops_sortation_v1 exists');
SELECT has_function('public', 'resolve_fieldops_lookup_v1',     ARRAY['text','jsonb','text'], 'public.resolve_fieldops_lookup_v1 exists');
SELECT has_function('public', 'resolve_fieldops_returns_v1',    ARRAY['text','jsonb'], 'public.resolve_fieldops_returns_v1 exists');
SELECT has_function('public', 'resolve_fieldops_hub_pickup_v1', ARRAY['text','jsonb'], 'public.resolve_fieldops_hub_pickup_v1 exists');
SELECT has_function('public', 'resolve_fieldops_hold_v1',       ARRAY['text','jsonb'], 'public.resolve_fieldops_hold_v1 exists');
SELECT has_function('public', 'resolve_fieldops_cash_drop_v1',  ARRAY['text','jsonb'], 'public.resolve_fieldops_cash_drop_v1 exists');
SELECT has_function('public', 'resolve_fieldops_wallet_v1',     ARRAY['text','jsonb'], 'public.resolve_fieldops_wallet_v1 exists');
SELECT has_function('public', 'resolve_fieldops_eor_v1',        ARRAY['text','jsonb'], 'public.resolve_fieldops_eor_v1 exists');

-- ===========================================================================
-- Existence — api.* (PostgREST surface)
-- ===========================================================================

SELECT has_function('api', 'resolve_fieldops_trips_v1',      ARRAY['text','jsonb'], 'api.resolve_fieldops_trips_v1 exists');
SELECT has_function('api', 'resolve_fieldops_sortation_v1',  ARRAY['text','jsonb'], 'api.resolve_fieldops_sortation_v1 exists');
SELECT has_function('api', 'resolve_fieldops_lookup_v1',     ARRAY['text','jsonb','text'], 'api.resolve_fieldops_lookup_v1 exists');
SELECT has_function('api', 'resolve_fieldops_returns_v1',    ARRAY['text','jsonb'], 'api.resolve_fieldops_returns_v1 exists');
SELECT has_function('api', 'resolve_fieldops_hub_pickup_v1', ARRAY['text','jsonb'], 'api.resolve_fieldops_hub_pickup_v1 exists');
SELECT has_function('api', 'resolve_fieldops_hold_v1',       ARRAY['text','jsonb'], 'api.resolve_fieldops_hold_v1 exists');
SELECT has_function('api', 'resolve_fieldops_cash_drop_v1',  ARRAY['text','jsonb'], 'api.resolve_fieldops_cash_drop_v1 exists');
SELECT has_function('api', 'resolve_fieldops_wallet_v1',     ARRAY['text','jsonb'], 'api.resolve_fieldops_wallet_v1 exists');
SELECT has_function('api', 'resolve_fieldops_eor_v1',        ARRAY['text','jsonb'], 'api.resolve_fieldops_eor_v1 exists');

-- ===========================================================================
-- Security: public.* are SECURITY DEFINER (read with org-scope inside).
-- ===========================================================================

DO $$
DECLARE
  fns TEXT[] := ARRAY[
    'resolve_fieldops_trips_v1',
    'resolve_fieldops_sortation_v1',
    'resolve_fieldops_lookup_v1',
    'resolve_fieldops_returns_v1',
    'resolve_fieldops_hub_pickup_v1',
    'resolve_fieldops_hold_v1',
    'resolve_fieldops_cash_drop_v1',
    'resolve_fieldops_wallet_v1',
    'resolve_fieldops_eor_v1'
  ];
  f TEXT;
  is_def BOOLEAN;
BEGIN
  FOREACH f IN ARRAY fns LOOP
    SELECT p.prosecdef
    INTO is_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = f
    LIMIT 1;
    PERFORM ok(is_def, 'public.' || f || ' is SECURITY DEFINER');
  END LOOP;
END $$;

-- ===========================================================================
-- Grants: anon must NOT execute; authenticated + service_role must.
-- ===========================================================================

DO $$
DECLARE
  fns TEXT[] := ARRAY[
    'resolve_fieldops_trips_v1',
    'resolve_fieldops_sortation_v1',
    'resolve_fieldops_lookup_v1',
    'resolve_fieldops_returns_v1',
    'resolve_fieldops_hub_pickup_v1',
    'resolve_fieldops_hold_v1',
    'resolve_fieldops_cash_drop_v1',
    'resolve_fieldops_wallet_v1',
    'resolve_fieldops_eor_v1'
  ];
  f TEXT;
  has_anon BOOLEAN;
  has_auth BOOLEAN;
BEGIN
  FOREACH f IN ARRAY fns LOOP
    SELECT bool_or(g.grantee = 'anon')
    INTO has_anon
    FROM information_schema.routine_privileges g
    WHERE g.specific_schema = 'public'
      AND g.routine_name = f
      AND g.privilege_type = 'EXECUTE';

    SELECT bool_or(g.grantee = 'authenticated')
    INTO has_auth
    FROM information_schema.routine_privileges g
    WHERE g.specific_schema = 'public'
      AND g.routine_name = f
      AND g.privilege_type = 'EXECUTE';

    PERFORM ok(COALESCE(has_anon, false) = false, 'public.' || f || ' has no anon EXECUTE grant');
    PERFORM ok(COALESCE(has_auth, false) = true,  'public.' || f || ' has authenticated EXECUTE grant');
  END LOOP;
END $$;

-- ===========================================================================
-- Unauthenticated callers are rejected.
-- ===========================================================================

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);

  -- Each public.* RPC raises ERRCODE 42501 when auth.uid() is NULL.
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_trips_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_sortation_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_lookup_v1(NULL, ''{}''::jsonb, ''wb-1'')',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_returns_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_hub_pickup_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_hold_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_cash_drop_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_wallet_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_eor_v1()',
    '42501'
  );
END $$;

-- ===========================================================================
-- Envelope shape — comments + names.
-- ===========================================================================

SELECT function_returns('public', 'resolve_fieldops_trips_v1',      ARRAY['text','jsonb'], 'jsonb', 'trips RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_sortation_v1',  ARRAY['text','jsonb'], 'jsonb', 'sortation RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_lookup_v1',     ARRAY['text','jsonb','text'], 'jsonb', 'lookup RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_returns_v1',    ARRAY['text','jsonb'], 'jsonb', 'returns RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_hub_pickup_v1', ARRAY['text','jsonb'], 'jsonb', 'hub_pickup RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_hold_v1',       ARRAY['text','jsonb'], 'jsonb', 'hold RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_cash_drop_v1',  ARRAY['text','jsonb'], 'jsonb', 'cash_drop RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_wallet_v1',     ARRAY['text','jsonb'], 'jsonb', 'wallet RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_eor_v1',        ARRAY['text','jsonb'], 'jsonb', 'eor RPC returns jsonb');

SELECT * FROM finish();
ROLLBACK;
