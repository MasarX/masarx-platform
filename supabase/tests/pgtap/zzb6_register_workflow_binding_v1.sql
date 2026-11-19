-- pgTAP: public.register_workflow_binding_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b615';
  v_ops UUID := '00000000-0000-0000-0000-00000000b751';
  v_sender UUID := '00000000-0000-0000-0000-00000000b752';
  v_tpl UUID := '00000000-0000-0000-0000-00000000b753';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WB Reg Org', 'b6-wb-reg-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wb-reg-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WB Reg Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wb-reg-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WB Reg Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id, created_by)
  VALUES (
    v_tpl,
    'B6 workflow binding registration template',
    'pgTAP template for register_workflow_binding_v1 projection readback',
    1,
    'active',
    'tenant',
    v_org,
    v_ops
  )
  ON CONFLICT (id) DO UPDATE
  SET
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id;

  PERFORM set_config('test.b6_wb_reg_org', v_org::text, true);
  PERFORM set_config('test.b6_wb_reg_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wb_reg_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wb_reg_tpl', v_tpl::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wb_reg_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.register_workflow_binding_v1(jsonb_build_object(
      'binding_key', 'b6_test_binding',
      'stage_key', 'pre_dispatch',
      'workflow_template_id', current_setting('test.b6_wb_reg_tpl'),
      'scope_type', 'tenant',
      'condition', jsonb_build_object('sender', 'b6_pg_tap_condition'),
      'enabled', true
    ))->>'ok')::bool
  ),
  'ops_admin can register_workflow_binding_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wb_reg_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.register_workflow_binding_v1(jsonb_build_object(
       'binding_key', 'b6_test_binding',
       'stage_key', 'pre_dispatch',
       'scope_type', 'tenant'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied register_workflow_binding_v1'
);
RESET ROLE;

-- 3) Ladder/audit: registration row recorded
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.workflow_binding_registrations
     WHERE binding_key = 'b6_test_binding'
       AND stage_key = 'pre_dispatch'
       AND workflow_template_id = current_setting('test.b6_wb_reg_tpl')::uuid
       AND scope_type = 'tenant'
  ),
  'register_workflow_binding_v1 wrote workflow_binding_registrations row with template lineage'
);

-- 4) Console registry readback: registered binding appears in the browser-facing registry source
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_binding_registry
    WHERE binding_key = 'b6_test_binding'
      AND actor_surface = 'console'
      AND entrypoint_type = 'rpc'
      AND current_execution_kind = 'workflow_native'
      AND configurability_status = 'workflow_configurable'
  ),
  'register_workflow_binding_v1 mirrors the binding into workflow_binding_registry'
);

-- 5) Console stage readback: stage/template/enabled state is available before any dispatch
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_binding_stage_registry
    WHERE binding_key = 'b6_test_binding'
      AND stage_key = 'pre_dispatch'
      AND workflow_template_id = current_setting('test.b6_wb_reg_tpl')::uuid
      AND is_enabled
  ),
  'register_workflow_binding_v1 mirrors stage template and enabled state into workflow_binding_stage_registry'
);

-- 6) Settings-ladder condition readback: condition is durable in workflow_binding_policy
SELECT is(
  (
    SELECT sv.value #>> ARRAY['bindings', 'b6_test_binding', 'stages', 'pre_dispatch', 'condition', 'sender']
    FROM public.settings_versions sv
    WHERE sv.category = 'workflow_binding_policy'
      AND sv.scope_type = 'tenant'
      AND sv.scope_id = current_setting('test.b6_wb_reg_org')::uuid
    ORDER BY sv.version DESC
    LIMIT 1
  ),
  'b6_pg_tap_condition',
  'register_workflow_binding_v1 persists binding condition in workflow_binding_policy'
);

-- 7) Console stage readback: stage condition mirror is available without dispatch
SELECT is(
  (
    SELECT condition->>'sender'
    FROM public.workflow_binding_stage_registry
    WHERE binding_key = 'b6_test_binding'
      AND stage_key = 'pre_dispatch'
  ),
  'b6_pg_tap_condition',
  'register_workflow_binding_v1 mirrors condition into workflow_binding_stage_registry'
);

-- 8) Browser-facing view readback: same registered binding can render without reload
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_bindings_console_v1
    WHERE binding_key = 'b6_test_binding'
      AND stage_key = 'pre_dispatch'
      AND workflow_template_id = current_setting('test.b6_wb_reg_tpl')::uuid
      AND status = 'active'
  ),
  'registered workflow binding appears in workflow_bindings_console_v1 for no-reload Console readback'
);

-- 9) Browser-facing condition readback: Console projection shows saved condition
SELECT is(
  (
    SELECT condition->>'sender'
    FROM public.workflow_bindings_console_v1
    WHERE binding_key = 'b6_test_binding'
      AND stage_key = 'pre_dispatch'
  ),
  'b6_pg_tap_condition',
  'workflow_bindings_console_v1 projects saved binding condition for no-reload readback'
);

-- 10) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_binding_registrations', 'select'),
  'authenticated has no SELECT on workflow_binding_registrations (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
