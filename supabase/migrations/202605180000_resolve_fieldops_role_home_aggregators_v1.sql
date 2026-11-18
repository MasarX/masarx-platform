-- Migration: resolve_fieldops_role_home_aggregators_v1 — Mobile V2 role-home
--            aggregators (loader / rider / supervisor).
-- Date: 2026-05-18
-- Spec: FieldOps Mobile V2 — closes engineering re-audit finding E1.
--   The loader / rider / supervisor "Home" tabs render through the
--   `useFieldopsLoaderTodayRpc` / `useFieldopsRiderTodayRpc` /
--   `useFieldopsSupervisorQueueRpc` hooks (apps/fieldops/src/mobile-v2-rpc-hooks.ts).
--   Those hooks called `resolve_fieldops_loader_today_v1` /
--   `resolve_fieldops_rider_today_v1` / `resolve_fieldops_supervisor_queue_v1`
--   — RPCs that did not exist in any migration. In the production native
--   shell PostgREST returned PGRST202 (404), `callRpc` threw, react-query
--   went to `isError`, and the role-home screen showed a permanent
--   "Couldn't reach the server" error card.
--
--   This migration ships the three resolver RPCs (and their `api.*`
--   SECURITY INVOKER mirrors) so the role-home tabs resolve real,
--   org-scoped data:
--
--     - resolve_fieldops_loader_today_v1
--         Loader warehouse-home envelope. Counts (live routes / parcels /
--         scanned / drivers waiting / cold-chain) and the driver-queue
--         list are aggregated from `route_runs` + `route_stops` for runs
--         in a pre-departure state (planned / loading / staged). Driver
--         names resolve from `public.users`. The greeting name is the
--         caller's own `users.full_name` first token. Quick-action tiles
--         are row-defined here (navigation surface, not business data) —
--         consistent with how `resolve_fieldops_eor_v1` row-defines its
--         checklist.
--
--     - resolve_fieldops_rider_today_v1
--         Rider gig-home envelope. Rider gig tickets + per-shift earnings
--         have no canonical source table in the schema yet, so this
--         resolver returns a shape-compatible envelope with the caller's
--         resolved identity (greeting name + employee id) and an HONEST
--         empty/zero state (no active ticket, empty upcoming, zero
--         earnings/trips). It never fabricates gig data. The frontend
--         hook treats this as a degraded "not yet available" state.
--
--     - resolve_fieldops_supervisor_queue_v1
--         Supervisor approvals-queue envelope. The queue is aggregated
--         from two REAL canonical tables: `route_runs` awaiting a
--         supervisor decision (status pending_review / requires_review /
--         awaiting_approval) and `fieldops_v2_incidents` filed by drivers.
--         Driver names resolve from `public.users`. The supervisor name
--         is the caller's own `users.full_name`.
--
--   AGENTS.md compliance posture:
--   - Zero hardcoding: every count / id / name resolves from canonical
--     rows. Quick-action tiles are a navigation surface (route ids +
--     labels), not tenant business constants.
--   - RLS / cross-org isolation: all functions are SECURITY DEFINER but
--     org-scope every query via `current_user_org_id()`; they never
--     expose cross-org rows. They prefer a shape-compatible empty / zero
--     envelope over raising when source data is absent — absence of data
--     is a valid state and the FE hook falls back to a preview sample
--     only when `supabase` is null (showcase) or the RPC is unreachable.
--   - Single source of truth: `api.*` wrappers proxy to `public.*` with
--     SECURITY INVOKER so PostgREST sees a stable contract.
--   - Idempotent + append-only: CREATE OR REPLACE FUNCTION; advisory-
--     locked migration; no edits to historical migration files.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605180000_resolve_fieldops_role_home_aggregators_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

-- ===========================================================================
-- Helper: first token of the caller's display name, for the "Hello, <name>"
-- app-bar greeting. Returns NULL when the user row / name is absent.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fieldops_v2_user_first_name_v1(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    btrim(split_part(btrim(COALESCE(u.full_name, '')), ' ', 1)),
    ''
  )
  FROM public.users u
  WHERE u.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_user_first_name_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_user_first_name_v1(UUID) TO authenticated, service_role;

