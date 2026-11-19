-- pgTAP: RBAC role templates + provisioning RPC v1

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(21);

CREATE OR REPLACE FUNCTION pg_temp.test_rbac_role_templates_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'RBAC Template Org', 'rbac-template-' || left(v_org::text, 8));

  RETURN NEXT has_table('public', 'rbac_role_templates', 'rbac_role_templates table exists');
  RETURN NEXT has_table('public', 'rbac_role_template_permissions', 'rbac_role_template_permissions table exists');

  RETURN NEXT ok(
    (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'rbac_role_templates'),
    'rbac_role_templates has RLS enabled'
  );

  RETURN NEXT ok(
    (SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'rbac_role_template_permissions'),
    'rbac_role_template_permissions has RLS enabled'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'rbac_role_templates'
        AND policyname = 'rbac_role_templates_service_policy'
    ),
    'rbac_role_templates_service_policy exists'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'rbac_role_template_permissions'
        AND policyname = 'rbac_role_template_permissions_service_policy'
    ),
    'rbac_role_template_permissions_service_policy exists'
  );

  RETURN NEXT ok(
    NOT has_table_privilege('authenticated', 'public.rbac_role_templates', 'SELECT'),
    'authenticated has no SELECT on rbac_role_templates'
  );

  RETURN NEXT ok(
    has_table_privilege('service_role', 'public.rbac_role_templates', 'SELECT'),
    'service_role has SELECT on rbac_role_templates'
  );

  RETURN NEXT has_function(
    'public',
    'provision_rbac_roles_from_templates_v1',
    ARRAY['uuid', 'text[]', 'uuid'],
    'provision_rbac_roles_from_templates_v1(uuid,text[],uuid) exists'
  );

  RETURN NEXT ok(
    has_function_privilege(
      'service_role',
      'public.provision_rbac_roles_from_templates_v1(uuid,text[],uuid)',
      'EXECUTE'
    ),
    'service_role can EXECUTE provision_rbac_roles_from_templates_v1'
  );

  RETURN NEXT ok(
    NOT has_function_privilege(
      'authenticated',
      'public.provision_rbac_roles_from_templates_v1(uuid,text[],uuid)',
      'EXECUTE'
    ),
    'authenticated cannot EXECUTE provision_rbac_roles_from_templates_v1'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.rbac_role_templates WHERE key = 'ops_admin'),
    1,
    'rbac_role_templates includes ops_admin'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.rbac_role_templates WHERE key = 'finance'),
    1,
    'rbac_role_templates includes finance'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.rbac_role_templates WHERE key = 'driver'),
    1,
    'rbac_role_templates includes driver'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.rbac_role_templates WHERE key = 'super_admin'),
    1,
    'rbac_role_templates includes super_admin'
  );

  RETURN NEXT ok(
    NOT EXISTS (
      SELECT lv.id
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission' AND lv.status = 'active'
      EXCEPT
      SELECT rtp.permission_id
      FROM public.rbac_role_template_permissions rtp
      JOIN public.rbac_role_templates rt ON rt.id = rtp.role_template_id
      WHERE rt.key = 'super_admin'
    ),
    'super_admin template covers every active RBAC permission'
  );

  -- Provision roles for the org (service-only).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  RETURN NEXT is(
    (SELECT COUNT(*)::INT
     FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin', 'finance'], NULL)),
    2,
    'provision returns 2 rows for ops_admin + finance'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT
     FROM public.rbac_roles
     WHERE organization_id = v_org AND key IN ('ops_admin', 'finance')),
    2,
    'provision creates org roles for ops_admin + finance'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT
     FROM public.rbac_role_permissions rp
     JOIN public.rbac_roles r ON r.id = rp.role_id
     WHERE r.organization_id = v_org AND r.key = 'finance'),
    (SELECT COUNT(*)::INT
     FROM public.rbac_role_template_permissions tp
     JOIN public.rbac_role_templates t ON t.id = tp.role_template_id
     WHERE t.key = 'finance'),
    'finance role permissions match template'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT
     FROM public.rbac_role_permissions rp
     JOIN public.rbac_roles r ON r.id = rp.role_id
     WHERE r.organization_id = v_org AND r.key = 'ops_admin'),
    (SELECT COUNT(*)::INT
     FROM public.rbac_role_template_permissions tp
     JOIN public.rbac_role_templates t ON t.id = tp.role_template_id
     WHERE t.key = 'ops_admin'),
    'ops_admin role permissions match template'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT
     FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin', 'finance'], NULL)
     WHERE created IS FALSE),
    2,
    'provision is idempotent (created=false on re-provision)'
  );

  -- The ACL matrix above is the stable fail-closed proof for authenticated denial.
  -- Direct denied execution under the local Supabase Postgres runtime currently
  -- terminates the connection unexpectedly instead of returning 42501, so keep
  -- local pgTAP on the permission contract rather than the crashy invocation.
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_rbac_role_templates_v1();

SELECT * FROM finish();

ROLLBACK;
