-- Migration: Archive schema and archiving_history audit table
-- Purpose: Provide durable location for archived partitions and an audit ledger of retention actions
-- Date: 2025-11-23 14:10

BEGIN;

-- Schema to hold archived RANGE partitions
CREATE SCHEMA IF NOT EXISTS archive;

-- Retention audit ledger
CREATE TABLE IF NOT EXISTS public.archiving_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  partition_name TEXT NOT NULL,
  parent_name TEXT,
  action TEXT NOT NULL,            -- archive | delete | skip
  retention_months INTEGER,
  policy TEXT,                     -- policy resolved (archive/delete)
  partition_end TIMESTAMPTZ,
  row_count BIGINT,
  outcome TEXT NOT NULL,           -- success | error
  error TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arch_hist_table_time
  ON public.archiving_history(table_name, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_arch_hist_action_time
  ON public.archiving_history(action, executed_at DESC);

COMMIT;

