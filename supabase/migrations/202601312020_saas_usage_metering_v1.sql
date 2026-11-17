-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: SaaS usage metering + entitlements policy (usage_events SSOT)
-- Date: 2026-01-31
--
-- Goals:
--   - Provide enterprise SaaS posture: SSOT usage metering + tenant entitlements/limits policy (row-driven).
--   - Keep runtime enforcement workflow-driven later; this is structure-only (tables/RLS/RBAC/contracts/tests).
--   - Zero hardcoding: metrics are row-driven lookups; limits are settings-ladder policy rows.
--
-- Notes:
--   - usage_events is an immutable ledger (audit disabled by contract).
--   - Reads are RBAC-gated (usage.read) + RLS org isolation; writes are service-only via RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601312020_saas_usage_metering_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven usage metrics + units)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('usage_metric', 'SaaS usage metering metric keys (stable; add new rows for new billable metrics)', 'finance', 'tier_1', TRUE),
  ('usage_unit', 'SaaS usage metering units (count, bytes, seconds, etc.)', 'finance', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  -- Units
  ('usage_unit', 'count', 'Count', 'Count of events/items', 10, TRUE, '{}' ),
  ('usage_unit', 'bytes', 'Bytes', 'Bytes (storage/bandwidth)', 20, FALSE, '{}' ),
  ('usage_unit', 'seconds', 'Seconds', 'Seconds (compute/time)', 30, FALSE, '{}' ),

  -- Metrics (seed minimal last-mile + platform baseline; extend via lookup_values)
  ('usage_metric', 'shipments.created', 'Shipments Created', 'Billable shipment creation events', 10, TRUE,  '{"default_unit":"count"}' ),
  ('usage_metric', 'tasks.completed', 'Tasks Completed', 'Billable task completions (driver/warehouse/ops)', 20, FALSE, '{"default_unit":"count"}' ),
  ('usage_metric', 'scan_events.ingested', 'Scan Events', 'Billable scan events ingested (mobile/warehouse)', 30, FALSE, '{"default_unit":"count"}' ),
  ('usage_metric', 'location_pings.ingested', 'Location Pings', 'Billable location pings ingested (telemetry)', 40, FALSE, '{"default_unit":"count"}' ),
  ('usage_metric', 'routes.optimized', 'Route Optimizations', 'Billable route optimization executions', 50, FALSE, '{"default_unit":"count"}' ),
  ('usage_metric', 'pod.artifacts.stored', 'Proof of Delivery Artifacts', 'Billable evidence artifacts stored (photos/signatures)', 60, FALSE, '{"default_unit":"count"}' ),
  ('usage_metric', 'api.requests', 'API Requests', 'Billable API requests (when enabled)', 70, FALSE, '{"default_unit":"count"}' )
) AS v(category, value, label, description, sort_order, is_default, metadata)
WHERE ld.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) RBAC: permission key usage.read + template mapping (row-driven)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status, metadata)
SELECT
  ld.id,
  'usage.read',
  'Usage Read',
  'Read SaaS usage metering ledgers and entitlement status (tenant control-plane).',
  150,
  FALSE,
  'active',
  '{"resource":"usage","action":"read"}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'rbac_permission'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH perm AS (
  SELECT lv.id
  FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
  WHERE ld.category = 'rbac_permission'
    AND lv.value = 'usage.read'
  LIMIT 1
),
templates AS (
  SELECT id, key
  FROM public.rbac_role_templates
  WHERE key IN ('ops_admin', 'finance', 'agreements_admin')
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object('seed', TRUE, 'source', 'saas_usage_metering_v1')
FROM templates t
CROSS JOIN perm p
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) usage_events SSOT ledger (HASH+RANGE monthly) + idempotency dedupe
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.usage_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  metric_key TEXT NOT NULL, -- lookup category usage_metric (enforced via lookup_column_contracts)
  quantity NUMERIC NOT NULL DEFAULT 1,
  unit TEXT NULL, -- lookup category usage_unit (enforced via lookup_column_contracts)

  subject_type TEXT NULL,
  subject_id UUID NULL,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  idempotency_key TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT usage_events_metric_key_ck CHECK (btrim(metric_key) <> '' AND metric_key = lower(metric_key)),
  CONSTRAINT usage_events_quantity_ck CHECK (quantity > 0),
  CONSTRAINT usage_events_unit_ck CHECK (unit IS NULL OR (btrim(unit) <> '' AND unit = lower(unit))),
  CONSTRAINT usage_events_subject_type_ck CHECK (subject_type IS NULL OR (btrim(subject_type) <> '' AND subject_type = lower(subject_type))),
  CONSTRAINT usage_events_subject_ck CHECK (
    (subject_type IS NULL AND subject_id IS NULL) OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
  ),
  CONSTRAINT usage_events_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> ''),
  CONSTRAINT usage_events_scope_ck CHECK (sender_id IS NULL OR client_id IS NOT NULL),

  PRIMARY KEY (id, organization_id, occurred_at)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.usage_events_p0
  PARTITION OF public.usage_events
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (occurred_at);

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_name TEXT := format('usage_events_%s_%s_p0', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.usage_events_p0 FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_from::timestamptz,
      v_to::timestamptz
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_usage_events_org_metric_time
  ON public.usage_events (organization_id, metric_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_subject_time
  ON public.usage_events (subject_type, subject_id, occurred_at DESC)
  WHERE subject_type IS NOT NULL AND subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_actor_time
  ON public.usage_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_client_time
  ON public.usage_events (client_id, occurred_at DESC)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_sender_time
  ON public.usage_events (sender_id, occurred_at DESC)
  WHERE sender_id IS NOT NULL;

COMMENT ON TABLE public.usage_events IS
  'SaaS usage metering ledger (SSOT). Immutable, partitioned and retention-governed; reads RBAC-gated; writes service-only via record_usage_event_v1.';

CREATE TABLE IF NOT EXISTS public.usage_event_dedupe (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  usage_event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_event_dedupe_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_usage_event_dedupe_event_id
  ON public.usage_event_dedupe (usage_event_id);

COMMENT ON TABLE public.usage_event_dedupe IS
  'Idempotency keys for usage_events write-paths (unique per organization).';

-------------------------------------------------------------------------------
-- 4) RLS + least-privilege grants
-------------------------------------------------------------------------------

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events_p0 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_event_dedupe ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.usage_events FROM PUBLIC;
REVOKE ALL ON TABLE public.usage_events FROM anon;
REVOKE ALL ON TABLE public.usage_events FROM authenticated;

REVOKE ALL ON TABLE public.usage_events_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.usage_events_p0 FROM anon;
REVOKE ALL ON TABLE public.usage_events_p0 FROM authenticated;

REVOKE ALL ON TABLE public.usage_event_dedupe FROM PUBLIC;
REVOKE ALL ON TABLE public.usage_event_dedupe FROM anon;
REVOKE ALL ON TABLE public.usage_event_dedupe FROM authenticated;

DROP POLICY IF EXISTS usage_events_select ON public.usage_events;
CREATE POLICY usage_events_select ON public.usage_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('usage.read', organization_id)
    )
  );

