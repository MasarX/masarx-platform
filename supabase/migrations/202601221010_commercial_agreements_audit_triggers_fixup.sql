-- Migration: Commercial agreements audit trigger reconciliation (fixup)
-- Date: 2026-01-22
--
-- Purpose:
--   - Ensure audit triggers are attached for newly registered audit-enabled tables
--     (commercial_agreements, commercial_agreement_terms) via row-driven table_contracts.
--   - Keep enforcement centralized in public.ensure_audit_triggers() (SSOT).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221010_commercial_agreements_audit_triggers_fixup'));
SET search_path TO public, extensions, pg_temp;

-- Ensure timestamp triggers are present (idempotent) and attach audit triggers where enabled.
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601221010_commercial_agreements_audit_triggers_fixup'));
COMMIT;

