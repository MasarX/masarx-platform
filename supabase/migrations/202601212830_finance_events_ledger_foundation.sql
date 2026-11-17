-- Plan: PLAN-202601-finance-events-ledger-foundation / Step: S04
-- Migration: Finance SSOT ledger foundation (finance_events + COD/settlement policy scaffolding)
-- Date: 2026-01-21
--
-- Goals:
--   - Introduce an immutable finance ledger (`finance_events`) with strict RLS and partition readiness.
--   - Add row-driven finance enums via lookup_definitions/lookup_values (no hardcoded branches).
--   - Add policy categories (`cod_policy`, `settlement_policy`) with schema contracts + safe global defaults.
--   - Provide an idempotent write-path RPC (`record_finance_event_v1`) for engine/service use.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212830_finance_events_ledger_foundation'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (dynamic enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('finance_event_type', 'Finance event types for finance_events ledger', 'finance', 'tier_1', TRUE)
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
  ('charge', 'Charge', 'Charge assessed (pricing/billing)', 10, TRUE, '{}' ),
  ('refund', 'Refund', 'Refund issued (credit/return/complaint)', 20, FALSE, '{}' ),
  ('fee', 'Fee', 'Fee assessed (service/handling)', 30, FALSE, '{}' ),
  ('tax', 'Tax', 'Tax assessed/withheld', 40, FALSE, '{}' ),
  ('cod_collected', 'COD Collected', 'Cash-on-delivery amount collected', 50, FALSE, '{}' ),
  ('cod_handover', 'COD Handover', 'COD handover between actors (driver→branch, etc.)', 60, FALSE, '{}' ),
  ('deposit', 'Deposit', 'Deposit to bank/company cash', 70, FALSE, '{}' ),
  ('payout', 'Payout', 'Payout to counterparty (driver/client)', 80, FALSE, '{}' ),
  ('adjustment', 'Adjustment', 'Manual adjustment with reason (policy-driven)', 90, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'finance_event_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('finance_direction', 'Direction relative to the account (increases/decreases) for finance_events ledger', 'finance', 'tier_1', TRUE)
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
  ('in', 'In', 'Increases account balance', 1, TRUE, '{}' ),
  ('out', 'Out', 'Decreases account balance', 2, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'finance_direction'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('finance_account_type', 'Account types for finance_events (row-driven, no hardcoding)', 'finance', 'tier_1', TRUE)
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
  ('company', 'Company', 'Company-level account (per tenant)', 10, TRUE, '{}' ),
  ('client', 'Client', 'Client account (B2B customer)', 20, FALSE, '{}' ),
  ('sender', 'Sender', 'Sender/sub-account (merchant)', 30, FALSE, '{}' ),
  ('branch', 'Branch', 'Branch/warehouse cash account', 40, FALSE, '{}' ),
  ('driver', 'Driver', 'Driver cash account (usually auth user id)', 50, FALSE, '{}' ),
  ('external', 'External', 'External/untracked counterparty', 60, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'finance_account_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Policy categories (commercial agreements: COD + settlement scaffolding)
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
  'cod_policy',
  'COD collection and handover policy (fees, responsibilities, evidence requirements).',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
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
  'cod_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "COD Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "currency": { "type": ["string", "null"] },
      "allowed_methods": { "type": ["array", "null"], "items": { "type": "string" } },
      "handover": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "require_shift_close": { "type": ["boolean", "null"] },
          "require_evidence": { "type": ["boolean", "null"] },
          "variance_tolerance_amount": { "type": ["number", "null"], "minimum": 0 }
        }
      },
      "fees": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "cod_pct": { "type": ["number", "null"], "minimum": 0 },
          "flat": { "type": ["number", "null"], "minimum": 0 }
        }
      }
    }
  }'::jsonb,
  'COD policy resolved via settings ladder; defines allowed methods, handover requirements, and fee knobs (pricing integration later).',
  '[
    {
      "version": 1,
      "enabled": false,
      "currency": "SAR",
      "allowed_methods": ["cash"],
      "handover": { "require_shift_close": true, "require_evidence": true, "variance_tolerance_amount": 0 },
      "fees": { "cod_pct": 0, "flat": 0 }
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO NOTHING;

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
  'settlement_policy',
  'Settlement and reconciliation policy (batching scopes, locking/approval rules, variance thresholds).',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
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
  'settlement_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Settlement Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "batch_scopes": { "type": ["array", "null"], "items": { "type": "string" } },
      "locking": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "require_manager_approval": { "type": ["boolean", "null"] },
          "max_variance_amount": { "type": ["number", "null"], "minimum": 0 }
        }
      }
    }
  }'::jsonb,
  'Settlement policy resolved via settings ladder; defines how settlement batches are formed and locked (projection tables in follow-up plan).',
  '[
    {
      "version": 1,
      "enabled": false,
      "batch_scopes": ["driver_shift", "branch_day", "client_cycle"],
      "locking": { "require_manager_approval": true, "max_variance_amount": 0 }
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO NOTHING;

-- Seed safe global defaults (disabled until configured).
WITH cod_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', false,
    'currency', 'SAR',
    'allowed_methods', jsonb_build_array('cash'),
    'handover', jsonb_build_object('require_shift_close', true, 'require_evidence', true, 'variance_tolerance_amount', 0),
    'fees', jsonb_build_object('cod_pct', 0, 'flat', 0)
  ) AS body
),
settlement_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', false,
    'batch_scopes', jsonb_build_array('driver_shift', 'branch_day', 'client_cycle'),
    'locking', jsonb_build_object('require_manager_approval', true, 'max_variance_amount', 0)
  ) AS body
),
insert_versions AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
  SELECT 'cod_policy', 'global', NULL, 1, cod_upsert.body, 1, now() FROM cod_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
),
insert_settlement_versions AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
  SELECT 'settlement_policy', 'global', NULL, 1, settlement_upsert.body, 1, now() FROM settlement_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM (
  SELECT category, scope_type, scope_id, id, value FROM insert_versions
  UNION ALL
  SELECT category, scope_type, scope_id, id, value FROM insert_settlement_versions
) sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND (
      (sv.scope_type = 'global' AND s.scope_id IS NULL AND sv.scope_id IS NULL)
      OR s.scope_id = sv.scope_id
    )
);

