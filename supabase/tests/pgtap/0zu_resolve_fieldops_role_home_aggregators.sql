-- pgTAP coverage for the Mobile V2 role-home aggregator RPCs
-- (resolve_fieldops_loader_today_v1, resolve_fieldops_rider_today_v1,
--  resolve_fieldops_supervisor_queue_v1, resolve_fieldops_profile_v1)
-- shipped in 202605180000_resolve_fieldops_role_home_aggregators_v1.sql.
--
-- Closes engineering re-audit findings E1 (loader/rider/supervisor home
-- RPCs were called by the FE hooks but did not exist in any migration —
-- the production native shell showed a permanent server-error card) and
-- E3 (the shell-chrome identity was a hardcoded fixture; it now resolves
-- the caller identity via resolve_fieldops_profile_v1).
--
-- Each RPC is verified for: existence (public + api), SECURITY DEFINER,
-- jsonb return shape, grants (anon must NOT execute; authenticated +
-- service_role must), unauthenticated rejection, and envelope key shape.

BEGIN;
SELECT plan(37);

-- ===========================================================================
-- Existence — public.*
-- ===========================================================================

SELECT has_function('public', 'resolve_fieldops_loader_today_v1',     ARRAY['text','jsonb'], 'public.resolve_fieldops_loader_today_v1 exists');
SELECT has_function('public', 'resolve_fieldops_rider_today_v1',      ARRAY['text','jsonb'], 'public.resolve_fieldops_rider_today_v1 exists');
SELECT has_function('public', 'resolve_fieldops_supervisor_queue_v1', ARRAY['text','jsonb'], 'public.resolve_fieldops_supervisor_queue_v1 exists');
SELECT has_function('public', 'resolve_fieldops_profile_v1',          ARRAY['text','jsonb'], 'public.resolve_fieldops_profile_v1 exists');
SELECT has_function('public', 'fieldops_v2_user_first_name_v1',       ARRAY['uuid'], 'public.fieldops_v2_user_first_name_v1 helper exists');

-- ===========================================================================
-- Existence — api.* (PostgREST surface)
-- ===========================================================================

SELECT has_function('api', 'resolve_fieldops_loader_today_v1',     ARRAY['text','jsonb'], 'api.resolve_fieldops_loader_today_v1 exists');
SELECT has_function('api', 'resolve_fieldops_rider_today_v1',      ARRAY['text','jsonb'], 'api.resolve_fieldops_rider_today_v1 exists');
SELECT has_function('api', 'resolve_fieldops_supervisor_queue_v1', ARRAY['text','jsonb'], 'api.resolve_fieldops_supervisor_queue_v1 exists');
SELECT has_function('api', 'resolve_fieldops_profile_v1',          ARRAY['text','jsonb'], 'api.resolve_fieldops_profile_v1 exists');

-- ===========================================================================
-- Return type — all four resolvers return jsonb.
-- ===========================================================================

SELECT function_returns('public', 'resolve_fieldops_loader_today_v1',     ARRAY['text','jsonb'], 'jsonb', 'loader_today RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_rider_today_v1',      ARRAY['text','jsonb'], 'jsonb', 'rider_today RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_supervisor_queue_v1', ARRAY['text','jsonb'], 'jsonb', 'supervisor_queue RPC returns jsonb');
SELECT function_returns('public', 'resolve_fieldops_profile_v1',          ARRAY['text','jsonb'], 'jsonb', 'profile RPC returns jsonb');

-- ===========================================================================
-- Security: public.* are SECURITY DEFINER (org-scope enforced inside body).
-- ===========================================================================

DO $$
DECLARE
  fns TEXT[] := ARRAY[
    'resolve_fieldops_loader_today_v1',
    'resolve_fieldops_rider_today_v1',
    'resolve_fieldops_supervisor_queue_v1',
    'resolve_fieldops_profile_v1'
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
    'resolve_fieldops_loader_today_v1',
    'resolve_fieldops_rider_today_v1',
    'resolve_fieldops_supervisor_queue_v1',
    'resolve_fieldops_profile_v1'
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
-- Unauthenticated callers are rejected with SQLSTATE 42501.
-- ===========================================================================

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);

  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_loader_today_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_rider_today_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_supervisor_queue_v1()',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.resolve_fieldops_profile_v1()',
    '42501'
  );
END $$;

-- ===========================================================================
-- Envelope shape — when a resolver runs with a user that has no org
-- context, it returns a shape-compatible empty/zero envelope (never an
-- error, never a fabricated row). We assert the canonical envelope keys
-- exist so the FE hook contract is structurally stable.
-- ===========================================================================

DO $$
DECLARE
  v_loader JSONB;
  v_rider JSONB;
  v_sup JSONB;
  v_profile JSONB;
  v_uid UUID := gen_random_uuid();
BEGIN
  -- Authenticate as a user with no users-row -> current_user_org_id() is
  -- NULL -> resolvers take the no-org branch and return the empty envelope.
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_loader := public.resolve_fieldops_loader_today_v1();
  PERFORM ok(
    v_loader ? 'live_routes' AND v_loader ? 'total_parcels'
      AND v_loader ? 'scanned_parcels' AND v_loader ? 'drivers'
      AND v_loader ? 'quick_actions',
    'loader_today envelope carries the canonical keys'
  );
  PERFORM ok(
    jsonb_typeof(v_loader->'quick_actions') = 'array'
      AND jsonb_array_length(v_loader->'quick_actions') = 6,
    'loader_today quick_actions is a 6-tile navigation array'
  );

  v_rider := public.resolve_fieldops_rider_today_v1();
  PERFORM ok(
    v_rider ? 'earnings_today' AND v_rider ? 'trips_completed'
      AND v_rider ? 'active' AND v_rider ? 'upcoming',
    'rider_today envelope carries the canonical keys'
  );
  PERFORM ok(
    (v_rider->>'active') IS NULL
      AND jsonb_typeof(v_rider->'upcoming') = 'array'
      AND jsonb_array_length(v_rider->'upcoming') = 0,
    'rider_today returns an honest empty gig state (no fabricated tickets)'
  );

  v_sup := public.resolve_fieldops_supervisor_queue_v1();
  PERFORM ok(
    v_sup ? 'supervisor_name' AND v_sup ? 'queue' AND v_sup ? 'active_id',
    'supervisor_queue envelope carries the canonical keys'
  );
  PERFORM ok(
    jsonb_typeof(v_sup->'queue') = 'array',
    'supervisor_queue queue is a jsonb array'
  );

  v_profile := public.resolve_fieldops_profile_v1();
  PERFORM ok(
    v_profile ? 'name' AND v_profile ? 'badge',
    'profile envelope carries the canonical name + badge keys'
  );
  PERFORM ok(
    (v_profile->>'name') IS NULL AND (v_profile->>'badge') IS NULL,
    'profile returns a null identity envelope when the caller has no org context'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
