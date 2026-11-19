-- pgTAP: Console V2 Billing readback resources.
-- Ensures invoice drawer support data is reachable through backend-backed,
-- scope-aware resources without exposing the service-only usage ledger table.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

SELECT has_view('public', 'v_usage_event_directory', 'Billing usage readback view exists');
SELECT has_view('public', 'v_commercial_agreement_directory', 'Billing agreement readback view exists');
SELECT has_view('public', 'v_commercial_agreement_term_directory', 'Billing agreement term readback view exists');

SELECT columns_are(
  'public',
  'v_usage_event_directory',
  ARRAY[
    'id', 'organization_id', 'client_id', 'sender_id',
    'metric_key', 'kind', 'quantity', 'qty', 'unit',
    'subject_type', 'subject_id', 'actor_user_id',
    'metadata', 'occurred_at', 'received_at', 'created_at'
  ],
  'usage readback view exposes canonical columns plus Billing FE aliases'
);

SELECT columns_are(
  'public',
  'v_commercial_agreement_directory',
  ARRAY[
    'id', 'organization_id', 'client_id', 'sender_id',
    'agreement_code', 'title', 'status', 'effective_from',
    'effective_until', 'expires_at', 'signed_at', 'signed_by_user_id',
    'metadata', 'created_at', 'updated_at'
  ],
  'agreement readback view exposes canonical columns plus expires_at alias'
);

SELECT columns_are(
  'public',
  'v_commercial_agreement_term_directory',
  ARRAY[
    'id', 'organization_id', 'client_id', 'sender_id',
    'agreement_id', 'category', 'settings_version_id',
    'settings_scope_hash', 'metadata', 'created_at', 'updated_at'
  ],
  'agreement term readback view exposes agreement scope columns'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.v_usage_event_directory', 'SELECT'),
  'authenticated can SELECT the usage readback view'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.v_commercial_agreement_directory', 'SELECT'),
  'authenticated can SELECT the agreement readback view'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.v_commercial_agreement_term_directory', 'SELECT'),
  'authenticated can SELECT the agreement term readback view'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.usage_events', 'SELECT'),
  'usage_events remains service-only for direct table reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
     WHERE value->>'key' = 'usage_events'
       AND value->>'relation' = 'public.v_usage_event_directory'
       AND value#>>'{scope_columns,tenant}' = 'organization_id'
  ),
  'ui_read_registry routes usage_events through the usage readback projection'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
     WHERE value->>'key' = 'commercial_agreements'
       AND value->>'relation' = 'public.v_commercial_agreement_directory'
       AND value#>>'{scope_columns,tenant}' = 'organization_id'
  ),
  'ui_read_registry routes commercial_agreements through the agreement readback projection'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
     WHERE value->>'key' = 'commercial_agreement_terms'
       AND value->>'relation' = 'public.v_commercial_agreement_term_directory'
       AND value#>>'{scope_columns,tenant}' = 'organization_id'
  ),
  'ui_read_registry routes commercial_agreement_terms through the term readback projection'
);

SELECT * FROM finish();
ROLLBACK;
