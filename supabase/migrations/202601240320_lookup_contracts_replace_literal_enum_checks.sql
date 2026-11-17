-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Replace literal-list enum CHECK constraints with lookup contracts (row-driven SSOT)
--
-- Goals
-- - Eliminate hardcoded enum CHECK constraints that encode allowed values via ANY(ARRAY[...]).
-- - Use public.lookup_definitions + public.lookup_values as the SSOT for allowed values.
-- - Use public.lookup_column_contracts as the row-driven mapping (table, column) -> category
--   with optional per-column allowed_values subsets (no per-table hardcoding).
-- - Preserve non-enum integrity checks (e.g., jsonb_typeof exclusions) by rewriting them
--   without literal allowlists when possible.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Extend lookup_column_contracts: optional allowed_values subset
-------------------------------------------------------------------------------

ALTER TABLE public.lookup_column_contracts
  ADD COLUMN IF NOT EXISTS allowed_values TEXT[];

ALTER TABLE public.lookup_column_contracts
  DROP CONSTRAINT IF EXISTS lookup_column_contracts_allowed_values_nonempty;

ALTER TABLE public.lookup_column_contracts
  ADD CONSTRAINT lookup_column_contracts_allowed_values_nonempty
  CHECK (allowed_values IS NULL OR array_length(allowed_values, 1) > 0);

-------------------------------------------------------------------------------
-- 2) Update enforcement trigger: honor allowed_values when present
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_lookup_column_contracts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  v_row JSONB;
  v_val TEXT;
  v_def_id UUID;
  v_allow_inactive BOOLEAN;
BEGIN
  v_row := to_jsonb(NEW);

  FOR rec IN
    SELECT column_name, lookup_category, allow_inactive, allowed_values
    FROM public.lookup_column_contracts
    WHERE table_schema = TG_TABLE_SCHEMA
      AND table_name = TG_TABLE_NAME
  LOOP
    v_val := v_row ->> rec.column_name;
    IF v_val IS NULL THEN
      CONTINUE;
    END IF;
    IF btrim(v_val) = '' THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: empty string is not allowed (category "%")',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.column_name, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;

    IF rec.allowed_values IS NOT NULL AND NOT (v_val = ANY (rec.allowed_values)) THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: "%" is not allowed for category "%" in this column',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.column_name, v_val, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;

    v_allow_inactive := rec.allow_inactive;

    SELECT d.id
    INTO v_def_id
    FROM public.lookup_definitions d
    WHERE d.category = rec.lookup_category;

    IF v_def_id IS NULL THEN
      RAISE EXCEPTION
        'Lookup category "%" is not registered in lookup_definitions (required for %.%.%)',
        rec.lookup_category, TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.column_name
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.lookup_values lv
      WHERE lv.lookup_definition_id = v_def_id
        AND lv.value = v_val
        AND lv.retired_at IS NULL
        AND (v_allow_inactive OR lv.status = 'active')
        AND (lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ) THEN
      RAISE EXCEPTION
        'Invalid lookup value for %.%.%: "%" is not an allowed value for category "%"',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, rec.column_name, v_val, rec.lookup_category
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_lookup_column_contracts()
  SET search_path = public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 3) Add missing lookup categories + values (SSOT)
-------------------------------------------------------------------------------

