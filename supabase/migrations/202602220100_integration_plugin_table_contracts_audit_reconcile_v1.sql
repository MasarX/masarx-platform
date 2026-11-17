-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S02,S95,S99
-- Migration: Reconcile table contracts + audit triggers after integration plugin control-plane tables.
-- Purpose:
--   - Ensure public.table_contracts rows added for integration plugin tables are fully enforced.
--   - Attach audit triggers for audit-enabled contract rows (pgTAP 072 compliance).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220100_integration_plugin_table_contracts_audit_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT * FROM public.apply_table_contracts();
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202602220100_integration_plugin_table_contracts_audit_reconcile_v1'));
COMMIT;
