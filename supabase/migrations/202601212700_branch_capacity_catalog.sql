-- Plan: PLAN-202601-branch-capacity-calendars-service-catalog / Step: S04
-- Migration: Branch next-level foundations (service catalog + coverage windows + capacity + calendars + memberships)
-- Date: 2026-01-21
--
-- Goals:
--   - Add canonical service catalog primitives (service_levels + service_offerings).
--   - Add time-bound coverage overrides (branch_coverage_windows) without replacing baseline branch_zones.
--   - Add capacity windows (branch_capacity_windows) and calendar events (calendar_events) as row-driven inputs for promise + dispatch.
--   - Add branch memberships (branch_memberships) to enable branch-scoped operations and reconciliation workflows.
--   - Enforce least-privilege RLS and SSOT governance (table_contracts + audit triggers).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212700_branch_capacity_catalog'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 0) Common guard helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.branch_zone_enforce_org_match_v1()
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
    RAISE EXCEPTION 'branch-zone mapping: branch % not found', NEW.branch_id;
  END IF;

  SELECT z.organization_id
    INTO v_zone_org
    FROM public.zones z
   WHERE z.id = NEW.zone_id;

  IF v_zone_org IS NULL THEN
    RAISE EXCEPTION 'branch-zone mapping: zone % not found', NEW.zone_id;
  END IF;

  IF v_branch_org IS DISTINCT FROM v_zone_org THEN
    RAISE EXCEPTION 'branch-zone mapping: organization mismatch (branch org %, zone org %)', v_branch_org, v_zone_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

-- Rebind baseline branch_zones trigger to the generic helper (reduces redundancy).
DROP TRIGGER IF EXISTS trg_branch_zones_enforce_org_match ON public.branch_zones;
CREATE TRIGGER trg_branch_zones_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.branch_zones
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_zone_enforce_org_match_v1();
-------------------------------------------------------------------------------
-- 1) Service catalog (canonical service_levels + service_offerings)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.service_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT service_levels_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT service_levels_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT service_levels_unique_org_key UNIQUE (organization_id, key)
);

COMMENT ON TABLE public.service_levels
  IS 'Canonical service level catalog per organization (row-driven service offerings).';
COMMENT ON COLUMN public.service_levels.key
  IS 'Stable per-organization service level key (lowercase). Used by promise and dispatch policies.';

CREATE INDEX IF NOT EXISTS idx_service_levels_org_active_key
  ON public.service_levels (organization_id, is_active, key);

DROP TRIGGER IF EXISTS trg_service_levels_set_updated_at ON public.service_levels;
CREATE TRIGGER trg_service_levels_set_updated_at
  BEFORE UPDATE ON public.service_levels
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.service_offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_level_id UUID NOT NULL REFERENCES public.service_levels(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  -- Optional: restrict offering to a single zone (otherwise applies to all zones covered by the branch).
  zone_id UUID REFERENCES public.zones(id) ON DELETE CASCADE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  priority INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT service_offerings_effective_range_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT service_offerings_priority_ck CHECK (priority >= 0)
);

COMMENT ON TABLE public.service_offerings
  IS 'Service availability mapping (service_level ↔ branch[/zone]) with effective windows.';
COMMENT ON COLUMN public.service_offerings.zone_id
  IS 'Optional zone restriction for the offering; NULL means branch-wide offering.';

