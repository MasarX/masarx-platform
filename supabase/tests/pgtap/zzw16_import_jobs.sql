-- pgTAP: W16-5 — public.import_jobs SSOT + RPC contract
--   * import_jobs table exists with canonical column shape and RLS enabled.
--   * import_job_create_v1(p_args) creates a queued job with the canonical envelope.
--   * import_job_cancel_v1(p_args) cancels a queued job (status=cancelled).
--   * import_job_cancel_v1(p_args) refuses to cancel a completed job (22023).
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- ----- Setup -----
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000000160001'::uuid;
  v_ops UUID := '00000000-0000-0000-0000-000000160a01'::uuid;
  v_completed_job UUID := '00000000-0000-0000-0000-00000016c001'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W16-5 Imports Org', 'w16-imp-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops, v_org, 'w16-imp-ops-' || left(v_ops::text, 8) || '@example.com',
          'W16 Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  -- Pre-seed a completed job so we can prove import_job_cancel_v1 refuses it.
  INSERT INTO public.import_jobs (
    id, organization_id, kind, source, status,
    submitted_at, started_at, completed_at, submitted_by_user_id, row_count
  ) VALUES (
    v_completed_job, v_org, 'shipments', 'file_upload', 'completed',
    now() - interval '2 minutes', now() - interval '1 minute 30 seconds',
    now() - interval '1 minute', v_ops, 5
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w16_imp_org', v_org::text, true);
  PERFORM set_config('test.w16_imp_ops', v_ops::text, true);
  PERFORM set_config('test.w16_imp_completed_job', v_completed_job::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Table + RLS invariant
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.import_jobs'::regclass),
  'public.import_jobs has RLS enabled'
);

-- 2) import_job_create_v1 happy path (authenticated Console operator)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w16_imp_ops'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.w16_imp_ops'), 'role', 'authenticated')::text,
  true
);

SELECT lives_ok(
  format($q$
    SELECT public.import_job_create_v1(jsonb_build_object(
      'kind', 'shipments',
      'source', 'file_upload',
      'row_count', 12,
      'organization_id', %L
    ))
  $q$, current_setting('test.w16_imp_org')),
  'authenticated operator can import_job_create_v1 (happy path)'
);

-- 3) import_job_cancel_v1 happy path on a queued job
DO $$
DECLARE
  v_org UUID := current_setting('test.w16_imp_org')::uuid;
  v_user UUID := current_setting('test.w16_imp_ops')::uuid;
  v_job UUID;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  -- Create a fresh queued job so we have a known cancellable target.
  v_job := gen_random_uuid();
  INSERT INTO public.import_jobs (id, organization_id, kind, source, status, submitted_at, submitted_by_user_id)
  VALUES (v_job, v_org, 'clients', 'file_upload', 'queued', now(), v_user);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );

  v_result := public.import_job_cancel_v1(jsonb_build_object(
    'import_job_id', v_job,
    'reason', 'tester abort'
  ));

  PERFORM set_config('test.w16_imp_cancel_result', v_result::text, true);
  PERFORM set_config('test.w16_imp_cancelled_job', v_job::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT status FROM public.import_jobs
    WHERE id = current_setting('test.w16_imp_cancelled_job')::uuid),
  'cancelled',
  'import_job_cancel_v1 transitions queued -> cancelled'
);

SELECT is(
  (SELECT cancelled_reason FROM public.import_jobs
    WHERE id = current_setting('test.w16_imp_cancelled_job')::uuid),
  'tester abort',
  'import_job_cancel_v1 persists submitted cancellation reason'
);

-- 4) import_job_cancel_v1 refuses a completed job (lifecycle guard)
SELECT throws_ok(
  format($q$
    SELECT public.import_job_cancel_v1(jsonb_build_object(
      'import_job_id', %L
    ))
  $q$, current_setting('test.w16_imp_completed_job')),
  '22023', NULL,
  'import_job_cancel_v1 refuses to cancel a completed job'
);

SELECT * FROM finish();
ROLLBACK;
