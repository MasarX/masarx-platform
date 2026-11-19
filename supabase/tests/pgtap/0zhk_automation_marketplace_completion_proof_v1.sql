-- Native SG13 lifecycle/security integration fixtures. UNRUN without an admitted native DB lane.
-- All fixture writes are rolled back. No production/provider traffic is performed.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT no_plan();

CREATE TEMP TABLE sg13_ids(key TEXT PRIMARY KEY,id UUID NOT NULL DEFAULT gen_random_uuid());
INSERT INTO sg13_ids(key) SELECT unnest(ARRAY['org_a','org_b','author','installer','client_actor','no_cap','reviewer','client_a','client_b','workflow_a','workflow_b','workflow_client_b','provider_a','provider_b','provider_c']);
GRANT SELECT ON sg13_ids TO authenticated;
CREATE TEMP TABLE sg13_results(key TEXT PRIMARY KEY,value JSONB NOT NULL);
GRANT SELECT,INSERT,UPDATE ON sg13_results TO authenticated;
CREATE FUNCTION pg_temp.id(TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM pg_temp.sg13_ids WHERE key=$1 $$;
CREATE FUNCTION pg_temp.result(TEXT) RETURNS JSONB LANGUAGE sql AS $$ SELECT value FROM pg_temp.sg13_results WHERE key=$1 $$;
CREATE FUNCTION pg_temp.actor(TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE 'RESET ROLE';
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.id($1),'role','authenticated')::text,true);
 PERFORM set_config('request.jwt.claim.sub',pg_temp.id($1)::text,true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 EXECUTE 'SET LOCAL ROLE authenticated';
END $$;
CREATE FUNCTION pg_temp.manifest() RETURNS JSONB LANGUAGE sql AS $$
 SELECT '{"display":{"title":"Synthetic SG13"},"docs":{},"variable_schema":{"keys":[]},"connection_requirements":{"bindings":[]},"dependency_requirements":{"required_assets":[]},"capability_requirements":[],"install_constraints":{"allowed_scope_placeholders":[]},"egress_profile":{},"compatibility":{},"artifact_hash":""}'::jsonb
$$;
CREATE FUNCTION pg_temp.activate_workflow(workflow_template_id UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
 -- Exercise a real transition, not the already-active no-op. pgTAP's exception
 -- subtransaction rolls this draft transition back when activation is rejected.
 PERFORM public.ui_set_workflow_template_status_v1(workflow_template_id,'draft','Prepare SG13 fixture reactivation');
 RETURN public.ui_set_workflow_template_status_v1(workflow_template_id,'active','Activate SG13 fixture through the native lifecycle');
END $$;
CREATE FUNCTION pg_temp.assign_template(org UUID,actor UUID,template TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE role_id UUID; actor_type TEXT; policy_scope TEXT; policy_scope_id UUID;
 scoped_policy JSONB; effective_policy JSONB; role_keys TEXT[]; schema_version INT;
BEGIN
 IF template='ops_admin' THEN
  SELECT p.role_id INTO role_id FROM public.provision_rbac_roles_from_templates_v1(org,ARRAY[template],actor) p LIMIT 1;
  IF role_id IS NULL THEN RAISE EXCEPTION 'Fixture operational role template missing'; END IF;
  INSERT INTO public.rbac_user_role_assignments(organization_id,user_id,role_id,assigned_by_user_id,metadata)
  VALUES(org,actor,role_id,actor,'{"source":"pgtap-sg13"}') ON CONFLICT DO NOTHING;
  RETURN;
 END IF;
 SELECT u.user_type,CASE WHEN u.access_scope_type='platform' THEN public.get_root_scope_type_key_v1() ELSE u.access_scope_type END,
  CASE WHEN u.access_scope_type='tenant' THEN u.organization_id ELSE u.access_scope_id END
 INTO STRICT actor_type,policy_scope,policy_scope_id FROM public.users u WHERE u.id=actor AND u.organization_id=org;
 PERFORM pg_advisory_xact_lock(hashtext('sg13:access_control_policy:'||policy_scope||':'||COALESCE(policy_scope_id::text,'root')));
 effective_policy:=public.resolve_settings_merged('access_control_policy',policy_scope,policy_scope_id);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(effective_policy->'roles') r WHERE r->>'key'=template) THEN
  RAISE EXCEPTION 'Fixture marketplace policy role missing';
 END IF;
 SELECT sv.value INTO scoped_policy FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='access_control_policy' AND s.scope_type=policy_scope AND s.scope_id IS NOT DISTINCT FROM policy_scope_id;
 scoped_policy:=COALESCE(scoped_policy,'{}'::jsonb);
 SELECT array_agg(DISTINCT role_key ORDER BY role_key) INTO role_keys
  FROM unnest(public.resolve_role_keys_v1(effective_policy,actor,actor_type)||ARRAY[template]) r(role_key);
 scoped_policy:=jsonb_set(scoped_policy,'{assignments}',COALESCE(scoped_policy->'assignments','{}'::jsonb)||jsonb_build_object(
  'user_id',COALESCE(scoped_policy#>'{assignments,user_id}','{}'::jsonb)||jsonb_build_object(actor::text,to_jsonb(role_keys))),TRUE);
 SELECT MAX(version) INTO schema_version FROM public.schema_registry WHERE category='access_control_policy' AND is_active;
 PERFORM public.upsert_settings_value_v1('access_control_policy',policy_scope,policy_scope_id,scoped_policy,schema_version,'SG13 explicit actor roles');
END $$;

INSERT INTO public.organizations(id,name,slug,timezone,locale,billing_status,default_settings)
SELECT id,'SG13 '||key,'sg13-'||id::text,'Asia/Riyadh','en','active','{}' FROM sg13_ids WHERE key IN ('org_a','org_b');
INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status,settings_override)
SELECT id,pg_temp.id('org_a'),'SG13 '||key,'sg13-'||id::text,'standard','active','{}' FROM sg13_ids WHERE key IN ('client_a','client_b');
INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
SELECT id,CASE WHEN key='installer' THEN pg_temp.id('org_b') ELSE pg_temp.id('org_a') END,
 'sg13-'||id::text||'@example.invalid','SG13 '||key,CASE WHEN key='reviewer' THEN 'super_admin' ELSE 'ops_admin' END,'active',
 CASE WHEN key='reviewer' THEN 'platform' WHEN key='client_actor' THEN 'client' ELSE 'tenant' END,
 CASE WHEN key='client_actor' THEN pg_temp.id('client_a') ELSE NULL END
FROM sg13_ids WHERE key IN ('author','installer','client_actor','no_cap','reviewer');
DO $$
DECLARE actor RECORD; template TEXT;
BEGIN
 FOR actor IN SELECT * FROM sg13_ids WHERE key IN ('author','installer','client_actor') LOOP
  FOREACH template IN ARRAY ARRAY['ops_admin','automation_marketplace_publisher','automation_marketplace_installer'] LOOP
   PERFORM pg_temp.assign_template(CASE WHEN actor.key='installer' THEN pg_temp.id('org_b') ELSE pg_temp.id('org_a') END,actor.id,template);
  END LOOP;
 END LOOP;
END $$;
SELECT ok(public.resolve_settings_merged('access_control_policy','tenant',pg_temp.id('org_a'))
  #>ARRAY['assignments','user_id',pg_temp.id('client_actor')::text] IS NULL
 AND public.resolve_settings_merged('access_control_policy','client',pg_temp.id('client_a'))
  #>ARRAY['assignments','user_id',pg_temp.id('client_actor')::text] ? 'automation_marketplace_installer',
 'client fixture assignment remains at its exact client scope, not the parent tenant');
SELECT pg_temp.actor('reviewer');
SELECT is(current_user::text,'authenticated','platform creation uses the real authenticated role');
SELECT ok(auth.uid()=pg_temp.id('reviewer') AND public.current_user_scope_type()='platform'
 AND public.current_user_scope_id() IS NULL AND public.user_has_capability_v1('workflow_runs.write'),
 'existing super-admin reviewer has its actual platform session and workflow capability');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('platform_created_template',api.ui_create_workflow_template_v1('sg13_platform_'||pg_temp.id('reviewer')::text,'Actual platform creation',NULL)) $$,
 'platform reviewer creates through the actual API workflow RPC without a fallback actor');
SELECT pg_temp.actor('author');
SELECT ok(public.user_has_capability_v1('automation_marketplace.publish') AND public.user_has_capability_v1('automation_marketplace.install'),
 'explicit fixture policy roles authorize publish and install');
SELECT ok(public.user_has_capability_v1('workflow_runs.write'),'explicit fixture roles preserve baseline workflow capability');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('tenant_created_template',api.ui_create_workflow_template_v1('sg13_tenant_'||pg_temp.id('author')::text,'Actual tenant creation',NULL)) $$,
 'existing authorized tenant actor retains actual API workflow creation');
SELECT pg_temp.actor('client_actor');
SELECT ok(public.user_has_capability_v1('workflow_runs.write'),'existing client fixture roles retain their workflow capability');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('client_created_template',api.ui_create_workflow_template_v1('sg13_client_'||pg_temp.id('client_actor')::text,'Actual client creation',NULL)) $$,
 'existing authorized client actor retains actual API workflow creation');
SELECT pg_temp.actor('no_cap');
SELECT ok(NOT public.user_has_capability_v1('automation_marketplace.publish') AND NOT public.user_has_capability_v1('automation_marketplace.install'),
 'unassigned actor does not inherit marketplace capabilities from another fixture actor');
RESET ROLE;
SELECT is(current_user::text,'postgres','persisted creation readback runs only after returning to postgres');
SELECT is((SELECT scope_type FROM public.workflow_templates WHERE id=(pg_temp.result('platform_created_template')->>'workflow_template_id')::uuid),public.get_root_scope_type_key_v1(),'platform creation persists the canonical root scope');
SELECT is((SELECT scope_id FROM public.workflow_templates WHERE id=(pg_temp.result('platform_created_template')->>'workflow_template_id')::uuid),NULL::uuid,'platform creation persists no entity scope ID');
SELECT is((SELECT created_by FROM public.workflow_templates WHERE id=(pg_temp.result('platform_created_template')->>'workflow_template_id')::uuid),pg_temp.id('reviewer'),'platform creation preserves the authenticated creator');
SELECT is((SELECT scope_type FROM public.workflow_templates WHERE id=(pg_temp.result('tenant_created_template')->>'workflow_template_id')::uuid),'tenant','tenant creation retains its scope type');
SELECT is((SELECT scope_id FROM public.workflow_templates WHERE id=(pg_temp.result('tenant_created_template')->>'workflow_template_id')::uuid),pg_temp.id('org_a'),'tenant creation retains its exact organization');
SELECT is((SELECT created_by FROM public.workflow_templates WHERE id=(pg_temp.result('tenant_created_template')->>'workflow_template_id')::uuid),pg_temp.id('author'),'tenant creation preserves the authenticated creator');
SELECT is((SELECT scope_type FROM public.workflow_templates WHERE id=(pg_temp.result('client_created_template')->>'workflow_template_id')::uuid),'client','client creation retains its scope type');
SELECT is((SELECT scope_id FROM public.workflow_templates WHERE id=(pg_temp.result('client_created_template')->>'workflow_template_id')::uuid),pg_temp.id('client_a'),'client creation retains its exact client');
SELECT is((SELECT created_by FROM public.workflow_templates WHERE id=(pg_temp.result('client_created_template')->>'workflow_template_id')::uuid),pg_temp.id('client_actor'),'client creation preserves the authenticated creator');
INSERT INTO public.workflow_templates(id,name,description,version,status,scope_type,scope_id)
SELECT id,'sg13-workflow-'||id::text,'Synthetic source',1,'draft',CASE WHEN key='workflow_client_b' THEN 'client' ELSE 'tenant' END,
 CASE WHEN key='workflow_b' THEN pg_temp.id('org_b') WHEN key='workflow_client_b' THEN pg_temp.id('client_b') ELSE pg_temp.id('org_a') END
FROM sg13_ids WHERE key IN ('workflow_a','workflow_b','workflow_client_b');
INSERT INTO public.workflow_template_steps(workflow_template_id,sequence_order,operation_name,transition_condition,handler_key,enabled,manual_action_required)
SELECT id,1,'workflow_control','success','workflow_control',true,false FROM sg13_ids WHERE key IN ('workflow_a','workflow_b','workflow_client_b');
INSERT INTO public.providers(id,organization_id,name,provider_type,enabled)
VALUES(pg_temp.id('provider_a'),pg_temp.id('org_a'),'SG13 A','http',true),
      (pg_temp.id('provider_b'),pg_temp.id('org_b'),'SG13 B','http',true),
      (pg_temp.id('provider_c'),pg_temp.id('org_a'),'SG13 C','http',true);

SELECT pg_temp.actor('author');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('v1',public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),'SG13 private',NULL,'private',pg_temp.manifest())) $$,'owner creates a draft snapshot through the actual RPC');
SELECT is((SELECT publication_status FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),'draft','initial catalogue readback is draft');
SELECT throws_ok($$ UPDATE public.automation_asset_listing_versions SET snapshot_payload='{}' WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid $$,'42501',NULL,'authenticated direct snapshot DML is denied');
SELECT throws_ok($$ UPDATE public.automation_asset_listings SET publication_status='approved' WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid $$,'42501',NULL,'authenticated direct publication transition is denied');
SELECT throws_ok($$ SELECT public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_b'),NULL,NULL,'private',pg_temp.manifest()) $$,'42501',NULL,'definer source capture cannot cross tenants');
SELECT throws_ok($$ SELECT public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_provider_id:=pg_temp.id('provider_b'),p_name:='bad provider') $$,'42501',NULL,'new connection provider must belong to the target organization');
SELECT throws_ok($$ SELECT public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_name:='bad config',p_config:='{"token":"sg13-synthetic"}') $$,'23514',NULL,'recognized inline credentials are rejected outside Vault payloads');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('connection',public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_provider_id:=pg_temp.id('provider_a'),p_name:='synthetic credential',p_config:='{"endpoint":"https://example.invalid"}',p_oauth_metadata:='{"scope":"read"}',p_metadata:='{"label":"preserve"}',p_secret_payload:='{"api_key":"sg13-vault-only"}')) $$,'connection secret is accepted only through the actual Vault write boundary');
SELECT lives_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('connection')->>'connection_id')::uuid,p_name:='renamed') $$,'minimal update preserves omitted configuration and identity');
SELECT is((SELECT config FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid),'{"endpoint":"https://example.invalid"}'::jsonb,'omitted config survives readback');
SELECT is((SELECT oauth_metadata FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid),'{"scope":"read"}'::jsonb,'omitted OAuth metadata survives readback');
SELECT is((SELECT metadata FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid),'{"label":"preserve"}'::jsonb,'omitted metadata survives readback');
SELECT throws_ok($$ SELECT credentials_vault_id FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid $$,'42501',NULL,'direct web read cannot expose a Vault identifier');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('client_b_connection',public.integration_connection_upsert_v1(p_owner_scope_type:='client',p_owner_scope_id:=pg_temp.id('client_b'),p_name:='client B',p_secret_payload:='{"secret":"sg13-client-b"}',p_secret_storage_mode:='hash_only')) $$,'tenant owner creates an exact child-scope verifier connection');
SELECT pg_temp.actor('client_actor');
SELECT is((SELECT count(*) FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),0::bigint,'client cannot read tenant-private listing');
SELECT is((SELECT count(*) FROM public.integration_connections WHERE id=(pg_temp.result('client_b_connection')->>'connection_id')::uuid),0::bigint,'client cannot read a sibling client connection');
SELECT throws_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('client_b_connection')->>'connection_id')::uuid,p_owner_scope_type:='client',p_owner_scope_id:=pg_temp.id('client_a')) $$,'42501',NULL,'NEW authorized scope cannot launder an unauthorized OLD connection');
SELECT throws_ok($$ SELECT public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_client_b'),NULL,NULL,'private',pg_temp.manifest()) $$,'42501',NULL,'client publisher cannot capture a sibling-scope source');
SELECT pg_temp.actor('installer');
SELECT is((SELECT count(*) FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),0::bigint,'cross-tenant private root is invisible');
SELECT is((SELECT count(*) FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid),0::bigint,'cross-tenant private version is invisible');
SELECT throws_ok($$ SELECT public.automation_asset_install_v1((pg_temp.result('v1')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_b')) $$,'42501',NULL,'definer install cannot bypass private source authorization');
SELECT pg_temp.actor('no_cap');
SELECT throws_ok($$ SELECT public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),NULL,NULL,'private',pg_temp.manifest()) $$,'42501',NULL,'scope membership alone does not authorize publishing');

SELECT pg_temp.actor('author');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('v1')->>'listing_version_id')::uuid,'tenant_shared') $$,'private/tenant publication uses the actual lifecycle');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('local_install',public.automation_asset_install_v1((pg_temp.result('v1')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'))) $$,'ordinary nonactivated copy succeeds');
SELECT is((SELECT install_status FROM public.automation_asset_installs WHERE id=(pg_temp.result('local_install')->>'install_id')::uuid),'installed','copy readback is installed without claiming activation');
SELECT is(pg_temp.result('local_install')#>>'{activation_result,activated}','false','copy result is explicitly not activated');
SELECT is((SELECT status FROM public.workflow_templates WHERE id=(pg_temp.result('local_install')->>'installed_resource_id')::uuid),'draft','nonactivated local workflow stays draft');
SELECT pg_temp.actor('client_actor');
SELECT is((SELECT count(*) FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),1::bigint,'approved tenant sharing is visible within the tenant');
SELECT pg_temp.actor('installer');
SELECT is((SELECT count(*) FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),0::bigint,'tenant sharing is not cross-tenant public access');

SELECT pg_temp.actor('author');
SELECT lives_ok($$ SELECT public.ui_create_workflow_template_step_v1(pg_temp.id('workflow_a'),'{"operation_name":"workflow_control","transition_condition":"success","handler_key":"workflow_control","enabled":true}') $$,'normal workflow edit creates a changed source before the next version');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('v2',public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),'SG13 replacement',NULL,'marketplace_public',pg_temp.manifest(),p_listing_id:=(pg_temp.result('v1')->>'listing_id')::uuid)) $$,'explicit append creates the next immutable draft without table DML');
SELECT is((SELECT listing_version_no FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v2')->>'listing_version_id')::uuid),2,'append version number is monotonic under the root lock');
SELECT is((SELECT latest_listing_version_id FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),(pg_temp.result('v1')->>'listing_version_id')::uuid,'draft replacement does not replace approved current pointer');
SELECT is((public.ui_get_resource_v1('automation_asset_installs',(pg_temp.result('local_install')->>'install_id')::uuid)->>'upgrade_available')::boolean,FALSE,'draft replacement does not advertise an upgrade through the real read RPC');
SELECT throws_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('v2')->>'listing_version_id')::uuid,'marketplace_public') $$,'P0001',NULL,'public approval cannot bypass review through publication policy');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('review2',public.automation_asset_submit_review_v1((pg_temp.result('v2')->>'listing_version_id')::uuid)) $$,'new public version submits through the actual review lifecycle');
SELECT is((SELECT publication_status FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),'approved','submitted replacement keeps old approved catalogue state');
SELECT throws_ok($$ SELECT public.automation_asset_review_decide_v1((pg_temp.result('review2')->>'review_id')::uuid,'approved') $$,'42501',NULL,'ordinary tenant publisher cannot act as global reviewer');
SELECT pg_temp.actor('installer');
SELECT is((SELECT count(*) FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v2')->>'listing_version_id')::uuid),0::bigint,'unapproved public-labelled replacement is invisible cross-tenant');
SELECT pg_temp.actor('reviewer');
SELECT lives_ok($$ SELECT public.automation_asset_review_decide_v1((pg_temp.result('review2')->>'review_id')::uuid,'approved') $$,'explicit platform reviewer approves the replacement');
SELECT throws_ok($$ SELECT public.automation_asset_review_decide_v1((pg_temp.result('review2')->>'review_id')::uuid,'approved') $$,'23514',NULL,'decided review cannot be replayed');
SELECT pg_temp.actor('installer');
SELECT is((SELECT count(*) FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v2')->>'listing_version_id')::uuid),1::bigint,'approved public version is readable cross-tenant');
SELECT is((SELECT count(*) FROM public.automation_asset_installs_read_v1 WHERE id=(pg_temp.result('local_install')->>'install_id')::uuid),0::bigint,'public source visibility does not reveal another tenant install or derived availability');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('public_install',public.automation_asset_install_v1((pg_temp.result('v2')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_b'),'{}','{}',true)) $$,'approved public workflow installs and activates in the authorized tenant');
SELECT is(pg_temp.result('public_install')#>>'{activation_result,activated}','true','activation result confirms actual activation');
SELECT is((SELECT status FROM public.workflow_templates WHERE id=(pg_temp.result('public_install')->>'installed_resource_id')::uuid),'active','activated runtime resource is canonical active');
SELECT is((SELECT handler_key FROM public.workflow_template_steps WHERE workflow_template_id=(pg_temp.result('public_install')->>'installed_resource_id')::uuid LIMIT 1),'workflow_control','effective donor handler copy is preserved');

SELECT pg_temp.actor('author');
SELECT is((public.ui_get_resource_v1('automation_asset_installs',(pg_temp.result('local_install')->>'install_id')::uuid)->>'upgrade_available')::boolean,TRUE,'approved newer current version advertises a real eligible upgrade');
SELECT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(public.ui_list_resource_v1('automation_asset_installs',jsonb_build_object('listing_id',pg_temp.result('v1')->>'listing_id'))->'items') item WHERE item->>'id'=pg_temp.result('local_install')->>'install_id' AND item->>'upgrade_available'='true'),'real list RPC and getter agree on the derived upgrade boolean');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('fork_candidate',public.automation_asset_install_v1((pg_temp.result('v1')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'))) $$,'old approved version remains an installable baseline');
SELECT lives_ok($$ SELECT public.automation_asset_fork_v1((pg_temp.result('fork_candidate')->>'install_id')::uuid) $$,'fork is an explicit local divergence');
SELECT is((SELECT upgrade_available FROM public.automation_asset_installs_read_v1 WHERE id=(pg_temp.result('fork_candidate')->>'install_id')::uuid),FALSE,'forked copies do not advertise blind upstream upgrades');
SELECT lives_ok($$ SELECT public.automation_asset_upgrade_apply_v1((pg_temp.result('local_install')->>'install_id')::uuid,(pg_temp.result('v2')->>'listing_version_id')::uuid) $$,'approved appended version upgrades the existing authorized copy');
SELECT is((public.ui_get_resource_v1('automation_asset_installs',(pg_temp.result('local_install')->>'install_id')::uuid)->>'upgrade_available')::boolean,FALSE,'applied current version clears derived availability without a background write');
SELECT is((SELECT current_listing_version_id FROM public.automation_asset_installs WHERE id=(pg_temp.result('local_install')->>'install_id')::uuid),(pg_temp.result('v2')->>'listing_version_id')::uuid,'upgrade current version is canonical readback');
SELECT lives_ok($$ SELECT public.automation_asset_fork_v1((pg_temp.result('local_install')->>'install_id')::uuid,NULL) $$,'fork with omitted reason preserves non-null metadata');
SELECT throws_ok($$ SELECT public.automation_asset_upgrade_apply_v1((pg_temp.result('local_install')->>'install_id')::uuid,(pg_temp.result('v2')->>'listing_version_id')::uuid) $$,'P0001',NULL,'serialized fork state blocks blind upgrades');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('v3',public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),NULL,NULL,'marketplace_public',pg_temp.manifest(),p_listing_id:=(pg_temp.result('v1')->>'listing_id')::uuid)) $$,'another append is available for rejection proof');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('review3',public.automation_asset_submit_review_v1((pg_temp.result('v3')->>'listing_version_id')::uuid)) $$,'third draft submits without changing approved current');
SELECT pg_temp.actor('reviewer');
SELECT lives_ok($$ SELECT public.automation_asset_review_decide_v1((pg_temp.result('review3')->>'review_id')::uuid,'rejected') $$,'review rejection is recorded without overwriting the approved current');
SELECT pg_temp.actor('author');
SELECT is((SELECT latest_listing_version_id FROM public.automation_asset_listings WHERE id=(pg_temp.result('v1')->>'listing_id')::uuid),(pg_temp.result('v2')->>'listing_version_id')::uuid,'rejected replacement leaves approved current pointer intact');
RESET ROLE;
UPDATE public.workflow_template_steps SET metadata=jsonb_build_object('auth',jsonb_build_object('auth_config_id','{{conn.synthetic_provider.auth_config_id}}')) WHERE workflow_template_id=pg_temp.id('workflow_a');
SELECT pg_temp.actor('author');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('bound_listing',public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{"auth_types":["api_key"]}}'))) $$,'connection requirement is declared in the immutable manifest');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('bound_listing')->>'listing_version_id')::uuid) $$,'bound workflow publishes through the real transition');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('bound_install',public.automation_asset_install_v1((pg_temp.result('bound_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('connection')->>'connection_id')))) $$,'declared installer-owned connection binds through the real install');
SELECT ok(EXISTS(SELECT 1 FROM public.automation_asset_install_bindings WHERE install_id=(pg_temp.result('bound_install')->>'install_id')::uuid AND binding_key='synthetic_provider' AND runtime_resource_type='provider_auth_configs' AND runtime_resource_id IS NOT NULL),'binding readback contains only the installer runtime reference');
INSERT INTO pg_temp.sg13_results SELECT 'binding_before',to_jsonb(b) FROM public.automation_asset_install_bindings b WHERE install_id=(pg_temp.result('bound_install')->>'install_id')::uuid;
SELECT is(public.integration_connection_bind_install_v1((pg_temp.result('bound_install')->>'install_id')::uuid,'synthetic_provider',(pg_temp.result('connection')->>'connection_id')::uuid)->>'noop','true','exact binding confirmation returns a true noop');
SELECT is((SELECT to_jsonb(b) FROM public.automation_asset_install_bindings b WHERE install_id=(pg_temp.result('bound_install')->>'install_id')::uuid),pg_temp.result('binding_before'),'true noop preserves the complete binding row including timestamps');
SELECT ok(EXISTS(SELECT 1 FROM public.workflow_template_steps s WHERE s.workflow_template_id=(pg_temp.result('bound_install')->>'installed_resource_id')::uuid AND s.metadata #>> '{auth,auth_config_id}'=pg_temp.result('binding_before')->>'runtime_resource_id'),'copied executable metadata points to original A');
SELECT throws_ok($$ SELECT pg_temp.activate_workflow((pg_temp.result('bound_install')->>'installed_resource_id')::uuid) $$,'23514','Activation requires a current-generation credential-presence check for each connection','a later native workflow transition cannot bypass the seeded test policy');
SELECT throws_ok($$ SELECT public.integration_connection_bind_install_v1((pg_temp.result('bound_install')->>'install_id')::uuid,'undeclared',(pg_temp.result('connection')->>'connection_id')::uuid) $$,'23514',NULL,'undeclared binding cannot be smuggled into a saved install');
SELECT throws_ok($$ SELECT public.integration_connection_bind_install_v1((pg_temp.result('bound_install')->>'install_id')::uuid,'synthetic_provider',(pg_temp.result('client_b_connection')->>'connection_id')::uuid) $$,'23514',NULL,'scope-local reuse rejects an otherwise visible sibling connection');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('credential_test',public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid)) $$,'credential-presence validation is available through its actual RPC');
SELECT is(pg_temp.result('credential_test')->>'remote_verified','false','local credential validation never claims a remote provider test');
SELECT is(pg_temp.result('credential_test')->>'credential_generation',pg_temp.result('credential_test')->>'last_tested_credential_generation','successful evidence is tied to the current generation');
SELECT lives_ok($$ SELECT pg_temp.activate_workflow((pg_temp.result('bound_install')->>'installed_resource_id')::uuid) $$,'current-generation presence evidence permits actual workflow activation');
SELECT lives_ok($$ SELECT public.integration_connection_rotate_v1((pg_temp.result('connection')->>'connection_id')::uuid,'{"api_key":"sg13-rotated"}') $$,'rotation uses the actual generation-changing lifecycle');
SELECT throws_ok($$ SELECT pg_temp.activate_workflow((pg_temp.result('bound_install')->>'installed_resource_id')::uuid) $$,'23514','Activation requires a current-generation credential-presence check for each connection','rotation stales evidence even for later activation of the same saved workflow');
SELECT lives_ok($$ SELECT public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid) $$,'rotation can be checked again without any remote claim');
SELECT lives_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('connection')->>'connection_id')::uuid,p_config:='{"endpoint":"https://example.invalid/changed"}') $$,'configuration changes advance the credential contract generation');
SELECT throws_ok($$ SELECT pg_temp.activate_workflow((pg_temp.result('bound_install')->>'installed_resource_id')::uuid) $$,'23514',NULL,'configuration changes also invalidate prior test evidence');
RESET ROLE;
SELECT public.upsert_settings_value_v1('automation_marketplace_policy','tenant',pg_temp.id('org_a'),jsonb_set(public.automation_marketplace_resolve_policy_v1('tenant',pg_temp.id('org_a'),pg_temp.id('org_a')),'{connections,require_test_before_activation}','false'),1,'Synthetic activation policy false');
SELECT pg_temp.actor('author');
SELECT lives_ok($$ SELECT pg_temp.activate_workflow((pg_temp.result('bound_install')->>'installed_resource_id')::uuid) $$,'policy false permits ready bindings without test evidence');
RESET ROLE;
SELECT public.upsert_settings_value_v1('automation_marketplace_policy','tenant',pg_temp.id('org_a'),jsonb_set(public.automation_marketplace_resolve_policy_v1('tenant',pg_temp.id('org_a'),pg_temp.id('org_a')),'{connections,require_test_before_activation}','true'),1,'Synthetic restore activation policy');
SELECT pg_temp.actor('author');
SELECT lives_ok($$ SELECT public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid) $$,'current configuration can be locally checked again');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('empty_connection',public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_name:='empty credential',p_secret_payload:='{"nested":{"empty":"   "}}')) $$,'synthetic empty Vault payload is retained for negative check');
SELECT is(public.integration_connection_test_v1((pg_temp.result('empty_connection')->>'connection_id')::uuid)->>'ok','false','Vault pointer alone is not nonempty credential presence');
SELECT is((SELECT last_tested_credential_generation FROM public.integration_connections WHERE id=(pg_temp.result('empty_connection')->>'connection_id')::uuid),NULL::bigint,'failed check cannot stamp successful generation evidence');
RESET ROLE;
UPDATE public.integration_connections SET status='disabled' WHERE id=(pg_temp.result('empty_connection')->>'connection_id')::uuid;
SELECT pg_temp.actor('author');
SELECT is(public.integration_connection_test_v1((pg_temp.result('empty_connection')->>'connection_id')::uuid)->>'status','disabled','local testing never reactivates disabled connections');
SELECT lives_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('client_b_connection')->>'connection_id')::uuid,p_name:='renamed verifier') $$,'minimal hash-only update remains valid');
SELECT is((SELECT secret_storage_mode FROM public.integration_connections WHERE id=(pg_temp.result('client_b_connection')->>'connection_id')::uuid),'hash_only','omitted storage mode retains the existing verifier contract');

SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_plugin',public.integration_plugin_generate_draft_v1('SG13 bound native','webhook',p_workflow_binding:=jsonb_build_object('template_id',pg_temp.result('bound_install')->>'installed_resource_id'),p_outbound_operations:='[{"operation_name":"sg13_bound","method":"POST","url_template":"https://example.invalid","auth":{"mode":"api_key_header","header":"x-api-key","credential_key":"api_key","auth_config_id":"{{conn.synthetic_provider.auth_config_id}}"}}]')) $$,'valid native plugin source retains exact bound-auth provenance');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_listing',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('native_plugin')->>'version_id')::uuid,NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{}}'))) $$,'bound plugin uses the canonical snapshot boundary');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('native_listing')->>'listing_version_id')::uuid) $$,'bound plugin publishes normally');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_copy',public.automation_asset_install_v1((pg_temp.result('native_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('connection')->>'connection_id')))) $$,'draft plugin copy is allowed before another generation check');
SELECT lives_ok($$ SELECT public.integration_plugin_submit_v1((SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'SG13 later activation proof') $$,'saved draft follows the native submit lifecycle before later activation');
SELECT lives_ok($$ SELECT public.integration_plugin_approve_v1((SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'approved','SG13 later activation proof') $$,'saved submitted copy follows the native approval lifecycle');
SELECT is((SELECT status FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'approved','later activation fixture is persistently approved before credential rotation');
SELECT lives_ok($$ SELECT public.integration_connection_rotate_v1((pg_temp.result('connection')->>'connection_id')::uuid,'{"api_key":"sg13-native-rotated"}') $$,'rotation stales prior evidence for the saved plugin');
SELECT throws_ok($$ SELECT public.integration_plugin_activate_v1((SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'tenant',pg_temp.id('org_a')) $$,'23514','Activation requires a current-generation credential-presence check for each connection','later native plugin activation cannot bypass the evidence policy');
RESET ROLE;
-- Core is owner-only; retain the actor claims while proving its table guard.
SELECT throws_ok($$ SELECT public.integration_plugin_activate_core_v1((SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'tenant',pg_temp.id('org_a')) $$,'23514','Activation requires a current-generation credential-presence check for each connection','core activation is guarded at the same actual table transition');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ SELECT public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid) $$,'current generation receives local evidence');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_activated',public.integration_plugin_activate_v1((SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'tenant',pg_temp.id('org_a'))) $$,'current evidence permits native activation without remote traffic');
SELECT is((SELECT status FROM public.integration_plugins WHERE id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),'active','native activation readback is actually active');
RESET ROLE;
SELECT is((SELECT array_agg(o.handler_key ORDER BY o.id) FROM public.integration_plugin_bindings b JOIN public.operation_templates o ON o.id=b.runtime_resource_id WHERE b.plugin_version_id=(SELECT id FROM public.integration_plugin_versions WHERE plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid) AND b.binding_type='operation_template' AND b.runtime_resource_type='operation_templates'),ARRAY['outbound_http']::text[],'native activation persists the canonical outbound handler');
SELECT pg_temp.actor('author');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('connection_b',public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_provider_id:=pg_temp.id('provider_a'),p_name:='synthetic B',p_secret_payload:='{"api_key":"sg13-b"}')) $$,'another authorized same-scope connection is not confused with binding A');
SELECT throws_ok($$ SELECT public.integration_connection_bind_install_v1((pg_temp.result('bound_install')->>'install_id')::uuid,'synthetic_provider',(pg_temp.result('connection_b')->>'connection_id')::uuid) $$,'23514',NULL,'already materialized workflow A to B change is also refused');
SELECT throws_ok($$ SELECT public.integration_connection_bind_install_v1((pg_temp.result('native_copy')->>'install_id')::uuid,'synthetic_provider',(pg_temp.result('connection_b')->>'connection_id')::uuid) $$,'23514','Materialized install bindings cannot change; create a fresh copy with the required bindings','active plugin A to B rebinding is explicitly deferred, not metadata-only success');
SELECT ok(EXISTS(SELECT 1 FROM public.integration_plugin_versions v WHERE v.plugin_id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid AND v.outbound_operations #>> '{0,auth,auth_config_id}'=pg_temp.result('binding_before')->>'runtime_resource_id'),'rejected rebind preserves the active executable auth reference A');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('copy_b',public.automation_asset_install_v1((pg_temp.result('bound_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('connection_b')->>'connection_id')))) $$,'initial bindings remain supported for a fresh copy');
INSERT INTO pg_temp.sg13_results SELECT 'binding_b_before',to_jsonb(b) FROM public.automation_asset_install_bindings b WHERE install_id=(pg_temp.result('copy_b')->>'install_id')::uuid;
SELECT lives_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('connection_b')->>'connection_id')::uuid,p_provider_id:=pg_temp.id('provider_c')) $$,'provider change creates a new runtime identity on the same connection');
SELECT throws_ok($$ SELECT public.integration_connection_bind_install_v1((pg_temp.result('copy_b')->>'install_id')::uuid,'synthetic_provider',(pg_temp.result('connection_b')->>'connection_id')::uuid) $$,'23514',NULL,'same connection ID with changed effective runtime ID is not a true noop');
SELECT is((SELECT to_jsonb(b) FROM public.automation_asset_install_bindings b WHERE install_id=(pg_temp.result('copy_b')->>'install_id')::uuid),pg_temp.result('binding_b_before'),'failed effective-reference change preserves the old materialized binding row');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_source2',public.integration_plugin_generate_draft_v1('SG13 bound native','webhook',p_plugin_id:=(pg_temp.result('native_plugin')->>'plugin_id')::uuid,p_workflow_binding:=jsonb_build_object('template_id',pg_temp.result('bound_install')->>'installed_resource_id'),p_outbound_operations:='[{"operation_name":"sg13_bound_next","method":"POST","url_template":"https://example.invalid/next","auth":{"mode":"api_key_header","header":"x-api-key","credential_key":"api_key","auth_config_id":"{{conn.synthetic_provider.auth_config_id}}"}}]')) $$,'native source creates a distinct second version for real rollback proof');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_listing2',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('native_source2')->>'version_id')::uuid,NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{}}'),p_listing_id:=(pg_temp.result('native_listing')->>'listing_id')::uuid)) $$,'second bound plugin snapshot appends through the canonical lifecycle');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('native_listing2')->>'listing_version_id')::uuid) $$,'next plugin snapshot is actually approved');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('native_stage2',public.automation_asset_upgrade_apply_v1((pg_temp.result('native_copy')->>'install_id')::uuid,(pg_temp.result('native_listing2')->>'listing_version_id')::uuid)) $$,'marketplace upgrade stages the next native-approved copy without a DML shortcut');
SELECT lives_ok($$ SELECT public.integration_plugin_activate_v1((pg_temp.result('native_stage2')->>'staged_plugin_version_id')::uuid,'tenant',pg_temp.id('org_a')) $$,'current-generation evidence permits later staged-version activation');
SELECT lives_ok($$ SELECT public.integration_connection_rotate_v1((pg_temp.result('connection')->>'connection_id')::uuid,'{"api_key":"sg13-rollback-stale"}') $$,'another rotation invalidates evidence for reactivation and rollback');
SELECT throws_ok($$ SELECT public.integration_plugin_rollback_v1((pg_temp.result('native_copy')->>'installed_resource_id')::uuid,(pg_temp.result('native_activated')->>'plugin_version_id')::uuid) $$,'23514',NULL,'actual rollback to a different previously active version cannot bypass current-generation evidence');
SELECT is((SELECT active_version_id FROM public.integration_plugins WHERE id=(pg_temp.result('native_copy')->>'installed_resource_id')::uuid),(pg_temp.result('native_stage2')->>'staged_plugin_version_id')::uuid,'failed rollback leaves the newer active version and runtime changes transactional');
SELECT lives_ok($$ SELECT public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid) $$,'later independent fixtures retain a checked current connection');

SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('long_plugin',public.integration_plugin_generate_draft_v1('SG13 long key','api')) $$,'native source is prepared before the valid maximum-length key fixture');
RESET ROLE;
UPDATE public.integration_plugins SET plugin_key=repeat('q',120) WHERE id=(pg_temp.result('long_plugin')->>'plugin_id')::uuid;
SELECT pg_temp.actor('author');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('long_listing',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('long_plugin')->>'version_id')::uuid,NULL,NULL,'private',pg_temp.manifest())) $$,'snapshot accepts a valid 120-character plugin key');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('long_listing')->>'listing_version_id')::uuid) $$,'long-key snapshot follows normal publication');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('long_copy2',public.automation_asset_install_v1((pg_temp.result('long_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'))) $$,'first same-tenant maximum-length key collision terminates');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('long_copy3',public.automation_asset_install_v1((pg_temp.result('long_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'))) $$,'repeated maximum-length key collision also terminates');
SELECT is((SELECT plugin_key FROM public.integration_plugins WHERE id=(pg_temp.result('long_copy2')->>'installed_resource_id')::uuid),repeat('q',118)||'-2','suffix space is reserved within the key length');
SELECT is((SELECT plugin_key FROM public.integration_plugins WHERE id=(pg_temp.result('long_copy3')->>'installed_resource_id')::uuid),repeat('q',118)||'-3','subsequent copy retains its distinct suffix');
RESET ROLE;
CREATE FUNCTION pg_temp.unrelated_unique() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic unrelated constraint' USING ERRCODE='23505',CONSTRAINT='sg13_unrelated_unique'; END $$;
CREATE TRIGGER sg13_unrelated_unique BEFORE INSERT ON public.integration_plugins FOR EACH ROW EXECUTE FUNCTION pg_temp.unrelated_unique();
SELECT pg_temp.actor('author');
SELECT throws_ok($$ SELECT public.automation_asset_install_v1((pg_temp.result('long_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a')) $$,'23505','Synthetic unrelated constraint','only the intended organization-key unique constraint is retried');
RESET ROLE;
DROP TRIGGER sg13_unrelated_unique ON public.integration_plugins;
SELECT pg_temp.actor('author');

SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('bound_replacement',public.automation_asset_create_listing_v1('workflow_template',pg_temp.id('workflow_a'),NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{"auth_types":["bearer_token"]}}'),p_listing_id:=(pg_temp.result('bound_listing')->>'listing_id')::uuid)) $$,'replacement manifest can change the required connection auth contract');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('bound_replacement')->>'listing_version_id')::uuid) $$,'new requirement version follows normal publication');
SELECT throws_ok($$ SELECT public.automation_asset_upgrade_apply_v1((pg_temp.result('bound_install')->>'install_id')::uuid,(pg_temp.result('bound_replacement')->>'listing_version_id')::uuid) $$,'23514','Connection auth type is not allowed by the manifest','upgrade revalidates existing bindings against the target manifest even when snapshot content is unchanged');
SELECT is((SELECT current_listing_version_id FROM public.automation_asset_installs WHERE id=(pg_temp.result('bound_install')->>'install_id')::uuid),(pg_temp.result('bound_listing')->>'listing_version_id')::uuid,'rejected requirement upgrade leaves the old install current');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_source',public.integration_plugin_generate_draft_v1('SG13 rollback source','api',p_source_payload:='{"type":"object","properties":{"token":{"description":"Public tracking token","maxLength":64}}}',p_organization_id:=pg_temp.id('org_a'))) $$,'native plugin source preserves a legitimate schema member named token');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_listing',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('plugin_source')->>'version_id')::uuid,NULL,NULL,'private',pg_temp.manifest())) $$,'plugin source snapshots use the real authorized publication boundary');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('plugin_listing')->>'listing_version_id')::uuid) $$,'plugin publication produces a saved approved version');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_copy',public.automation_asset_install_v1((pg_temp.result('plugin_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'))) $$,'a nonactivated plugin copy remains available before native activation');
-- Induce a native activation failure after the install enters the real plugin lifecycle.
RESET ROLE;
CREATE FUNCTION pg_temp.fail_fixture_plugin_activation() RETURNS trigger
LANGUAGE plpgsql AS $fixture$
BEGIN
  RAISE EXCEPTION 'Synthetic native activation failure';
