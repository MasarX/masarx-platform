-- pgTAP: public.ui_set_workflow_template_status_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b618';
  v_ops UUID := '00000000-0000-0000-0000-00000000b781';
  v_sender UUID := '00000000-0000-0000-0000-00000000b782';
  v_template_id UUID := '00000000-0000-0000-0000-00000000b783';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WT Status Org', 'b6-wt-status-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wt-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WT Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wt-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WT Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  -- Seed a tenant-scoped template the test will flip.
  INSERT INTO public.workflow_templates (id, name, status, scope_type, scope_id, created_by)
  VALUES (v_template_id,
          'B6 WT Status Template ' || left(v_template_id::text, 8),
          'draft', 'tenant', v_org, v_ops)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wt_org', v_org::text, true);
  PERFORM set_config('test.b6_wt_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wt_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wt_template', v_template_id::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wt_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.ui_set_workflow_template_status_v1(jsonb_build_object(
      'template_id', current_setting('test.b6_wt_template'),
      'status', 'active'
    ))->>'ok')::bool
  ),
  'ops_admin can ui_set_workflow_template_status_v1 (draft -> active)'
);
RESET ROLE;

-- 2) Denied (sender_user lacks workflows.write capability)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wt_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_set_workflow_template_status_v1(jsonb_build_object(
       'template_id', current_setting('test.b6_wt_template'),
       'status', 'inactive'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_set_workflow_template_status_v1 (capability gate)'
);
RESET ROLE;

-- 3) Invalid status validation (capability passes, payload validation throws)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wt_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_set_workflow_template_status_v1(jsonb_build_object(
       'template_id', current_setting('test.b6_wt_template'),
       'status', 'frobnicated'
     )) $$,
  '22023',
  NULL,
  'ops_admin invalid status rejected with 22023'
);
RESET ROLE;

-- 4) Audit row recorded
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.workflow_template_status_changes
     WHERE workflow_template_id = current_setting('test.b6_wt_template')::uuid
       AND next_status = 'active'
  ),
  'ui_set_workflow_template_status_v1 wrote workflow_template_status_changes row'
);

-- 5) RLS isolation: status-changes ledger is service-only
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_template_status_changes', 'select'),
  'authenticated has no SELECT on workflow_template_status_changes (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
