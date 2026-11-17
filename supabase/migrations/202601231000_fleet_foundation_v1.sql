-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fleet foundation v1 (vehicles + assignments + maintenance windows)
-- Date: 2026-01-23
--
-- Goals:
--   - Add core fleet/vehicle management tables (org-scoped, branch-aware).
--   - Keep data model simple and dynamic (no hardcoded branches/roles).
--   - Enforce least-privilege RLS (tenant-only access; clients/senders cannot see fleet data).
--   - Ensure cross-table organization consistency via triggers (no cross-tenant links).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601231000_fleet_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('vehicle_status', 'Vehicle lifecycle/status for fleet management', 'fleet', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active', 'Active', 'Vehicle is active and available (subject to assignments/downtime)', 10, TRUE, '{}' ),
  ('inactive', 'Inactive', 'Vehicle is inactive (temporarily unavailable)', 20, FALSE, '{}' ),
  ('in_maintenance', 'In Maintenance', 'Vehicle is in maintenance/downtime', 30, FALSE, '{}' ),
  ('retired', 'Retired', 'Vehicle is retired/decommissioned', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('vehicle_assignment_status', 'Vehicle assignment status (active/ended/canceled)', 'fleet', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active', 'Active', 'Assignment is currently active', 10, TRUE, '{}' ),
  ('ended', 'Ended', 'Assignment ended normally', 20, FALSE, '{}' ),
  ('canceled', 'Canceled', 'Assignment was canceled', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'vehicle_assignment_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Fleet tables (org-scoped; branch-aware)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vehicle_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_types_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT vehicle_types_name_ck CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_types_org_key
  ON public.vehicle_types (organization_id, key);

CREATE INDEX IF NOT EXISTS idx_vehicle_types_org_active
  ON public.vehicle_types (organization_id, is_active, key);

COMMENT ON TABLE public.vehicle_types
  IS 'Fleet vehicle types (org-scoped). Provides configurable capacity/attributes via metadata.';

DROP TRIGGER IF EXISTS trg_vehicle_types_set_updated_at ON public.vehicle_types;
CREATE TRIGGER trg_vehicle_types_set_updated_at
  BEFORE UPDATE ON public.vehicle_types
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  vehicle_type_id UUID REFERENCES public.vehicle_types(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'active', -- lookup vehicle_status
  plate_number TEXT NULL,
  plate_number_upper TEXT GENERATED ALWAYS AS (upper(plate_number)) STORED,
  vin TEXT NULL,
  make TEXT NULL,
  model TEXT NULL,
  model_year INT NULL,
  color TEXT NULL,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  acquired_at TIMESTAMPTZ NULL,
  retired_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicles_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT vehicles_plate_ck CHECK (plate_number IS NULL OR btrim(plate_number) <> ''),
  CONSTRAINT vehicles_vin_ck CHECK (vin IS NULL OR btrim(vin) <> ''),
  CONSTRAINT vehicles_model_year_ck CHECK (model_year IS NULL OR model_year >= 1900),
  CONSTRAINT vehicles_retired_after_acquired_ck CHECK (acquired_at IS NULL OR retired_at IS NULL OR retired_at >= acquired_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_org_plate_upper
  ON public.vehicles (organization_id, plate_number_upper)
  WHERE plate_number IS NOT NULL AND btrim(plate_number) <> '';

CREATE INDEX IF NOT EXISTS idx_vehicles_org_branch
  ON public.vehicles (organization_id, branch_id)
  WHERE branch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicles_org_status
  ON public.vehicles (organization_id, status, created_at DESC);

COMMENT ON TABLE public.vehicles
  IS 'Fleet vehicles/assets (org-scoped, optionally assigned to branches). Operational flows should use tasks/workflows; this is the fleet SSOT for assets.';

CREATE OR REPLACE FUNCTION public.vehicles_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_type_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'vehicles: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'vehicles: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicles: organization mismatch (vehicle org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.vehicle_type_id IS NOT NULL THEN
    SELECT vt.organization_id INTO v_type_org
    FROM public.vehicle_types vt
    WHERE vt.id = NEW.vehicle_type_id;

    IF v_type_org IS NULL THEN
      RAISE EXCEPTION 'vehicles: vehicle_type % not found', NEW.vehicle_type_id USING ERRCODE = '23503';
    END IF;

    IF v_type_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicles: organization mismatch (vehicle org %, vehicle_type org %)', NEW.organization_id, v_type_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vehicles_enforce_org_match ON public.vehicles;
CREATE TRIGGER trg_vehicles_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicles_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_vehicles_set_updated_at ON public.vehicles;
CREATE TRIGGER trg_vehicles_set_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.vehicle_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  assigned_to_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'active', -- lookup vehicle_assignment_status
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_assignments_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT vehicle_assignments_time_range_ck CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One active assignment per vehicle at a time (simple invariant; deeper constraints can be policy-driven later).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_assignments_vehicle_active
  ON public.vehicle_assignments (vehicle_id)
  WHERE status = 'active' AND ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_org_vehicle
  ON public.vehicle_assignments (organization_id, vehicle_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_assignments_org_user
  ON public.vehicle_assignments (organization_id, assigned_to_user_id, started_at DESC)
  WHERE assigned_to_user_id IS NOT NULL;

COMMENT ON TABLE public.vehicle_assignments
  IS 'Vehicle assignments (org-scoped): bind vehicles to drivers/branches over time. Used for dispatch and accountability.';

CREATE OR REPLACE FUNCTION public.vehicle_assignments_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_vehicle_org UUID;
  v_branch_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'vehicle_assignments: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT v.organization_id INTO v_vehicle_org
  FROM public.vehicles v
  WHERE v.id = NEW.vehicle_id;

  IF v_vehicle_org IS NULL THEN
    RAISE EXCEPTION 'vehicle_assignments: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
  END IF;

  IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vehicle_assignments: organization mismatch (assignment org %, vehicle org %)', NEW.organization_id, v_vehicle_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'vehicle_assignments: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicle_assignments: organization mismatch (assignment org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.assigned_to_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.assigned_to_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'vehicle_assignments: user % not found', NEW.assigned_to_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'vehicle_assignments: organization mismatch (assignment org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vehicle_assignments_enforce_org_match ON public.vehicle_assignments;
CREATE TRIGGER trg_vehicle_assignments_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.vehicle_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicle_assignments_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_vehicle_assignments_set_updated_at ON public.vehicle_assignments;
CREATE TRIGGER trg_vehicle_assignments_set_updated_at
  BEFORE UPDATE ON public.vehicle_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,

  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  reason TEXT NULL,
  notes TEXT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicle_maintenance_windows_range_ck CHECK (window_end_at >= window_start_at),
  CONSTRAINT vehicle_maintenance_windows_reason_ck CHECK (reason IS NULL OR btrim(reason) <> '')
);

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_windows_org_vehicle
  ON public.vehicle_maintenance_windows (organization_id, vehicle_id, window_start_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_windows_vehicle_window
  ON public.vehicle_maintenance_windows (vehicle_id, window_start_at, window_end_at);

COMMENT ON TABLE public.vehicle_maintenance_windows
  IS 'Vehicle downtime windows for maintenance/inspections (org-scoped). Used by dispatch policies to prevent assignment.';

CREATE OR REPLACE FUNCTION public.vehicle_maintenance_windows_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_vehicle_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'vehicle_maintenance_windows: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT v.organization_id INTO v_vehicle_org
  FROM public.vehicles v
  WHERE v.id = NEW.vehicle_id;

  IF v_vehicle_org IS NULL THEN
    RAISE EXCEPTION 'vehicle_maintenance_windows: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
  END IF;

  IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vehicle_maintenance_windows: organization mismatch (window org %, vehicle org %)', NEW.organization_id, v_vehicle_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vehicle_maintenance_windows_enforce_org_match ON public.vehicle_maintenance_windows;
CREATE TRIGGER trg_vehicle_maintenance_windows_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.vehicle_maintenance_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicle_maintenance_windows_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_vehicle_maintenance_windows_set_updated_at ON public.vehicle_maintenance_windows;
CREATE TRIGGER trg_vehicle_maintenance_windows_set_updated_at
  BEFORE UPDATE ON public.vehicle_maintenance_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS (tenant-only; clients/senders cannot see fleet data)
-------------------------------------------------------------------------------

ALTER TABLE public.vehicle_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_maintenance_windows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vehicle_types FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicle_types FROM anon;
REVOKE ALL ON TABLE public.vehicle_types FROM authenticated;

REVOKE ALL ON TABLE public.vehicles FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicles FROM anon;
REVOKE ALL ON TABLE public.vehicles FROM authenticated;

REVOKE ALL ON TABLE public.vehicle_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicle_assignments FROM anon;
REVOKE ALL ON TABLE public.vehicle_assignments FROM authenticated;

REVOKE ALL ON TABLE public.vehicle_maintenance_windows FROM PUBLIC;
REVOKE ALL ON TABLE public.vehicle_maintenance_windows FROM anon;
REVOKE ALL ON TABLE public.vehicle_maintenance_windows FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_assignments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_maintenance_windows TO authenticated;

GRANT ALL ON TABLE public.vehicle_types TO service_role;
GRANT ALL ON TABLE public.vehicles TO service_role;
GRANT ALL ON TABLE public.vehicle_assignments TO service_role;
GRANT ALL ON TABLE public.vehicle_maintenance_windows TO service_role;

-- service_role full access
DROP POLICY IF EXISTS vehicle_types_service_policy ON public.vehicle_types;
CREATE POLICY vehicle_types_service_policy ON public.vehicle_types
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS vehicles_service_policy ON public.vehicles;
CREATE POLICY vehicles_service_policy ON public.vehicles
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS vehicle_assignments_service_policy ON public.vehicle_assignments;
CREATE POLICY vehicle_assignments_service_policy ON public.vehicle_assignments
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS vehicle_maintenance_windows_service_policy ON public.vehicle_maintenance_windows;
CREATE POLICY vehicle_maintenance_windows_service_policy ON public.vehicle_maintenance_windows
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Authenticated SELECT (tenant-only)
DROP POLICY IF EXISTS vehicle_types_select_policy ON public.vehicle_types;
CREATE POLICY vehicle_types_select_policy ON public.vehicle_types
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicles_select_policy ON public.vehicles;
CREATE POLICY vehicles_select_policy ON public.vehicles
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_assignments_select_policy ON public.vehicle_assignments;
CREATE POLICY vehicle_assignments_select_policy ON public.vehicle_assignments
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_maintenance_windows_select_policy ON public.vehicle_maintenance_windows;
CREATE POLICY vehicle_maintenance_windows_select_policy ON public.vehicle_maintenance_windows
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- Authenticated write (tenant-only via user_can_write)
DROP POLICY IF EXISTS vehicle_types_write_policy ON public.vehicle_types;
CREATE POLICY vehicle_types_write_policy ON public.vehicle_types
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicles_write_policy ON public.vehicles;
CREATE POLICY vehicles_write_policy ON public.vehicles
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_assignments_write_policy ON public.vehicle_assignments;
CREATE POLICY vehicle_assignments_write_policy ON public.vehicle_assignments
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS vehicle_maintenance_windows_write_policy ON public.vehicle_maintenance_windows;
CREATE POLICY vehicle_maintenance_windows_write_policy ON public.vehicle_maintenance_windows
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 4) Table contracts (timestamp + audit SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'vehicle_types', TRUE, TRUE, TRUE, 'Fleet vehicle types (org-scoped).'),
  ('public', 'vehicles', TRUE, TRUE, TRUE, 'Fleet vehicles/assets (org-scoped).'),
  ('public', 'vehicle_assignments', TRUE, TRUE, TRUE, 'Vehicle assignment records (org-scoped).'),
  ('public', 'vehicle_maintenance_windows', TRUE, TRUE, TRUE, 'Vehicle maintenance/downtime windows (org-scoped).')
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601231000_fleet_foundation_v1'));
COMMIT;