-- Ensure PATCH is present for http_method (existing category)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'PATCH', 'PATCH', 40, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'http_method'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('scope_type', 'Scope ladder type (global/tenant/client/sender/source/resource)', 'engineering', 'tier_1', false),
  ('audit_redaction_mode', 'Audit redaction allow/deny mode', 'engineering', 'tier_1', false),
  ('audit_op', 'Audit change operation type', 'engineering', 'tier_1', false),
  ('domain_event_status', 'Domain event processing status', 'engineering', 'tier_1', false),
  ('mapping_direction', 'Directional mapping behavior', 'engineering', 'tier_1', false),
  ('geocoding_status', 'Geocoding attempt status', 'engineering', 'tier_1', false),
  ('label_design_draft_status', 'Label design draft status', 'operations', 'tier_1', false),
  ('label_design_token_type', 'Label design token type', 'engineering', 'tier_1', false),
  ('label_template_validation_status', 'Label template validation status', 'engineering', 'tier_1', false),
  ('manual_review_resolution_outcome', 'Manual review resolution outcome', 'operations', 'tier_1', false),
  ('ops_quarantine_status', 'Operations quarantine status', 'operations', 'tier_1', false),
  ('mapping_type', 'Mapping config type', 'engineering', 'tier_1', false),
  ('call_type', 'Operation/outbound call type', 'engineering', 'tier_1', false),
  ('target_type', 'Outbound call target type', 'engineering', 'tier_1', false),
  ('language_code', 'Preferred language code', 'operations', 'tier_1', false),
  ('safe_missing_behavior', 'Safe missing behavior for resolvers', 'engineering', 'tier_1', false),
  ('access_scope_type', 'User access scope type', 'operations', 'tier_1', false),
  ('workflow_enforcement_mode', 'Workflow guardrails enforcement mode', 'engineering', 'tier_1', false),
  ('qa_status', 'QA run/case status', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('scope_type', 'global', 'Global', 10, false),
    ('scope_type', 'tenant', 'Tenant', 20, false),
    ('scope_type', 'client', 'Client', 30, false),
    ('scope_type', 'sender', 'Sender', 40, false),
    ('scope_type', 'source', 'Source', 50, false),
    ('scope_type', 'resource', 'Resource', 60, false),

    ('audit_redaction_mode', 'denylist', 'Denylist', 10, true),
    ('audit_redaction_mode', 'allowlist', 'Allowlist', 20, false),

    ('audit_op', 'INSERT', 'INSERT', 10, false),
    ('audit_op', 'UPDATE', 'UPDATE', 20, false),
    ('audit_op', 'DELETE', 'DELETE', 30, false),
    ('audit_op', 'TRUNCATE', 'TRUNCATE', 40, false),

    ('domain_event_status', 'pending', 'Pending', 10, true),
    ('domain_event_status', 'processing', 'Processing', 20, false),
    ('domain_event_status', 'completed', 'Completed', 30, false),
    ('domain_event_status', 'failed', 'Failed', 40, false),
    ('domain_event_status', 'skipped', 'Skipped', 50, false),

    ('mapping_direction', 'inbound', 'Inbound', 10, false),
    ('mapping_direction', 'outbound', 'Outbound', 20, false),
    ('mapping_direction', 'both', 'Both', 30, true),

    ('geocoding_status', 'queued', 'Queued', 10, true),
    ('geocoding_status', 'in_progress', 'In Progress', 20, false),
    ('geocoding_status', 'succeeded', 'Succeeded', 30, false),
    ('geocoding_status', 'failed', 'Failed', 40, false),
    ('geocoding_status', 'skipped', 'Skipped', 50, false),
    ('geocoding_status', 'deferred', 'Deferred', 60, false),

    ('label_design_draft_status', 'draft', 'Draft', 10, true),
    ('label_design_draft_status', 'published', 'Published', 20, false),
    ('label_design_draft_status', 'archived', 'Archived', 30, false),

    ('label_design_token_type', 'font_size', 'Font Size', 10, false),
    ('label_design_token_type', 'spacing', 'Spacing', 20, false),
    ('label_design_token_type', 'band_height', 'Band Height', 30, false),
    ('label_design_token_type', 'padding', 'Padding', 40, false),
    ('label_design_token_type', 'color', 'Color', 50, false),
    ('label_design_token_type', 'border', 'Border', 60, false),
    ('label_design_token_type', 'barcode_min_width', 'Barcode Min Width', 70, false),
    ('label_design_token_type', 'barcode_min_height', 'Barcode Min Height', 80, false),
    ('label_design_token_type', 'misc', 'Misc', 90, true),

    ('label_template_validation_status', 'pending', 'Pending', 10, true),
    ('label_template_validation_status', 'passed', 'Passed', 20, false),
    ('label_template_validation_status', 'failed', 'Failed', 30, false),

    ('manual_review_resolution_outcome', 'approved', 'Approved', 10, false),
    ('manual_review_resolution_outcome', 'rejected', 'Rejected', 20, false),
    ('manual_review_resolution_outcome', 'resolved', 'Resolved', 30, true),
    ('manual_review_resolution_outcome', 'canceled', 'Canceled', 40, false),

    ('ops_quarantine_status', 'open', 'Open', 10, true),
    ('ops_quarantine_status', 'resolved', 'Resolved', 20, false),
    ('ops_quarantine_status', 'dismissed', 'Dismissed', 30, false),
    ('ops_quarantine_status', 'replayed', 'Replayed', 40, false),

    ('mapping_type', 'provider_response', 'Provider Response', 10, false),
    ('mapping_type', 'webhook_inbound', 'Webhook Inbound', 20, true),
    ('mapping_type', 'webhook_outbound', 'Webhook Outbound', 30, false),
    ('mapping_type', 'event_extraction', 'Event Extraction', 40, false),
    ('mapping_type', 'webhook_response', 'Webhook Response', 50, false),

    ('call_type', 'provider_api', 'Provider API', 10, true),
    ('call_type', 'client_webhook', 'Client Webhook', 20, false),
    ('call_type', 'comms_sms', 'Comms SMS', 30, false),
    ('call_type', 'comms_whatsapp', 'Comms WhatsApp', 40, false),
    ('call_type', 'comms_email', 'Comms Email', 50, false),
    ('call_type', 'comms_voice', 'Comms Voice', 60, false),

    ('target_type', 'provider', 'Provider', 10, true),
    ('target_type', 'client', 'Client', 20, false),
    ('target_type', 'recipient', 'Recipient', 30, false),

    ('language_code', 'ar', 'Arabic', 10, true),
    ('language_code', 'en', 'English', 20, false),

    ('safe_missing_behavior', 'return_null', 'Return NULL', 10, true),
    ('safe_missing_behavior', 'skip', 'Skip', 20, false),
    ('safe_missing_behavior', 'skip_with_ack', 'Skip With Ack', 30, false),
    ('safe_missing_behavior', 'hard_fail', 'Hard Fail', 40, false),

    ('access_scope_type', 'platform', 'Platform', 10, true),
    ('access_scope_type', 'tenant', 'Tenant', 20, false),
    ('access_scope_type', 'client', 'Client', 30, false),
    ('access_scope_type', 'sender', 'Sender', 40, false),

    ('workflow_enforcement_mode', 'enforce', 'Enforce', 10, true),
    ('workflow_enforcement_mode', 'warn', 'Warn', 20, false),
    ('workflow_enforcement_mode', 'disabled', 'Disabled', 30, false),

    ('qa_status', 'running', 'Running', 10, true),
    ('qa_status', 'passed', 'Passed', 20, false),
    ('qa_status', 'failed', 'Failed', 30, false),
    ('qa_status', 'skipped', 'Skipped', 40, false),
    ('qa_status', 'canceled', 'Canceled', 50, false)
) v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Row-driven metadata: access_scope_type requires access_scope_id for some values.
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || jsonb_build_object('requires_scope_id', true)
WHERE lv.lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'access_scope_type')
  AND lv.value IN ('client', 'sender');

UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || jsonb_build_object('requires_scope_id', false)
WHERE lv.lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'access_scope_type')
  AND lv.value IN ('platform', 'tenant');

-------------------------------------------------------------------------------
-- 4) Column contracts: map columns to categories + optional allowed_values
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category, allowed_values)
VALUES
  -- API/log method + direction
  ('public', 'api_call_log', 'method', 'http_method', NULL),
  ('public', 'webhook_log', 'method', 'http_method', NULL),
  ('public', 'webhook_log', 'direction', 'mapping_direction', ARRAY['inbound','outbound']),

  -- Scope ladder types (single SSOT category; per-column subsets)
  ('public', 'api_routes', 'scope_type', 'scope_type', ARRAY['global','tenant','client','sender','source']),
  ('public', 'label_design_drafts', 'scope_type', 'scope_type', ARRAY['tenant','client','sender']),
  ('public', 'label_template_specs', 'template_scope_type', 'scope_type', ARRAY['global','tenant','client','sender','resource']),

  -- Auditing + domain statuses
  ('public', 'audit_redaction_rules', 'mode', 'audit_redaction_mode', NULL),
  ('public', 'audit_table_changes', 'op', 'audit_op', NULL),
  ('public', 'domain_events', 'status', 'domain_event_status', NULL),

  -- Mapping + ops
  ('public', 'field_mappings', 'direction', 'mapping_direction', NULL),
  ('public', 'mapping_configs', 'mapping_type', 'mapping_type', NULL),
  ('public', 'operation_templates', 'call_type', 'call_type', NULL),
  ('public', 'ops_quarantine', 'status', 'ops_quarantine_status', NULL),

  -- Geocoding attempts
  ('public', 'geocoding_attempts', 'status', 'geocoding_status', NULL),

  -- Labels/templates
  ('public', 'label_design_drafts', 'status', 'label_design_draft_status', NULL),
  ('public', 'label_design_tokens', 'token_type', 'label_design_token_type', NULL),
  ('public', 'label_template_validation', 'validation_status', 'label_template_validation_status', NULL),

  -- Manual review
  ('public', 'manual_review_tasks', 'resolution_outcome', 'manual_review_resolution_outcome', NULL),

  -- Outbound calls
  ('public', 'outbound_calls', 'call_type', 'call_type', NULL),
  ('public', 'outbound_calls', 'target_type', 'target_type', NULL),

  -- Recipients
  ('public', 'recipients', 'preferred_language', 'language_code', NULL),

  -- Settings governance
  ('public', 'settings_category_registry', 'safe_missing_behavior', 'safe_missing_behavior', NULL),

  -- Users
  ('public', 'users', 'access_scope_type', 'access_scope_type', NULL),

  -- Workflow guardrails
  ('public', 'workflow_guardrails', 'enforcement_mode', 'workflow_enforcement_mode', NULL),

  -- QA schema (internal, but still row-driven)
  ('qa', 'qa_runs', 'status', 'qa_status', NULL),
  ('qa', 'qa_run_steps', 'status', 'qa_status', NULL),
  ('qa', 'qa_case_results', 'status', 'qa_status', ARRAY['passed','failed','skipped'])