-------------------------------------------------------------------------------
-- 3) finance_events ledger (HASH+RANGE monthly) + RLS hardening
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.finance_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  event_type TEXT NOT NULL, -- lookup category 'finance_event_type'
  direction TEXT NOT NULL, -- lookup category 'finance_direction'
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL, -- explicit currency per row (no implicit conversion)

  account_type TEXT NOT NULL, -- lookup category 'finance_account_type'
  account_id UUID,

  subject_type TEXT,
  subject_id UUID,

  decision_log_id UUID,
  settings_resolution_id UUID,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT finance_events_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT finance_events_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT finance_events_direction_nonempty CHECK (btrim(direction) <> ''),
  CONSTRAINT finance_events_account_type_nonempty CHECK (btrim(account_type) <> ''),

  PRIMARY KEY (id, organization_id, occurred_at)
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.finance_events_p0
  PARTITION OF public.finance_events
  FOR VALUES WITH (MODULUS 1, REMAINDER 0)
  PARTITION BY RANGE (occurred_at);

DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  -- HASH+RANGE partition naming convention: always suffix `_p{remainder}`, including `_p0`.
  v_name TEXT := format('finance_events_%s_%s_p0', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.finance_events_p0 FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_from::timestamptz,
      v_to::timestamptz
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_finance_events_event_type
  ON public.finance_events(event_type);
CREATE INDEX IF NOT EXISTS idx_finance_events_account
  ON public.finance_events(account_type, account_id);
CREATE INDEX IF NOT EXISTS idx_finance_events_subject
  ON public.finance_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_finance_events_occurred_at
  ON public.finance_events_p0(occurred_at);

COMMENT ON TABLE public.finance_events IS 'Immutable finance event ledger (SSOT): charges, fees, COD, payouts, adjustments; projections built later.';

-- Idempotency dedupe (kept separate to support HASH+RANGE without unique constraints across subpartitions).
CREATE TABLE IF NOT EXISTS public.finance_event_dedupe (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  idempotency_key TEXT NOT NULL,
  finance_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finance_event_dedupe_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_finance_event_dedupe_event_id
  ON public.finance_event_dedupe(finance_event_id);

COMMENT ON TABLE public.finance_event_dedupe IS 'Idempotency keys for finance_events write-paths (unique per organization).';

-- RLS: service-role only.
ALTER TABLE public.finance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_events FROM PUBLIC;
REVOKE ALL ON TABLE public.finance_events FROM anon;
REVOKE ALL ON TABLE public.finance_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.finance_events
  TO service_role;
DROP POLICY IF EXISTS finance_events_service_policy ON public.finance_events;
CREATE POLICY finance_events_service_policy
  ON public.finance_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

ALTER TABLE public.finance_events_p0 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_events_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.finance_events_p0 FROM anon;
REVOKE ALL ON TABLE public.finance_events_p0 FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.finance_events_p0
  TO service_role;
DROP POLICY IF EXISTS finance_events_p0_service_policy ON public.finance_events_p0;
CREATE POLICY finance_events_p0_service_policy
  ON public.finance_events_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

ALTER TABLE public.finance_event_dedupe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_event_dedupe FROM PUBLIC;
REVOKE ALL ON TABLE public.finance_event_dedupe FROM anon;
REVOKE ALL ON TABLE public.finance_event_dedupe FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.finance_event_dedupe
  TO service_role;
DROP POLICY IF EXISTS finance_event_dedupe_service_policy ON public.finance_event_dedupe;
CREATE POLICY finance_event_dedupe_service_policy
  ON public.finance_event_dedupe
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Table contracts (SSOT): finance ledgers are their own audit; no updated_at.
INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'finance_events', TRUE, FALSE, FALSE, 'Finance SSOT ledger (immutable); audit disabled by contract.'),
  ('public', 'finance_event_dedupe', TRUE, FALSE, FALSE, 'Finance idempotency keys (service-only).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Partitioning registration (HASH+RANGE monthly; long retention for finance).
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
  'finance_events',
  'HASH+RANGE',
  'organization_id|occurred_at',
  'monthly',
  NULL,
  84,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

-- Bootstrap partitions now (idempotent; uses partitioning_config).
SELECT * FROM public.create_next_partitions();

-------------------------------------------------------------------------------
-- 4) Canonical finance write-path RPC (service-only; idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_finance_event_v1(
  p_event JSONB
)
RETURNS TABLE (
  finance_event_id UUID,
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
  v_event_type TEXT := NULL;
  v_direction TEXT := NULL;
  v_amount NUMERIC := NULL;
  v_currency TEXT := NULL;
  v_account_type TEXT := NULL;
  v_account_id UUID := NULL;
  v_subject_type TEXT := NULL;
  v_subject_id UUID := NULL;
  v_decision_log_id UUID := NULL;
  v_settings_resolution_id UUID := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_occurred_at TIMESTAMPTZ := now();

  v_partition_base TEXT;
  v_expected_partition TEXT;
  v_hash_parent RECORD;
  v_remainder INT;
  v_missing BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_event) <> 'object' THEN
    RAISE EXCEPTION 'record_finance_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_event->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  v_event_type := NULLIF(v_event->>'event_type', '');
  v_direction := NULLIF(v_event->>'direction', '');
  BEGIN v_amount := NULLIF(v_event->>'amount', '')::NUMERIC; EXCEPTION WHEN others THEN v_amount := NULL; END;
  v_currency := NULLIF(v_event->>'currency', '');
  v_account_type := NULLIF(v_event->>'account_type', '');
  BEGIN v_account_id := NULLIF(v_event->>'account_id', '')::UUID; EXCEPTION WHEN others THEN v_account_id := NULL; END;
  v_subject_type := NULLIF(v_event->>'subject_type', '');
  BEGIN v_subject_id := NULLIF(v_event->>'subject_id', '')::UUID; EXCEPTION WHEN others THEN v_subject_id := NULL; END;
  BEGIN v_decision_log_id := NULLIF(v_event->>'decision_log_id', '')::UUID; EXCEPTION WHEN others THEN v_decision_log_id := NULL; END;
  BEGIN v_settings_resolution_id := NULLIF(v_event->>'settings_resolution_id', '')::UUID; EXCEPTION WHEN others THEN v_settings_resolution_id := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_event->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_event->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;
  BEGIN v_occurred_at := COALESCE(NULLIF(v_event->>'occurred_at', '')::timestamptz, now()); EXCEPTION WHEN others THEN v_occurred_at := now(); END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_finance_event_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'record_finance_event_v1 missing event_type' USING ERRCODE = '23514';
  END IF;
  IF v_direction IS NULL THEN
    RAISE EXCEPTION 'record_finance_event_v1 missing direction' USING ERRCODE = '23514';
  END IF;
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'record_finance_event_v1 invalid amount' USING ERRCODE = '23514';
  END IF;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'record_finance_event_v1 missing currency' USING ERRCODE = '23514';
  END IF;
  IF v_account_type IS NULL THEN
    RAISE EXCEPTION 'record_finance_event_v1 missing account_type' USING ERRCODE = '23514';
  END IF;

  -- Ensure the monthly partition exists for every HASH parent (future-proof for modulus expansion).
  v_partition_base := public.generate_partition_name_range_monthly('finance_events', v_occurred_at);

  FOR v_hash_parent IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'finance_events'
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

  -- Idempotency: if key exists, return prior finance_event_id without creating a duplicate.
  IF v_idempotency_key IS NOT NULL THEN
    INSERT INTO public.finance_event_dedupe(organization_id, idempotency_key, finance_event_id, created_at)
    VALUES (v_org_id, v_idempotency_key, v_event_id, now())
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

    IF NOT FOUND THEN
      SELECT d.finance_event_id
        INTO v_event_id
        FROM public.finance_event_dedupe d
       WHERE d.organization_id = v_org_id
         AND d.idempotency_key = v_idempotency_key;

      RETURN QUERY SELECT v_event_id, FALSE;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.finance_events(
    id, organization_id,
    event_type, direction, amount, currency,
    account_type, account_id,
    subject_type, subject_id,
    decision_log_id, settings_resolution_id,
    idempotency_key, metadata,
    occurred_at, created_at
  ) VALUES (
    v_event_id, v_org_id,
    v_event_type, v_direction, v_amount, v_currency,
    v_account_type, v_account_id,
    v_subject_type, v_subject_id,
    v_decision_log_id, v_settings_resolution_id,
    v_idempotency_key, v_metadata,
    v_occurred_at, now()
  );

  RETURN QUERY SELECT v_event_id, v_created;
END;
$function$;

COMMENT ON FUNCTION public.record_finance_event_v1(JSONB) IS
  'Service write-path: record an immutable finance_events ledger row (idempotent by organization_id + idempotency_key via finance_event_dedupe).';

REVOKE ALL ON FUNCTION public.record_finance_event_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_finance_event_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212830_finance_events_ledger_foundation'));
COMMIT;
