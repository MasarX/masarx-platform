-- Migration: Reconcile table_contracts timestamp/audit enforcement after tenant-signup rollout
-- Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S99
-- Purpose:
--   - Keep table_contracts + audit triggers fully reconciled after recent table additions.
--   - Fail-closed against drift caught by pgTAP 072_table_contracts_timestamp_audit.sql.

BEGIN;

SELECT pg_advisory_lock(hashtext('202602201140_table_contracts_audit_reconcile_v1'));

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'tenant_signup_requests',
  TRUE,
  TRUE,
  TRUE,
  'Tenant signup approval queue contract (timestamp + audit) reconcile'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');
SELECT public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202602201140_table_contracts_audit_reconcile_v1'));

COMMIT;
