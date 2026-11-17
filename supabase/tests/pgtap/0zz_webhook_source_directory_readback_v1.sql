-- pgTAP: Console webhook source token rotation can read back the
-- backend-backed directory projection after mutation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(68);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'public.v_webhook_source_directory',
  'webhook_sources reads the canonical scoped projection'
);

SELECT is(
  (
    SELECT resource->>'relation'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'public.v_webhook_source_directory',
  'webhook_source_directory reads the canonical operator projection'
);

SELECT is(
  (
    SELECT resource->>'id_column'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'id',
  'webhook_source_directory identifies rows by source id'
);

SELECT is(
  (
    SELECT resource->>'capability_read'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'webhooks.read',
  'webhook_source_directory is gated by webhooks.read'
);

SELECT is(
  (
    SELECT resource->>'capability_write'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'webhooks.write',
  'webhook_source_directory keeps the source mutation capability lineage'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,tenant}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'organization_id',
  'webhook_sources registry scopes tenant reads by organization_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,client}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'client_id',
  'webhook_sources registry scopes client reads by source client_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_sources'
  ),
  'sender_id',
  'webhook_sources registry scopes sender reads by source sender_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,tenant}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'organization_id',
  'webhook_source_directory registry scopes tenant reads by organization_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,client}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'client_id',
  'webhook_source_directory registry scopes client reads by source client_id'
);

SELECT is(
  (
    SELECT resource#>>'{scope_columns,sender}'
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_source_directory'
  ),
  'sender_id',
  'webhook_source_directory registry scopes sender reads by source sender_id'
);

SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_webhook_source_directory'::regclass),
  '{security_invoker=true}',
  'v_webhook_source_directory remains security_invoker'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'webhook_source_directory'
            AND resource->>'relation' = 'public.v_webhook_source_directory'
            AND resource->>'capability_read' = 'webhooks.read'
       )
  ),
  'all scoped read registries expose webhook_source_directory'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(resource->'scope_columns', '{}'::jsonb)) AS scope(scope_type, column_name)
      LEFT JOIN information_schema.columns column_info
        ON column_info.table_schema = split_part(resource->>'relation', '.', 1)
       AND column_info.table_name = split_part(resource->>'relation', '.', 2)
       AND column_info.column_name = scope.column_name
     WHERE resource->>'key' IN ('webhook_sources', 'webhook_source_directory')
       AND column_info.column_name IS NULL
  ),
  'every configured webhook source scope column exists on its registered relation'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'Console Webhook Source Directory Org',
  'console-webhook-source-directory-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10'::uuid,
  'webhook_inbound',
  'console-source-directory-test',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'Console webhook source directory readback test mapping'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    updated_at = now();

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES
  (
    'c43946c7-4ac7-47c3-888e-4ee13d0bb421'::uuid,
    'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
    'Console Webhook Source Client',
    'console-webhook-source-client',
    'active'
  ),
  (
    'd8acb5a4-603f-481a-805c-b164d38ffed5'::uuid,
    'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
    'Console Webhook Source Sibling Client',
    'console-webhook-source-sibling-client',
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.senders (id, client_id, name, status)
VALUES
  (
    'a90731cc-0b13-4aa9-852a-6bc92ce7b04a'::uuid,
    'c43946c7-4ac7-47c3-888e-4ee13d0bb421'::uuid,
    'Console Webhook Source Sender',
    'active'
  ),
  (
    'b9109b8d-66a4-4c8c-9556-815733266152'::uuid,
    'd8acb5a4-603f-481a-805c-b164d38ffed5'::uuid,
    'Console Webhook Source Sibling Sender',
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET client_id = EXCLUDED.client_id,
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  '34f5e45d-2084-4afd-833c-42197241683e'::uuid,
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'console-source-directory-test',
  'Console Source Directory Test',
  'generic',
  'console-source-directory-test-token',
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10'::uuid,
  100,
  true,
  'a90731cc-0b13-4aa9-852a-6bc92ce7b04a'::uuid
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    sender_id = EXCLUDED.sender_id,
    updated_at = now();

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  rate_limit_per_hour,
  enabled,
  sender_id
)
VALUES (
  '6a4aa13f-d0a2-43d0-af61-a5f57235940b'::uuid,
  'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
  'console-source-directory-sibling',
  'Console Source Directory Sibling',
  'generic',
  'console-source-directory-sibling-token',
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10'::uuid,
  100,
  true,
  'b9109b8d-66a4-4c8c-9556-815733266152'::uuid
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    auth_token = EXCLUDED.auth_token,
    mapping_config_id = EXCLUDED.mapping_config_id,
    sender_id = EXCLUDED.sender_id,
    updated_at = now();

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
VALUES
  (
    'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0'::uuid,
    'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
    'console-source-directory@example.test',
    'Console Source Directory Tenant Admin',
    'super_admin',
    'tenant',
    NULL,
    'active'
  ),
  (
    'c6c661b1-a1b5-4fc4-8c54-98835a124d54'::uuid,
    'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
    'console-source-directory-client@example.test',
    'Console Source Directory Client Admin',
    'super_admin',
    'client',
    'c43946c7-4ac7-47c3-888e-4ee13d0bb421'::uuid,
    'active'
  ),
  (
    'd557deed-b0fc-49e1-9bdd-c600dafadef6'::uuid,
    'a933c303-f846-4b0c-9a54-7403aef4a7b1'::uuid,
    'console-source-directory-sender@example.test',
    'Console Source Directory Sender Admin',
    'super_admin',
    'sender',
    'a90731cc-0b13-4aa9-852a-6bc92ce7b04a'::uuid,
    'active'
  )
ON CONFLICT (id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    user_type = EXCLUDED.user_type,
    access_scope_type = EXCLUDED.access_scope_type,
    access_scope_id = EXCLUDED.access_scope_id,
    status = EXCLUDED.status,
    updated_at = now();

-- The tenant read also requires the canonical agreements.read RBAC permission.
INSERT INTO public.rbac_roles(organization_id,key,name)
VALUES('a933c303-f846-4b0c-9a54-7403aef4a7b1','source_directory_reader','Source directory reader');
INSERT INTO public.rbac_role_permissions(organization_id,role_id,permission_id)
SELECT r.organization_id,r.id,lv.id FROM public.rbac_roles r
JOIN public.lookup_definitions ld ON ld.category='rbac_permission'
JOIN public.lookup_values lv ON lv.lookup_definition_id=ld.id AND lv.value='agreements.read'
WHERE r.organization_id='a933c303-f846-4b0c-9a54-7403aef4a7b1' AND r.key='source_directory_reader';
INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id)
SELECT organization_id,'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0',id FROM public.rbac_roles
WHERE organization_id='a933c303-f846-4b0c-9a54-7403aef4a7b1' AND key='source_directory_reader';

SELECT set_config('request.jwt.claim.sub', 'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'bf013b6a-cb0b-4040-bd0d-36bf6dc693d0',
    'role', 'authenticated',
    'email', 'console-source-directory@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_sources', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'tenant-scoped webhook_sources list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_sources', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  'console-source-directory-test',
  'tenant-scoped webhook_sources get returns its source'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_source_directory', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'tenant-scoped webhook_source_directory list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  'console-source-directory-test',
  'tenant-scoped webhook_source_directory get returns its source'
);

SELECT isnt(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'auth_token_masked',
  'console-source-directory-test-token',
  'webhook_source_directory readback exposes only token status, not token material'
);

RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'c6c661b1-a1b5-4fc4-8c54-98835a124d54', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c6c661b1-a1b5-4fc4-8c54-98835a124d54',
    'role', 'authenticated',
    'email', 'console-source-directory-client@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_sources', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'client-scoped webhook_sources list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_sources', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  NULL::text,
  'client-scoped webhook_sources cannot bypass tenant-only RLS'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_source_directory', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'client-scoped webhook_source_directory list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  NULL::text,
  'client-scoped webhook_source_directory cannot bypass tenant-only RLS'
);

SELECT is(
  public.ui_get_resource_v1('webhook_sources', '6a4aa13f-d0a2-43d0-af61-a5f57235940b'::uuid),
  NULL::jsonb,
  'client-scoped webhook_sources hides a sibling client source'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '6a4aa13f-d0a2-43d0-af61-a5f57235940b'::uuid),
  NULL::jsonb,
  'client-scoped webhook_source_directory hides a sibling client source'
);

