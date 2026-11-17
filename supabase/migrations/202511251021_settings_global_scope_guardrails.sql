-- moved from 202511251020 to avoid duplicate version key with partition_rename_p0_range_children
-- see PLAN-202511-db-cloud-local-alignment-nd (S08 drift reconciliation)

-- Migration: Guardrails for global scope rows (scope_id must be NULL)
-- Purpose: Prevent regressions where global settings use zero-UUID scope_id

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Helper: add check constraint if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settings_versions_global_null_scope_check'
      AND conrelid = 'public.settings_versions'::regclass
  ) THEN
    ALTER TABLE public.settings_versions
      ADD CONSTRAINT settings_versions_global_null_scope_check
      CHECK (scope_type <> 'global' OR scope_id IS NULL);
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- safe to ignore
END$$;

-- Partition check (if partition exists)
DO $$
BEGIN
  IF to_regclass('public.settings_versions_p0') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'settings_versions_p0_global_null_scope_check'
        AND conrelid = 'public.settings_versions_p0'::regclass
    ) THEN
      ALTER TABLE public.settings_versions_p0
        ADD CONSTRAINT settings_versions_p0_global_null_scope_check
        CHECK (scope_type <> 'global' OR scope_id IS NULL);
    END IF;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- safe to ignore
END$$;

-- Settings table check
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settings_global_null_scope_check'
      AND conrelid = 'public.settings'::regclass
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_global_null_scope_check
      CHECK (scope_type <> 'global' OR scope_id IS NULL);
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- safe to ignore
END$$;

COMMIT;