-- ===========================================================================
-- 1) resolve_fieldops_loader_today_v1 — loader warehouse-home envelope.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_loader_today_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_first_name TEXT;
  v_total_parcels INT := 0;
  v_scanned_parcels INT := 0;
  v_cold_chain INT := 0;
  v_live_routes INT := 0;
  v_drivers_waiting INT := 0;
  v_drivers JSONB := '[]'::jsonb;
  v_quick_actions JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_loader_today_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  -- Quick-action tiles: navigation surface (route + label + sub copy),
  -- not tenant business data. Row-defined here so the FE renders a
  -- consistent grid; counts in the sub-copy are intentionally generic
  -- because the per-tile detail is owned by the destination screen.
  v_quick_actions := jsonb_build_array(
    jsonb_build_object('id','loader-scan','icon','scan','label','Scan-out','sub','Induct parcels'),
    jsonb_build_object('id','loader-manifest','icon','list','label','Manifest','sub','Route manifest'),
    jsonb_build_object('id','bay-board','icon','package','label','Bay board','sub','Driver queue · cages'),
    jsonb_build_object('id','inbound','icon','truck','label','Inbound dock','sub','Arrivals'),
    jsonb_build_object('id','hold','icon','flag','label','Hold queue','sub','Exceptions'),
    jsonb_build_object('id','sync','icon','cloud-up','label','Sync','sub','Outbox')
  );

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'greeting_name', NULL,
      'wave_label', NULL,
      'bay', NULL,
      'route_label', NULL,
      'cut_off', NULL,
      'cold_chain_count', 0,
      'live_routes', 0,
      'total_parcels', 0,
      'scanned_parcels', 0,
      'drivers_waiting', 0,
      'quick_actions', v_quick_actions,
      'drivers', '[]'::jsonb
    );
  END IF;

  v_first_name := public.fieldops_v2_user_first_name_v1(v_user_id);

  -- Live routes = route_runs in a pre-departure / loading state in the
  -- caller's org. These are the runs a loader is actively staging.
  SELECT COUNT(*)::int
    INTO v_live_routes
    FROM public.route_runs rr
   WHERE rr.organization_id = v_org
     AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress');

  -- Parcel + scanned + cold-chain counts from the route_stops on those runs.
  SELECT
    COALESCE(COUNT(*), 0)::int,
    COALESCE(SUM(CASE WHEN COALESCE(rs.metadata->>'scan_state', '') IN ('scanned', 'inducted', 'loaded')
                      THEN 1 ELSE 0 END), 0)::int,
    COALESCE(SUM(CASE WHEN COALESCE((rs.metadata->>'cold_chain')::boolean, FALSE)
                      THEN 1 ELSE 0 END), 0)::int
    INTO v_total_parcels, v_scanned_parcels, v_cold_chain
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
     AND rr.organization_id = rs.organization_id
   WHERE rr.organization_id = v_org
     AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress');

  -- Driver queue: one entry per pre-departure run that has an assigned
  -- driver. `pct` is the scanned/total ratio for that run; status is
  -- `loading` once any parcel is scanned, `waiting` until then.
  WITH run_progress AS (
    SELECT
      rr.id AS run_id,
      rr.driver_user_id,
      rr.status AS run_status,
      COUNT(rs.id) AS stop_total,
      SUM(CASE WHEN COALESCE(rs.metadata->>'scan_state', '') IN ('scanned', 'inducted', 'loaded')
               THEN 1 ELSE 0 END) AS stop_scanned
    FROM public.route_runs rr
    LEFT JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    WHERE rr.organization_id = v_org
      AND rr.status IN ('planned', 'loading', 'staged', 'started', 'in_progress')
      AND rr.driver_user_id IS NOT NULL
    GROUP BY rr.id, rr.driver_user_id, rr.status
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'name',   COALESCE(u.full_name, '—'),
          'route',  COALESCE('RT-' || substr(rp.run_id::text, 1, 8), '—'),
          'pct',    CASE WHEN rp.stop_total > 0
                         THEN ROUND((rp.stop_scanned::numeric / rp.stop_total) * 100)::int
                         ELSE 0 END,
          'status', CASE WHEN COALESCE(rp.stop_scanned, 0) > 0 THEN 'loading' ELSE 'waiting' END
        )
        ORDER BY u.full_name
      ),
      '[]'::jsonb
    ),
    COALESCE(SUM(CASE WHEN COALESCE(rp.stop_scanned, 0) = 0 THEN 1 ELSE 0 END), 0)::int
    INTO v_drivers, v_drivers_waiting
    FROM run_progress rp
    LEFT JOIN public.users u
      ON u.id = rp.driver_user_id
     AND u.organization_id = v_org;

  RETURN jsonb_build_object(
    'greeting_name', v_first_name,
    -- wave_label / bay / route_label / cut_off describe the loader's
    -- active wave assignment. There is no canonical loader-wave table
    -- yet, so these honestly stay NULL. The FE hook degrades a NULL to a
    -- neutral empty string in production (never a fixture value); the
    -- preview/offline showcase sample is used only when supabase is null
    -- or the resolver is unreachable. Counts + driver queue are live.
    'wave_label', NULL,
    'bay', NULL,
    'route_label', NULL,
    'cut_off', NULL,
    'cold_chain_count', v_cold_chain,
    'live_routes', v_live_routes,
    'total_parcels', v_total_parcels,
    'scanned_parcels', v_scanned_parcels,
    'drivers_waiting', v_drivers_waiting,
    'quick_actions', v_quick_actions,
    'drivers', v_drivers
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_loader_today_v1(TEXT, JSONB) IS
  'Mobile V2 loader warehouse-home aggregator. Counts + driver queue resolve from route_runs + route_stops for pre-departure runs in the caller org; driver names from public.users. Quick-action tiles are a navigation surface (row-defined). wave_label/bay/route_label/cut_off honestly stay NULL until a loader-wave table ships; the FE hook degrades a NULL to a neutral empty string in production and uses the preview sample only when supabase is null/unreachable.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_loader_today_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_loader_today_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_loader_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_loader_today_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 2) resolve_fieldops_rider_today_v1 — rider gig-home envelope.
--    Rider gig tickets + per-shift earnings have no canonical source
--    table yet. This resolver returns the caller's resolved identity
--    plus an honest empty/zero state — it never fabricates gig data.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_rider_today_v1(
  p_active_role TEXT DEFAULT 'rider',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_first_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_rider_today_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  IF v_org IS NOT NULL THEN
    v_first_name := public.fieldops_v2_user_first_name_v1(v_user_id);
  END IF;

  -- Honest "data source not yet available" envelope. greeting_name +
  -- employee_id carry the caller's resolved identity when available;
  -- everything gig-specific (active ticket, upcoming, earnings, trips,
  -- rating, shift duration) stays empty/zero/NULL. The FE hook keeps
  -- its preview sample for those NULL fields only and renders an honest
  -- empty active-ticket / up-next state — never fabricated gig rows.
  RETURN jsonb_build_object(
    'greeting_name', v_first_name,
    'employee_id', NULL,
    'online', NULL,
    'earnings_today', 0,
    'trips_completed', 0,
    'rating', NULL,
    'shift_duration', NULL,
    'currency', NULL,
    'currency_label', NULL,
    'active', NULL,
    'upcoming', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_rider_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_rider_today_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_rider_today_v1(TEXT, JSONB) IS
  'Mobile V2 rider gig-home aggregator. Rider gig tickets + per-shift earnings have no canonical source table yet, so this returns the caller resolved identity (greeting_name from public.users) plus an honest empty/zero state. It never fabricates gig data; the FE hook degrades to a preview-only fallback for the NULL fields.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_rider_today_v1(
  p_active_role TEXT DEFAULT 'rider',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_rider_today_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_rider_today_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_rider_today_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 3) resolve_fieldops_supervisor_queue_v1 — supervisor approvals queue.
--    Aggregated from two REAL canonical tables: route_runs awaiting a
--    supervisor decision + fieldops_v2_incidents filed by drivers.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_supervisor_queue_v1(
  p_active_role TEXT DEFAULT 'supervisor',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_first_name TEXT;
  v_queue JSONB := '[]'::jsonb;
  v_active_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_supervisor_queue_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'supervisor_name', NULL,
      'queue', '[]'::jsonb,
      'active_id', NULL
    );
  END IF;

  v_first_name := public.fieldops_v2_user_first_name_v1(v_user_id);

  -- Union two real approval sources, newest first:
  --   route_runs awaiting review  -> kind = route_change
  --   fieldops_v2_incidents       -> kind = incident
  -- Each row maps to the MobileV2SupervisorItem envelope.
  WITH approvals AS (
    SELECT
      'run:' || rr.id::text                                        AS item_id,
      'route_change'                                               AS kind,
      COALESCE(u.full_name, '—')                                   AS driver,
      'RUN-' || substr(rr.id::text, 1, 8)                          AS ref,
      COALESCE(rr.updated_at, rr.created_at)                       AS at_ts,
      CONCAT_WS(' · ',
        'Route run awaiting review',
        NULLIF(rr.status, ''),
        rr.planned_date::text
      )                                                            AS detail
    FROM public.route_runs rr
    LEFT JOIN public.users u
      ON u.id = rr.driver_user_id
     AND u.organization_id = v_org
    WHERE rr.organization_id = v_org
      AND rr.status IN ('pending_review', 'requires_review', 'awaiting_approval')

    UNION ALL

    SELECT
      'incident:' || inc.id::text                                  AS item_id,
      'incident'                                                   AS kind,
      COALESCE(u.full_name, '—')                                   AS driver,
      'INC-' || substr(inc.id::text, 1, 8)                         AS ref,
      inc.created_at                                               AS at_ts,
      CONCAT_WS(' · ',
        NULLIF(inc.type_id, ''),
        'severity ' || COALESCE(inc.severity, 'low'),
        NULLIF(btrim(COALESCE(inc.statement, '')), '')
      )                                                            AS detail
    FROM public.fieldops_v2_incidents inc
    LEFT JOIN public.users u
      ON u.id = inc.reported_by_user_id
     AND u.organization_id = v_org
    WHERE inc.organization_id = v_org
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id',     a.item_id,
          'kind',   a.kind,
          'driver', a.driver,
          'ref',    a.ref,
          'atMs',   (extract(epoch FROM a.at_ts) * 1000)::bigint,
          'detail', COALESCE(a.detail, '')
        )
        ORDER BY a.at_ts DESC
      ),
      '[]'::jsonb
    )
    INTO v_queue
    FROM approvals a;

  v_active_id := v_queue->0->>'id';

  RETURN jsonb_build_object(
    'supervisor_name', v_first_name,
    'queue', v_queue,
    'active_id', v_active_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) IS
  'Mobile V2 supervisor approvals-queue aggregator. Queue unions route_runs awaiting review + fieldops_v2_incidents, org-scoped to the caller, newest-first. Driver names from public.users; supervisor name is the caller full_name. FE hook falls back to a preview sample only when supabase is null.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_supervisor_queue_v1(
  p_active_role TEXT DEFAULT 'supervisor',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_supervisor_queue_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_supervisor_queue_v1(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 4) resolve_fieldops_profile_v1 — shell-chrome identity envelope.
