-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: KPI catalog + daily rollups v1 (definitions + rollups + rollup events)
-- Date: 2026-01-31
--
-- Goals:
--   - Provide a canonical KPI registry and rollup storage to avoid per-tenant hardcoded dashboards.
--   - Keep KPIs derived from SSOT ledgers (shipments/tasks/scan_events/finance_events) via worker jobs (out of scope here).
--   - Enforce strict RLS (tenant-only; clients/senders cannot see KPI catalog/rollups by default).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311830_kpi_catalog_rollups_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) kpi_definitions (catalog / projection)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kpi_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kpi_definitions_key_ck CHECK (btrim(key) <> '' AND key = lower(key)),
  CONSTRAINT kpi_definitions_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT kpi_definitions_definition_object_ck CHECK (jsonb_typeof(definition) = 'object')
);

COMMENT ON TABLE public.kpi_definitions IS
  'KPI definitions catalog (org-scoped). Use worker jobs to compute rollups from SSOT ledgers; do not hardcode per-tenant analytics.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_definitions_org_key
  ON public.kpi_definitions (organization_id, key);

CREATE INDEX IF NOT EXISTS idx_kpi_definitions_org_active
  ON public.kpi_definitions (organization_id, is_active, key);

ALTER TABLE public.kpi_definitions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kpi_definitions FROM PUBLIC;
REVOKE ALL ON TABLE public.kpi_definitions FROM anon;
REVOKE ALL ON TABLE public.kpi_definitions FROM authenticated;

DROP POLICY IF EXISTS kpi_definitions_select ON public.kpi_definitions;
CREATE POLICY kpi_definitions_select ON public.kpi_definitions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS kpi_definitions_service_policy ON public.kpi_definitions;
CREATE POLICY kpi_definitions_service_policy ON public.kpi_definitions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.kpi_definitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpi_definitions TO service_role;

DROP TRIGGER IF EXISTS trg_kpi_definitions_set_updated_at ON public.kpi_definitions;
CREATE TRIGGER trg_kpi_definitions_set_updated_at
  BEFORE UPDATE ON public.kpi_definitions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) kpi_rollups_daily (projection)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kpi_rollups_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kpi_key TEXT NOT NULL,
  day DATE NOT NULL,

  -- Flexible dimensions (e.g., {"branch_id": "...", "zone_id": "...", "service_level": "same_day"}).
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,

  value_num NUMERIC,
  numerator NUMERIC,
  denominator NUMERIC,

  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT kpi_rollups_daily_kpi_key_ck CHECK (btrim(kpi_key) <> '' AND kpi_key = lower(kpi_key)),
  CONSTRAINT kpi_rollups_daily_dimensions_object_ck CHECK (jsonb_typeof(dimensions) = 'object'),
  CONSTRAINT kpi_rollups_daily_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT kpi_rollups_daily_value_ck CHECK (
    value_num IS NOT NULL
    OR (numerator IS NOT NULL AND denominator IS NOT NULL)
  ),
  CONSTRAINT kpi_rollups_daily_kpi_fk
    FOREIGN KEY (organization_id, kpi_key) REFERENCES public.kpi_definitions(organization_id, key) ON DELETE CASCADE
);

COMMENT ON TABLE public.kpi_rollups_daily IS
  'Daily KPI rollups (projection) for analytics. Derived from SSOT ledgers; backfilled by worker jobs.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_rollups_daily_unique
  ON public.kpi_rollups_daily (organization_id, kpi_key, day, dimensions);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_rollups_daily_org_idempotency
  ON public.kpi_rollups_daily (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_kpi_rollups_daily_org_day
  ON public.kpi_rollups_daily (organization_id, day DESC);

CREATE INDEX IF NOT EXISTS idx_kpi_rollups_daily_org_kpi_day
  ON public.kpi_rollups_daily (organization_id, kpi_key, day DESC);

-- FK supporting index (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_kpi_rollups_daily__org_kpi_fk
  ON public.kpi_rollups_daily (organization_id, kpi_key);

ALTER TABLE public.kpi_rollups_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kpi_rollups_daily FROM PUBLIC;
REVOKE ALL ON TABLE public.kpi_rollups_daily FROM anon;
REVOKE ALL ON TABLE public.kpi_rollups_daily FROM authenticated;

DROP POLICY IF EXISTS kpi_rollups_daily_select ON public.kpi_rollups_daily;
CREATE POLICY kpi_rollups_daily_select ON public.kpi_rollups_daily
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS kpi_rollups_daily_service_policy ON public.kpi_rollups_daily;
CREATE POLICY kpi_rollups_daily_service_policy ON public.kpi_rollups_daily
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.kpi_rollups_daily TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpi_rollups_daily TO service_role;

DROP TRIGGER IF EXISTS trg_kpi_rollups_daily_set_updated_at ON public.kpi_rollups_daily;
CREATE TRIGGER trg_kpi_rollups_daily_set_updated_at
  BEFORE UPDATE ON public.kpi_rollups_daily
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) kpi_rollup_events (ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.kpi_rollup_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  kpi_key TEXT,
  day_from DATE,
  day_to DATE,
  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT kpi_rollup_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT kpi_rollup_events_kpi_key_ck CHECK (kpi_key IS NULL OR (btrim(kpi_key) <> '' AND kpi_key = lower(kpi_key))),
  CONSTRAINT kpi_rollup_events_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '')
);

COMMENT ON TABLE public.kpi_rollup_events IS
  'KPI rollup execution ledger (SSOT) for backfills/provenance (worker-driven).';

CREATE INDEX IF NOT EXISTS idx_kpi_rollup_events_org_created
  ON public.kpi_rollup_events (organization_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_rollup_events_org_idempotency
  ON public.kpi_rollup_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_kpi_rollup_events__actor_user_id__fk
  ON public.kpi_rollup_events (actor_user_id);

ALTER TABLE public.kpi_rollup_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.kpi_rollup_events FROM PUBLIC;
REVOKE ALL ON TABLE public.kpi_rollup_events FROM anon;
REVOKE ALL ON TABLE public.kpi_rollup_events FROM authenticated;

DROP POLICY IF EXISTS kpi_rollup_events_select ON public.kpi_rollup_events;
CREATE POLICY kpi_rollup_events_select ON public.kpi_rollup_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS kpi_rollup_events_service_policy ON public.kpi_rollup_events;
CREATE POLICY kpi_rollup_events_service_policy ON public.kpi_rollup_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.kpi_rollup_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kpi_rollup_events TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts + apply
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'kpi_definitions', TRUE, TRUE, TRUE, 'KPI definitions catalog (org-scoped; tenant-visible).'),
  ('public', 'kpi_rollups_daily', TRUE, TRUE, FALSE, 'KPI rollups projection (worker-derived; disable double-audit).'),
  ('public', 'kpi_rollup_events', TRUE, FALSE, FALSE, 'KPI rollup execution ledger (SSOT; disable double-audit).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();
SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601311830_kpi_catalog_rollups_v1'));
COMMIT;

