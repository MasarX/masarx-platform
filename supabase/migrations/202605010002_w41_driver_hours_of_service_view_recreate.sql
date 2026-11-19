-- Spec-Issue: W41 closure of W40 local-Supabase E2E findings (F2)
-- Step: W41-F2
-- Migration: Recreate-strategy fixup for 202604280005_driver_hours_of_service_v1
--
-- W40 finding (P1):
--   docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log
--     HARD-FAIL 202604280005_driver_hours_of_service_v1.sql:
--       cannot drop columns from view
--
-- Root cause:
--   The driver_hours_of_service migration calls
--   `public.refresh_api_contract_views_v1()` which iterates ALL user-facing
--   tables and runs `CREATE OR REPLACE VIEW api.<table>` for each. When any
--   prior table column was dropped (e.g. webhook_inbox_events ack_* columns
--   in 202511201900_remove_ack_artifacts), the corresponding `api.<table>`
--   view still has the old column shape recorded. CREATE OR REPLACE VIEW
--   refuses to drop columns from an existing view definition (PG behavior),
--   so the entire transaction aborts and `driver_hours_of_service` table
--   never gets created.
--
-- Closure strategy:
--   1. Patch `public.refresh_api_contract_views_v1()` to use the safe
--      DROP-then-CREATE pattern so column shrinkage is handled idempotently.
--   2. Idempotently re-create the missing driver_hours_of_service objects
--      (table + indexes + RLS + policies + table_contracts row) so the
--      table actually exists before downstream view migrations
--      (202604302710_v_driver_directory) try to read from it.
--   3. Refresh api.* contract views with the patched function.
--
-- Append-only: this migration creates new objects only and patches one
-- function in place (CREATE OR REPLACE FUNCTION). It does NOT edit any
-- historical migration file.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605010002_w41_driver_hours_of_service_view_recreate'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Patch refresh_api_contract_views_v1 to be column-shrink-safe.
--    DROP VIEW IF EXISTS ... CASCADE; CREATE VIEW ... is idempotent and never
--    fails on column shape change. CASCADE ensures dependent api.<X> views
--    cannot pin a stale shape.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_api_contract_views_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_has_exclusions BOOLEAN := FALSE;
BEGIN
  v_has_exclusions := (to_regclass('public.api_contract_view_exclusions') IS NOT NULL);

  EXECUTE 'CREATE SCHEMA IF NOT EXISTS api';

  -- Deny-by-default: no PUBLIC, no anon schema access.
  EXECUTE 'REVOKE ALL ON SCHEMA api FROM PUBLIC';
  EXECUTE 'REVOKE USAGE ON SCHEMA api FROM anon';

  -- Explicit grants for supported roles only.
  EXECUTE 'GRANT USAGE ON SCHEMA api TO authenticated';
  EXECUTE 'GRANT USAGE ON SCHEMA api TO service_role';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_label_renderer_role';
  END IF;

  FOR r IN
    SELECT tablename
    FROM public.security_rls_user_facing
    ORDER BY tablename
  LOOP
    IF v_has_exclusions AND EXISTS (
      SELECT 1
      FROM public.api_contract_view_exclusions x
      WHERE x.schema_name = 'api'
        AND x.view_name = r.tablename
    ) THEN
      CONTINUE;
    END IF;

    -- W41 F2: use DROP-then-CREATE so column shrinkage on the underlying
    -- public table is handled cleanly. CREATE OR REPLACE VIEW raises
    -- "cannot drop columns from view" when the new SELECT has fewer columns
    -- than the existing view definition. CASCADE drops any chained api.* views
    -- that depend on this one (none today, but safe).
    EXECUTE format('DROP VIEW IF EXISTS api.%I CASCADE', r.tablename);

    EXECUTE format(
      'CREATE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);

    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    IF v_auth_select THEN EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename); END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_api_contract_views_v1() TO service_role;

COMMENT ON FUNCTION public.refresh_api_contract_views_v1()
  IS 'Service-only: Rebuild api.<table> contract views for the current user-facing public surface, skipping api_contract_view_exclusions. Uses DROP-then-CREATE so source column shrinkage is handled cleanly. Does not grant to anon.';

-- ---------------------------------------------------------------------------
-- 2) Idempotently ensure the canonical hours_of_service objects exist:
--    a) HOS duty status lookup
--    b) public.driver_hours_of_service base table (org-scoped)
--    c) Org-match enforcement trigger
--    d) RLS policies + grants
--    e) table_contracts row + apply_table_contracts/ensure_audit_triggers
--    f) Final api view refresh
-- ---------------------------------------------------------------------------

-- 2a) Lookup seed (idempotent)
INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'hours_of_service_duty_status',
  'Driver hours-of-service duty status (driving / on_duty / off_duty / sleeper)',
  'fleet',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('off_duty', 'Off Duty', 'Driver is off duty', 10, TRUE, '{}'),
  ('on_duty',  'On Duty',  'Driver is on duty (not driving)', 20, FALSE, '{}'),
  ('driving',  'Driving',  'Driver is actively driving', 30, FALSE, '{}'),
  ('sleeper',  'Sleeper',  'Driver is in sleeper berth', 40, FALSE, '{}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'hours_of_service_duty_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- 2b) Base table (idempotent)
