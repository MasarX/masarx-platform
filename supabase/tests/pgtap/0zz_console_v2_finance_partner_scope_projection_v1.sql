-- pgTAP: Console V2 Finance partner-scope readback uses the row-driven
-- marketplace_participants projection instead of app-side fallbacks.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

SELECT has_view('public', 'marketplace_participants', 'marketplace_participants projection exists');
SELECT has_column('public', 'marketplace_participants', 'partner_id', 'projection exposes partner_id alias');
SELECT has_column('public', 'marketplace_participants', 'participant_id', 'projection exposes participant_id alias');
SELECT has_column('public', 'marketplace_participants', 'supplier_participant_profile_id', 'projection exposes supplier profile alias');
SELECT has_column('public', 'marketplace_participants', 'display_name', 'projection exposes display label');
SELECT has_column('public', 'marketplace_participants', 'name', 'projection exposes Console label alias');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_participants'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ),
  'marketplace_participants is a security_invoker view'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') AS resource
     WHERE resource->>'key' = 'marketplace_participants'
       AND resource->>'relation' = 'public.marketplace_participants'
       AND resource->>'write_relation' = 'public.marketplace_participant_profiles'
       AND resource->>'capability_read' = 'marketplace_participants.read'
       AND COALESCE(resource->'select', '[]'::jsonb) @> '["partner_id","participant_id","supplier_participant_profile_id","display_name","name"]'::jsonb
  ),
  'ui_read_registry routes marketplace_participants through the projection'
);

DO $seed$
DECLARE
  v_org UUID := 'f6060606-0000-4000-8000-000000000101'::uuid;
  v_user UUID := 'f6060606-0000-4000-8000-000000000102'::uuid;
  v_profile UUID := 'f6060606-0000-4000-8000-000000000103'::uuid;
BEGIN
  DELETE FROM public.marketplace_participant_profiles WHERE id = v_profile;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Finance Partner Scope Projection Org', 'finance-partner-scope-projection-org')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  ) VALUES (
    v_user,
    v_org,
    'finance-partner-scope-projection@example.test',
    'Finance Partner Scope Projection Operator',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id,
      status = EXCLUDED.status;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);

  INSERT INTO public.marketplace_participant_profiles (
    id,
    organization_id,
    participant_type_key,
    status,
    listing_status,
    compliance_state,
    display_name,
    legal_name,
    network_metadata,
    profile
  ) VALUES (
    v_profile,
    v_org,
    'carrier_partner',
    'approved',
    'public',
    'approved',
    'Finance Partner Scope Projection',
    'Finance Partner Scope Projection LLC',
    jsonb_build_object('source', 'finance-partner-scope-readback-test'),
    jsonb_build_object('proof_marker', 'finance-partner-scope-readback-test')
  );
END;
$seed$;

SELECT is(
  (SELECT name FROM public.marketplace_participants WHERE id = 'f6060606-0000-4000-8000-000000000103'::uuid),
  'Finance Partner Scope Projection',
  'direct projection resolves the partner display label'
);

DO $api$
DECLARE
  v_user UUID := 'f6060606-0000-4000-8000-000000000102'::uuid;
  v_profile UUID := 'f6060606-0000-4000-8000-000000000103'::uuid;
  v_detail JSONB;
  v_list JSONB;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user,
      'role', 'authenticated',
      'email', 'finance-partner-scope-projection@example.test'
    )::text,
    true
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  v_detail := api.ui_get_resource_v1('marketplace_participants', v_profile);
  IF v_detail->>'display_name' IS DISTINCT FROM 'Finance Partner Scope Projection' THEN
    RAISE EXCEPTION 'marketplace_participants detail readback returned %', v_detail;
  END IF;
  IF v_detail->>'partner_id' IS DISTINCT FROM v_profile::text THEN
    RAISE EXCEPTION 'marketplace_participants detail missing partner_id alias: %', v_detail;
  END IF;

  v_list := api.ui_list_resource_v1(
    'marketplace_participants',
    jsonb_build_object('status', 'approved'),
    10,
    0,
    jsonb_build_object('key', 'updated_at', 'direction', 'desc')
  );
  IF v_list->>'resource' IS DISTINCT FROM 'marketplace_participants' THEN
    RAISE EXCEPTION 'marketplace_participants list returned wrong resource: %', v_list;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(v_list->'rows', v_list->'items', '[]'::jsonb)) AS row(value)
     WHERE row.value->>'id' = v_profile::text
       AND row.value->>'name' = 'Finance Partner Scope Projection'
  ) THEN
    RAISE EXCEPTION 'marketplace_participants list missing seeded projection row: %', v_list;
  END IF;

  EXECUTE 'RESET ROLE';
END;
$api$;

SELECT pass('api marketplace_participants detail/list readback resolves partner scope aliases');

SELECT * FROM finish();

ROLLBACK;