CREATE INDEX IF NOT EXISTS idx_service_offerings_branch_active
  ON public.service_offerings (branch_id, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_service_offerings_level_active
  ON public.service_offerings (service_level_id, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_service_offerings_zone_active
  ON public.service_offerings (zone_id, is_active, effective_from DESC)
  WHERE zone_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.service_offerings_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_level_org UUID;
  v_zone_org UUID;
BEGIN
  SELECT b.organization_id INTO v_branch_org FROM public.branches b WHERE b.id = NEW.branch_id;
  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'service_offerings: branch % not found', NEW.branch_id;
  END IF;

  SELECT sl.organization_id INTO v_level_org FROM public.service_levels sl WHERE sl.id = NEW.service_level_id;
  IF v_level_org IS NULL THEN
    RAISE EXCEPTION 'service_offerings: service_level % not found', NEW.service_level_id;
  END IF;

  IF v_branch_org IS DISTINCT FROM v_level_org THEN
    RAISE EXCEPTION 'service_offerings: organization mismatch (branch org %, service_level org %)', v_branch_org, v_level_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    SELECT z.organization_id INTO v_zone_org FROM public.zones z WHERE z.id = NEW.zone_id;
    IF v_zone_org IS NULL THEN
      RAISE EXCEPTION 'service_offerings: zone % not found', NEW.zone_id;
    END IF;
    IF v_branch_org IS DISTINCT FROM v_zone_org THEN
      RAISE EXCEPTION 'service_offerings: organization mismatch (branch org %, zone org %)', v_branch_org, v_zone_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_service_offerings_enforce_org_match ON public.service_offerings;
CREATE TRIGGER trg_service_offerings_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.service_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.service_offerings_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_service_offerings_set_updated_at ON public.service_offerings;
CREATE TRIGGER trg_service_offerings_set_updated_at
  BEFORE UPDATE ON public.service_offerings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
-------------------------------------------------------------------------------
-- 2) Coverage overrides: branch_coverage_windows (time-bound branch↔zone mapping)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branch_coverage_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  zone_id UUID NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  priority INT NOT NULL DEFAULT 0,
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT branch_coverage_windows_effective_range_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT branch_coverage_windows_priority_ck CHECK (priority >= 0)
);

COMMENT ON TABLE public.branch_coverage_windows
  IS 'Time-bound coverage overrides for zones (branch ↔ zone). Baseline remains branch_zones.';
COMMENT ON COLUMN public.branch_coverage_windows.reason
  IS 'Human-readable rationale for the override (temporary coverage, peak load, outage, etc.).';

CREATE INDEX IF NOT EXISTS idx_branch_coverage_windows_zone_active
  ON public.branch_coverage_windows (zone_id, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_branch_coverage_windows_branch_active
  ON public.branch_coverage_windows (branch_id, is_active, effective_from DESC);

DROP TRIGGER IF EXISTS trg_branch_coverage_windows_enforce_org_match ON public.branch_coverage_windows;
CREATE TRIGGER trg_branch_coverage_windows_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.branch_coverage_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_zone_enforce_org_match_v1();

CREATE OR REPLACE FUNCTION public.branch_coverage_windows_enforce_no_overlap_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_existing UUID;
  v_new_range tstzrange;
BEGIN
  IF COALESCE(NEW.is_active, TRUE) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  v_new_range := tstzrange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::timestamptz), '[)');

  SELECT bcw.id
    INTO v_existing
    FROM public.branch_coverage_windows bcw
   WHERE bcw.zone_id = NEW.zone_id
     AND bcw.is_active IS TRUE
     AND bcw.id IS DISTINCT FROM NEW.id
     AND tstzrange(bcw.effective_from, COALESCE(bcw.effective_to, 'infinity'::timestamptz), '[)') && v_new_range
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'branch_coverage_windows: overlapping active window for zone % (existing %)', NEW.zone_id, v_existing
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_coverage_windows_no_overlap ON public.branch_coverage_windows;
CREATE TRIGGER trg_branch_coverage_windows_no_overlap
  BEFORE INSERT OR UPDATE ON public.branch_coverage_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_coverage_windows_enforce_no_overlap_v1();

