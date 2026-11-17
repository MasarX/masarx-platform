-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Dynamic lookup enforcement (row-driven contract)
--
-- Goals
-- - Eliminate hardcoded enums in the data plane by enforcing "lookup category" values via SSOT tables:
--   - public.lookup_definitions (categories)
--   - public.lookup_values (allowed values)
-- - Keep enforcement dynamic: table/column mappings are rows in public.lookup_column_contracts.
--
-- Notes
-- - Enforcement is implemented as a generic trigger that reads contract rows per table.
-- - Triggers are attached per table automatically via apply_lookup_column_contracts().

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Ensure lookup categories exist (enterprise readiness baseline)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('approval_status', 'Settings approval workflow status', 'engineering', 'tier_1', false),
  ('backoff_strategy', 'Rate limit backoff strategy', 'engineering', 'tier_1', false),
  ('billing_status', 'Organization billing status', 'operations', 'tier_1', false),
  ('circuit_state', 'Circuit breaker state', 'engineering', 'tier_1', false),
  ('client_status', 'Client lifecycle status', 'operations', 'tier_1', false),
  ('communication_channel', 'Communication channel', 'operations', 'tier_1', false),
  ('component_health_status', 'Component health status', 'engineering', 'tier_1', false),
  ('domain_category', 'Webhook domain category', 'engineering', 'tier_1', false),
  ('feature_flag_scope', 'Feature flag scope ladder', 'engineering', 'tier_1', false),
  ('geocoding_attempt_type', 'Geocoding attempt type', 'engineering', 'tier_1', false),
  ('http_method', 'HTTP method', 'engineering', 'tier_1', false),
  ('job_status', 'Job status', 'engineering', 'tier_1', false),
  ('lookup_value_status', 'Lookup value status', 'engineering', 'tier_1', false),
  ('mapping_domain', 'Mapping domain', 'engineering', 'tier_1', false),
  ('message_status', 'Message delivery status', 'operations', 'tier_1', false),
  ('processing_status', 'Webhook processing status', 'engineering', 'tier_1', false),
  ('provider_auth_type', 'Provider authentication type', 'engineering', 'tier_1', false),
  ('provider_type', 'Provider type', 'engineering', 'tier_1', false),
  ('rate_limit_window', 'Rate limit window unit', 'engineering', 'tier_1', false),
  ('request_entry_point', 'Workflow entry point', 'engineering', 'tier_1', false),
  ('sender_status', 'Sender lifecycle status', 'operations', 'tier_1', false),
  ('settings_audit_action', 'Settings audit log action', 'engineering', 'tier_1', false),
  ('sla_tier', 'Client SLA tier', 'operations', 'tier_1', false),
  ('urgency_level', 'Message urgency level', 'operations', 'tier_1', false),
  ('user_status', 'User lifecycle status', 'operations', 'tier_1', false),
  ('user_type', 'User type / platform role', 'operations', 'tier_1', false),
  ('workflow_run_status', 'Workflow run status', 'engineering', 'tier_1', false),
  ('workflow_status', 'Workflow template status', 'engineering', 'tier_1', false),
  ('workflow_step_status', 'Workflow run step status', 'engineering', 'tier_1', false),
  ('workflow_transition', 'Workflow step transition condition', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('approval_status', 'pending', 'Pending', 10, true),
    ('approval_status', 'approved', 'Approved', 20, false),
    ('approval_status', 'rejected', 'Rejected', 30, false),
    ('approval_status', 'withdrawn', 'Withdrawn', 40, false),

    ('backoff_strategy', 'linear', 'Linear', 10, true),
    ('backoff_strategy', 'exponential', 'Exponential', 20, false),
    ('backoff_strategy', 'fibonacci', 'Fibonacci', 30, false),

    ('billing_status', 'active', 'Active', 10, true),
    ('billing_status', 'suspended', 'Suspended', 20, false),
    ('billing_status', 'trial', 'Trial', 30, false),

    ('circuit_state', 'closed', 'Closed', 10, true),
    ('circuit_state', 'open', 'Open', 20, false),
    ('circuit_state', 'half_open', 'Half Open', 30, false),

    ('client_status', 'active', 'Active', 10, true),
    ('client_status', 'suspended', 'Suspended', 20, false),
    ('client_status', 'terminated', 'Terminated', 30, false),

    ('communication_channel', 'sms', 'SMS', 10, false),
    ('communication_channel', 'whatsapp', 'WhatsApp', 20, true),
    ('communication_channel', 'email', 'Email', 30, false),

    ('component_health_status', 'healthy', 'Healthy', 10, true),
    ('component_health_status', 'degraded', 'Degraded', 20, false),
    ('component_health_status', 'down', 'Down', 30, false),

    ('domain_category', 'shipment', 'Shipment', 10, true),
    ('domain_category', 'tracking', 'Tracking', 20, false),
    ('domain_category', 'communication', 'Communication', 30, false),
    ('domain_category', 'delivery_sync', 'Delivery Sync', 40, false),

    ('feature_flag_scope', 'global', 'Global', 10, true),
    ('feature_flag_scope', 'tenant', 'Tenant', 20, false),
    ('feature_flag_scope', 'client', 'Client', 30, false),

    ('geocoding_attempt_type', 'primary', 'Primary', 10, true),
    ('geocoding_attempt_type', 'fallback', 'Fallback', 20, false),
    ('geocoding_attempt_type', 'retry', 'Retry', 30, false),
    ('geocoding_attempt_type', 'manual_review', 'Manual Review', 40, false),
    ('geocoding_attempt_type', 'cache_hit', 'Cache Hit', 50, false),

    ('http_method', 'GET', 'GET', 10, false),
    ('http_method', 'POST', 'POST', 20, true),
    ('http_method', 'PUT', 'PUT', 30, false),
    ('http_method', 'DELETE', 'DELETE', 40, false),

    ('job_status', 'pending', 'Pending', 10, true),
    ('job_status', 'in_progress', 'In Progress', 20, false),
    ('job_status', 'completed', 'Completed', 30, false),
    ('job_status', 'failed', 'Failed', 40, false),
    ('job_status', 'permanently_failed', 'Permanently Failed', 50, false),

    ('lookup_value_status', 'draft', 'Draft', 10, false),
    ('lookup_value_status', 'active', 'Active', 20, true),
    ('lookup_value_status', 'archived', 'Archived', 30, false),

    ('mapping_domain', 'status', 'Status', 10, true),
    ('mapping_domain', 'service_level', 'Service Level', 20, false),
    ('mapping_domain', 'country_code', 'Country Code', 30, false),
    ('mapping_domain', 'payment_method', 'Payment Method', 40, false),
    ('mapping_domain', 'currency', 'Currency', 50, false),
    ('mapping_domain', 'unit_of_measure', 'Unit Of Measure', 60, false),

    ('message_status', 'sent', 'Sent', 10, true),
    ('message_status', 'delivered', 'Delivered', 20, false),
    ('message_status', 'failed', 'Failed', 30, false),
    ('message_status', 'bounce', 'Bounce', 40, false),

    ('processing_status', 'pending', 'Pending', 10, true),
    ('processing_status', 'processing', 'Processing', 20, false),
    ('processing_status', 'succeeded', 'Succeeded', 30, false),
    ('processing_status', 'failed', 'Failed', 40, false),

    ('provider_auth_type', 'api_key', 'API Key', 10, true),
    ('provider_auth_type', 'oauth2', 'OAuth 2.0', 20, false),
    ('provider_auth_type', 'bearer_token', 'Bearer Token', 30, false),
    ('provider_auth_type', 'basic_auth', 'Basic Auth', 40, false),
    ('provider_auth_type', 'hmac', 'HMAC', 50, false),
    ('provider_auth_type', 'custom', 'Custom', 60, false),

    ('provider_type', 'comms', 'Comms', 10, false),
    ('provider_type', 'geocoding', 'Geocoding', 20, true),
    ('provider_type', 'routing', 'Routing', 30, false),
    ('provider_type', 'webhook', 'Webhook', 40, false),
    ('provider_type', 'payment', 'Payment', 50, false),
    ('provider_type', 'delivery', 'Delivery', 60, false),

    ('rate_limit_window', 'second', 'Second', 10, false),
    ('rate_limit_window', 'minute', 'Minute', 20, true),
    ('rate_limit_window', 'hour', 'Hour', 30, false),
    ('rate_limit_window', 'day', 'Day', 40, false),

    ('request_entry_point', 'webhook', 'Webhook', 10, true),
    ('request_entry_point', 'api', 'API', 20, false),
    ('request_entry_point', 'worker', 'Worker', 30, false),
    ('request_entry_point', 'manual', 'Manual', 40, false),

    ('sender_status', 'active', 'Active', 10, true),
    ('sender_status', 'inactive', 'Inactive', 20, false),

    ('settings_audit_action', 'created', 'Created', 10, true),
    ('settings_audit_action', 'approved', 'Approved', 20, false),
    ('settings_audit_action', 'applied', 'Applied', 30, false),
    ('settings_audit_action', 'rolled_back', 'Rolled Back', 40, false),
    ('settings_audit_action', 'reverted', 'Reverted', 50, false),

    ('sla_tier', 'economy', 'Economy', 10, false),
    ('sla_tier', 'standard', 'Standard', 20, true),
    ('sla_tier', 'premium', 'Premium', 30, false),

    ('urgency_level', 'low', 'Low', 10, false),
    ('urgency_level', 'medium', 'Medium', 20, true),
    ('urgency_level', 'high', 'High', 30, false),
    ('urgency_level', 'critical', 'Critical', 40, false),

    ('user_status', 'active', 'Active', 10, true),
    ('user_status', 'suspended', 'Suspended', 20, false),

    ('user_type', 'ops_admin', 'Ops Admin', 10, false),
    ('user_type', 'account_manager', 'Account Manager', 20, false),
    ('user_type', 'super_admin', 'Super Admin', 30, true),
    ('user_type', 'driver', 'Driver', 40, false),
    ('user_type', 'dispatcher', 'Dispatcher', 50, false),

    ('workflow_run_status', 'pending', 'Pending', 10, true),
    ('workflow_run_status', 'in_progress', 'In Progress', 20, false),
    ('workflow_run_status', 'completed', 'Completed', 30, false),
    ('workflow_run_status', 'failed', 'Failed', 40, false),
    ('workflow_run_status', 'cancelled', 'Cancelled', 50, false),

    ('workflow_status', 'draft', 'Draft', 10, true),
    ('workflow_status', 'active', 'Active', 20, false),
    ('workflow_status', 'archived', 'Archived', 30, false),

    ('workflow_step_status', 'pending', 'Pending', 10, true),
    ('workflow_step_status', 'in_progress', 'In Progress', 20, false),
    ('workflow_step_status', 'completed', 'Completed', 30, false),
    ('workflow_step_status', 'failed', 'Failed', 40, false),
    ('workflow_step_status', 'skipped', 'Skipped', 50, false),

    ('workflow_transition', 'success', 'Success', 10, false),
    ('workflow_transition', 'failure', 'Failure', 20, false),
    ('workflow_transition', 'always', 'Always', 30, true),
    ('workflow_transition', 'custom', 'Custom', 40, false)
) AS v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Contract table: lookup_column_contracts (SSOT mapping columns -> categories)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lookup_column_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_schema TEXT NOT NULL DEFAULT 'public',
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  lookup_category TEXT NOT NULL,
  allow_inactive BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lookup_column_contracts_schema_nonempty CHECK (btrim(table_schema) <> ''),
  CONSTRAINT lookup_column_contracts_table_nonempty CHECK (btrim(table_name) <> ''),
  CONSTRAINT lookup_column_contracts_column_nonempty CHECK (btrim(column_name) <> ''),
  CONSTRAINT lookup_column_contracts_category_nonempty CHECK (btrim(lookup_category) <> ''),
  CONSTRAINT lookup_column_contracts_unique UNIQUE (table_schema, table_name, column_name)
);

