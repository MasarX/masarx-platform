-- W41 closure of W40 finding F4
-- pgTAP: driver_profile_summary_v1 view rewrite (phone from dp.metadata)
--
-- Asserts:
--   * View public.driver_profile_summary_v1 exists.
--   * View has security_invoker = true (W35d alignment).
--   * View column shape includes the canonical projections including phone.
--   * Underlying users table does NOT have a phone column (regression guard
--     for the F4 root cause).
--
-- Evidence link: docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

CREATE OR REPLACE FUNCTION test_w41_driver_profile_summary_phone_fixup()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reloptions TEXT[];
  v_users_phone_exists BOOLEAN;
BEGIN
  RETURN NEXT has_view(
    'public', 'driver_profile_summary_v1',
    'public.driver_profile_summary_v1 view exists'
  );

  RETURN NEXT has_column(
    'public', 'driver_profile_summary_v1', 'phone',
    'view exposes phone column'
  );

  RETURN NEXT has_column(
    'public', 'driver_profile_summary_v1', 'name',
    'view exposes name column'
  );

  RETURN NEXT has_column(
    'public', 'driver_profile_summary_v1', 'license_number',
    'view exposes license_number column'
  );

  -- security_invoker = true
  SELECT c.reloptions
    INTO v_reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'driver_profile_summary_v1'
     AND c.relkind = 'v';

  RETURN NEXT ok(
    v_reloptions @> ARRAY['security_invoker=true'],
    'driver_profile_summary_v1 view has security_invoker=true'
  );

  -- Regression guard: users.phone must NOT exist (since F4 closure routes
  -- around it). If a future migration adds users.phone, this test must be
  -- updated alongside the view to prefer the canonical column.
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name = 'phone'
  ) INTO v_users_phone_exists;

  RETURN NEXT ok(
    NOT v_users_phone_exists,
    'public.users.phone does not exist (F4 regression guard; remove this assertion if a canonical users.phone migration lands)'
  );

  -- Service-role and authenticated grants on the view.
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'public.driver_profile_summary_v1', 'select'),
    'authenticated has SELECT on driver_profile_summary_v1'
  );
END
$function$;

SELECT * FROM test_w41_driver_profile_summary_phone_fixup();

ROLLBACK;
