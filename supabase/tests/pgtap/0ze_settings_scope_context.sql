-- pgTAP: resolve_settings_scope_context_v1 defaults tenant scope_id to org
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_scope_type TEXT;
  v_scope_id UUID;
  v_org_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Scope Context Org', 'scope-context-org-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'scope-context-' || left(v_user::text, 8) || '@example.com',
    'Scope Context User',
    'tenant',
    NULL
  );

  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT scope_type, scope_id, organization_id
    INTO v_scope_type, v_scope_id, v_org_id
    FROM public.resolve_settings_scope_context_v1('tenant', NULL)
    LIMIT 1;

  PERFORM is(v_scope_type, 'tenant', 'tenant scope type preserved');
  PERFORM is(v_scope_id, v_org, 'tenant scope_id defaults to org id');
  PERFORM is(v_org_id, v_org, 'organization_id resolves from tenant scope');

  EXECUTE 'RESET ROLE';
END;
$$;

SELECT * FROM finish();
ROLLBACK;
