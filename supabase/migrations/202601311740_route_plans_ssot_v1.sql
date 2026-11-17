-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Route optimization SSOT v1 (route_plans projection + route_plan_events ledger)
-- Date: 2026-01-31
--
-- Goals:
--   - Add solver-agnostic route planning SSOT primitives to support VRP/optimization providers.
--   - Keep solver logic outside DB; this schema captures inputs/outputs/provenance only.
--   - Link generated route_runs back to the originating route_plan (optional FK).
--   - Enforce strict RLS (tenant-only; clients/senders cannot see route plans).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311740_route_plans_ssot_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('route_plan_status', 'Route plan status for solver/optimization runs', 'dispatch', 'tier_1', TRUE)
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
  ('created',   'Created',   'Plan created; inputs captured', 10, TRUE,  '{}' ),
  ('submitted', 'Submitted', 'Submitted to solver/optimizer', 20, FALSE, '{}' ),
  ('solved',    'Solved',    'Solver produced a solution', 30, FALSE, '{}' ),
  ('applied',   'Applied',   'Solution applied (route_runs created/updated)', 40, FALSE, '{}' ),
  ('failed',    'Failed',    'Solver failed', 90, FALSE, '{"is_final": true}' ),
  ('canceled',  'Canceled',  'Plan canceled', 95, FALSE, '{"is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'route_plan_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) route_plans projection + route_plan_events ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.route_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  planned_date DATE NULL,
  status TEXT NOT NULL DEFAULT 'created', -- lookup route_plan_status
  status_reason TEXT,

  requested_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NULL,
  solved_at TIMESTAMPTZ NULL,
  applied_at TIMESTAMPTZ NULL,

  -- Solver-agnostic payloads (inputs/constraints/solution). Keep flexible; validate via schema_registry later.
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  solution JSONB NOT NULL DEFAULT '{}'::jsonb,

  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT route_plans_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT route_plans_version_ck CHECK (version > 0)
);

COMMENT ON TABLE public.route_plans
  IS 'Route plan projection for optimization runs (solver-agnostic). Immutable audit trail is route_plan_events.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_plans_org_idempotency
  ON public.route_plans (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_route_plans_org_status
  ON public.route_plans (organization_id, status, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_route_plans__branch_id__fk
  ON public.route_plans (branch_id);

CREATE INDEX IF NOT EXISTS idx_route_plans__requested_by_user_id__fk
  ON public.route_plans (requested_by_user_id);

CREATE OR REPLACE FUNCTION public.route_plans_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'route_plans: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id INTO v_branch_org
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'route_plans: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_plans: organization mismatch (plan org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.requested_by_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.requested_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'route_plans: user % not found', NEW.requested_by_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'route_plans: organization mismatch (plan org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_route_plans_enforce_org_match ON public.route_plans;
CREATE TRIGGER trg_route_plans_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.route_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.route_plans_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_route_plans_set_updated_at ON public.route_plans;
CREATE TRIGGER trg_route_plans_set_updated_at
  BEFORE UPDATE ON public.route_plans
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.route_plan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_plan_id UUID NOT NULL REFERENCES public.route_plans(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  plan_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT route_plan_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT route_plan_events_plan_version_ck CHECK (plan_version > 0)
);

COMMENT ON TABLE public.route_plan_events
  IS 'Immutable route plan event ledger (SSOT). route_plans is the projection.';

CREATE INDEX IF NOT EXISTS idx_route_plan_events_plan_created
  ON public.route_plan_events (route_plan_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_plan_events_plan_version
  ON public.route_plan_events (route_plan_id, plan_version);

CREATE INDEX IF NOT EXISTS idx_route_plan_events_org_created
  ON public.route_plan_events (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_route_plan_events__actor_user_id__fk
  ON public.route_plan_events (actor_user_id);

-------------------------------------------------------------------------------
-- 3) Optional: link route_runs to route_plan_id (provenance)
-------------------------------------------------------------------------------

ALTER TABLE public.route_runs
  ADD COLUMN IF NOT EXISTS route_plan_id UUID REFERENCES public.route_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_route_runs__route_plan_id__fk
  ON public.route_runs (route_plan_id);

-------------------------------------------------------------------------------
-- 4) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.route_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_plan_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.route_plans FROM PUBLIC;
REVOKE ALL ON TABLE public.route_plans FROM anon;
REVOKE ALL ON TABLE public.route_plans FROM authenticated;

REVOKE ALL ON TABLE public.route_plan_events FROM PUBLIC;
REVOKE ALL ON TABLE public.route_plan_events FROM anon;
REVOKE ALL ON TABLE public.route_plan_events FROM authenticated;

DROP POLICY IF EXISTS route_plans_select ON public.route_plans;
CREATE POLICY route_plans_select ON public.route_plans
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS route_plans_service_policy ON public.route_plans;
CREATE POLICY route_plans_service_policy ON public.route_plans
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS route_plan_events_select ON public.route_plan_events;
CREATE POLICY route_plan_events_select ON public.route_plan_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS route_plan_events_service_policy ON public.route_plan_events;
CREATE POLICY route_plan_events_service_policy ON public.route_plan_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.route_plans TO authenticated;
GRANT SELECT ON public.route_plan_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_plans TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_plan_events TO service_role;

-------------------------------------------------------------------------------
-- 5) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'route_plans', TRUE, TRUE, TRUE, 'Route plan projection (solver-agnostic) for optimization runs.'),
  ('public', 'route_plan_events', TRUE, FALSE, FALSE, 'Route plan event ledger (SSOT).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'route_plans', 'status', 'route_plan_status')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311740_route_plans_ssot_v1'));
COMMIT;