DROP TRIGGER IF EXISTS trg_branch_coverage_windows_set_updated_at ON public.branch_coverage_windows;
CREATE TRIGGER trg_branch_coverage_windows_set_updated_at
  BEFORE UPDATE ON public.branch_coverage_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.resolve_branch_id_for_zone_at(
  p_zone_id UUID,
  p_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE sql
STABLE
AS $function$
  WITH win AS (
    SELECT bcw.branch_id
    FROM public.branch_coverage_windows bcw
    WHERE bcw.zone_id = p_zone_id
      AND bcw.is_active IS TRUE
      AND bcw.effective_from <= p_at
      AND (bcw.effective_to IS NULL OR bcw.effective_to > p_at)
    ORDER BY bcw.priority DESC, bcw.effective_from DESC, bcw.created_at DESC
    LIMIT 1
  ),
  base AS (
    SELECT bz.branch_id
    FROM public.branch_zones bz
    WHERE bz.zone_id = p_zone_id
    LIMIT 1
  )
  SELECT COALESCE((SELECT branch_id FROM win), (SELECT branch_id FROM base));
$function$;

COMMENT ON FUNCTION public.resolve_branch_id_for_zone_at(UUID, TIMESTAMPTZ)
  IS 'Resolve branch_id for a zone at a timestamp: prefer active branch_coverage_windows, fallback to baseline branch_zones.';
-------------------------------------------------------------------------------
-- 3) Capacity windows (row-driven; consumed by promise + dispatch)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branch_capacity_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES public.zones(id) ON DELETE CASCADE,
  service_level_id UUID REFERENCES public.service_levels(id) ON DELETE CASCADE,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  day_of_week SMALLINT,
  window_start_local TIME,
  window_end_local TIME,
  priority INT NOT NULL DEFAULT 0,
  capacity JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT branch_capacity_windows_effective_range_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT branch_capacity_windows_dow_ck CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
  CONSTRAINT branch_capacity_windows_time_pair_ck CHECK (
    (window_start_local IS NULL AND window_end_local IS NULL)
    OR (window_start_local IS NOT NULL AND window_end_local IS NOT NULL AND window_end_local > window_start_local)
  ),
  CONSTRAINT branch_capacity_windows_priority_ck CHECK (priority >= 0)
);

COMMENT ON TABLE public.branch_capacity_windows
  IS 'Branch capacity windows (row-driven). Used by promise and dispatch to accept/reject/shift work.';
COMMENT ON COLUMN public.branch_capacity_windows.capacity
  IS 'Capacity payload (JSONB) e.g. {\"max_stops\": 120, \"max_cod_shipments\": 20, \"max_volume_m3\": 3.0}. Interpretation is policy/workflow-defined.';

CREATE INDEX IF NOT EXISTS idx_branch_capacity_windows_branch_active
  ON public.branch_capacity_windows (branch_id, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_branch_capacity_windows_zone_active
  ON public.branch_capacity_windows (zone_id, is_active, effective_from DESC)
  WHERE zone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_branch_capacity_windows_level_active
  ON public.branch_capacity_windows (service_level_id, is_active, effective_from DESC)
  WHERE service_level_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.branch_capacity_windows_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_zone_org UUID;
  v_level_org UUID;
BEGIN
  SELECT b.organization_id INTO v_branch_org FROM public.branches b WHERE b.id = NEW.branch_id;
  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'branch_capacity_windows: branch % not found', NEW.branch_id;
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    SELECT z.organization_id INTO v_zone_org FROM public.zones z WHERE z.id = NEW.zone_id;
    IF v_zone_org IS NULL THEN
      RAISE EXCEPTION 'branch_capacity_windows: zone % not found', NEW.zone_id;
    END IF;
    IF v_branch_org IS DISTINCT FROM v_zone_org THEN
      RAISE EXCEPTION 'branch_capacity_windows: organization mismatch (branch org %, zone org %)', v_branch_org, v_zone_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.service_level_id IS NOT NULL THEN
    SELECT sl.organization_id INTO v_level_org FROM public.service_levels sl WHERE sl.id = NEW.service_level_id;
    IF v_level_org IS NULL THEN
      RAISE EXCEPTION 'branch_capacity_windows: service_level % not found', NEW.service_level_id;
    END IF;
    IF v_branch_org IS DISTINCT FROM v_level_org THEN
      RAISE EXCEPTION 'branch_capacity_windows: organization mismatch (branch org %, service_level org %)', v_branch_org, v_level_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_capacity_windows_enforce_org_match ON public.branch_capacity_windows;
CREATE TRIGGER trg_branch_capacity_windows_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.branch_capacity_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_capacity_windows_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_branch_capacity_windows_set_updated_at ON public.branch_capacity_windows;
CREATE TRIGGER trg_branch_capacity_windows_set_updated_at
  BEFORE UPDATE ON public.branch_capacity_windows
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
-------------------------------------------------------------------------------
-- 4) Calendar events (closures/holidays/blackouts)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE,
  zone_id UUID REFERENCES public.zones(id) ON DELETE CASCADE,
  city_id UUID REFERENCES public.canonical_cities(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT,
  reason TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT calendar_events_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT calendar_events_range_ck CHECK (ends_at > starts_at)
);

