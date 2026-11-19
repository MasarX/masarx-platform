-- pgTAP: Console V2 label design draft RPCs are real api-schema contracts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_label_design_draft_rpc_contract_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_create JSONB;
  v_list JSONB;
  v_update JSONB;
  v_archive JSONB;
  v_draft_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org,
    'Console V2 Label Draft Org',
    'console-v2-label-draft-' || left(v_org::text, 8)
  );

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id,
    status
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-label-draft@example.test',
    'Console V2 Label Designer',
    'ops_admin',
    'tenant',
    NULL,
    'active'
  );

  RETURN NEXT has_function('public', 'label_designer_list_drafts', ARRAY['text','uuid']::text[], 'public label draft list RPC exists');
  RETURN NEXT has_function('public', 'label_designer_create_draft', ARRAY['text','uuid','text','text','jsonb']::text[], 'public label draft create RPC exists');
  RETURN NEXT has_function('public', 'label_designer_update_draft', ARRAY['uuid','text','text','jsonb']::text[], 'public label draft update RPC exists');
  RETURN NEXT has_function('public', 'label_designer_archive_draft', ARRAY['uuid','text']::text[], 'public label draft archive RPC exists');
  RETURN NEXT has_function('api', 'label_designer_list_drafts', ARRAY['text','uuid']::text[], 'api label draft list wrapper exists');
  RETURN NEXT has_function('api', 'label_designer_create_draft', ARRAY['text','uuid','text','text','jsonb']::text[], 'api label draft create wrapper exists');
  RETURN NEXT has_function('api', 'label_designer_update_draft', ARRAY['uuid','text','text','jsonb']::text[], 'api label draft update wrapper exists');
  RETURN NEXT has_function('api', 'label_designer_archive_draft', ARRAY['uuid','text']::text[], 'api label draft archive wrapper exists');

  RETURN NEXT ok(
    (
      SELECT p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'label_designer_list_drafts'
      LIMIT 1
    ),
    'public label draft list RPC is SECURITY DEFINER'
  );
  RETURN NEXT ok(
    (
      SELECT p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'label_designer_create_draft'
      LIMIT 1
    ),
    'public label draft create RPC is SECURITY DEFINER'
  );
  RETURN NEXT ok(
    (
      SELECT p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'label_designer_update_draft'
      LIMIT 1
    ),
    'public label draft update RPC is SECURITY DEFINER'
  );
  RETURN NEXT ok(
    (
      SELECT p.prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'label_designer_archive_draft'
      LIMIT 1
    ),
    'public label draft archive RPC is SECURITY DEFINER'
  );
  RETURN NEXT ok(
    has_function_privilege('authenticated', 'api.label_designer_list_drafts(text,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'api.label_designer_create_draft(text,uuid,text,text,jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'api.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'api.label_designer_archive_draft(uuid,text)', 'EXECUTE'),
    'authenticated can execute api label draft RPC wrappers'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'service_role')::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.label_designer_create_draft(
    'tenant',
    v_org,
    'shipping',
    'Initial tenant label design',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'shipping',
        jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())
      )
    )
  )
    INTO v_create;

  v_draft_id := (v_create #>> '{draft,id}')::uuid;

  SELECT api.label_designer_list_drafts('tenant', v_org)
    INTO v_list;

  SELECT api.label_designer_update_draft(
    v_draft_id,
    'returns',
    'Updated tenant label design',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'returns',
        jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())
      )
    )
  )
    INTO v_update;

  SELECT api.label_designer_list_drafts('tenant', v_org)
    INTO v_list;

  SELECT api.label_designer_archive_draft(
    v_draft_id,
    'pgTAP stale draft cleanup'
  )
    INTO v_archive;

  SELECT api.label_designer_list_drafts('tenant', v_org)
    INTO v_list;

  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(COALESCE((v_create->>'ok')::boolean, FALSE), 'api create draft returns ok');
  RETURN NEXT is(v_create #>> '{draft,organization_id}', v_org::text, 'api create draft persists tenant organization_id');
  RETURN NEXT is(jsonb_array_length(COALESCE(v_list->'drafts', '[]'::jsonb)), 1, 'api list drafts returns the created draft');
  RETURN NEXT ok(COALESCE((v_update->>'ok')::boolean, FALSE), 'api update draft returns ok');
  RETURN NEXT is(v_update #>> '{draft,label_type}', 'returns', 'api update draft changes label_type');
  RETURN NEXT is(v_update #>> '{draft,status}', 'draft', 'api update keeps the label design in draft status');
  RETURN NEXT ok(COALESCE((v_archive->>'ok')::boolean, FALSE), 'api archive draft returns ok');
  RETURN NEXT is(v_archive #>> '{draft,status}', 'archived', 'api archive draft returns archived readback');
  RETURN NEXT is(v_list #>> '{drafts,0,draft_name}', 'Updated tenant label design', 'api list drafts reflects the updated draft');
  RETURN NEXT is(v_list #>> '{drafts,0,status}', 'archived', 'api list drafts reflects archived status without dropping the row');
  RETURN NEXT is(v_list #>> '{drafts,0,archive_reason}', 'pgTAP stale draft cleanup', 'api list drafts preserves archive reason readback');

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_label_design_draft_rpc_contract_v1();

SELECT * FROM finish();

ROLLBACK;
