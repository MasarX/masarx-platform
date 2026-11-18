-- pgTAP: Console V2 browser-safe target-label request wrapper.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, extensions, pg_temp;

SELECT plan(11);

SELECT has_function(
  'public',
  'ui_request_label_generation_target_v1',
  ARRAY['jsonb'],
  'public.ui_request_label_generation_target_v1 exists'
);

SELECT has_function(
  'api',
  'ui_request_label_generation_target_v1',
  ARRAY['jsonb'],
  'api.ui_request_label_generation_target_v1 exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_request_label_generation_target_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.ui_request_label_generation_target_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.ui_request_label_generation_target_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute public.ui_request_label_generation_target_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_request_label_generation_target_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.ui_request_label_generation_target_v1'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.request_label_generation_target_v1(text,uuid,text,uuid,text,uuid,text)', 'EXECUTE'),
  'authenticated still cannot directly execute service target-label RPC'
);

DO $$
DECLARE
  v_org UUID := '93000000-0000-4000-8000-00000000aa01'::uuid;
  v_branch UUID := '93000000-0000-4000-8000-00000000aa02'::uuid;
  v_run UUID := '93000000-0000-4000-8000-00000000aa03'::uuid;
  v_ops UUID := '93000000-0000-4000-8000-00000000aa04'::uuid;
  v_client_user UUID := '93000000-0000-4000-8000-00000000aa05'::uuid;
  v_result JSONB;
  v_lease_status TEXT;
BEGIN
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org, 'Console target label org', 'console-target-label-org', 'UTC', 'en-US', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'pgtaplbl', 'pgTAP label branch', 'UTC', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'target-label-ops@example.com', 'Target Label Ops', 'ops_admin', 'tenant', NULL),
    (v_client_user, v_org, 'target-label-client@example.com', 'Target Label Client', 'client_admin', 'tenant', NULL)
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        user_type = EXCLUDED.user_type,
        access_scope_type = EXCLUDED.access_scope_type,
        access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO route_runs (id, organization_id, branch_id, status, planned_date, metadata)
  VALUES (v_run, v_org, v_branch, 'planned', CURRENT_DATE, jsonb_build_object('source', 'pgtap-target-label'))
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ops::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_request_label_generation_target_v1(jsonb_build_object(
    'organization_id', v_org,
    'target_type', 'route',
    'target_id', v_run,
    'label_type', 'shipping',
    'requested_source', 'pgtap_console_target_label'
  ))
    INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM ok((v_result ->> 'ok')::boolean, 'ops user can enqueue route target label through api wrapper');
  PERFORM is(v_result ->> 'target_type', 'route_run', 'api wrapper normalizes route target type');
  PERFORM ok(
    EXISTS (
      SELECT 1
      FROM public.label_jobs
      WHERE id = (v_result ->> 'label_job_id')::uuid
        AND organization_id = v_org
        AND target_type = 'route_run'
        AND target_id = v_run
        AND shipment_id IS NULL
        AND requested_source = 'pgtap_console_target_label'
    ),
    'api wrapper writes target-neutral label_jobs row with route lineage'
  );

  SELECT leased.status
    INTO v_lease_status
    FROM public.lease_label_job(NULL::uuid, 60, (v_result ->> 'label_job_id')::uuid) leased;

  PERFORM is(v_lease_status, 'in_progress', 'renderer lease accepts target-neutral route label job without client_id');

  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_client_user::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      $q$SELECT api.ui_request_label_generation_target_v1(%L::jsonb)$q$,
      jsonb_build_object(
        'organization_id', v_org,
        'target_type', 'route',
        'target_id', v_run,
        'label_type', 'shipping',
        'requested_source', 'pgtap_console_target_label_denied'
      )::text
    ),
    'P0001',
    'labels.reprint capability is required',
    'client user without labels.reprint cannot enqueue target label'
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT finish();
ROLLBACK;
