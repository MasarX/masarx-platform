-- pgTAP: public.v_import_job_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W28 (paired projection views - PLATFORM)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_import_job_directory',
  'public.v_import_job_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_import_job_directory',
  ARRAY[
    'id', 'organization_id', 'kind', 'source', 'status',
    'submitted_at', 'started_at', 'completed_at',
    'submitted_by_user_id',
    'row_count', 'error_count', 'error_summary',
    'correlation_id', 'cancelled_reason',
    'created_at', 'updated_at',
    'tenant_label', 'tenant_slug',
    'submitted_by_label', 'submitted_by_email',
    'row_count_value', 'error_count_value',
    'is_terminal', 'is_active', 'is_failed', 'has_errors',
    'duration_seconds', 'queue_wait_seconds', 'age_seconds',
    'error_summary_count'
  ],
  'v_import_job_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_import_job_directory', 'SELECT'),
  'service_role has SELECT on v_import_job_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_import_job_directory', 'SELECT'),
  'anon has no SELECT on v_import_job_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_import_job_directory', 'SELECT'),
  'authenticated has SELECT on v_import_job_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'import_jobs'
       AND c.relkind = 'r'
  ),
  'public.import_jobs remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a completed failed job.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000028c001';
  v_user   UUID := '00000000-0000-0000-0000-00000028c002';
  v_job    UUID := '00000000-0000-0000-0000-00000028c003';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W28 Imports Org', 'w28-im-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w28-im-u-main@example.com',
    'W28 Imports Operator', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.import_jobs (
    id, organization_id, kind, source, status,
    submitted_at, started_at, completed_at,
    submitted_by_user_id,
    row_count, error_count, error_summary
  )
  VALUES (
    v_job, v_org, 'shipments', 'file_upload', 'failed',
    now() - INTERVAL '2 hours',
    now() - INTERVAL '110 minutes',
    now() - INTERVAL '90 minutes',
    v_user,
    100, 7,
    jsonb_build_object(
      'errors', jsonb_build_array(
        jsonb_build_object('row', 3, 'reason', 'invalid_e164'),
        jsonb_build_object('row', 9, 'reason', 'invalid_e164'),
        jsonb_build_object('row', 17, 'reason', 'unknown_client')
      ),
      'by_kind', jsonb_build_object('invalid_e164', 2, 'unknown_client', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_import_job_directory
    WHERE id = '00000000-0000-0000-0000-00000028c003'::UUID
      AND tenant_label = 'W28 Imports Org'
      AND submitted_by_label = 'W28 Imports Operator'
      AND submitted_by_email = 'w28-im-u-main@example.com'
      AND row_count_value = 100
      AND error_count_value = 7
      AND is_terminal = TRUE
      AND is_active = FALSE
      AND is_failed = TRUE
      AND has_errors = TRUE
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 1100
      AND duration_seconds < 1500
      AND queue_wait_seconds IS NOT NULL
      AND queue_wait_seconds > 500
      AND queue_wait_seconds < 800
      AND age_seconds > 7000
      AND error_summary_count = 3
  ),
  'v_import_job_directory derives tenant_label + submitted_by_label/email + row_count_value + error_count_value + is_terminal + is_failed + has_errors + duration_seconds + queue_wait_seconds + age_seconds + error_summary_count'
);

-- 8) Edge case: queued job with NULL row_count + empty error_summary.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000028c001';
  v_job2   UUID := '00000000-0000-0000-0000-00000028c013';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.import_jobs (
    id, organization_id, kind, source, status,
    submitted_at,
    error_summary
  )
  VALUES (
    v_job2, v_org, 'clients', 'api', 'queued',
    now() - INTERVAL '5 minutes',
    '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_import_job_directory
    WHERE id = '00000000-0000-0000-0000-00000028c013'::UUID
      AND is_active = TRUE
      AND is_terminal = FALSE
      AND has_errors = FALSE
      AND duration_seconds IS NULL
      AND queue_wait_seconds IS NULL
      AND error_summary_count = 0
      AND row_count_value = 0
  ),
  'v_import_job_directory: queued job with NULL counts + empty error_summary resolves is_active=TRUE + is_terminal=FALSE + has_errors=FALSE + NULL timing aggregates + error_summary_count=0 + row_count_value=0'
);

SELECT * FROM finish();
ROLLBACK;
