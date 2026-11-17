-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Remove literal-list enum CHECK constraints from workflow trigger tables (row-driven lookup contracts)
--
-- Why
-- - pgTAP enforces ZERO HARD CODING: business-facing enums must not be embedded as literal allowlists
--   in CHECK constraints (see supabase/tests/pgtap/0zz_no_literal_enum_checks.sql).
-- - workflow_* trigger tables introduced literal-list CHECK constraints for scope/status.
--
-- What
-- - Drop the literal-list CHECK constraints:
--   - public.workflow_schedule_triggers.scope_type
--   - public.workflow_run_triggers.scope_type
--   - public.workflow_trigger_fires.fire_status
-- - Enforce the same domains via row-driven lookup contracts (public.lookup_column_contracts),
--   backed by SSOT categories (public.lookup_definitions + public.lookup_values).
--
-- Notes
-- - This is append-only and safe to re-run.
-- - Enforcement is generic via public.enforce_lookup_column_contracts() (no per-table hardcoding).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Ensure lookup category exists for workflow_trigger_fires.fire_status
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'workflow_trigger_fire_status',
  'Workflow trigger fire ledger status (pending/claimed/started/skipped/error)',
  'engineering',
  'tier_1',
  false
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('pending', 'Pending', 10, true),
    ('claimed', 'Claimed', 20, false),
    ('started', 'Started', 30, false),
    ('skipped', 'Skipped', 40, false),
    ('error', 'Error', 50, false)
) v(value, label, sort_order, is_default)
  ON d.category = 'workflow_trigger_fire_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Register lookup contracts for workflow trigger columns (row-driven)
-------------------------------------------------------------------------------

-- Ensure optional allowed_values exists (idempotent; some environments may predate the column).
ALTER TABLE public.lookup_column_contracts
  ADD COLUMN IF NOT EXISTS allowed_values TEXT[];

ALTER TABLE public.lookup_column_contracts
  DROP CONSTRAINT IF EXISTS lookup_column_contracts_allowed_values_nonempty;

ALTER TABLE public.lookup_column_contracts
  ADD CONSTRAINT lookup_column_contracts_allowed_values_nonempty
  CHECK (allowed_values IS NULL OR array_length(allowed_values, 1) > 0);

-- scope_type contracts: restrict to tenant/client/sender (supported by the trigger logic).
INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category, allowed_values)
VALUES
  ('public', 'workflow_schedule_triggers', 'scope_type', 'scope_type', ARRAY['tenant', 'client', 'sender']::TEXT[]),
  ('public', 'workflow_run_triggers', 'scope_type', 'scope_type', ARRAY['tenant', 'client', 'sender']::TEXT[]),
  ('public', 'workflow_trigger_fires', 'fire_status', 'workflow_trigger_fire_status', NULL)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

-- Attach/refresh enforcement triggers for affected tables.
SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 3) Drop literal-list CHECK constraints (pgTAP forbids these)
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.workflow_schedule_triggers') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.workflow_schedule_triggers DROP CONSTRAINT IF EXISTS workflow_schedule_triggers_scope_type_ck';
  END IF;

  IF to_regclass('public.workflow_run_triggers') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.workflow_run_triggers DROP CONSTRAINT IF EXISTS workflow_run_triggers_scope_type_ck';
  END IF;

  IF to_regclass('public.workflow_trigger_fires') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.workflow_trigger_fires DROP CONSTRAINT IF EXISTS workflow_trigger_fires_status_ck';
  END IF;
END;
$$;

COMMIT;

