-- Plan: PLAN-202602-landing-page-live / Step: S04
-- Migration: Register marketing_demo_requests in table_contracts v1
-- Date: 2026-02-05
--
-- Goal:
--   - Ensure every public base table is present in public.table_contracts (pgTAP 072_table_contracts_timestamp_audit.sql).
--   - Keep timestamp + audit enforcement row-driven (SSOT via table_contracts + apply_table_contracts/ensure_audit_triggers).
--
BEGIN;
SELECT pg_advisory_lock(hashtext('202602051500_marketing_demo_requests_table_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  'marketing_demo_requests',
  TRUE,
  TRUE,
  TRUE,
  'Landing: inbound marketing demo SSOT (inserted via edge intake RPC); enforce canonical timestamps + audit via contracts.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-- Apply contract enforcement deterministically in shared cloud/preview DBs.
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202602051500_marketing_demo_requests_table_contract_v1'));
COMMIT;