COMMENT ON TABLE public.calendar_events
  IS 'Calendar events for promise/dispatch (holidays, closures, blackouts). Org-scoped with optional branch/zone/city constraints.';

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_active_starts
  ON public.calendar_events (organization_id, is_active, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_branch_active_starts
  ON public.calendar_events (branch_id, is_active, starts_at DESC)
  WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_zone_active_starts
  ON public.calendar_events (zone_id, is_active, starts_at DESC)
  WHERE zone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_city_active_starts
  ON public.calendar_events (city_id, is_active, starts_at DESC)
  WHERE city_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.calendar_events_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_zone_org UUID;
  v_city_org UUID;
BEGIN
  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org FROM public.branches b WHERE b.id = NEW.branch_id;
    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'calendar_events: branch % not found', NEW.branch_id;
    END IF;
    IF NEW.organization_id IS DISTINCT FROM v_branch_org THEN
      RAISE EXCEPTION 'calendar_events: organization mismatch (event org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.zone_id IS NOT NULL THEN
    SELECT z.organization_id INTO v_zone_org FROM public.zones z WHERE z.id = NEW.zone_id;
    IF v_zone_org IS NULL THEN
      RAISE EXCEPTION 'calendar_events: zone % not found', NEW.zone_id;
    END IF;
    IF NEW.organization_id IS DISTINCT FROM v_zone_org THEN
      RAISE EXCEPTION 'calendar_events: organization mismatch (event org %, zone org %)', NEW.organization_id, v_zone_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.city_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_city_org FROM public.canonical_cities c WHERE c.id = NEW.city_id;
    IF v_city_org IS NULL THEN
      RAISE EXCEPTION 'calendar_events: city % not found', NEW.city_id;
    END IF;
    IF NEW.organization_id IS DISTINCT FROM v_city_org THEN
      RAISE EXCEPTION 'calendar_events: organization mismatch (event org %, city org %)', NEW.organization_id, v_city_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_calendar_events_enforce_org_match ON public.calendar_events;
CREATE TRIGGER trg_calendar_events_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.calendar_events_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_calendar_events_set_updated_at ON public.calendar_events;
CREATE TRIGGER trg_calendar_events_set_updated_at
  BEFORE UPDATE ON public.calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
-------------------------------------------------------------------------------
-- 5) Branch memberships (branch-scoped roles)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.branch_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT branch_memberships_role_ck CHECK (btrim(role_key) <> '' AND role_key = lower(role_key)),
  CONSTRAINT branch_memberships_effective_range_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT branch_memberships_unique_active UNIQUE (branch_id, user_id, role_key, effective_from)
);

COMMENT ON TABLE public.branch_memberships
  IS 'User↔branch memberships with role keys (branch manager/cashier/ops). Used for branch-scoped operations and reconciliation.';

