-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import runtime tables, storage bucket, and RLS

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091150_tabular_import_runtime_tables_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Private storage bucket for source uploads + error exports
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'Skipping tabular-imports bucket provisioning: storage.buckets missing';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    )
    VALUES (
      'tabular-imports',
      'tabular-imports',
      FALSE,
      26214400,
      ARRAY[
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/json'
      ]
    )
    ON CONFLICT (id) DO UPDATE
       SET public = EXCLUDED.public,
           file_size_limit = EXCLUDED.file_size_limit,
           allowed_mime_types = EXCLUDED.allowed_mime_types;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping storage.buckets upsert for tabular-imports (insufficient privilege/RLS).';
  END;
END $$;

DO $$
BEGIN
  IF to_regnamespace('storage') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS tabular_imports_service_role_rw ON storage.objects;
  CREATE POLICY tabular_imports_service_role_rw
    ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'tabular-imports')
    WITH CHECK (bucket_id = 'tabular-imports');
END $$;

-------------------------------------------------------------------------------
-- 2) SSOT tables: tabular_import_runs + tabular_import_run_rows
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tabular_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,
  resource_key TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  write_mode TEXT NOT NULL DEFAULT 'create',
  status TEXT NOT NULL DEFAULT 'prepared',
  profile_name TEXT,
  header_fingerprint TEXT,
  sheet_name TEXT,
  source_format TEXT,
  source_file_name TEXT,
  source_artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  error_artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  report_id UUID REFERENCES public.mapping_operation_reports(id) ON DELETE SET NULL,
  task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  total_rows INT NOT NULL DEFAULT 0,
  will_create INT NOT NULL DEFAULT 0,
  will_update INT NOT NULL DEFAULT 0,
  will_skip INT NOT NULL DEFAULT 0,
  blocked_count INT NOT NULL DEFAULT 0,
  warning_count INT NOT NULL DEFAULT 0,
  created_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tabular_import_runs_resource_key_ck CHECK (btrim(resource_key) <> ''),
  CONSTRAINT tabular_import_runs_relation_name_ck CHECK (btrim(relation_name) <> ''),
  CONSTRAINT tabular_import_runs_write_mode_ck CHECK (write_mode IN ('create', 'upsert')),
  CONSTRAINT tabular_import_runs_status_ck CHECK (
    status IN ('prepared', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'canceled')
  ),
  CONSTRAINT tabular_import_runs_counts_nonnegative_ck CHECK (
    total_rows >= 0
    AND will_create >= 0
    AND will_update >= 0
    AND will_skip >= 0
    AND blocked_count >= 0
    AND warning_count >= 0
    AND created_count >= 0
    AND updated_count >= 0
    AND skipped_count >= 0
    AND failed_count >= 0
  ),
  CONSTRAINT tabular_import_runs_summary_object_ck CHECK (jsonb_typeof(summary) = 'object')
);

COMMENT ON TABLE public.tabular_import_runs IS
  'SSOT parent row for each prepared/executed tabular import attempt.';

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_org_created
  ON public.tabular_import_runs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_org_status
  ON public.tabular_import_runs (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tabular_import_runs_resource_status
  ON public.tabular_import_runs (resource_key, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_tabular_import_runs_set_updated_at
  ON public.tabular_import_runs;

CREATE TRIGGER trg_tabular_import_runs_set_updated_at
BEFORE UPDATE ON public.tabular_import_runs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.tabular_import_run_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.tabular_import_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  action TEXT NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'queued',
  original_row JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapped_row JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  coercions JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_record_id TEXT,
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tabular_import_run_rows_unique_row UNIQUE (run_id, row_number),
  CONSTRAINT tabular_import_run_rows_row_number_ck CHECK (row_number > 0),
  CONSTRAINT tabular_import_run_rows_action_ck CHECK (action IN ('create', 'update', 'skip', 'block', 'failed')),
  CONSTRAINT tabular_import_run_rows_execution_status_ck CHECK (
    execution_status IN ('queued', 'succeeded', 'failed', 'skipped', 'blocked', 'canceled')
  ),
  CONSTRAINT tabular_import_run_rows_original_row_object_ck CHECK (jsonb_typeof(original_row) = 'object'),
  CONSTRAINT tabular_import_run_rows_mapped_row_object_ck CHECK (jsonb_typeof(mapped_row) = 'object'),
  CONSTRAINT tabular_import_run_rows_diagnostics_array_ck CHECK (jsonb_typeof(diagnostics) = 'array'),
  CONSTRAINT tabular_import_run_rows_coercions_array_ck CHECK (jsonb_typeof(coercions) = 'array'),
  CONSTRAINT tabular_import_run_rows_reason_codes_array_ck CHECK (jsonb_typeof(reason_codes) = 'array'),
  CONSTRAINT tabular_import_run_rows_reason_messages_array_ck CHECK (jsonb_typeof(reason_messages) = 'array'),
  CONSTRAINT tabular_import_run_rows_metadata_object_ck CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.tabular_import_run_rows IS
  'SSOT staged row ledger for tabular imports, including dry-run diagnostics, coercions, and execution outcomes.';

CREATE INDEX IF NOT EXISTS idx_tabular_import_run_rows_run_row
  ON public.tabular_import_run_rows (run_id, row_number);

CREATE INDEX IF NOT EXISTS idx_tabular_import_run_rows_org_status
  ON public.tabular_import_run_rows (organization_id, execution_status, row_number);

DROP TRIGGER IF EXISTS trg_tabular_import_run_rows_set_updated_at
  ON public.tabular_import_run_rows;

CREATE TRIGGER trg_tabular_import_run_rows_set_updated_at
BEFORE UPDATE ON public.tabular_import_run_rows
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.tabular_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tabular_import_run_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tabular_import_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.tabular_import_runs FROM anon;
REVOKE ALL ON TABLE public.tabular_import_runs FROM authenticated;
REVOKE ALL ON TABLE public.tabular_import_run_rows FROM PUBLIC;
REVOKE ALL ON TABLE public.tabular_import_run_rows FROM anon;
REVOKE ALL ON TABLE public.tabular_import_run_rows FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.tabular_import_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tabular_import_run_rows TO authenticated;
GRANT ALL ON TABLE public.tabular_import_runs TO service_role;
GRANT ALL ON TABLE public.tabular_import_run_rows TO service_role;

DROP POLICY IF EXISTS tabular_import_runs_service_policy ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_service_policy
ON public.tabular_import_runs
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

DROP POLICY IF EXISTS tabular_import_run_rows_service_policy ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_service_policy
ON public.tabular_import_run_rows
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

DROP POLICY IF EXISTS tabular_import_runs_select ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_select
ON public.tabular_import_runs
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

DROP POLICY IF EXISTS tabular_import_runs_insert ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_insert
ON public.tabular_import_runs
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

DROP POLICY IF EXISTS tabular_import_runs_update ON public.tabular_import_runs;
CREATE POLICY tabular_import_runs_update
ON public.tabular_import_runs
FOR UPDATE
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
)
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

DROP POLICY IF EXISTS tabular_import_run_rows_select ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_select
ON public.tabular_import_run_rows
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

DROP POLICY IF EXISTS tabular_import_run_rows_insert ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_insert
ON public.tabular_import_run_rows
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

DROP POLICY IF EXISTS tabular_import_run_rows_update ON public.tabular_import_run_rows;
CREATE POLICY tabular_import_run_rows_update
ON public.tabular_import_run_rows
FOR UPDATE
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
)
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND public.user_can_write()
);

SELECT pg_advisory_unlock(hashtext('202603091150_tabular_import_runtime_tables_v1'));
COMMIT;