CREATE TABLE IF NOT EXISTS public.driver_hours_of_service (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,

  segment_start TIMESTAMPTZ NOT NULL,
  segment_end TIMESTAMPTZ NULL,
  duty_status TEXT NOT NULL,

  notes TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  recorded_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  recorded_via_system TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT driver_hours_of_service_duty_status_ck
    CHECK (btrim(duty_status) <> '' AND duty_status = lower(duty_status)),
  CONSTRAINT driver_hours_of_service_segment_range_ck
    CHECK (segment_end IS NULL OR segment_end >= segment_start),
  CONSTRAINT driver_hours_of_service_notes_ck
    CHECK (notes IS NULL OR btrim(notes) <> ''),
  CONSTRAINT driver_hours_of_service_recorded_via_ck
    CHECK (recorded_via_system IS NULL OR btrim(recorded_via_system) <> '')
);

COMMENT ON TABLE public.driver_hours_of_service
  IS 'Canonical SSOT HOS ledger. One row per duty segment per driver. Org-scoped; tenant-only RLS. (W41 F2 idempotent recreate)';

CREATE INDEX IF NOT EXISTS idx_driver_hos_org_driver_start
  ON public.driver_hours_of_service (organization_id, driver_id, segment_start DESC);

CREATE INDEX IF NOT EXISTS idx_driver_hos_org_status_start
  ON public.driver_hours_of_service (organization_id, duty_status, segment_start DESC);

CREATE INDEX IF NOT EXISTS idx_driver_hos_open_segments
  ON public.driver_hours_of_service (driver_id, segment_start DESC)
  WHERE segment_end IS NULL;

-- 2c) updated_at trigger
DROP TRIGGER IF EXISTS trg_driver_hours_of_service_set_updated_at ON public.driver_hours_of_service;
CREATE TRIGGER trg_driver_hours_of_service_set_updated_at
  BEFORE UPDATE ON public.driver_hours_of_service
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Org-match enforcement function (idempotent)
CREATE OR REPLACE FUNCTION public.driver_hours_of_service_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_driver_org UUID;
  v_actor_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'driver_hours_of_service: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT dp.organization_id
    INTO v_driver_org
    FROM public.driver_profiles dp
   WHERE dp.id = NEW.driver_id;

  IF v_driver_org IS NULL THEN
    RAISE EXCEPTION 'driver_hours_of_service: driver_profile % not found', NEW.driver_id
      USING ERRCODE = '23503';
  END IF;

  IF v_driver_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'driver_hours_of_service: organization mismatch (segment org %, driver org %)', NEW.organization_id, v_driver_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.recorded_by_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_actor_org
      FROM public.users u
     WHERE u.id = NEW.recorded_by_user_id;

    IF v_actor_org IS NULL THEN
      RAISE EXCEPTION 'driver_hours_of_service: recorded_by_user % not found', NEW.recorded_by_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_actor_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'driver_hours_of_service: organization mismatch (segment org %, actor org %)', NEW.organization_id, v_actor_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_hours_of_service_enforce_org_match ON public.driver_hours_of_service;
CREATE TRIGGER trg_driver_hours_of_service_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.driver_hours_of_service
  FOR EACH ROW
  EXECUTE FUNCTION public.driver_hours_of_service_enforce_org_match_v1();

-- 2d) RLS + least-privilege grants (idempotent)
ALTER TABLE public.driver_hours_of_service ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.driver_hours_of_service FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_hours_of_service FROM anon;
REVOKE ALL ON TABLE public.driver_hours_of_service FROM authenticated;

DROP POLICY IF EXISTS driver_hours_of_service_service_policy ON public.driver_hours_of_service;
CREATE POLICY driver_hours_of_service_service_policy ON public.driver_hours_of_service
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS driver_hours_of_service_select_policy ON public.driver_hours_of_service;
CREATE POLICY driver_hours_of_service_select_policy ON public.driver_hours_of_service
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND EXISTS (
        SELECT 1 FROM public.driver_profiles dp
        WHERE dp.id = driver_hours_of_service.driver_id
          AND dp.user_id = auth.uid()
      )
    )
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('fleet.read', organization_id)
    )
  );

DROP POLICY IF EXISTS driver_hours_of_service_write_policy ON public.driver_hours_of_service;
CREATE POLICY driver_hours_of_service_write_policy ON public.driver_hours_of_service
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('fleet.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_hours_of_service TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_hours_of_service TO service_role;

-- 2e) Table contract registration (idempotent)
INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES (
  'public',
  'driver_hours_of_service',
  TRUE,
  TRUE,
  TRUE,
  'Driver hours-of-service ledger (org-scoped; user-facing; tenant-only). W41 F2 idempotent recreate.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-- 2f) Refresh api views with the patched DROP-then-CREATE function.
SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202605010002_w41_driver_hours_of_service_view_recreate'));

COMMIT;
