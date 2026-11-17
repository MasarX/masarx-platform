-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Bank accounts + bank reconciliation policy (statement ingestion foundation)
-- Date: 2026-01-22
--
-- Goals:
--   - Introduce bank_accounts as the SSOT for tenant bank accounts (non-sensitive fields only; hashes/last4 allowed).
--   - Add bank_reconciliation_policy settings category (ladder-resolved, row-driven).
--   - Provide a service-only ingestion RPC for bank statement lines that records them into finance_events (SSOT).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221120_bank_accounts_and_bank_reconciliation_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) SSOT table: bank_accounts (tenant-scoped)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Stable org-scoped key (prefer referencing by key in settings; avoid storing UUIDs in policy JSON).
  key TEXT NOT NULL,
  name TEXT,
  bank_name TEXT,

  currency TEXT NOT NULL,

  -- Do not store full IBAN/account numbers here. Keep only safe derivatives.
  iban_last4 TEXT,
  iban_sha256 BYTEA,
  account_last4 TEXT,
  account_sha256 BYTEA,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT bank_accounts_key_nonempty CHECK (btrim(key) <> ''),
  CONSTRAINT bank_accounts_key_lower CHECK (key = lower(key)),
  CONSTRAINT bank_accounts_currency_nonempty CHECK (btrim(currency) <> ''),
  CONSTRAINT bank_accounts_key_unique UNIQUE (organization_id, key),
  CONSTRAINT bank_accounts_iban_sha256_unique UNIQUE (organization_id, iban_sha256),
  CONSTRAINT bank_accounts_account_sha256_unique UNIQUE (organization_id, account_sha256)
);

COMMENT ON TABLE public.bank_accounts IS 'Tenant bank accounts (SSOT). Stores only safe identifiers (hash/last4), never full IBAN/account numbers.';

DROP TRIGGER IF EXISTS trg_bank_accounts_set_updated_at ON public.bank_accounts;
CREATE TRIGGER trg_bank_accounts_set_updated_at
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- RLS (tenant isolation): authenticated read; service-only writes.
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bank_accounts FROM PUBLIC;
REVOKE ALL ON TABLE public.bank_accounts FROM anon;
REVOKE ALL ON TABLE public.bank_accounts FROM authenticated;
GRANT SELECT ON TABLE public.bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bank_accounts TO service_role;

DROP POLICY IF EXISTS bank_accounts_service_policy ON public.bank_accounts;
CREATE POLICY bank_accounts_service_policy
  ON public.bank_accounts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS bank_accounts_authenticated_select ON public.bank_accounts;
CREATE POLICY bank_accounts_authenticated_select
  ON public.bank_accounts
  FOR SELECT
  TO authenticated
  USING (organization_id = public.current_user_org_id());

-- Table contracts + audit triggers (row-driven).
INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES (
  'public',
  'bank_accounts',
  TRUE,
  TRUE,
  TRUE,
  'Tenant bank accounts (non-sensitive fields only). Authenticated can SELECT; writes are service-only.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.ensure_audit_triggers();

-------------------------------------------------------------------------------
-- 2) Lookups (row-driven): finance_event_type + finance_account_type additions
-------------------------------------------------------------------------------

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
  ('bank_statement', 'Bank Statement', 'Bank statement line ingested from bank feed/import', 75, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'finance_event_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

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
  ('bank_account', 'Bank Account', 'Bank account (per tenant)', 15, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'finance_account_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Settings: bank_reconciliation_policy category + schema + safe global default
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
  'bank_reconciliation_policy',
  'Bank reconciliation and matching policy (bank statement ingestion/matching; row-driven).',
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
  'bank_reconciliation_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Bank Reconciliation Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "default_bank_account_key": { "type": ["string", "null"] },
      "bank_statement_event_type": { "type": ["string", "null"] },
      "match": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "window_days_before": { "type": ["integer", "null"], "minimum": 0 },
          "window_days_after": { "type": ["integer", "null"], "minimum": 0 },
          "amount_tolerance": { "type": ["number", "null"], "minimum": 0 },
          "require_unique": { "type": ["boolean", "null"] }
        }
      }
    }
  }'::jsonb,
  'Policy resolved via settings ladder; controls how bank statement lines are matched to internal settlement batches (no hardcoded tenant logic).',
  '[
    {
      "version": 1,
      "enabled": false,
      "default_bank_account_key": null,
      "bank_statement_event_type": "bank_statement",
      "match": { "window_days_before": 2, "window_days_after": 2, "amount_tolerance": 0, "require_unique": true }
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO NOTHING;

-- Seed safe global default (disabled).
WITH policy_upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', false,
    'default_bank_account_key', NULL,
    'bank_statement_event_type', 'bank_statement',
    'match', jsonb_build_object(
      'window_days_before', 2,
      'window_days_after', 2,
      'amount_tolerance', 0,
      'require_unique', true
    )
  ) AS body
),
insert_versions AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
  SELECT 'bank_reconciliation_policy', 'global', NULL, 1, policy_upsert.body, 1, now()
  FROM policy_upsert
  ON CONFLICT DO NOTHING
  RETURNING category, scope_type, scope_id, id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM insert_versions sv
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND s.scope_id IS NULL
);