RESET ROLE;

SELECT set_config('request.jwt.claim.sub', 'd557deed-b0fc-49e1-9bdd-c600dafadef6', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'd557deed-b0fc-49e1-9bdd-c600dafadef6',
    'role', 'authenticated',
    'email', 'console-source-directory-sender@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_sources', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'sender-scoped webhook_sources list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_sources', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  NULL::text,
  'sender-scoped webhook_sources cannot bypass tenant-only RLS'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('webhook_source_directory', '{}'::jsonb, 5, 0, NULL::jsonb) $$,
  'sender-scoped webhook_source_directory list executes'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '34f5e45d-2084-4afd-833c-42197241683e'::uuid)->>'source_identifier',
  NULL::text,
  'sender-scoped webhook_source_directory cannot bypass tenant-only RLS'
);

SELECT is(
  public.ui_get_resource_v1('webhook_sources', '6a4aa13f-d0a2-43d0-af61-a5f57235940b'::uuid),
  NULL::jsonb,
  'sender-scoped webhook_sources hides a sibling sender source'
);

SELECT is(
  public.ui_get_resource_v1('webhook_source_directory', '6a4aa13f-d0a2-43d0-af61-a5f57235940b'::uuid),
  NULL::jsonb,
  'sender-scoped webhook_source_directory hides a sibling sender source'
);