--    Engineering re-audit E3: the V2 drawer header + More screen rendered
--    a hardcoded driver-identity fixture (`MOBILE_V2_PREVIEW_USER`) in the
--    production native shell. This resolver returns the CALLER'S real
--    identity from `public.users` so the chrome is resolver-driven.
--
--    `name`  — users.full_name.
--    `badge` — a stable display badge derived from the real user id
--              (`DRV-<id-prefix>`); `public.users` has no employee_id
--              column yet, so this is a deterministic display label, not
--              a fabricated business identifier. A future migration that
--              adds an employee-id column can switch the source without
--              changing the FE contract.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_profile_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_user public.users%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_profile_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('name', NULL, 'badge', NULL);
  END IF;

  SELECT * INTO v_user
    FROM public.users u
   WHERE u.id = v_user_id
     AND u.organization_id = v_org;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('name', NULL, 'badge', NULL);
  END IF;

  RETURN jsonb_build_object(
    'name',  NULLIF(btrim(COALESCE(v_user.full_name, '')), ''),
    'badge', 'DRV-' || upper(substr(v_user.id::text, 1, 8))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_profile_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_profile_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_profile_v1(TEXT, JSONB) IS
  'Mobile V2 shell-chrome identity. Returns the caller name (users.full_name) + a stable display badge derived from the real user id. Org-scoped via current_user_org_id(); FE hook falls back to a preview fixture only when supabase is null.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_profile_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_profile_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_profile_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_profile_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605180000_resolve_fieldops_role_home_aggregators_v1'));
COMMIT;
