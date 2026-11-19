-- pgTAP: Console V2 workflow capability alignment for first-tenant operators.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_workflows_capability_alias_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000099214501';
  v_ops UUID := '00000000-0000-0000-0000-000099214511';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Workflows Capability Alias Org', 'console-v2-workflows-capability-alias')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-workflows-capability-alias@example.com',
    'Console V2 Workflows Capability Alias Ops',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    public.user_has_capability_v1('workflows.read', 'tenant', v_org),
    'ops_admin has workflows.read for Console V2 workflow and intake surfaces'
  );

  RETURN NEXT ok(
    public.user_has_capability_v1('workflows.write', 'tenant', v_org),
    'ops_admin has workflows.write for Console V2 workflow configuration surfaces'
  );

  RETURN NEXT ok(
    public.user_has_capability_v1('workflow_runs.read', 'tenant', v_org),
    'legacy workflow_runs.read remains available during migration'
  );
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_workflows_capability_alias_v1();

SELECT * FROM finish();
ROLLBACK;
