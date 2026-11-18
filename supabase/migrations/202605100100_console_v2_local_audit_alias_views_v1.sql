-- Console V2 live-audit support: thin alias views + api wrapper required by
-- the local-runtime first-tenant audit so the FE registry-driven reads land
-- on the canonical tables that exist with slightly different names.
--
-- These are additive aliases. Production runs that already have the canonical
-- relations get a CREATE OR REPLACE no-op; environments that only have the
-- foundational tables (driver_profiles + settings_row_from_policy_context_v1
-- without an api wrapper) get a complete read path.
--
-- Why this exists
-- ---------------
-- Live Chrome audit of /operate/fleet/drivers found two gaps in the local
-- backend:
--
-- 1. The `public.drivers` relation referenced by the registry (and a few
--    legacy SELECT paths) does not exist as a base table here. The
--    canonical equivalent is `public.driver_profiles` joined with
--    `public.users` for the operator-friendly columns (name/email).
--    Create a security-invoker view `public.drivers` projecting that join
--    so any caller doing `FROM public.drivers` (registry-driven reads,
--    legacy code) lands on the canonical data.
--
-- 2. `useResolveSettings(...)` calls
--    `api.resolve_settings_row_from_policy_context_v1(p_category, p_context)`
--    via PostgREST but only the `public.` variant exists. PostgREST
--    refuses to expose `public.` functions through the api schema unless
--    there is an explicit api wrapper. Without it the fleet/drivers page
--    falls back to "Driver KPI thresholds are not configured" because
--    the policy resolution silently returns empty. Add the api wrapper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605100100_console_v2_local_audit_alias_views_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- (1) `public.drivers` alias view over driver_profiles.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'drivers'
  ) THEN
    EXECUTE $sql$
      CREATE OR REPLACE VIEW public.drivers AS
      SELECT
        dp.id,
        dp.organization_id,
        dp.user_id,
        dp.driver_code,
        dp.status,
        dp.hired_at,
        dp.terminated_at,
        dp.metadata,
        dp.created_at,
        dp.updated_at,
        u.full_name AS name,
        u.email
      FROM public.driver_profiles dp
      LEFT JOIN public.users u ON u.id = dp.user_id
    $sql$;
    EXECUTE 'ALTER VIEW public.drivers SET (security_invoker = true)';
    EXECUTE 'GRANT SELECT ON public.drivers TO authenticated, service_role';
  END IF;
END $$;

-- (2) `api.resolve_settings_row_from_policy_context_v1` wrapper.
CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_settings_row_from_policy_context_v1(
  p_category text,
  p_context jsonb
)
RETURNS TABLE (
  settings_id uuid,
  settings_version_id uuid,
  scope_type text,
  scope_id uuid,
  value jsonb,
  version integer,
  scope_path jsonb
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.resolve_settings_row_from_policy_context_v1(p_category, p_context)
$function$;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.resolve_settings_row_from_policy_context_v1(text, jsonb) IS
  'Browser-safe api schema wrapper for public.resolve_settings_row_from_policy_context_v1, used by the FE useResolveSettings() hook.';

-- (3) `public.v_vehicle_directory` minimal alias for environments where the
-- canonical view's dependencies (vehicle_maintenance_windows.status etc.)
-- have not been backfilled yet. Projects all the FE-required columns as
-- nullable defaults so the Vehicles roster page can render against just the
-- base `public.vehicles` table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'v_vehicle_directory' AND c.relkind = 'v'
  ) THEN
    EXECUTE $sql$
      CREATE OR REPLACE VIEW public.v_vehicle_directory AS
      SELECT
        v.id,
        v.organization_id,
        v.plate_number,
        v.vehicle_type_id,
        v.status,
        v.created_at,
        v.updated_at,
        NULL::text       AS branch_label,
        NULL::uuid       AS active_assignment_id,
        NULL::uuid       AS active_driver_id,
        NULL::text       AS vehicle_type_label,
        NULL::text       AS current_driver_label,
        NULL::uuid       AS active_assignment_branch_id,
        NULL::timestamptz AS active_assignment_started_at,
        NULL::integer    AS assignment_age_seconds,
        NULL::timestamptz AS last_event_at,
        0::integer       AS event_count_24h
      FROM public.vehicles v
    $sql$;
    EXECUTE 'ALTER VIEW public.v_vehicle_directory SET (security_invoker = true)';
    EXECUTE 'GRANT SELECT ON public.v_vehicle_directory TO authenticated, service_role';
  END IF;
END $$;

-- (4) `public.hubs` alias view over `public.branches` for FE registry-driven
-- reads that target the legacy `hubs` resource key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'hubs'
  ) THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.hubs AS SELECT * FROM public.branches';
    EXECUTE 'ALTER VIEW public.hubs SET (security_invoker = true)';
    EXECUTE 'GRANT SELECT ON public.hubs TO authenticated, service_role';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605100100_console_v2_local_audit_alias_views_v1'));
COMMIT;