-------------------------------------------------------------------------------
-- 4) Resolver wrapper (ladder compliance): resolve_bank_reconciliation_policy
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_bank_reconciliation_policy(
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('bank_reconciliation_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) IS
  'Resolve bank_reconciliation_policy via canonical policy context resolver (resource > source > sender > client > tenant > global).';

REVOKE ALL ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_bank_reconciliation_policy(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 5) Service RPC: record_bank_statement_event_v1 (SSOT = finance_events)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_bank_statement_event_v1(
  p_input JSONB
)
RETURNS TABLE (
  finance_event_id UUID,
  created BOOLEAN,
  decision_log_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);

  v_org_id UUID := NULL;
  v_bank_account_id UUID := NULL;
  v_bank_account_key TEXT := NULL;

  v_event_type TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'event_type', 'bank_statement')), ''));
  v_direction TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'direction', '')), ''));
  v_amount NUMERIC := NULL;
  v_currency TEXT := NULLIF(btrim(COALESCE(v_input->>'currency', '')), '');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_occurred_at TIMESTAMPTZ := now();

  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_decision_id UUID := NULL;

  v_created RECORD;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_bank_account_id := NULLIF(v_input->>'bank_account_id', '')::uuid; EXCEPTION WHEN others THEN v_bank_account_id := NULL; END;
  v_bank_account_key := lower(NULLIF(btrim(COALESCE(v_input->>'bank_account_key', '')), ''));
  BEGIN v_amount := NULLIF(v_input->>'amount', '')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_occurred_at := COALESCE(NULLIF(v_input->>'occurred_at', '')::timestamptz, now()); EXCEPTION WHEN others THEN v_occurred_at := now(); END;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;
  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing event_type' USING ERRCODE = '23514';
  END IF;
  IF v_direction IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing direction' USING ERRCODE = '23514';
  END IF;
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 invalid amount' USING ERRCODE = '23514';
  END IF;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing currency' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'record_bank_statement_event_v1 missing idempotency_key' USING ERRCODE = '23514';
  END IF;

  IF v_bank_account_id IS NULL THEN
    IF v_bank_account_key IS NULL THEN
      RAISE EXCEPTION 'record_bank_statement_event_v1 requires bank_account_id or bank_account_key' USING ERRCODE = '23514';
    END IF;

    SELECT ba.id
      INTO v_bank_account_id
      FROM public.bank_accounts ba
     WHERE ba.organization_id = v_org_id
       AND ba.key = v_bank_account_key
       AND ba.is_active IS TRUE
     LIMIT 1;

    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'record_bank_statement_event_v1 bank_account_key % not found for organization_id %', v_bank_account_key, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF jsonb_typeof(v_metadata) <> 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  v_metadata := public.jsonb_deep_merge(
    v_metadata,
    jsonb_strip_nulls(jsonb_build_object(
      'bank_account_id', v_bank_account_id,
      'bank_account_key', v_bank_account_key
    ))
  );

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'bank_account',
    p_resource_id := v_bank_account_id,
    p_decision_point := 'bank_statement_ingest',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'record_bank_statement_event_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'event_type', v_event_type,
      'direction', v_direction,
      'amount', v_amount,
      'currency', v_currency,
      'occurred_at', v_occurred_at,
      'idempotency_key', v_idempotency_key
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  SELECT finance_event_id, created
    INTO v_created
    FROM public.record_finance_event_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_org_id,
        'event_type', v_event_type,
        'direction', v_direction,
        'amount', v_amount,
        'currency', v_currency,
        'account_type', 'bank_account',
        'account_id', v_bank_account_id,
        'subject_type', 'bank_account',
        'subject_id', v_bank_account_id,
        'decision_log_id', v_decision_id,
        'settings_resolution_id', NULL,
        'idempotency_key', v_idempotency_key,
        'metadata', v_metadata,
        'occurred_at', v_occurred_at
      ))
    )
   LIMIT 1;

  finance_event_id := v_created.finance_event_id;
  created := v_created.created;
  decision_log_id := v_decision_id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.record_bank_statement_event_v1(JSONB) IS
  'Service-only ingestion path for bank statement lines: records an immutable finance_events row (account_type=bank_account) and logs a decision; idempotent via finance_event_dedupe.';

REVOKE ALL ON FUNCTION public.record_bank_statement_event_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_bank_statement_event_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601221120_bank_accounts_and_bank_reconciliation_policy_v1'));
COMMIT;