COMMENT ON TABLE public.lookup_column_contracts IS
  'Row-driven lookup enforcement contracts: maps (table, column) -> lookup_definitions.category for dynamic enum governance.';

ALTER TABLE public.lookup_column_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lookup_column_contracts FROM PUBLIC;
REVOKE ALL ON TABLE public.lookup_column_contracts FROM anon;
REVOKE ALL ON TABLE public.lookup_column_contracts FROM authenticated;

DROP POLICY IF EXISTS lookup_column_contracts_service_policy ON public.lookup_column_contracts;
CREATE POLICY lookup_column_contracts_service_policy
  ON public.lookup_column_contracts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_lookup_column_contracts_set_updated_at ON public.lookup_column_contracts;
CREATE TRIGGER trg_lookup_column_contracts_set_updated_at
  BEFORE UPDATE ON public.lookup_column_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) Seed baseline column contracts (derived from existing "Lookup category" docs)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'organizations', 'billing_status', 'billing_status'),
  ('public', 'users', 'user_type', 'user_type'),
  ('public', 'users', 'status', 'user_status'),
  ('public', 'clients', 'sla_tier', 'sla_tier'),
  ('public', 'clients', 'status', 'client_status'),
  ('public', 'senders', 'status', 'sender_status'),
  ('public', 'settings_versions', 'scope_type', 'scope_type'),
  ('public', 'settings_approval_queue', 'status', 'approval_status'),
  ('public', 'feature_flags', 'scope_type', 'feature_flag_scope'),
  ('public', 'settings_change_log', 'action', 'settings_audit_action'),
  ('public', 'lookup_values', 'status', 'lookup_value_status'),
  ('public', 'field_mappings', 'mapping_domain', 'mapping_domain'),
  ('public', 'decision_log', 'decision_category', 'decision_category'),
  ('public', 'message_templates', 'channel', 'communication_channel'),
  ('public', 'message_templates', 'urgency_level', 'urgency_level'),
  ('public', 'recipient_preferences', 'channel', 'communication_channel'),
  ('public', 'comms_attempts', 'status', 'message_status'),
  ('public', 'outbound_calls', 'status', 'job_status'),
  ('public', 'workflow_templates', 'status', 'workflow_status'),
  ('public', 'workflow_template_steps', 'transition_condition', 'workflow_transition'),
  ('public', 'workflow_runs', 'entry_point', 'request_entry_point'),
  ('public', 'workflow_runs', 'workflow_status', 'workflow_run_status'),
  ('public', 'workflow_run_steps', 'step_status', 'workflow_step_status'),
  ('public', 'providers', 'provider_type', 'provider_type'),
  ('public', 'providers', 'health_status', 'component_health_status'),
  ('public', 'provider_auth_configs', 'auth_type', 'provider_auth_type'),
  ('public', 'operation_templates', 'method', 'http_method'),
  ('public', 'rate_limits', 'window_type', 'rate_limit_window'),
  ('public', 'rate_limits', 'backoff_strategy', 'backoff_strategy'),
  ('public', 'webhook_inbox', 'processing_status', 'processing_status'),
  ('public', 'webhook_rules', 'domain_category', 'domain_category'),
  ('public', 'circuit_breaker_state', 'state', 'circuit_state'),
  ('public', 'geocoding_attempts', 'attempt_type', 'geocoding_attempt_type')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO NOTHING;

