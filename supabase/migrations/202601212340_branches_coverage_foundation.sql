-- Plan: PLAN-202601-branches-coverage-foundation / Step: S04
-- Migration: Branches + coverage foundation (schema + RLS + contracts)
-- Date: 2026-01-21
--
-- Goals:
--   - Introduce org-scoped branches (depots/hubs/warehouses) as first-class rows.
--   - Model coverage by mapping branches to existing zones (no duplicated geography).
--   - Enforce least-privilege RLS (read for in-org users; write only for tenant/platform writers).
--   - Register in table_contracts for timestamp/audit enforcement (SSOT governance).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601212340_branches_coverage_foundation'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Branches (org-scoped)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  branch_type TEXT,
  timezone TEXT,
  operating_hours JSONB,
  address JSONB,
  coordinates geography(POINT, 4326),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT branches_code_ck CHECK (btrim(code) <> '' AND code = lower(code)),
  CONSTRAINT branches_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT branches_unique_org_code UNIQUE (organization_id, code)
);

COMMENT ON TABLE public.branches
  IS 'Org-scoped branches/depots/hubs/warehouses (row-driven operational units).';
COMMENT ON COLUMN public.branches.code
  IS 'Stable per-organization branch code (lowercase).';
COMMENT ON COLUMN public.branches.operating_hours
  IS 'Row-driven operating hours (JSONB); interpretation is policy/workflow defined.';
COMMENT ON COLUMN public.branches.address
  IS 'Branch address payload (JSONB). Stored separately from client-partitioned addresses.';
COMMENT ON COLUMN public.branches.coordinates
  IS 'Optional branch geolocation point (PostGIS geography).';

CREATE INDEX IF NOT EXISTS idx_branches_org_active_code
  ON public.branches (organization_id, is_active, code);
CREATE INDEX IF NOT EXISTS idx_branches_org_name
  ON public.branches (organization_id, name);

DROP TRIGGER IF EXISTS trg_branches_set_updated_at ON public.branches;
CREATE TRIGGER trg_branches_set_updated_at
  BEFORE UPDATE ON public.branches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Coverage mapping: branch_zones (org-scoped)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branch_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  zone_id UUID NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  priority INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT branch_zones_unique_zone UNIQUE (zone_id),
  CONSTRAINT branch_zones_priority_ck CHECK (priority IS NULL OR priority >= 0)
);

COMMENT ON TABLE public.branch_zones
  IS 'Row-driven branch coverage: maps each zone to one branch (baseline).';
COMMENT ON COLUMN public.branch_zones.priority
  IS 'Optional precedence for branch selection when multiple mappings are supported in future.';

CREATE INDEX IF NOT EXISTS idx_branch_zones_branch
  ON public.branch_zones (branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_zones_zone
  ON public.branch_zones (zone_id);

CREATE OR REPLACE FUNCTION public.branch_zones_enforce_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_zone_org UUID;
BEGIN
  SELECT b.organization_id
    INTO v_branch_org
    FROM public.branches b
   WHERE b.id = NEW.branch_id;

  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'branch_zones: branch % not found', NEW.branch_id;
  END IF;

  SELECT z.organization_id
    INTO v_zone_org
    FROM public.zones z
   WHERE z.id = NEW.zone_id;

  IF v_zone_org IS NULL THEN
    RAISE EXCEPTION 'branch_zones: zone % not found', NEW.zone_id;
  END IF;

  IF v_branch_org IS DISTINCT FROM v_zone_org THEN
    RAISE EXCEPTION 'branch_zones: organization mismatch (branch org %, zone org %)', v_branch_org, v_zone_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_zones_enforce_org_match ON public.branch_zones;
CREATE TRIGGER trg_branch_zones_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.branch_zones
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_zones_enforce_org_match();

CREATE OR REPLACE FUNCTION public.resolve_branch_id_for_zone(
  p_zone_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
AS $function$
  SELECT bz.branch_id
  FROM public.branch_zones bz
  WHERE bz.zone_id = p_zone_id
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.resolve_branch_id_for_zone(UUID)
  IS 'Resolve branch_id for a zone using branch_zones mapping (returns NULL when unmapped).';

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants (user-facing)
-------------------------------------------------------------------------------

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_zones ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.branches FROM PUBLIC;
REVOKE ALL ON TABLE public.branches FROM anon;
REVOKE ALL ON TABLE public.branches FROM authenticated;

REVOKE ALL ON TABLE public.branch_zones FROM PUBLIC;
REVOKE ALL ON TABLE public.branch_zones FROM anon;
REVOKE ALL ON TABLE public.branch_zones FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.branches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.branch_zones TO authenticated;

GRANT ALL ON TABLE public.branches TO service_role;
GRANT ALL ON TABLE public.branch_zones TO service_role;

DROP POLICY IF EXISTS branches_service_policy ON public.branches;
CREATE POLICY branches_service_policy ON public.branches
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS branches_select_policy ON public.branches;
CREATE POLICY branches_select_policy ON public.branches
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS branches_write_policy ON public.branches;
CREATE POLICY branches_write_policy ON public.branches
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

DROP POLICY IF EXISTS branch_zones_service_policy ON public.branch_zones;
CREATE POLICY branch_zones_service_policy ON public.branch_zones
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS branch_zones_select_policy ON public.branch_zones;
CREATE POLICY branch_zones_select_policy ON public.branch_zones
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.branches b
      WHERE b.id = public.branch_zones.branch_id
        AND b.organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS branch_zones_write_policy ON public.branch_zones;
CREATE POLICY branch_zones_write_policy ON public.branch_zones
  FOR ALL
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.id = public.branch_zones.branch_id
          AND b.organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.branches b
        WHERE b.id = branch_id
          AND b.organization_id = public.current_user_org_id()
      )
    )
  );

-------------------------------------------------------------------------------
-- 4) Register contracts + enforce timestamps/audit (SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  created_at_source_column,
  updated_at_required,
  updated_at_source_column,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'branches',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Org-scoped branches/depots/hubs.'
  ),
  (
    'public',
    'branch_zones',
    TRUE,
    NULL,
    TRUE,
    NULL,
    TRUE,
    'Branch coverage mapping to zones.'
  )
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601212340_branches_coverage_foundation'));
COMMIT;

