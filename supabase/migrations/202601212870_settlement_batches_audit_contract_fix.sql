-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix settlement_batches audit contract (avoid redundant auditing vs settlement_events ledger)
-- Date: 2026-01-21
--
-- Context:
--   settlement_batches is a projection derived from settlement_events (the SSOT ledger).
--   To preserve "single source of truth" and avoid redundant audit logs, disable audit triggers
--   for settlement_batches via table_contracts, then reconcile triggers via ensure_audit_triggers().

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212870_settlement_batches_audit_contract_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES (
  'public',
  'settlement_batches',
  TRUE,
  TRUE,
  FALSE,
  'Settlement projection is derived from settlement_events ledger; audit disabled to avoid redundancy.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Reconcile audit triggers to match row-driven table_contracts (create/drop as needed).
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601212870_settlement_batches_audit_contract_fix'));
COMMIT;