RESET ROLE;

-- F267: real governed read matrix. All added fixtures/settings roll back here.
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
INSERT INTO public.organizations(id,name,slug) VALUES
 ('1f267000-0000-4000-8000-000000000001','Source matrix foreign org','source-matrix-foreign-org');
INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,
 auth_token,mapping_config_id,rate_limit_per_hour,enabled,sender_id) VALUES
 ('1f267000-0000-4000-8000-000000000002','a933c303-f846-4b0c-9a54-7403aef4a7b1',
  'console-source-directory-extra','Matrix own source','generic','matrix-own-test-token',
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10',20,true,'a90731cc-0b13-4aa9-852a-6bc92ce7b04a'),
 ('1f267000-0000-4000-8000-000000000003','1f267000-0000-4000-8000-000000000001',
  'console-source-directory-foreign','Matrix foreign source','generic','matrix-foreign-test-token',
  '6a29701f-ff61-47a7-a51a-48c68e5cfd10',900,true,NULL);
INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id,status)
 VALUES ('1f267000-0000-4000-8000-000000000004','1f267000-0000-4000-8000-000000000001',
 'source-matrix-denied@example.test','Denied matrix reader','ops_admin','tenant',NULL,'active');
SELECT public.upsert_settings_value_v1('access_control_policy','tenant',
 '1f267000-0000-4000-8000-000000000001',
 '{"denies":[{"capability_key":"webhooks.read","scope_type":"tenant","scope_id":"1f267000-0000-4000-8000-000000000001","reason":"rollback-only read matrix"}]}'::jsonb,
 (SELECT version FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1),
 'Rollback-only source matrix denial');