-------------------------------------------------------------------------------
-- 4) Enforcement trigger function (generic; table-driven)
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
    SELECT column_name, lookup_category, allow_inactive
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
-- 5) Trigger applier (generic; attaches per-table triggers based on contract rows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_lookup_column_contracts(p_table_schema TEXT DEFAULT 'public')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  v_cols TEXT;
  v_fq TEXT;
  v_trg TEXT;
BEGIN
  FOR rec IN
    SELECT table_schema, table_name
    FROM public.lookup_column_contracts
    WHERE table_schema = p_table_schema
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
  LOOP
    v_fq := format('%I.%I', rec.table_schema, rec.table_name);
    IF to_regclass(v_fq) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT string_agg(format('%I', column_name), ', ' ORDER BY column_name)
    INTO v_cols
    FROM public.lookup_column_contracts
    WHERE table_schema = rec.table_schema
      AND table_name = rec.table_name;

    IF v_cols IS NULL OR btrim(v_cols) = '' THEN
      CONTINUE;
    END IF;

    v_trg := 'trg_lookup_contract_' || substr(md5(rec.table_schema || '.' || rec.table_name), 1, 12);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', v_trg, v_fq);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts()',
      v_trg,
      v_cols,
      v_fq
    );
  END LOOP;
END;
$$;

ALTER FUNCTION public.apply_lookup_column_contracts(TEXT)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.apply_lookup_column_contracts(TEXT) IS
  'Attaches lookup enforcement triggers for tables in lookup_column_contracts (row-driven; no per-table hardcoding).';

SELECT public.apply_lookup_column_contracts('public');

COMMIT;