ON CONFLICT (table_schema, table_name, column_name)
DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

-- Apply triggers for all affected tables in public + qa.
SELECT public.apply_lookup_column_contracts('public');
SELECT public.apply_lookup_column_contracts('qa');

-------------------------------------------------------------------------------
-- 5) Replace the users access_scope_id consistency check with row-driven metadata
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lookup_value_meta_bool(
  p_category TEXT,
  p_value TEXT,
  p_key TEXT,
  p_default BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((lv.metadata ->> p_key)::boolean, p_default)
  FROM public.lookup_definitions d
  JOIN public.lookup_values lv
    ON lv.lookup_definition_id = d.id
  WHERE d.category = p_category
    AND lv.value = p_value
    AND lv.retired_at IS NULL
  LIMIT 1
$$;

ALTER FUNCTION public.lookup_value_meta_bool(TEXT, TEXT, TEXT, BOOLEAN)
  SET search_path = public, extensions, pg_temp;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_access_scope_consistency_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_access_scope_consistency_check
  CHECK (
    (access_scope_id IS NOT NULL) =
      public.lookup_value_meta_bool('access_scope_type', access_scope_type, 'requires_scope_id', false)
  );

-------------------------------------------------------------------------------
-- 6) Drop legacy literal-list enum CHECK constraints (parents + all descendants)
-------------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
  child_relid REGCLASS;
