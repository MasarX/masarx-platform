-- Migration: Benchmark run metadata + run_id linking
-- Purpose: Make benchmark_results append-only and queryable per-run (no manual truncation) by introducing benchmark_runs and run_id foreign key.
-- Alignment: SSOT, row-driven, RLS enabled, least privilege policies.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE TABLE IF NOT EXISTS public.benchmark_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    benchmark_key TEXT NOT NULL DEFAULT 'geocoding',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.benchmark_runs IS 'Benchmark run metadata (SSOT). Each run groups benchmark_results via run_id.';

ALTER TABLE public.benchmark_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'benchmark_runs' AND policyname = 'benchmark_runs_service_role_all'
  ) THEN
    EXECUTE 'CREATE POLICY benchmark_runs_service_role_all ON public.benchmark_runs FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS benchmark_runs_key_created_idx ON public.benchmark_runs (benchmark_key, created_at DESC);

ALTER TABLE public.benchmark_results
    ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES public.benchmark_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS benchmark_results_run_idx ON public.benchmark_results (run_id);

COMMIT;

