-- pgTAP: workflow template visibility and writes follow platform/tenant/client/sender hierarchy.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

DO $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sibling_client UUID := gen_random_uuid();
  v_foreign_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_sibling_sender UUID := gen_random_uuid();
  v_platform_user UUID := gen_random_uuid();
  v_tenant_user UUID := gen_random_uuid();
  v_client_user UUID := gen_random_uuid();
  v_sender_user UUID := gen_random_uuid();
  v_global_template UUID := gen_random_uuid();
  v_tenant_template UUID := gen_random_uuid();
  v_foreign_tenant_template UUID := gen_random_uuid();
  v_client_template UUID := gen_random_uuid();
  v_sibling_client_template UUID := gen_random_uuid();
  v_sender_template UUID := gen_random_uuid();
  v_sibling_sender_template UUID := gen_random_uuid();
  v_count INTEGER;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'B4 scope hierarchy org', 'b4-scope-' || left(v_org::text, 8)),
    (v_foreign_org, 'B4 foreign scope org', 'b4-foreign-' || left(v_foreign_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status) VALUES
    (v_client, v_org, 'B4 client', 'b4-client-' || left(v_client::text, 8), 'active'),
    (v_sibling_client, v_org, 'B4 sibling client', 'b4-sibling-' || left(v_sibling_client::text, 8), 'active'),
    (v_foreign_client, v_foreign_org, 'B4 foreign client', 'b4-foreign-client-' || left(v_foreign_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, status) VALUES
    (v_sender, v_client, 'B4 sender', 'active'),
    (v_sibling_sender, v_sibling_client, 'B4 sibling sender', 'active');

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id
  ) VALUES
    (v_platform_user, v_org, 'b4-platform-' || left(v_platform_user::text, 8) || '@example.test', 'B4 Platform', 'super_admin', 'platform', NULL),
    (v_tenant_user, v_org, 'b4-tenant-' || left(v_tenant_user::text, 8) || '@example.test', 'B4 Tenant', 'ops_admin', 'tenant', NULL),
    (v_client_user, v_org, 'b4-client-' || left(v_client_user::text, 8) || '@example.test', 'B4 Client', 'client_admin', 'client', v_client),
    (v_sender_user, v_org, 'b4-sender-' || left(v_sender_user::text, 8) || '@example.test', 'B4 Sender', 'account_manager', 'sender', v_sender);

  INSERT INTO public.workflow_templates (
    id, name, description, version, status, scope_type, scope_id, notes
  ) VALUES
    (v_global_template, 'b4_global_' || left(v_global_template::text, 8), 'B4 global', 1, 'draft', 'global', NULL, 'pgTAP'),
    (v_tenant_template, 'b4_tenant_' || left(v_tenant_template::text, 8), 'B4 tenant', 1, 'draft', 'tenant', v_org, 'pgTAP'),
    (v_foreign_tenant_template, 'b4_foreign_' || left(v_foreign_tenant_template::text, 8), 'B4 foreign tenant', 1, 'draft', 'tenant', v_foreign_org, 'pgTAP'),
    (v_client_template, 'b4_client_' || left(v_client_template::text, 8), 'B4 client', 1, 'draft', 'client', v_client, 'pgTAP'),
    (v_sibling_client_template, 'b4_sibling_client_' || left(v_sibling_client_template::text, 8), 'B4 sibling client', 1, 'draft', 'client', v_sibling_client, 'pgTAP'),
    (v_sender_template, 'b4_sender_' || left(v_sender_template::text, 8), 'B4 sender', 1, 'draft', 'sender', v_sender, 'pgTAP'),
    (v_sibling_sender_template, 'b4_sibling_sender_' || left(v_sibling_sender_template::text, 8), 'B4 sibling sender', 1, 'draft', 'sender', v_sibling_sender, 'pgTAP');

  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(NOT public.workflow_template_scope_allowed('global', NULL), 'unauthenticated caller is denied');
  SELECT count(*) INTO v_count FROM public.workflow_templates WHERE id IN (
    v_global_template, v_tenant_template, v_foreign_tenant_template, v_client_template,
    v_sibling_client_template, v_sender_template, v_sibling_sender_template
  );
  PERFORM is(v_count, 0, 'unauthenticated RLS read returns no fixture rows');
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_platform_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.workflow_template_scope_allowed('tenant', v_foreign_org), 'platform caller can access foreign tenant scope');
  SELECT count(*) INTO v_count FROM public.workflow_templates WHERE id IN (
    v_global_template, v_tenant_template, v_foreign_tenant_template, v_client_template,
    v_sibling_client_template, v_sender_template, v_sibling_sender_template
  );
  PERFORM is(v_count, 7, 'platform RLS read sees every fixture scope');
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.workflow_template_scope_allowed('tenant', v_org), 'tenant caller sees own tenant');
  PERFORM ok(public.workflow_template_scope_allowed('client', v_client), 'tenant caller sees own client descendant');
  PERFORM ok(public.workflow_template_scope_allowed('sender', v_sender), 'tenant caller sees own sender descendant');
  PERFORM ok(NOT public.workflow_template_scope_allowed('client', v_foreign_client), 'tenant caller cannot see foreign client');
  SELECT count(*) INTO v_count FROM public.workflow_templates WHERE id IN (
    v_global_template, v_tenant_template, v_foreign_tenant_template, v_client_template,
    v_sibling_client_template, v_sender_template, v_sibling_sender_template
  );
  PERFORM is(v_count, 6, 'tenant RLS read sees global plus its complete hierarchy only');
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.workflow_template_scope_allowed('client', v_client), 'client caller sees exact client');
  PERFORM ok(public.workflow_template_scope_allowed('sender', v_sender), 'client caller sees direct-child sender');
  PERFORM ok(NOT public.workflow_template_scope_allowed('sender', v_sibling_sender), 'client caller cannot see sibling sender');
  PERFORM ok(NOT public.workflow_template_scope_allowed('tenant', v_org), 'client caller cannot see tenant scope');
  SELECT count(*) INTO v_count FROM public.workflow_templates WHERE id IN (
    v_global_template, v_tenant_template, v_foreign_tenant_template, v_client_template,
    v_sibling_client_template, v_sender_template, v_sibling_sender_template
  );
  PERFORM is(v_count, 3, 'client RLS read sees global, exact client, and direct-child sender');
  v_result := public.ui_set_workflow_template_status_v1(
    v_client_template, 'draft', 'verify exact client access');
  PERFORM ok(v_result @> '{"changed":false}'::jsonb,
    'client lifecycle seam admits an exact-client no-op');
  PERFORM throws_ok(
    format(
      'SELECT public.ui_set_workflow_template_status_v1(%L::uuid,%L,%L)',
      v_sibling_client_template, 'draft', 'verify sibling denial'),
    'P0002', 'ui_set_workflow_template_status_v1 template unavailable',
    'client lifecycle seam hides a sibling client template');
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM ok(public.workflow_template_scope_allowed('sender', v_sender), 'sender caller sees exact sender');
  PERFORM ok(NOT public.workflow_template_scope_allowed('sender', v_sibling_sender), 'sender caller cannot see sibling sender');
  SELECT count(*) INTO v_count FROM public.workflow_templates WHERE id IN (
    v_global_template, v_tenant_template, v_foreign_tenant_template, v_client_template,
    v_sibling_client_template, v_sender_template, v_sibling_sender_template
  );
  PERFORM is(v_count, 2, 'sender RLS read sees global and exact sender only');
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM finish();
ROLLBACK;
