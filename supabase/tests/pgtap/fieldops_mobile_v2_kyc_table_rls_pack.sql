-- pgTAP coverage for the Mobile V2 KYC / auth / pre-shift table RLS posture.
--
-- Closes the open audit follow-up: migration
-- 202605120400_fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2.sql creates
-- seven user-facing tables (fieldops_user_roles, fieldops_v2_kyc_docs,
-- fieldops_v2_vehicles, fieldops_v2_cleaning_checks,
-- fieldops_v2_pre_shift_passes, fieldops_v2_incidents, shipment_holds)
-- each with RLS + a service / select / insert policy trio, but the
-- companion pgTAP pack only asserted the RPC signatures and 42501
-- unauthenticated guards — nothing asserted the TABLE-level RLS posture.
-- A migration that disabled RLS, dropped a policy, over-granted anon, or
-- removed the org-scoping guard from a SELECT policy would pass the gate
-- undetected.
--
-- This pack asserts, per table:
--   - the table exists and RLS is ENABLED
--   - anon has NO SELECT / INSERT privilege (fully denied)
--   - authenticated has SELECT + INSERT but NOT DELETE
--   - service_role retains full access
--   - the service (FOR ALL) / select (FOR SELECT) / insert (FOR INSERT)
--     policies exist with the correct command
--   - the SELECT policy is org-scoped (references current_user_org_id())
--   - the INSERT policy is write-gated (references user_can_write())
-- plus the per-table specifics: fieldops_user_roles also exposes an
-- UPDATE policy; fieldops_v2_kyc_docs + fieldops_v2_vehicles SELECT
-- policies additionally scope to the owning user_id.
--
-- Companion: fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2.sql (RPC
-- signatures + behavioural 42501 denial). All catalog reads; no writes.

BEGIN;
SELECT plan(116);

DO $do$
DECLARE
  v_tables TEXT[] := ARRAY[
    'fieldops_user_roles',
    'fieldops_v2_kyc_docs',
    'fieldops_v2_vehicles',
    'fieldops_v2_cleaning_checks',
    'fieldops_v2_pre_shift_passes',
    'fieldops_v2_incidents',
    'shipment_holds'
  ];
  v_t TEXT;
  v_rel REGCLASS;
  v_rls BOOLEAN;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    v_rel := ('public.' || v_t)::regclass;

    -- 1) table exists.
    PERFORM has_table('public', v_t, format('table public.%s exists', v_t));

    -- 2) RLS is enabled.
    SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = v_rel;
    PERFORM ok(COALESCE(v_rls, FALSE), format('%s: row level security enabled', v_t));

    -- 3-4) anon is fully denied — no SELECT, no INSERT.
    PERFORM ok(
      NOT has_table_privilege('anon', v_rel, 'SELECT'),
      format('%s: anon has NO SELECT privilege', v_t));
    PERFORM ok(
      NOT has_table_privilege('anon', v_rel, 'INSERT'),
      format('%s: anon has NO INSERT privilege', v_t));

    -- 5-7) authenticated may read + insert, but never delete.
    PERFORM ok(
      has_table_privilege('authenticated', v_rel, 'SELECT'),
      format('%s: authenticated may SELECT', v_t));
    PERFORM ok(
      has_table_privilege('authenticated', v_rel, 'INSERT'),
      format('%s: authenticated may INSERT', v_t));
    PERFORM ok(
      NOT has_table_privilege('authenticated', v_rel, 'DELETE'),
      format('%s: authenticated may NOT DELETE', v_t));

    -- 8) service_role retains full access (ALL grant).
    PERFORM ok(
      has_table_privilege('service_role', v_rel, 'DELETE'),
      format('%s: service_role retains full access', v_t));

    -- 9-10) service_role FOR ALL policy.
    PERFORM ok(
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_service_policy'),
      format('%s: service_role policy exists', v_t));
    PERFORM is(
      (SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_service_policy'),
      'ALL',
      format('%s: service_role policy is FOR ALL', v_t));

    -- 11-13) SELECT policy exists, is FOR SELECT, and is org-scoped.
    PERFORM ok(
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_select_policy'),
      format('%s: select policy exists', v_t));
    PERFORM is(
      (SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_select_policy'),
      'SELECT',
      format('%s: select policy is FOR SELECT', v_t));
    PERFORM ok(
      (SELECT qual FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_select_policy') LIKE '%current_user_org_id%',
      format('%s: select policy is org-scoped (current_user_org_id)', v_t));

    -- 14-16) INSERT policy exists, is FOR INSERT, and is write-gated.
    PERFORM ok(
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_insert_policy'),
      format('%s: insert policy exists', v_t));
    PERFORM is(
      (SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_insert_policy'),
      'INSERT',
      format('%s: insert policy is FOR INSERT', v_t));
    PERFORM ok(
      (SELECT with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_t
          AND policyname = v_t || '_insert_policy') LIKE '%user_can_write%',
      format('%s: insert policy is write-gated (user_can_write)', v_t));
  END LOOP;

  -- ── Per-table specifics ──────────────────────────────────────────
  -- fieldops_user_roles additionally exposes an UPDATE policy (the
  -- role-select screen flips is_active between role rows).
  PERFORM ok(
    EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'fieldops_user_roles'
        AND policyname = 'fieldops_user_roles_update_policy'),
    'fieldops_user_roles: update policy exists');
  PERFORM is(
    (SELECT cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'fieldops_user_roles'
        AND policyname = 'fieldops_user_roles_update_policy'),
    'UPDATE',
    'fieldops_user_roles: update policy is FOR UPDATE');

  -- KYC docs + vehicles SELECT policies scope a non-writer caller to
  -- their OWN user_id — a driver cannot read another driver's KYC.
  PERFORM ok(
    (SELECT qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'fieldops_v2_kyc_docs'
        AND policyname = 'fieldops_v2_kyc_docs_select_policy') LIKE '%user_id%',
    'fieldops_v2_kyc_docs: select policy is owner-scoped (user_id)');
  PERFORM ok(
    (SELECT qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'fieldops_v2_vehicles'
        AND policyname = 'fieldops_v2_vehicles_select_policy') LIKE '%user_id%',
    'fieldops_v2_vehicles: select policy is owner-scoped (user_id)');
END
$do$;

SELECT * FROM finish();
ROLLBACK;