BEGIN
  FOR r IN
    SELECT parent_relid, constraint_name
    FROM (
      VALUES
        ('public.api_call_log'::regclass, 'api_call_log_method_check'),
        ('public.api_routes'::regclass, 'api_routes_scope_type_ck'),
        ('public.audit_redaction_rules'::regclass, 'audit_redaction_rules_mode_check'),
        ('public.audit_table_changes'::regclass, 'audit_table_changes_op_check'),
        ('public.domain_events'::regclass, 'domain_events_status_check'),
        ('public.field_mappings'::regclass, 'field_mappings_direction_check'),
        ('public.geocoding_attempts'::regclass, 'geocoding_attempts_attempt_type_check'),
        ('public.geocoding_attempts'::regclass, 'geocoding_attempts_status_check'),
        ('public.label_design_drafts'::regclass, 'label_design_drafts_scope_type_ck'),
        ('public.label_design_drafts'::regclass, 'label_design_drafts_status_ck'),
        ('public.label_design_tokens'::regclass, 'label_design_tokens_type_chk'),
        ('public.label_template_specs'::regclass, 'label_template_specs_scope_type_chk'),
        ('public.label_template_validation'::regclass, 'label_template_validation_status_chk'),
        ('public.manual_review_tasks'::regclass, 'manual_review_tasks_resolution_outcome_check'),
        ('public.mapping_configs'::regclass, 'mapping_configs_type_check'),
        ('public.operation_templates'::regclass, 'operation_templates_call_type_check'),
        ('public.ops_quarantine'::regclass, 'ops_quarantine_status_check'),
        ('public.outbound_calls'::regclass, 'outbound_calls_call_type_check'),
        ('public.outbound_calls'::regclass, 'outbound_calls_target_type_check'),
        ('public.recipients'::regclass, 'recipients_preferred_language_check'),
        ('public.settings_category_registry'::regclass, 'settings_category_registry_safe_missing_behavior_ck'),
        ('public.users'::regclass, 'users_access_scope_type_check'),
        ('public.webhook_log'::regclass, 'webhook_log_direction_check'),
        ('public.webhook_log'::regclass, 'webhook_log_method_check'),
        ('public.workflow_guardrails'::regclass, 'workflow_guardrails_enforcement_mode_ck'),
        ('qa.qa_case_results'::regclass, 'qa_case_results_status_check'),
        ('qa.qa_run_steps'::regclass, 'qa_run_steps_status_check'),
        ('qa.qa_runs'::regclass, 'qa_runs_status_check')
    ) AS t(parent_relid, constraint_name)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.parent_relid, r.constraint_name);

    FOR child_relid IN
      WITH RECURSIVE descendants AS (
        SELECT inhrelid
        FROM pg_inherits
        WHERE inhparent = r.parent_relid
        UNION ALL
        SELECT i.inhrelid
        FROM pg_inherits i
        JOIN descendants d
          ON i.inhparent = d.inhrelid
      )
      SELECT inhrelid::regclass
      FROM descendants
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', child_relid, r.constraint_name);
    END LOOP;
  END LOOP;
END $$;

-- Rewrite (not remove) label_design_tokens_value_type_chk to avoid a literal allowlist.
-- Note: This is a partitioned table; rewriting the parent constraint is sufficient.
ALTER TABLE public.label_design_tokens
  DROP CONSTRAINT IF EXISTS label_design_tokens_value_type_chk;

ALTER TABLE public.label_design_tokens
  ADD CONSTRAINT label_design_tokens_value_type_chk
  CHECK (jsonb_typeof(value) <> 'boolean' AND jsonb_typeof(value) <> 'null');

COMMIT;
