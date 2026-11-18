-- Migration: Register late platform ledgers in table_contracts
-- Date: 2026-05-03

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031340_table_contracts_late_platform_ledgers_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH desired_contracts (
  table_name,
  created_at_source_column,
  updated_at_required,
  audit_enabled,
  notes
) AS (
  VALUES
    ('alert_rule_revisions', NULL::text, FALSE, FALSE, 'Append-only alert rule revision audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('capability_grant_requests', NULL::text, TRUE, TRUE, 'Access-policy capability request workflow ledger with mutable decision fields.'),
    ('feature_flag_kill_events', NULL::text, FALSE, FALSE, 'Append-only feature-flag kill-switch audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('import_jobs', NULL::text, TRUE, TRUE, 'Bulk import lifecycle SSOT with mutable status/progress fields.'),
    ('lookup_value_revisions', NULL::text, FALSE, FALSE, 'Append-only lookup value revision audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('mapping_config_revisions', NULL::text, FALSE, FALSE, 'Append-only mapping config revision audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('ops_alert_events', NULL::text, FALSE, FALSE, 'Append-only ops alert event ledger; created_at is canonical and no row-level double-audit is required.'),
    ('password_reset_intents', NULL::text, FALSE, TRUE, 'Password reset intent lifecycle ledger; status changes are audited while created_at remains the canonical timestamp.'),
    ('revocation_audit', NULL::text, FALSE, FALSE, 'Canonical revocation audit intent ledger; created_at is canonical and no row-level double-audit is required.'),
    ('task_bulk_transition_runs', NULL::text, FALSE, FALSE, 'Append-only bulk task transition run ledger; created_at is canonical and no row-level double-audit is required.'),
    ('webhook_inbox_replays', NULL::text, FALSE, FALSE, 'Append-only webhook inbox replay audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('workflow_binding_registrations', NULL::text, FALSE, FALSE, 'Append-only workflow binding registration audit ledger; created_at is canonical and no row-level double-audit is required.'),
    ('workflow_binding_simulations', NULL::text, FALSE, FALSE, 'Append-only workflow binding simulation evidence ledger; created_at is canonical and no row-level double-audit is required.'),
    ('workflow_template_status_changes', 'changed_at'::text, FALSE, FALSE, 'Append-only workflow template status-change ledger; changed_at is the canonical created_at source.')
)
INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  created_at_source_column,
  updated_at_required,
  updated_at_source_column,
  audit_enabled,
  notes
)
SELECT
  'public',
  dc.table_name,
  TRUE,
  dc.created_at_source_column,
  dc.updated_at_required,
  NULL,
  dc.audit_enabled,
  dc.notes
FROM desired_contracts dc
WHERE to_regclass(format('public.%I', dc.table_name)) IS NOT NULL
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  created_at_source_column = EXCLUDED.created_at_source_column,
  updated_at_required = EXCLUDED.updated_at_required,
  updated_at_source_column = EXCLUDED.updated_at_source_column,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202605031340_table_contracts_late_platform_ledgers_fixup_v1'));
COMMIT;
