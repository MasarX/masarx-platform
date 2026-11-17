-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Reconcile audit triggers after RBAC tables (ensure_audit_triggers)
-- Date: 2026-01-30
--
-- Why:
--   - RBAC tables are audit-enabled via table_contracts.
--   - ensure_audit_triggers() is the SSOT reconciler that creates/drops triggers based on table_contracts.audit_enabled.
--   - New tables added after the last reconcile need an explicit reconcile to satisfy audit invariants.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300040_rbac_audit_triggers_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601300040_rbac_audit_triggers_reconcile_v1'));
COMMIT;