END;
$fixture$;
CREATE TRIGGER pgtap_fail_fixture_plugin_activation
  BEFORE UPDATE OF status ON public.integration_plugins
  FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION pg_temp.fail_fixture_plugin_activation();
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.automation_asset_install_v1((pg_temp.result('plugin_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}','{}',true) $$,'23514','Marketplace activation failed; no install was saved','native activation failure is safe and is not returned as successful activation');
SELECT is((SELECT count(*) FROM public.automation_asset_installs WHERE listing_id=(pg_temp.result('plugin_listing')->>'listing_id')::uuid),1::bigint,'failed activation leaves no partial install beyond the earlier successful draft copy');
RESET ROLE;
DROP TRIGGER pgtap_fail_fixture_plugin_activation ON public.integration_plugins;
SET LOCAL ROLE authenticated;

-- Draft generation fills empty bindings from policy. Publish a fixture whose saved binding is empty.
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES(
  'incomplete_plugin_source',public.integration_plugin_generate_draft_v1(
    'Synthetic incomplete plugin','api',p_organization_id:=pg_temp.id('org_a')
  )
) $$,'draft generation prepares the incomplete activation fixture');
RESET ROLE;
UPDATE public.integration_plugin_versions SET workflow_binding='{}'::jsonb
 WHERE id=(pg_temp.result('incomplete_plugin_source')->>'version_id')::uuid AND status='draft';
