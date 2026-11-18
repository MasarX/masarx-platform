-- Plan: PHASE B / B2 — Backend RPC contract gap-fill (FLEET)
-- Migration: driver_hours_of_service canonical table v1
-- Date: 2026-04-28
--
-- Goals:
--   - Provide the missing canonical SSOT table for HOS (Hours of Service) duty segments
--     so the FLEET cross-walk surfaces (FE) have a real backing relation rather than the
--     fictional "driver_hours_of_service" referenced in console-v2 audits.
--   - Tenant-scoped + RLS enforced with least-privilege grants (drivers.read / fleet.read for
--     reads, fleet.write for mutations through the canonical RPC contract).
--   - Append-only style: ledger-friendly with org-match enforcement and indexed for time + driver lookups.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280005_driver_hours_of_service_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seed: HOS duty status (dynamic enum; SSOT)
-------------------------------------------------------------------------------

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

-------------------------------------------------------------------------------
-- 2) driver_hours_of_service: canonical HOS ledger (org-scoped; tenant-only)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_hours_of_service (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,

  segment_start TIMESTAMPTZ NOT NULL,
  segment_end TIMESTAMPTZ NULL,
  duty_status TEXT NOT NULL, -- lookup hours_of_service_duty_status

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
  IS 'Canonical SSOT HOS ledger. One row per duty segment per driver. Org-scoped; tenant-only RLS.';
COMMENT ON COLUMN public.driver_hours_of_service.duty_status
  IS 'Duty status: driving | on_duty | off_duty | sleeper (sourced from lookup hours_of_service_duty_status).';
COMMENT ON COLUMN public.driver_hours_of_service.segment_end
  IS 'NULL when the segment is currently open (active).';

CREATE INDEX IF NOT EXISTS idx_driver_hos_org_driver_start
  ON public.driver_hours_of_service (organization_id, driver_id, segment_start DESC);

CREATE INDEX IF NOT EXISTS idx_driver_hos_org_status_start
  ON public.driver_hours_of_service (organization_id, duty_status, segment_start DESC);

CREATE INDEX IF NOT EXISTS idx_driver_hos_open_segments
  ON public.driver_hours_of_service (driver_id, segment_start DESC)
  WHERE segment_end IS NULL;

DROP TRIGGER IF EXISTS trg_driver_hours_of_service_set_updated_at ON public.driver_hours_of_service;
CREATE TRIGGER trg_driver_hours_of_service_set_updated_at
  BEFORE UPDATE ON public.driver_hours_of_service
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Cross-table org consistency (driver_profiles.organization_id == this row's organization_id;
-- recorded_by_user_id, when set, must belong to the same org).
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

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants
-------------------------------------------------------------------------------

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

-- Reads: drivers may see their own segments; tenant users with fleet.read may see org segments.
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

-- Writes: tenant-only, gated by fleet.write (least privilege; aligned with existing fleet RBAC).
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

-------------------------------------------------------------------------------
-- 4) Table contract registration (timestamps + audit posture)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES (
  'public',
  'driver_hours_of_service',
  TRUE,
  TRUE,
  TRUE,
  'Driver hours-of-service ledger (org-scoped; user-facing; tenant-only).'
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

-- API view refresh is deferred to 202605010002_w41_driver_hours_of_service_view_recreate,
-- where refresh_api_contract_views_v1 is patched to drop/recreate views safely.
-- Calling the pre-patch refresher here can fail on column-shape changes.

SELECT pg_advisory_unlock(hashtext('202604280005_driver_hours_of_service_v1'));
COMMIT;