CREATE INDEX IF NOT EXISTS idx_branch_memberships_branch_active
  ON public.branch_memberships (branch_id, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_branch_memberships_user_active
  ON public.branch_memberships (user_id, is_active, effective_from DESC);

CREATE OR REPLACE FUNCTION public.branch_memberships_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_user_org UUID;
BEGIN
  SELECT b.organization_id INTO v_branch_org FROM public.branches b WHERE b.id = NEW.branch_id;
  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'branch_memberships: branch % not found', NEW.branch_id;
  END IF;

  SELECT u.organization_id INTO v_user_org FROM public.users u WHERE u.id = NEW.user_id;
  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'branch_memberships: user % not found', NEW.user_id;
  END IF;

  IF v_branch_org IS DISTINCT FROM v_user_org THEN
    RAISE EXCEPTION 'branch_memberships: organization mismatch (branch org %, user org %)', v_branch_org, v_user_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_memberships_enforce_org_match ON public.branch_memberships;
CREATE TRIGGER trg_branch_memberships_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.branch_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.branch_memberships_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_branch_memberships_set_updated_at ON public.branch_memberships;
CREATE TRIGGER trg_branch_memberships_set_updated_at
  BEFORE UPDATE ON public.branch_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
-------------------------------------------------------------------------------
-- 6) RLS (user-facing configuration tables)
-------------------------------------------------------------------------------

ALTER TABLE public.service_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_coverage_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_capacity_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_memberships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.service_levels FROM PUBLIC;
REVOKE ALL ON TABLE public.service_levels FROM anon;
REVOKE ALL ON TABLE public.service_levels FROM authenticated;

REVOKE ALL ON TABLE public.service_offerings FROM PUBLIC;
REVOKE ALL ON TABLE public.service_offerings FROM anon;
REVOKE ALL ON TABLE public.service_offerings FROM authenticated;

REVOKE ALL ON TABLE public.branch_coverage_windows FROM PUBLIC;
REVOKE ALL ON TABLE public.branch_coverage_windows FROM anon;
REVOKE ALL ON TABLE public.branch_coverage_windows FROM authenticated;

REVOKE ALL ON TABLE public.branch_capacity_windows FROM PUBLIC;
REVOKE ALL ON TABLE public.branch_capacity_windows FROM anon;
REVOKE ALL ON TABLE public.branch_capacity_windows FROM authenticated;

REVOKE ALL ON TABLE public.calendar_events FROM PUBLIC;
REVOKE ALL ON TABLE public.calendar_events FROM anon;
REVOKE ALL ON TABLE public.calendar_events FROM authenticated;

REVOKE ALL ON TABLE public.branch_memberships FROM PUBLIC;
REVOKE ALL ON TABLE public.branch_memberships FROM anon;
REVOKE ALL ON TABLE public.branch_memberships FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_levels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_offerings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.branch_coverage_windows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.branch_capacity_windows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.branch_memberships TO authenticated;

GRANT ALL ON TABLE public.service_levels TO service_role;
GRANT ALL ON TABLE public.service_offerings TO service_role;
GRANT ALL ON TABLE public.branch_coverage_windows TO service_role;
GRANT ALL ON TABLE public.branch_capacity_windows TO service_role;
GRANT ALL ON TABLE public.calendar_events TO service_role;
GRANT ALL ON TABLE public.branch_memberships TO service_role;

-- service_role full access
DROP POLICY IF EXISTS service_levels_service_policy ON public.service_levels;
CREATE POLICY service_levels_service_policy ON public.service_levels
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS service_offerings_service_policy ON public.service_offerings;
CREATE POLICY service_offerings_service_policy ON public.service_offerings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS branch_coverage_windows_service_policy ON public.branch_coverage_windows;
CREATE POLICY branch_coverage_windows_service_policy ON public.branch_coverage_windows
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS branch_capacity_windows_service_policy ON public.branch_capacity_windows;
CREATE POLICY branch_capacity_windows_service_policy ON public.branch_capacity_windows
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS calendar_events_service_policy ON public.calendar_events;
CREATE POLICY calendar_events_service_policy ON public.calendar_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS branch_memberships_service_policy ON public.branch_memberships;
CREATE POLICY branch_memberships_service_policy ON public.branch_memberships
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Authenticated read (org-scoped)
DROP POLICY IF EXISTS service_levels_select_policy ON public.service_levels;
CREATE POLICY service_levels_select_policy ON public.service_levels
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS service_offerings_select_policy ON public.service_offerings;
CREATE POLICY service_offerings_select_policy ON public.service_offerings
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.branches b
      WHERE b.id = branch_id
        AND b.organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS branch_coverage_windows_select_policy ON public.branch_coverage_windows;
