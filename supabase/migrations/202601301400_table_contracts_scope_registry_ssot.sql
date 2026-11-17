-- Plan: PLAN-202601-ladder-phase6-preview-table-contracts / Step: S04
-- Migration: Register ladder SSOT tables in table_contracts (timestamp + audit SSOT)
-- Purpose:
--   - Ensure new ladder SSOT tables created after the initial table_contracts seed
--     are explicitly covered by public.table_contracts.
--   - Prevent merge-queue preview DB failures where pgTAP enforces full coverage of
--     public base tables (072_table_contracts_timestamp_audit.sql).
BEGIN;

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
VALUES
  ('public', 'scope_type_registry', TRUE, TRUE, TRUE, 'Ladder SSOT: scope type registry (configuration)'),
  ('public', 'scope_type_aliases', TRUE, TRUE, TRUE, 'Ladder SSOT: scope type aliases (configuration)'),
  ('public', 'scope_ladder_edges', TRUE, TRUE, TRUE, 'Ladder SSOT: scope ladder edges (configuration)')
ON CONFLICT (table_schema, table_name) DO NOTHING;

-- Reconcile any missing canonical timestamps/triggers and apply audit posture.
SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

COMMIT;
