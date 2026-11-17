-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Route runs foundation v1 (route_runs + route_stops)
-- Date: 2026-01-23
--
-- Goals:
--   - Add route run + stop planning SSOT (org-scoped, branch-aware).
--   - Keep execution state in tasks/workflows (no duplicated stop state machines).
--   - Enforce least-privilege RLS (tenant-only access; clients/senders cannot see route plans).
--   - Enforce cross-table organization consistency via triggers (no cross-tenant links).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601231130_route_runs_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('route_run_status', 'Route run lifecycle/status for dispatch operations', 'dispatch', 'tier_1', TRUE)
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
  ('planned', 'Planned', 'Route run is planned but not started', 10, TRUE, '{}' ),
  ('in_progress', 'In Progress', 'Route run has started and is executing', 20, FALSE, '{}' ),
  ('completed', 'Completed', 'Route run completed', 30, FALSE, '{}' ),
  ('canceled', 'Canceled', 'Route run canceled', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'route_run_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('route_stop_kind', 'Route stop kind aligned to service_type (delivery/pickup/swap/rto)', 'dispatch', 'tier_1', TRUE)
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
  ('delivery', 'Delivery', 'Delivery stop', 10, TRUE, '{}' ),
  ('pickup', 'Pickup', 'Pickup stop', 20, FALSE, '{}' ),
  ('swap', 'Swap', 'Swap stop', 30, FALSE, '{}' ),
  ('rto', 'Return', 'Return-to-origin stop', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'route_stop_kind'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Route runs + stops (org-scoped; branch-aware)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  driver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'planned', -- lookup route_run_status
  planned_date DATE NULL,
  planned_start_at TIMESTAMPTZ NULL,
  planned_end_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  ended_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT route_runs_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT route_runs_planned_range_ck CHECK (
    planned_start_at IS NULL
    OR planned_end_at IS NULL
    OR planned_end_at >= planned_start_at
  ),
  CONSTRAINT route_runs_started_range_ck CHECK (
    started_at IS NULL
    OR ended_at IS NULL
    OR ended_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_route_runs_org_branch_status
  ON public.route_runs (organization_id, branch_id, status, created_at DESC)
  WHERE branch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_runs_org_vehicle_status
  ON public.route_runs (organization_id, vehicle_id, status, created_at DESC)
  WHERE vehicle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_runs_org_driver_status
  ON public.route_runs (organization_id, driver_user_id, status, created_at DESC)
  WHERE driver_user_id IS NOT NULL;

COMMENT ON TABLE public.route_runs
  IS 'Dispatch route runs (org-scoped). Execution is driven via tasks/workflows; this table captures planning + assignments.';

CREATE OR REPLACE FUNCTION public.route_runs_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_vehicle_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'route_runs: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.vehicle_id IS NOT NULL THEN
    SELECT v.organization_id INTO v_vehicle_org
    FROM public.vehicles v
    WHERE v.id = NEW.vehicle_id;

    IF v_vehicle_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: vehicle % not found', NEW.vehicle_id USING ERRCODE = '23503';
    END IF;

    IF v_vehicle_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, vehicle org %)', NEW.organization_id, v_vehicle_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.driver_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.driver_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'route_runs: user % not found', NEW.driver_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_runs: organization mismatch (route_run org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_runs_enforce_org_match ON public.route_runs;
CREATE TRIGGER trg_route_runs_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.route_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.route_runs_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_route_runs_set_updated_at ON public.route_runs;
CREATE TRIGGER trg_route_runs_set_updated_at
  BEFORE UPDATE ON public.route_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  route_run_id UUID NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,

  -- Shipments are HASH partitioned by client_id; store client_id alongside shipment_id for deterministic joins.
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,

  stop_kind TEXT NOT NULL DEFAULT 'delivery', -- lookup route_stop_kind
  sequence_order INT NOT NULL,
  planned_window_start_at TIMESTAMPTZ NULL,
  planned_window_end_at TIMESTAMPTZ NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT route_stops_stop_kind_ck CHECK (btrim(stop_kind) <> '' AND stop_kind = lower(stop_kind)),
  CONSTRAINT route_stops_sequence_order_ck CHECK (sequence_order > 0),
  CONSTRAINT route_stops_planned_window_ck CHECK (
    planned_window_start_at IS NULL
    OR planned_window_end_at IS NULL
    OR planned_window_end_at >= planned_window_start_at
  ),
  CONSTRAINT route_stops_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_stops_run_sequence
  ON public.route_stops (route_run_id, sequence_order);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_stops_run_shipment
  ON public.route_stops (route_run_id, client_id, shipment_id);

CREATE INDEX IF NOT EXISTS idx_route_stops_org_run
  ON public.route_stops (organization_id, route_run_id, sequence_order);

CREATE INDEX IF NOT EXISTS idx_route_stops_org_shipment
  ON public.route_stops (organization_id, client_id, shipment_id);

CREATE INDEX IF NOT EXISTS idx_route_stops_client_shipment
  ON public.route_stops (client_id, shipment_id);

COMMENT ON TABLE public.route_stops
  IS 'Route stops (org-scoped) referencing shipments by (shipment_id, client_id) and ordered within a route_run. Execution is driven via tasks/workflows.';

CREATE OR REPLACE FUNCTION public.route_stops_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_run_org UUID;
  v_client_org UUID;
  v_ship_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'route_stops: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT rr.organization_id INTO v_run_org
  FROM public.route_runs rr
  WHERE rr.id = NEW.route_run_id;

  IF v_run_org IS NULL THEN
    RAISE EXCEPTION 'route_stops: route_run % not found', NEW.route_run_id USING ERRCODE = '23503';
  END IF;

  IF v_run_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'route_stops: organization mismatch (stop org %, route_run org %)', NEW.organization_id, v_run_org
      USING ERRCODE = '23514';
  END IF;

  SELECT c.organization_id INTO v_client_org
  FROM public.clients c
  WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'route_stops: client % not found', NEW.client_id USING ERRCODE = '23503';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'route_stops: organization mismatch (stop org %, client org %)', NEW.organization_id, v_client_org
      USING ERRCODE = '23514';
  END IF;

  SELECT s.organization_id INTO v_ship_org
  FROM public.shipments s
  WHERE s.id = NEW.shipment_id
    AND s.client_id = NEW.client_id;

  IF v_ship_org IS NULL THEN
    RAISE EXCEPTION 'route_stops: shipment % not found for client %', NEW.shipment_id, NEW.client_id
      USING ERRCODE = '23503';
  END IF;

  IF v_ship_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'route_stops: organization mismatch (stop org %, shipment org %)', NEW.organization_id, v_ship_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_stops_enforce_org_match ON public.route_stops;
CREATE TRIGGER trg_route_stops_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.route_stops
  FOR EACH ROW
  EXECUTE FUNCTION public.route_stops_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_route_stops_set_updated_at ON public.route_stops;
CREATE TRIGGER trg_route_stops_set_updated_at
  BEFORE UPDATE ON public.route_stops
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS (tenant-only; clients/senders cannot see route plans)
-------------------------------------------------------------------------------

ALTER TABLE public.route_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_stops ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.route_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.route_runs FROM anon;
REVOKE ALL ON TABLE public.route_runs FROM authenticated;

REVOKE ALL ON TABLE public.route_stops FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops FROM anon;
REVOKE ALL ON TABLE public.route_stops FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.route_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.route_stops TO authenticated;

GRANT ALL ON TABLE public.route_runs TO service_role;
GRANT ALL ON TABLE public.route_stops TO service_role;

-- service_role full access
DROP POLICY IF EXISTS route_runs_service_policy ON public.route_runs;
CREATE POLICY route_runs_service_policy ON public.route_runs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS route_stops_service_policy ON public.route_stops;
CREATE POLICY route_stops_service_policy ON public.route_stops
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Authenticated SELECT (tenant-only)
DROP POLICY IF EXISTS route_runs_select_policy ON public.route_runs;
CREATE POLICY route_runs_select_policy ON public.route_runs
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS route_stops_select_policy ON public.route_stops;
CREATE POLICY route_stops_select_policy ON public.route_stops
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
DROP POLICY IF EXISTS route_runs_write_policy ON public.route_runs;
CREATE POLICY route_runs_write_policy ON public.route_runs
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

DROP POLICY IF EXISTS route_stops_write_policy ON public.route_stops;
CREATE POLICY route_stops_write_policy ON public.route_stops
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
  ('public', 'route_runs', TRUE, TRUE, TRUE, 'Dispatch route runs (org-scoped).'),
  ('public', 'route_stops', TRUE, TRUE, TRUE, 'Dispatch route stops (org-scoped).')
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601231130_route_runs_foundation_v1'));
COMMIT;
