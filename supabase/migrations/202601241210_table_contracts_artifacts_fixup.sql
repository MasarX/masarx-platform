-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Table contracts fixup for artifacts tables
-- Date: 2026-01-24
--
-- Purpose:
--   - Ensure newly introduced evidence tables are registered in table_contracts SSOT.
--   - Keep timestamp/audit enforcement consistent via apply_table_contracts + ensure_audit_triggers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601241210_table_contracts_artifacts_fixup'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'artifacts', TRUE, TRUE, TRUE, 'Evidence artifacts registry (storage refs + metadata).'),
  ('public', 'artifact_links', TRUE, TRUE, TRUE, 'Evidence artifact link model (resource attachments).')
ON CONFLICT (table_schema, table_name) DO NOTHING;

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

SELECT pg_advisory_unlock(hashtext('202601241210_table_contracts_artifacts_fixup'));
COMMIT;

