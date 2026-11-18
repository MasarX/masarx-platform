-- Native command/ACL coverage. Storage rows are catalog fixtures, not uploaded image bytes
-- or proof of the Edge signed-URL service. All fixture rows/settings/claims roll back.
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(76);

SELECT ok(has_function_privilege('authenticated', 'api.organization_profile_read_v1(uuid)', 'EXECUTE'), 'authenticated may enter guarded profile read');
SELECT ok(has_function_privilege('authenticated', 'api.ui_update_organization_profile_v1(jsonb)', 'EXECUTE'), 'authenticated may enter guarded profile save');
SELECT ok(NOT has_function_privilege('anon', 'api.organization_profile_read_v1(uuid)', 'EXECUTE'), 'anonymous cannot enter profile read');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_update_organization_profile_v1(jsonb)', 'EXECUTE'), 'anonymous cannot enter profile save');
SELECT ok(NOT has_function_privilege('authenticated', 'api.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'authenticated cannot enter API compensation');
SELECT ok(NOT has_function_privilege('authenticated', 'public.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'authenticated cannot enter public compensation');
SELECT ok(NOT has_function_privilege('anon', 'api.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'anonymous cannot enter API compensation');
SELECT ok(NOT has_function_privilege('anon', 'public.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'anonymous cannot enter public compensation');
SELECT ok(has_function_privilege('service_role', 'api.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'service role may enter exact API compensation');
SELECT ok(has_function_privilege('service_role', 'public.organization_profile_abort_upload_v1(uuid,uuid,uuid,uuid,text)', 'EXECUTE'), 'service role may enter exact public compensation');

CREATE FUNCTION pg_temp.test_organization_profile_branding_v1()
RETURNS SETOF TEXT LANGUAGE plpgsql AS $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_writer UUID := gen_random_uuid();
  v_other_writer UUID := gen_random_uuid();
  v_no_cap UUID := gen_random_uuid();
  v_inactive UUID := gen_random_uuid();
  v_platform UUID := gen_random_uuid();
  v_missing UUID := gen_random_uuid();
  v_correlation UUID := gen_random_uuid();
  v_artifacts UUID[] := ARRAY[]::UUID[];
  v_uploads UUID[] := ARRAY[]::UUID[];
  v_keys TEXT[] := ARRAY[]::TEXT[];
  v_id UUID;
  v_upload UUID;
  v_key TEXT;
  v_source TEXT;
  v_mime TEXT;
  v_file TEXT;
  v_sha TEXT;
  v_target UUID;
  v_creator UUID;
  v_actor UUID;
  v_created BOOLEAN;
  v_result JSONB;
  v_defaults JSONB;
  v_before JSONB;
  v_old_branding JSONB;
  v_shared UUID;
  v_link UUID;
  v_i INT;
  v_label TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'postgres', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"postgres"}', TRUE);

  RETURN NEXT ok(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'label-render-assets' AND public IS FALSE), 'branding reuses the existing private bucket');
  RETURN NEXT ok(EXISTS (
    SELECT 1 FROM public.table_contracts tc
    JOIN pg_trigger t ON t.tgrelid = 'public.organizations'::regclass AND t.tgname = 'audit_row_change'
    JOIN pg_proc p ON p.oid = t.tgfoid AND p.proname = 'audit_capture_row_change'
    WHERE tc.table_schema = 'public' AND tc.table_name = 'organizations' AND tc.audit_enabled IS TRUE
      AND t.tgenabled <> 'D' AND NOT t.tgisinternal
  ), 'existing organization audit contract/trigger is active, without a new audit path');

  INSERT INTO public.organizations (id, name, slug, timezone, locale, default_settings)
  VALUES (v_org, 'Branding fixture', 'branding-' || v_org, 'UTC', 'en',
    '{"auth":{"retain":true},"runtime":{"retain":"unchanged"},"branding":{"primary_color":"#112233","secondary_color":"#445566","custom_retained":"keep"}}'::jsonb),
    (v_foreign_org, 'Foreign branding fixture', 'branding-' || v_foreign_org, 'UTC', 'en', '{}'::jsonb);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, status)
  VALUES
    (v_writer, v_org, v_writer || '@example.com', 'Branding writer', 'ops_admin', 'tenant', 'active'),
    (v_other_writer, v_org, v_other_writer || '@example.com', 'Other branding writer', 'ops_admin', 'tenant', 'active'),
    (v_no_cap, v_org, v_no_cap || '@example.com', 'Branding reader without write', 'account_manager', 'tenant', 'active'),
    (v_inactive, v_org, v_inactive || '@example.com', 'Inactive branding writer', 'ops_admin', 'tenant', 'suspended'),
    (v_platform, v_org, v_platform || '@example.com', 'Platform branding writer', 'super_admin', 'platform', 'active');

  -- Real service registry calls create old/new and invalid-target fixtures. They do not
  -- bypass register_artifact_v1 ACL or pretend a catalog row contains real image bytes.
  FOR v_i IN 1..10 LOOP
    v_upload := gen_random_uuid();
    v_target := CASE WHEN v_i = 3 THEN v_foreign_org ELSE v_org END;
    v_creator := CASE WHEN v_i = 4 THEN v_other_writer ELSE v_writer END;
    v_source := CASE WHEN v_i = 5 THEN 'not-organization-profile' ELSE 'organization-profile' END;
    v_mime := CASE WHEN v_i = 7 THEN 'image/svg+xml' ELSE 'image/png' END;
    v_sha := CASE WHEN v_i = 8 THEN 'untrusted' ELSE repeat('a', 64) END;
    v_file := 'logo.png';
    v_key := v_target::text || CASE WHEN v_i = 6 THEN '/designer/' ELSE '/branding/' END || v_upload::text || '/' || v_file;
    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
    EXECUTE 'SET LOCAL ROLE service_role';
    SELECT artifact_id, created INTO v_id, v_created FROM api.register_artifact_v1(jsonb_build_object(
      'organization_id', v_target, 'created_by_user_id', v_creator, 'source_system', v_source,
      'storage_bucket', 'label-render-assets', 'storage_key', v_key, 'mime_type', v_mime,
      'size_bytes', 80, 'sha256', v_sha, 'metadata', jsonb_build_object('upload_id', v_upload, 'file_name', CASE WHEN v_i = 9 THEN '../logo.png' ELSE v_file END)
    ));
    IF v_id IS NULL OR v_created IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Could not create unique artifact fixture %', v_i; END IF;
    EXECUTE 'SET LOCAL ROLE postgres';
    IF v_i <> 10 THEN
      INSERT INTO storage.objects (bucket_id, name, metadata)
      VALUES ('label-render-assets', v_key, jsonb_build_object('mimetype', v_mime, 'size', 80));
    END IF;
    v_artifacts := array_append(v_artifacts, v_id);
    v_uploads := array_append(v_uploads, v_upload);
    v_keys := array_append(v_keys, v_key);
  END LOOP;
  UPDATE public.organizations SET default_settings = jsonb_set(default_settings, '{branding}',
    default_settings->'branding' || jsonb_build_object('logo_artifact_id', v_artifacts[1],
      'logo_storage_bucket', 'label-render-assets', 'logo_storage_key', v_keys[1],
      'logo_url', 'https://legacy.example.invalid/do-not-return')) WHERE id = v_org;
  SELECT default_settings INTO v_defaults FROM public.organizations WHERE id = v_org;
  v_old_branding := v_defaults->'branding';

  PERFORM set_config('request.jwt.claim.sub', v_writer::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_writer, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_capability_v1('organizations.write'), 'seeded tenant ops_admin has literal organizations.write');
  RETURN NEXT ok(public.user_has_resource_capability_v1('organizations', 'write'), 'same actor passes the current organization resource-write mapping');
  RETURN NEXT is(public.current_user_org_id(), v_org, 'verified tenant scope is the requested organization');
  v_result := api.organization_profile_read_v1(v_org);
  RETURN NEXT is(v_result #> '{profile,default_settings}', '{"branding":{"primary_color":"#112233","secondary_color":"#445566"}}'::jsonb, 'profile read exposes only the two safe branding colors');
  RETURN NEXT is(v_result #>> '{logo,artifact_id}', v_artifacts[1]::text, 'preview authorization resolves only the currently linked valid artifact');
  RETURN NEXT ok(NOT ((v_result->'profile')::text LIKE '%' || v_keys[1] || '%') AND NOT ((v_result->'profile')::text LIKE '%legacy.example.invalid%'), 'profile payload never returns internal logo path or legacy public URL');

  PERFORM set_config('request.correlation_id', v_correlation::text, TRUE);
  v_result := api.ui_update_organization_profile_v1(jsonb_build_object('organization_id', v_org,
    'name', 'Confirmed branding name', 'timezone', 'Asia/Riyadh', 'locale', 'ar',
    'primary_color', '#aAbBcC', 'secondary_color', '#001122'));
  RETURN NEXT is(v_result->'profile', jsonb_build_object('id', v_org, 'name', 'Confirmed branding name', 'timezone', 'Asia/Riyadh', 'locale', 'ar',
    'default_settings', '{"branding":{"primary_color":"#aAbBcC","secondary_color":"#001122"}}'::jsonb), 'allowed profile/color save returns actual safe database readback');
  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT default_settings INTO v_before FROM public.organizations WHERE id = v_org;
  RETURN NEXT is(v_before - 'branding', v_defaults - 'branding', 'save retains unrelated auth/runtime defaults exactly');
  RETURN NEXT is((v_before->'branding') - ARRAY['primary_color','secondary_color'], (v_old_branding) - ARRAY['primary_color','secondary_color'], 'color edit retains the previous logo and other existing branding keys');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.artifacts WHERE id = v_artifacts[1]) AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'label-render-assets' AND name = v_keys[1]), 'profile-only edit preserves the original artifact and object');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.audit_table_changes WHERE schema_name = 'public' AND table_name = 'organizations'
    AND op = 'UPDATE' AND pk = jsonb_build_object('id', v_org) AND changed_by = v_writer::text AND correlation_id = v_correlation), 'normal organization audit trigger records the verified writer and request correlation');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'default_settings_patch', jsonb_build_object('auth', jsonb_build_object('bypass', TRUE)))), '22023', 'Invalid profile fields', 'arbitrary default-settings patch cannot enter the profile command');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'logo_storage_key', v_keys[2])), '22023', 'Invalid profile fields', 'caller storage identity is rejected');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'primary_color', 123)), '22023', 'Invalid branding color', 'color must be a bounded typed hexadecimal string');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'locale', NULL)), '22023', 'Invalid locale', 'null locale cannot overwrite the saved profile');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is((SELECT default_settings FROM public.organizations WHERE id = v_org), v_before, 'all rejected settings edits preserve the saved defaults');
  EXECUTE 'SET LOCAL ROLE authenticated';

  FOR v_i IN 3..10 LOOP
    v_label := (ARRAY['old','new','foreign organization','another creator','wrong source','designer path','wrong MIME','invalid digest','unsafe filename','missing object'])[v_i];
    RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'logo_artifact_id', v_artifacts[v_i])), '42501', 'Logo artifact is not an owned branding upload', 'save refuses artifact with ' || v_label);
  END LOOP;
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_read_v1(%L::uuid)', v_foreign_org), '42501', 'Organization outside writer scope', 'tenant writer cannot read foreign organization branding');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_foreign_org, 'name', 'Forbidden')), '42501', 'Organization outside writer scope', 'tenant writer cannot update a foreign organization');

  FOREACH v_actor IN ARRAY ARRAY[v_no_cap, v_inactive, v_missing] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_actor::text, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text, TRUE);
    RETURN NEXT throws_ok(format('SELECT api.organization_profile_read_v1(%L::uuid)', v_org), '42501', NULL::TEXT, 'missing capability/inactive/missing actor cannot read branding: ' || v_actor);
    RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'name', 'Forbidden')), '42501', NULL::TEXT, 'missing capability/inactive/missing actor cannot save branding: ' || v_actor);
  END LOOP;
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'anon', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', TRUE);
  EXECUTE 'SET LOCAL ROLE anon';
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_read_v1(%L::uuid)', v_org), '42501', NULL::TEXT, 'actual anonymous role cannot call the profile read');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'name', 'Forbidden')), '42501', NULL::TEXT, 'actual anonymous role cannot call the profile save');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', v_platform::text, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_platform, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.organization_profile_read_v1(v_foreign_org) #>> '{profile,id}', v_foreign_org::text, 'verified platform writer may explicitly target another organization');
  RETURN NEXT is(api.ui_update_organization_profile_v1(jsonb_build_object('organization_id', v_foreign_org, 'name', 'Platform confirmed')) #>> '{profile,name}', 'Platform confirmed', 'platform writer save follows the existing platform scope path');

  -- A literal capability must not bypass a scope's remapped resource-write deny.
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    jsonb_build_object('resource_map', jsonb_build_object('organizations', jsonb_build_object('write', 'shipments.write')),
      'denies', jsonb_build_array(jsonb_build_object('capability_key', 'shipments.write', 'scope_type', 'tenant', 'scope_id', v_org))), 1, 'pgTAP organization branding remapped write denial');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';
  PERFORM set_config('request.jwt.claim.sub', v_writer::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_writer, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_capability_v1('organizations.write'), 'literal organization write remains granted under the remapped policy');
  RETURN NEXT ok(NOT public.user_has_resource_capability_v1('organizations', 'write'), 'existing resource-write boundary independently denies the remapped capability');
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_read_v1(%L::uuid)', v_org), '42501', 'Organization resource write denied', 'preview/read guard respects effective resource-write denial');
  RETURN NEXT throws_ok(format('SELECT api.ui_update_organization_profile_v1(%L::jsonb)', jsonb_build_object('organization_id', v_org, 'name', 'Forbidden')), '42501', 'Organization resource write denied', 'save guard respects effective resource-write denial');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', v_org,
    '{"resource_map":{"organizations":{"write":"organizations.write"}},"denies":[]}'::jsonb, 1, 'pgTAP restore canonical organization branding mapping');
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'access_control_policy:%';

  PERFORM set_config('request.jwt.claim.sub', v_other_writer::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other_writer, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.ui_update_organization_profile_v1(jsonb_build_object('organization_id', v_org, 'logo_artifact_id', v_artifacts[4]));
  RETURN NEXT is(v_result #>> '{logo,artifact_id}', v_artifacts[4]::text, 'successful replacement saves and reads back the actual owned registered logo');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok((SELECT default_settings - 'branding' = v_before - 'branding' AND NOT (default_settings->'branding' ? 'logo_url') FROM public.organizations WHERE id = v_org), 'successful replacement keeps unrelated defaults and removes only the legacy public-logo field');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.artifacts WHERE id = v_artifacts[1]) AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'label-render-assets' AND name = v_keys[1]), 'successful replacement does not delete the old artifact or object');
  PERFORM set_config('request.jwt.claim.sub', v_writer::text, TRUE);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_writer, 'role', 'authenticated')::text, TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is(api.organization_profile_read_v1(v_org) #>> '{logo,artifact_id}', v_artifacts[4]::text, 'authorized writer may preview the valid current logo uploaded by another verified writer');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.organizations SET default_settings = v_before WHERE id = v_org;

  -- Invalid existing links never become preview authority. Another legitimate uploader
  -- is intentionally allowed on read; only new-logo saving requires this caller's ownership.
  FOREACH v_i IN ARRAY ARRAY[3,5,6,7,8,9,10] LOOP
    UPDATE public.organizations SET default_settings = jsonb_set(default_settings, '{branding,logo_artifact_id}', to_jsonb(v_artifacts[v_i]::text)) WHERE id = v_org;
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_result := api.organization_profile_read_v1(v_org);
    RETURN NEXT is(v_result->'logo', 'null'::jsonb, 'invalid linked artifact cannot authorize a preview: case ' || v_i);
    EXECUTE 'SET LOCAL ROLE postgres';
  END LOOP;
  UPDATE public.organizations SET default_settings = v_before WHERE id = v_org;

  -- Compensation never deletes the old logo or anything referenced anywhere else.
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)', v_artifacts[2], v_org, v_writer, v_uploads[2], v_keys[2]), '42501', NULL::TEXT, 'user cannot call actual compensation even for their own new upload');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)', v_artifacts[1], v_org, v_writer, v_uploads[1], v_keys[1]), '42501', 'Upload identity is missing, changed or linked', 'saved original logo cannot be compensated');
  INSERT INTO public.artifact_links (organization_id, artifact_id, resource_type, resource_id, relation_type)
  VALUES (v_org, v_artifacts[2], 'organizations', v_org, 'evidence') RETURNING id INTO v_link;
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)', v_artifacts[2], v_org, v_writer, v_uploads[2], v_keys[2]), '42501', 'Upload identity is missing, changed or linked', 'artifact_links reference protects the new object');
  DELETE FROM public.artifact_links WHERE id = v_link;
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.organizations SET default_settings = jsonb_build_object('branding', jsonb_build_object('logo_storage_bucket', 'label-render-assets', 'logo_storage_key', v_keys[2])) WHERE id = v_foreign_org;
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)', v_artifacts[2], v_org, v_writer, v_uploads[2], v_keys[2]), '42501', 'Upload identity is missing, changed or linked', 'a different saved profile protects the exact bucket/key even without an artifact id');
  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.organizations SET default_settings = '{}'::jsonb WHERE id = v_foreign_org;
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT artifact_id INTO v_shared FROM api.register_artifact_v1(jsonb_build_object('organization_id', v_foreign_org,
    'created_by_user_id', v_writer, 'source_system', 'organization-profile', 'storage_bucket', 'label-render-assets',
    'storage_key', v_keys[2], 'mime_type', 'image/png', 'size_bytes', 80, 'sha256', repeat('a',64)));
  RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)', v_artifacts[2], v_org, v_writer, v_uploads[2], v_keys[2]), '42501', 'Upload identity is missing, changed or linked', 'a different artifact referencing the same object prevents compensation');
  DELETE FROM public.artifacts WHERE id = v_shared;
  FOR v_i IN 1..4 LOOP
    RETURN NEXT throws_ok(format('SELECT api.organization_profile_abort_upload_v1(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)',
      v_artifacts[2], CASE WHEN v_i = 1 THEN v_foreign_org ELSE v_org END,
      CASE WHEN v_i = 2 THEN v_other_writer ELSE v_writer END,
      CASE WHEN v_i = 3 THEN v_uploads[1] ELSE v_uploads[2] END,
      CASE WHEN v_i = 4 THEN v_keys[1] ELSE v_keys[2] END), '42501', 'Upload identity is missing, changed or linked', 'compensation refuses a changed exact identity field: case ' || v_i);
  END LOOP;
  RETURN NEXT ok(api.organization_profile_abort_upload_v1(v_artifacts[2], v_org, v_writer, v_uploads[2], v_keys[2]), 'service may abort only the exact unlinked newly registered upload');
  RETURN NEXT ok(NOT EXISTS (SELECT 1 FROM public.artifacts WHERE id = v_artifacts[2]), 'exact abort removes only the new artifact registration');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'label-render-assets' AND name = v_keys[2]), 'database abort leaves exact object removal to the Edge storage operation');
  RETURN NEXT ok(EXISTS (SELECT 1 FROM public.artifacts WHERE id = v_artifacts[1])
    AND EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'label-render-assets' AND name = v_keys[1])
    AND (SELECT default_settings->'branding'->>'logo_artifact_id' = v_artifacts[1]::text FROM public.organizations WHERE id = v_org), 'all rejected saves and compensation leave the old saved logo intact');
  RETURN;
END;
$fixture$;

SELECT * FROM pg_temp.test_organization_profile_branding_v1();
SELECT * FROM finish();
ROLLBACK;