DROP POLICY IF EXISTS usage_events_service_policy ON public.usage_events;
CREATE POLICY usage_events_service_policy ON public.usage_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS usage_events_p0_service_policy ON public.usage_events_p0;
CREATE POLICY usage_events_p0_service_policy ON public.usage_events_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS usage_event_dedupe_service_policy ON public.usage_event_dedupe;
CREATE POLICY usage_event_dedupe_service_policy ON public.usage_event_dedupe
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.usage_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_events TO service_role;
GRANT ALL ON public.usage_events_p0 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_event_dedupe TO service_role;

-------------------------------------------------------------------------------
-- 5) Contracts: lookup enforcement + scope projection + table contracts + retention
-------------------------------------------------------------------------------

-- Enforce row-driven metric/unit categories.
INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'usage_events', 'metric_key', 'usage_metric'),
  ('public', 'usage_events', 'unit', 'usage_unit')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

-- Org projection integrity for optional client scope (sender integrity remains service responsibility).
INSERT INTO public.scope_projection_contracts (
  table_schema,
  table_name,
  parent_schema,
  parent_table,
  join_local_cols,
  join_parent_cols,
  projections
)
VALUES
  ('public', 'usage_events', 'public', 'clients', ARRAY['client_id'], ARRAY['id'], '{"organization_id":"organization_id"}'::jsonb)