-- No SECURITY DEFINER: each RPC executes under the actual authenticated SQL role.
CREATE FUNCTION pg_temp.source_read_matrix(p_actor uuid,p_ids jsonb,p_names jsonb,p_rate_sum numeric)
RETURNS SETOF text LANGUAGE plpgsql AS $test$
DECLARE r jsonb; m jsonb; expected_count integer:=jsonb_array_length(p_ids);
BEGIN
 PERFORM set_config('request.jwt.claim.sub',p_actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_actor,'role','authenticated')::text,true);
 SET LOCAL ROLE authenticated;
 r:=public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',100,0,
   '{"key":"source_identifier","direction":"asc"}');
 RETURN NEXT is(COALESCE((SELECT jsonb_agg(value->'id' ORDER BY ord) FROM jsonb_array_elements(r->'items') WITH ORDINALITY q(value,ord)),'[]'::jsonb),
   p_ids,p_actor||' list contains exactly visible fixture IDs');
 RETURN NEXT is((r->>'total')::integer,expected_count,p_actor||' list total excludes foreign scope');
 m:=public.ui_resource_metrics_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',ARRAY['rate_limit_per_hour']);
 RETURN NEXT is(jsonb_build_object('total',m->'total','sum',m#>'{columns,rate_limit_per_hour,sum}'),
   jsonb_build_object('total',expected_count,'sum',p_rate_sum),p_actor||' metrics use same scope and numeric values');
 RETURN NEXT is(public.ui_filter_distinct_values_v1('webhook_sources','source_identifier','console-source-directory-',100),
   p_names,p_actor||' public distinct excludes sibling and foreign values');
 RETURN NEXT is(api.ui_filter_distinct_values_v1('webhook_sources','source_identifier','console-source-directory-',100),
   p_names,p_actor||' API distinct preserves actor scope');
 RETURN NEXT is(public.ui_get_resource_v1('webhook_sources','1f267000-0000-4000-8000-000000000003'),
   NULL::jsonb,p_actor||' get rejects foreign organization');
 r:=public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',1,1,
   '{"key":"source_identifier","direction":"asc"}');
 RETURN NEXT is(jsonb_build_object('id',r#>'{items,0,id}','size',jsonb_array_length(r->'items'),'total',r->'total','offset',r->'offset'),
   jsonb_build_object('id',p_ids->1,'size',LEAST(1,GREATEST(expected_count-1,0)),'total',expected_count,'offset',1),p_actor||' ascending pagination keeps exact total');
 r:=public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',1,0,
   '{"key":"source_identifier","direction":"desc"}');
 RETURN NEXT is(r#>'{items,0,id}',p_ids->(expected_count-1),p_actor||' descending sort reverses fixture order');
 r:=public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-extra"}',0,-1,NULL);
 m:=public.ui_resource_metrics_v1('webhook_sources','{"source_identifier":"console-source-directory-extra"}',ARRAY['rate_limit_per_hour']);
 RETURN NEXT is(jsonb_build_object('size',jsonb_array_length(r->'items'),'total',r->'total','limit',r->'limit','offset',r->'offset','metrics_total',m->'total','sum',m#>'{columns,rate_limit_per_hour,sum}'),
   CASE WHEN expected_count>0 THEN '{"size":1,"total":1,"limit":1,"offset":0,"metrics_total":1,"sum":20}'::jsonb
     ELSE '{"size":0,"total":0,"limit":1,"offset":0,"metrics_total":0,"sum":null}'::jsonb END,
   p_actor||' filter and normalized bounds agree across list and metrics');
 RESET ROLE;
END;
$test$;
SELECT * FROM pg_temp.source_read_matrix('bf013b6a-cb0b-4040-bd0d-36bf6dc693d0',
 '["1f267000-0000-4000-8000-000000000002","6a4aa13f-d0a2-43d0-af61-a5f57235940b","34f5e45d-2084-4afd-833c-42197241683e"]',
 '["console-source-directory-extra","console-source-directory-sibling","console-source-directory-test"]',220);
SELECT * FROM pg_temp.source_read_matrix('c6c661b1-a1b5-4fc4-8c54-98835a124d54',
 '[]','[]',NULL);
SELECT * FROM pg_temp.source_read_matrix('d557deed-b0fc-49e1-9bdd-c600dafadef6',
 '[]','[]',NULL);

-- Scoped pagination is written through the canonical history-preserving helper.
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT public.upsert_settings_value_v1('ui_pagination','client','c43946c7-4ac7-47c3-888e-4ee13d0bb421',
 '{"max_page_size":2,"default_page_size":1,"allowed_sizes":[1,2]}'::jsonb,
 (SELECT version FROM public.schema_registry WHERE category='ui_pagination' AND is_active ORDER BY version DESC LIMIT 1),
 'Rollback-only client pagination');
SELECT public.upsert_settings_value_v1('ui_pagination','sender','a90731cc-0b13-4aa9-852a-6bc92ce7b04a',
 '{"max_page_size":1,"default_page_size":1,"allowed_sizes":[1]}'::jsonb,
 (SELECT version FROM public.schema_registry WHERE category='ui_pagination' AND is_active ORDER BY version DESC LIMIT 1),
 'Rollback-only sender pagination');
SELECT set_config('request.jwt.claim.sub','d557deed-b0fc-49e1-9bdd-c600dafadef6',true);
SELECT set_config('request.jwt.claims','{"sub":"d557deed-b0fc-49e1-9bdd-c600dafadef6","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT is(public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',100,0,NULL)->>'limit',
 '1','sender scoped pagination clamps oversized request');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','c6c661b1-a1b5-4fc4-8c54-98835a124d54',true);
SELECT set_config('request.jwt.claims','{"sub":"c6c661b1-a1b5-4fc4-8c54-98835a124d54","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT is(public.ui_list_resource_v1('webhook_sources','{"source_identifier":"console-source-directory-%"}',100,0,NULL)->>'limit',
 '2','sender pagination does not replace client pagination');
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','1f267000-0000-4000-8000-000000000004',true);
SELECT set_config('request.jwt.claims','{"sub":"1f267000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT public.ui_list_resource_v1('webhook_sources','{}',1,0,NULL)$q$,'42501',NULL,'denied actor cannot list');
SELECT throws_ok($q$SELECT public.ui_get_resource_v1('webhook_sources','1f267000-0000-4000-8000-000000000003')$q$,'42501',NULL,'denied actor cannot get own source');
SELECT throws_ok($q$SELECT public.ui_resource_metrics_v1('webhook_sources','{}',NULL)$q$,'42501',NULL,'denied actor cannot read metrics');
SELECT throws_ok($q$SELECT api.ui_filter_distinct_values_v1('webhook_sources','source_identifier',NULL,1)$q$,'42501',NULL,'denied actor cannot read distinct');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET LOCAL ROLE anon;
SELECT throws_ok($q$SELECT public.ui_list_resource_v1('webhook_sources','{}',1,0,NULL)$q$,'42501',NULL,'anon cannot list');
SELECT throws_ok($q$SELECT public.ui_get_resource_v1('webhook_sources','1f267000-0000-4000-8000-000000000003')$q$,'42501',NULL,'anon cannot get');
SELECT throws_ok($q$SELECT public.ui_resource_metrics_v1('webhook_sources','{}',NULL)$q$,'42501',NULL,'anon cannot read metrics');
SELECT throws_ok($q$SELECT api.ui_filter_distinct_values_v1('webhook_sources','source_identifier',NULL,1)$q$,'42501',NULL,'anon cannot read distinct');
RESET ROLE;

SET CONSTRAINTS ALL IMMEDIATE;
SELECT * FROM finish();

ROLLBACK;
