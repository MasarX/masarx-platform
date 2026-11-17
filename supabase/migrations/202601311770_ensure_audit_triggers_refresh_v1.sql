-- Migration: ensure_audit_triggers refresh v1 (reconcile audit triggers after new contract rows)
-- Purpose:
--   - pgTAP enforces that audit-enabled tables have audit triggers (072_table_contracts_timestamp_audit.sql).
--   - `public.ensure_audit_triggers()` is the SSOT reconciler based on `public.table_contracts.audit_enabled`.

BEGIN;

SELECT pg_advisory_lock(hashtext('202601311770_ensure_audit_triggers_refresh_v1'));

SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601311770_ensure_audit_triggers_refresh_v1'));

COMMIT;