ON CONFLICT ON CONSTRAINT scope_projection_contracts_unique DO NOTHING;

SELECT public.apply_scope_projection_contracts('public');

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'usage_events', TRUE, FALSE, FALSE, 'SaaS usage metering ledger (immutable SSOT); audit disabled by contract.'),
  ('public', 'usage_event_dedupe', TRUE, FALSE, FALSE, 'SaaS usage metering idempotency keys (service-only).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Partitioning registration (HASH+RANGE monthly; long retention like finance).
INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
)
VALUES (
  'usage_events',
  'HASH+RANGE',
  'organization_id|occurred_at',
  'monthly',
  NULL,
  84,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config;

-- Bootstrap partitions now (idempotent; uses partitioning_config).
SELECT * FROM public.create_next_partitions();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-------------------------------------------------------------------------------
-- 6) RPC: record_usage_event_v1 (service-only; idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_usage_event_v1(
  p_event JSONB
)
RETURNS TABLE (
  usage_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_event JSONB := COALESCE(p_event, '{}'::jsonb);
  v_event_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;

  v_metric_key TEXT := NULL;
  v_quantity NUMERIC := 1;
  v_unit TEXT := NULL;

  v_subject_type TEXT := NULL;
  v_subject_id UUID := NULL;
  v_actor_user_id UUID := NULL;

  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_occurred_at TIMESTAMPTZ := NULL;

  v_partition_base TEXT;
  v_hash_parent RECORD;
  v_remainder INT;
  v_expected_partition TEXT;
  v_missing BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_event) <> 'object' THEN
    RAISE EXCEPTION 'record_usage_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_event->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_event->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_event->>'sender_id', '')::uuid; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_event->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_subject_id := NULLIF(v_event->>'subject_id', '')::uuid; EXCEPTION WHEN others THEN v_subject_id := NULL; END;

  v_metric_key := lower(NULLIF(btrim(COALESCE(v_event->>'metric_key', '')), ''));
  v_unit := lower(NULLIF(btrim(COALESCE(v_event->>'unit', '')), ''));
  v_subject_type := lower(NULLIF(btrim(COALESCE(v_event->>'subject_type', '')), ''));
  v_idempotency_key := NULLIF(btrim(COALESCE(v_event->>'idempotency_key', '')), '');

  BEGIN v_quantity := NULLIF(v_event->>'quantity', '')::numeric; EXCEPTION WHEN others THEN v_quantity := 1; END;
  BEGIN v_occurred_at := NULLIF(v_event->>'occurred_at', '')::timestamptz; EXCEPTION WHEN others THEN v_occurred_at := NULL; END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_usage_event_v1 missing organization_id' USING ERRCODE = '23502';
  END IF;
  IF v_metric_key IS NULL THEN
    RAISE EXCEPTION 'record_usage_event_v1 missing metric_key' USING ERRCODE = '23514';
  END IF;
  IF v_quantity IS NULL OR v_quantity <= 0 THEN
    RAISE EXCEPTION 'record_usage_event_v1 invalid quantity' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'record_usage_event_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;
  IF v_sender_id IS NOT NULL AND v_client_id IS NULL THEN
    RAISE EXCEPTION 'record_usage_event_v1 client_id is required when sender_id is set' USING ERRCODE = '23514';
  END IF;

  IF v_occurred_at IS NULL THEN
    v_occurred_at := now();
  END IF;

  v_metadata := COALESCE(v_event->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN v_metadata := '{}'::jsonb; END IF;

  -- Ensure the monthly partition exists for every HASH parent (future-proof for modulus expansion).
  v_partition_base := public.generate_partition_name_range_monthly('usage_events', v_occurred_at);

  FOR v_hash_parent IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'usage_events'
      AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    SELECT COALESCE(NULLIF(regexp_replace(v_hash_parent.relname, '.*_p([0-9]+)$', '\\1'),''), '0')::int
      INTO v_remainder;

    v_expected_partition := format('%s_p%s', v_partition_base, v_remainder);

    IF to_regclass('public.' || v_expected_partition) IS NULL THEN
      v_missing := TRUE;
      EXIT;
    END IF;
  END LOOP;

  IF v_missing THEN
    PERFORM public.create_next_partitions();
  END IF;

  -- Idempotency: if key exists, return prior usage_event_id without creating a duplicate.
  INSERT INTO public.usage_event_dedupe(organization_id, idempotency_key, usage_event_id, occurred_at, created_at)
  VALUES (v_org_id, v_idempotency_key, v_event_id, v_occurred_at, now())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.usage_event_id
      INTO v_event_id
      FROM public.usage_event_dedupe d
     WHERE d.organization_id = v_org_id
       AND d.idempotency_key = v_idempotency_key;

    RETURN QUERY SELECT v_event_id, FALSE;
    RETURN;
  END IF;

  INSERT INTO public.usage_events(
    id, organization_id,
    client_id, sender_id,
    metric_key, quantity, unit,
    subject_type, subject_id,
    actor_user_id,
    idempotency_key, metadata,
    occurred_at, received_at, created_at
  ) VALUES (
    v_event_id, v_org_id,
    v_client_id, v_sender_id,
    v_metric_key, v_quantity, v_unit,
    v_subject_type, v_subject_id,
    v_actor_user_id,
    v_idempotency_key, v_metadata,
    v_occurred_at, now(), now()
  );

  RETURN QUERY SELECT v_event_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.record_usage_event_v1(JSONB) IS
  'Service write-path: record an immutable usage_events ledger row (idempotent by organization_id + idempotency_key via usage_event_dedupe).';

REVOKE ALL ON FUNCTION public.record_usage_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_usage_event_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.record_usage_event_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_event_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 7) Settings: saas_entitlements_policy (row-driven; global+tenant)
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'saas_entitlements_policy',
  'Tenant SaaS entitlements/limits policy (limits/quota) resolved via ladder; used for metering/billing (structure-first).',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global","tenant"]'::jsonb,
  NULL
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'saas_entitlements_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "SaaS Entitlements Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "enforcement_mode": { "type": ["string", "null"], "enum": ["log_only", "hard_fail", null] },
      "limits": {
        "type": ["array", "null"],
        "items": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "metric_key": { "type": "string" },
            "period": { "type": "string", "enum": ["day", "month", "year"] },
            "max": { "type": "number", "minimum": 0 },
            "unit": { "type": ["string", "null"] },
            "is_active": { "type": ["boolean", "null"] }
          },
          "required": ["metric_key", "period", "max"]
        }
      }
    }
  }'::jsonb,
  'Tenant SaaS entitlements/limits policy resolved via settings ladder; defines quota rows for usage_events metrics.',
  '[
    { "version": 1, "enabled": true, "enforcement_mode": "log_only", "limits": [] }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', true,
    'enforcement_mode', 'log_only',
    'limits', '[]'::jsonb
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'saas_entitlements_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global saas_entitlements_policy (safe default)',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'saas_entitlements_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'saas_entitlements_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_id) DO NOTHING;

-- API contract views are derived from user-facing grants (public.security_rls_user_facing).
SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601312020_saas_usage_metering_v1'));
COMMIT;