CREATE POLICY branch_coverage_windows_select_policy ON public.branch_coverage_windows
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.branches b
      WHERE b.id = branch_id
        AND b.organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS branch_capacity_windows_select_policy ON public.branch_capacity_windows;
CREATE POLICY branch_capacity_windows_select_policy ON public.branch_capacity_windows
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.branches b
      WHERE b.id = branch_id
        AND b.organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS calendar_events_select_policy ON public.calendar_events;
CREATE POLICY calendar_events_select_policy ON public.calendar_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

DROP POLICY IF EXISTS branch_memberships_select_policy ON public.branch_memberships;
CREATE POLICY branch_memberships_select_policy ON public.branch_memberships
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR EXISTS (
      SELECT 1
      FROM public.branches b
      WHERE b.id = branch_id
        AND b.organization_id = public.current_user_org_id()
    )
  );

-- Authenticated write (org-scoped, least-privilege)
DROP POLICY IF EXISTS service_levels_write_policy ON public.service_levels;
CREATE POLICY service_levels_write_policy ON public.service_levels
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

DROP POLICY IF EXISTS service_offerings_write_policy ON public.service_offerings;
CREATE POLICY service_offerings_write_policy ON public.service_offerings
  FOR ALL
  TO authenticated
  USING (
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

DROP POLICY IF EXISTS branch_coverage_windows_write_policy ON public.branch_coverage_windows;
CREATE POLICY branch_coverage_windows_write_policy ON public.branch_coverage_windows
  FOR ALL
  TO authenticated
  USING (
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

DROP POLICY IF EXISTS branch_capacity_windows_write_policy ON public.branch_capacity_windows;
CREATE POLICY branch_capacity_windows_write_policy ON public.branch_capacity_windows
  FOR ALL
  TO authenticated
  USING (
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

DROP POLICY IF EXISTS calendar_events_write_policy ON public.calendar_events;
CREATE POLICY calendar_events_write_policy ON public.calendar_events
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

DROP POLICY IF EXISTS branch_memberships_write_policy ON public.branch_memberships;
CREATE POLICY branch_memberships_write_policy ON public.branch_memberships
  FOR ALL
  TO authenticated
  USING (
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
-- 7) Branch resolver (prefer time-bound coverage windows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_branch_id_for_zone(
  p_zone_id UUID
)
RETURNS UUID
LANGUAGE sql
VOLATILE
AS $function$
  SELECT public.resolve_branch_id_for_zone_at(p_zone_id, public.workflow_now());
$function$;

COMMENT ON FUNCTION public.resolve_branch_id_for_zone(UUID)
  IS 'Resolve branch_id for a zone: prefer active branch_coverage_windows, fallback to baseline branch_zones (uses workflow_now for deterministic workflows).';
-------------------------------------------------------------------------------
-- 8) Register contracts + enforce timestamps/audit (SSOT)
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
  ('public', 'service_levels', TRUE, NULL, TRUE, NULL, TRUE, 'Service level catalog per organization.'),
  ('public', 'service_offerings', TRUE, NULL, TRUE, NULL, TRUE, 'Service offerings per branch[/zone] with effective windows.'),
  ('public', 'branch_coverage_windows', TRUE, NULL, TRUE, NULL, TRUE, 'Coverage overrides for zones with effective windows.'),
  ('public', 'branch_capacity_windows', TRUE, NULL, TRUE, NULL, TRUE, 'Capacity windows for promise/dispatch inputs.'),
  ('public', 'calendar_events', TRUE, NULL, TRUE, NULL, TRUE, 'Calendar events (closures/holidays/blackouts).'),
  ('public', 'branch_memberships', TRUE, NULL, TRUE, NULL, TRUE, 'Branch-scoped user memberships/roles.')
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601212700_branch_capacity_catalog'));
COMMIT;
