-- pgTAP: Console V2 workflow run cancel uses the browser-safe close RPC under RLS.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-202605231930'::uuid;
  v_ops UUID := '00000000-0000-0000-0001-202605231930'::uuid;
  v_sender UUID := '00000000-0000-0000-0002-202605231930'::uuid;
  v_template UUID := '00000000-0000-0000-0003-202605231930'::uuid;
  v_template_step UUID := '00000000-0000-0000-0008-202605231930'::uuid;
  v_run UUID := '00000000-0000-0000-0004-202605231930'::uuid;
  v_step UUID := '00000000-0000-0000-0005-202605231930'::uuid;
  v_denied_run UUID := '00000000-0000-0000-0006-202605231930'::uuid;
  v_denied_step UUID := '00000000-0000-0000-0007-202605231930'::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Workflow Close Cancel Org', 'workflow-close-cancel-202605231930')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'workflow-close-cancel-ops@example.com', 'Workflow Close Ops', 'ops_admin', 'tenant', NULL, 'active'),
    (v_sender, v_org, 'workflow-close-cancel-sender@example.com', 'Workflow Close Sender', 'sender_user', 'tenant', NULL, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id, created_by)
  VALUES (v_template, 'workflow_close_cancel_pgtap_v1', 1, 'active', 'tenant', v_org, v_ops)
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        status = EXCLUDED.status,
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    enabled
  )
  VALUES (
    v_template_step,
    v_template,
    1,
    'pgtap_pending_step',
    'always',
    'workflow_control',
    'v1',
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
    SET operation_name = EXCLUDED.operation_name,
        enabled = EXCLUDED.enabled;

  PERFORM set_config('app.workflow_run_id', v_run::text, true);
  INSERT INTO public.workflow_runs (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, created_at, updated_at)
  VALUES
    (v_run, v_template, 1, 'pgtap', 'pending', jsonb_build_object('organization_id', v_org), now(), now())
  ON CONFLICT (id) DO UPDATE
    SET workflow_status = EXCLUDED.workflow_status,
        completed_at = NULL,
        context = EXCLUDED.context,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', v_denied_run::text, true);
  INSERT INTO public.workflow_runs (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context, created_at, updated_at)
  VALUES
    (v_denied_run, v_template, 1, 'pgtap', 'pending', jsonb_build_object('organization_id', v_org), now(), now())
  ON CONFLICT (id) DO UPDATE
    SET workflow_status = EXCLUDED.workflow_status,
        completed_at = NULL,
        context = EXCLUDED.context,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', v_run::text, true);
  INSERT INTO public.workflow_run_steps (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, retry_attempt, max_retries, handler_key, handler_version, created_at, updated_at)
  VALUES
    (v_step, v_run, v_template_step, 1, 'pending', 'pgtap_pending_step', 0, 1, 'workflow_control', 'v1', now(), now())
  ON CONFLICT (id) DO UPDATE
    SET step_status = EXCLUDED.step_status,
        operation_completed_at = NULL,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', v_denied_run::text, true);
  INSERT INTO public.workflow_run_steps (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, retry_attempt, max_retries, handler_key, handler_version, created_at, updated_at)
  VALUES
    (v_denied_step, v_denied_run, v_template_step, 1, 'pending', 'pgtap_denied_step', 0, 1, 'workflow_control', 'v1', now(), now())
  ON CONFLICT (id) DO UPDATE
    SET step_status = EXCLUDED.step_status,
        operation_completed_at = NULL,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', '', true);

  PERFORM set_config('test.workflow_close_ops', v_ops::text, true);
  PERFORM set_config('test.workflow_close_sender', v_sender::text, true);
  PERFORM set_config('test.workflow_close_run', v_run::text, true);
  PERFORM set_config('test.workflow_close_step', v_step::text, true);
  PERFORM set_config('test.workflow_close_denied_run', v_denied_run::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_close_ops'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', current_setting('test.workflow_close_ops'))::text, true);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT api.close_workflow_run(current_setting('test.workflow_close_run')::uuid, 'cancelled') $$,
  'ops_admin can cancel a pending workflow run through api.close_workflow_run'
);
RESET ROLE;

SELECT is(
  (SELECT workflow_status FROM public.workflow_runs WHERE id = current_setting('test.workflow_close_run')::uuid),
  'cancelled',
  'close_workflow_run persists cancelled status'
);

SELECT ok(
  (SELECT completed_at IS NOT NULL FROM public.workflow_runs WHERE id = current_setting('test.workflow_close_run')::uuid),
  'close_workflow_run persists completed_at for cancelled run'
);

SELECT is(
  (SELECT step_status FROM public.workflow_run_steps WHERE id = current_setting('test.workflow_close_step')::uuid),
  'skipped',
  'close_workflow_run reconciles pending steps to skipped under cancelled run'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_close_sender'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', current_setting('test.workflow_close_sender'))::text, true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.close_workflow_run(current_setting('test.workflow_close_denied_run')::uuid, 'cancelled') $$,
  '42501',
  NULL,
  'sender_user cannot cancel workflow run without workflow_runs.write'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