SET LOCAL ROLE authenticated;
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES(
  'incomplete_plugin_listing',public.automation_asset_create_listing_v1(
    'integration_plugin',(pg_temp.result('incomplete_plugin_source')->>'version_id')::uuid,
    NULL,NULL,'private',pg_temp.manifest()
  )
) $$,'marketplace snapshots the incomplete native fixture');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1(
  (pg_temp.result('incomplete_plugin_listing')->>'listing_version_id')::uuid
) $$,'incomplete fixture can be published as a private listing');
RESET ROLE;
SELECT is(
  (SELECT snapshot_payload#>'{version,workflow_binding}' FROM public.automation_asset_listing_versions
    WHERE id=(pg_temp.result('incomplete_plugin_listing')->>'listing_version_id')::uuid),
  '{}'::jsonb,'activation fixture has an empty native workflow binding'
);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT public.automation_asset_install_v1(
  (pg_temp.result('incomplete_plugin_listing')->>'listing_version_id')::uuid,
  'tenant',pg_temp.id('org_a'),'{}','{}',true
) $$,'23514','Marketplace activation failed; no install was saved','native activation rejects an empty workflow binding without injected failure');
SELECT is(
  (SELECT count(*) FROM public.automation_asset_installs
    WHERE listing_id=(pg_temp.result('incomplete_plugin_listing')->>'listing_id')::uuid),
  0::bigint,'incomplete native activation leaves no saved installation'
);

SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_source2',public.integration_plugin_generate_draft_v1('SG13 rollback source','api',p_plugin_id:=(pg_temp.result('plugin_source')->>'plugin_id')::uuid,p_source_payload:='{"title":"Changed public schema"}',p_organization_id:=pg_temp.id('org_a'))) $$,'native source lifecycle creates the next plugin source version');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_listing2',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('plugin_source2')->>'version_id')::uuid,NULL,NULL,'private',pg_temp.manifest(),p_listing_id:=(pg_temp.result('plugin_listing')->>'listing_id')::uuid)) $$,'plugin append preserves source plugin identity');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('plugin_listing2')->>'listing_version_id')::uuid) $$,'plugin replacement publishes through the canonical lifecycle');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('plugin_upgrade',public.automation_asset_upgrade_apply_v1((pg_temp.result('plugin_copy')->>'install_id')::uuid,(pg_temp.result('plugin_listing2')->>'listing_version_id')::uuid)) $$,'plugin manual upgrade stages an approved local version');
SELECT is(pg_temp.result('plugin_upgrade')->>'runtime_activated','false','staged plugin upgrade never claims a runtime switch');
SELECT is((SELECT metadata->>'pending_plugin_version_id' FROM public.automation_asset_installs WHERE id=(pg_temp.result('plugin_copy')->>'install_id')::uuid),pg_temp.result('plugin_upgrade')->>'staged_plugin_version_id','staged version result matches canonical pending metadata');
SELECT is((SELECT status FROM public.integration_plugin_versions WHERE id=(pg_temp.result('plugin_upgrade')->>'staged_plugin_version_id')::uuid),'approved','staged local plugin version is approved, not silently activated');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('secret_template_source',public.integration_plugin_generate_draft_v1('SG13 secret expression','api',p_outbound_operations:='[{"operation_name":"sg13","method":"POST","url_template":"https://example.invalid","headers_template":{"authorization":"{{secret.synthetic_provider.token}}"},"body_template":{"message":"public literal"}}]',p_organization_id:=pg_temp.id('org_a'))) $$,'native source can retain a declared unresolved secret expression for the bounded copy proof');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('secret_template_listing',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('secret_template_source')->>'version_id')::uuid,NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{"auth_types":["api_key"]}}'))) $$,'shared snapshot preserves declared placeholders without materializing secrets');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('secret_template_listing')->>'listing_version_id')::uuid) $$,'declared unresolved template can be retained as an approved copy source');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('secret_template_copy',public.automation_asset_install_v1((pg_temp.result('secret_template_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('connection')->>'connection_id')))) $$,'draft copy retains unsupported secret placeholders intact');
SELECT ok(EXISTS(SELECT 1 FROM public.integration_plugin_versions v WHERE v.plugin_id=(pg_temp.result('secret_template_copy')->>'installed_resource_id')::uuid AND v.outbound_operations #>> '{0,headers_template,authorization}'='{{secret.synthetic_provider.token}}'),'draft runtime readback does not rewrite the secret expression');
SELECT throws_ok($$ SELECT public.automation_asset_install_v1((pg_temp.result('secret_template_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('connection')->>'connection_id')),true) $$,'23514','Activation requires resolved install values; replace secret placeholders with a declared connection auth_config_id and native auth mode','unsupported raw-secret execution refuses activation with value-free actionable guidance');
SELECT is((SELECT count(*) FROM public.automation_asset_installs WHERE listing_id=(pg_temp.result('secret_template_listing')->>'listing_id')::uuid),1::bigint,'refused secret materialization leaves no partial activated install');
SELECT throws_ok($$ INSERT INTO pg_temp.sg13_results VALUES('unsafe_plugin_source',public.integration_plugin_generate_draft_v1('SG13 unsafe synthetic source','api',p_outbound_operations:='[{"operation_name":"sg13","headers_template":{"X-Provider-Auth":"Bearer sg13-raw"}}]',p_organization_id:=pg_temp.id('org_a'))) $$,'23514',NULL,'inline credentials are refused at native draft creation');
SELECT ok(pg_temp.result('unsafe_plugin_source') IS NULL AND NOT EXISTS(SELECT 1 FROM public.integration_plugins
 WHERE organization_id=pg_temp.id('org_a') AND name='SG13 unsafe synthetic source'),
 'refused inline credentials leave no saved source or draft result');
SELECT lives_ok($$ SELECT public.integration_connection_revoke_v1((pg_temp.result('connection')->>'connection_id')::uuid,NULL) $$,'revoke is an authorized row-locked transition');
SELECT throws_ok($$ SELECT public.integration_connection_rotate_v1((pg_temp.result('connection')->>'connection_id')::uuid,'{"api_key":"sg13-new"}') $$,'23514',NULL,'rotation cannot resurrect revoked credentials');
SELECT throws_ok($$ SELECT public.integration_connection_test_v1((pg_temp.result('connection')->>'connection_id')::uuid) $$,'23514',NULL,'credential test cannot resurrect revoked connection status');

RESET ROLE;
SELECT ok((SELECT a.marketplace_explicit_only FROM public.provider_auth_configs a JOIN public.integration_connections c ON c.runtime_auth_config_id=a.id WHERE c.id=(pg_temp.result('connection')->>'connection_id')::uuid),'synced runtime credentials are durably explicit-only, including after revoke');
INSERT INTO pg_temp.sg13_ids(key) VALUES('marked_operation'),('marked_mapping');
INSERT INTO public.mapping_configs(id,mapping_type,mapping_key,mapping_config,organization_id)
VALUES(pg_temp.id('marked_mapping'),'provider_response','sg13-'||pg_temp.id('marked_mapping')::text,'{}',pg_temp.id('org_a'));
INSERT INTO public.operation_templates(id,provider_id,operation_name,handler_key,method,url_template,headers_template,body_template,mapping_config_id,metadata)
SELECT pg_temp.id('marked_operation'),pg_temp.id('provider_a'),'sg13_marked_operation','outbound_http','POST','https://example.invalid','{}','{}',pg_temp.id('marked_mapping'),
 jsonb_build_object('auth',jsonb_build_object('auth_config_id',runtime_auth_config_id)) FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid;
SELECT throws_ok($$ SELECT public.automation_marketplace_assert_install_references_v1(jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('metadata',jsonb_build_object('operation_template_id',pg_temp.id('marked_operation'))))),'tenant',pg_temp.id('org_a'),pg_temp.id('org_a'),'{}') $$,'42501','Operation credential is not an authorized install binding','operation-template indirection cannot borrow a marked credential outside current authorized bindings');
SELECT is((SELECT artifact_hash FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid),(SELECT public.automation_marketplace_hash_payload_v1(snapshot_payload) FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid),'immutable snapshot hash matches stored content');
SELECT throws_ok($$ UPDATE public.automation_asset_listing_versions SET snapshot_payload='{}' WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid $$,'23514',NULL,'even privileged mutation cannot rewrite an existing snapshot');
SELECT ok((SELECT credential_generation>0 FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid),'credential generation advances on revoke');
SELECT ok((SELECT credentials_vault_id IS NULL AND credentials='{}'::jsonb AND expires_at<=now() FROM public.provider_auth_configs WHERE id=(SELECT runtime_auth_config_id FROM public.integration_connections WHERE id=(pg_temp.result('connection')->>'connection_id')::uuid)),'revoke invalidates the runtime pointer with an empty credential object that preserves the existing CHECK');
SELECT is(public.automation_marketplace_resolve_install_payload_v1('{"exact":"{{var.name}}","expression":"prefix {{var.name}}","unknown":"{{request.token}}","ref":"{{conn.provider.auth_config_id}}","secret":"{{secret.provider.token}}"}','{"name":"public literal"}','{"provider":{"auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}','{}'),
 '{"exact":"public literal","expression":"prefix {{var.name}}","unknown":"{{request.token}}","ref":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830","secret":"{{secret.provider.token}}"}'::jsonb,
 'whole-value substitution preserves unrelated expressions and never substitutes raw secrets');
SELECT throws_ok($$ SELECT public.automation_marketplace_resolve_install_payload_v1('{"auth":{"auth_config_id":"{{var.selected}}"}}','{"selected":"22222222-2222-4222-8222-222222222222"}','{}','{}') $$,'23514',NULL,'a variable cannot launder a foreign credential UUID into an executable selector');
SELECT throws_ok($$ SELECT public.automation_marketplace_assert_bound_auth_refs_v1(public.automation_marketplace_resolve_install_payload_v1('{"auth":"{{var.selected}}"}','{"selected":{"auth_config_id":"22222222-2222-4222-8222-222222222222"}}','{}','{}'),'{}') $$,'42501',NULL,'object-valued variables cannot bypass the final bound-reference closure');
SELECT lives_ok($$ SELECT public.automation_marketplace_assert_bound_auth_refs_v1(public.automation_marketplace_resolve_install_payload_v1('{"auth":{"auth_config_id":"{{conn.provider.auth_config_id}}"}}','{}','{"provider":{"auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}','{}'),'{"provider":{"auth_config_id":"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"}}') $$,'exact authorized connection provenance survives both materialization and final reference validation');
SELECT lives_ok($$ SELECT public.automation_marketplace_assert_secret_free_v1('{"properties":{"token":{"type":"string","description":"Public tracking token"}},"auth":{"credential_key":"token","auth_config_id":"{{conn.provider.auth_config_id}}"}}') $$,'schema identifiers and native auth selectors remain valid references');
SELECT lives_ok($$ SELECT public.automation_marketplace_assert_secret_free_v1('{"auth":{"mode":"body_fields","fields":{"password":"password","token":"access_token"}}}') $$,'native body-field selector names are references, not literal credentials');
SELECT is((SELECT jsonb_array_length(snapshot_payload->'steps') FROM public.automation_asset_listing_versions WHERE id=(pg_temp.result('v1')->>'listing_version_id')::uuid),1,'source edits and later lifecycle transitions preserve the first immutable snapshot');
SELECT throws_ok($$ SELECT public.automation_marketplace_assert_secret_free_v1('{"headers":{"X-Provider-Auth":"Bearer sg13-raw"}}') $$,'23514',NULL,'credential-bearing literal text cannot enter snapshots');
SELECT lives_ok($$ SELECT public.automation_marketplace_assert_secret_free_v1('{"body":{"description":"Basic service"},"properties":{"token":{"type":"string","default":"public-tracking-value"}}}') $$,'noncredential body text and legitimate schema defaults are preserved');
SELECT throws_ok($$ SELECT public.automation_marketplace_assert_secret_free_v1('{"headers":{"X-Provider-Auth":"Basic dXNlcjpwYXNz"}}') $$,'23514',NULL,'recognized Basic credentials are refused without confusing ordinary body text');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('transition_connection',public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=pg_temp.id('org_a'),p_provider_id:=pg_temp.id('provider_a'),p_name:='SG13 transition retained reference',p_secret_payload:='{"api_key":"sg13-transition"}')) $$,'Vault connection creates a real runtime row before verifier transition');
SELECT ok(public.automation_marketplace_sync_runtime_auth_config_v1((pg_temp.result('transition_connection')->>'connection_id')::uuid) IS NOT NULL,'Vault-ready helper exposes a usable explicit runtime reference');
SELECT lives_ok($$ SELECT public.integration_connection_upsert_v1(p_connection_id:=(pg_temp.result('transition_connection')->>'connection_id')::uuid,p_secret_storage_mode:='hash_only',p_secret_payload:='{"secret":"sg13-verifier"}') $$,'Vault to verifier transition preserves the existing credential constraint');
SELECT is(public.automation_marketplace_sync_runtime_auth_config_v1((pg_temp.result('transition_connection')->>'connection_id')::uuid),NULL::uuid,'verifier-only helper does not expose the retained stale runtime ID');
SELECT is(public.automation_marketplace_install_context_v1(jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{}}'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('transition_connection')->>'connection_id')),'tenant',pg_temp.id('org_a'),pg_temp.id('org_a')) #>> '{conn,synthetic_provider,auth_config_id}',NULL::text,'install context also returns no runtime auth ID after the transition');
SELECT ok(EXISTS(SELECT 1 FROM public.integration_connections c JOIN public.provider_auth_configs a ON a.id=c.runtime_auth_config_id WHERE c.id=(pg_temp.result('transition_connection')->>'connection_id')::uuid AND a.credentials='{}'::jsonb AND a.credentials_vault_id IS NULL AND a.marketplace_explicit_only),'old marked runtime row remains as empty audit state, not a usable binding');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('verifier_plugin_source',public.integration_plugin_generate_draft_v1('SG13 verifier reference','api',p_outbound_operations:='[{"operation_name":"sg13","method":"POST","url_template":"https://example.invalid","auth":{"mode":"api_key_header","header":"x-api-key","credential_key":"api_key","auth_config_id":"{{conn.synthetic_provider.auth_config_id}}"}}]')) $$,'native plugin source declares an explicit connection credential reference');
SELECT lives_ok($$ INSERT INTO pg_temp.sg13_results VALUES('verifier_plugin_listing',public.automation_asset_create_listing_v1('integration_plugin',(pg_temp.result('verifier_plugin_source')->>'version_id')::uuid,NULL,NULL,'private',jsonb_set(pg_temp.manifest(),'{connection_requirements}','{"synthetic_provider":{}}'))) $$,'explicit-reference snapshot is retained without embedding a secret');
SELECT lives_ok($$ SELECT public.automation_asset_publish_version_v1((pg_temp.result('verifier_plugin_listing')->>'listing_version_id')::uuid) $$,'explicit-reference listing publishes normally');
SELECT throws_ok($$ SELECT public.automation_asset_install_v1((pg_temp.result('verifier_plugin_listing')->>'listing_version_id')::uuid,'tenant',pg_temp.id('org_a'),'{}',jsonb_build_object('synthetic_provider',jsonb_build_object('connection_id',pg_temp.result('transition_connection')->>'connection_id')),true) $$,'23514','Activation requires resolved install values; replace secret placeholders with a declared connection auth_config_id and native auth mode','verifier-only stale history cannot be treated as a configured activation credential');
SELECT is((SELECT count(*) FROM public.automation_asset_installs WHERE listing_id=(pg_temp.result('verifier_plugin_listing')->>'listing_id')::uuid),0::bigint,'unavailable credential activation leaves no partial install');
SELECT * FROM finish();
ROLLBACK;
