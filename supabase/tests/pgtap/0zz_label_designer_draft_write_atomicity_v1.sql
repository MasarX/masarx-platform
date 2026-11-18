-- Native transaction guards: rejected validation must still retain the row lock.
-- Run only in the existing pgTAP database qualification lane; all fixtures roll back.
BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(41);

SELECT ok(
  pg_get_functiondef('public.label_designer_update_draft(uuid,text,text,jsonb)'::regprocedure)
    ~ 'organization_id = v_org[[:space:]]+LIMIT 1[[:space:]]+FOR UPDATE;'
  AND pg_get_functiondef('public.label_designer_publish_label_design_draft(uuid,text)'::regprocedure)
    ~ 'organization_id = v_org[[:space:]]+LIMIT 1[[:space:]]+FOR UPDATE;',
  'save and publish lock the tenant-qualified row at their first read'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'authenticated retains public draft-save execution'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'authenticated retains API draft-save execution'
);
SELECT ok(
  has_function_privilege('service_role', 'public.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'service_role retains public draft-publish execution'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'anonymous public draft-save execution remains denied'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'anonymous API draft-publish execution remains denied'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'anonymous API draft-save execution remains denied'
);
SELECT ok(
  has_function_privilege('service_role', 'public.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'service_role retains public draft-save execution'
);
SELECT ok(
  has_function_privilege('service_role', 'api.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'service_role retains API draft-save execution'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'anonymous public draft-publish execution remains denied'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'authenticated retains public draft-publish execution'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'authenticated retains API draft-publish execution'
);
SELECT ok(
  has_function_privilege('service_role', 'api.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'service_role retains API draft-publish execution'
);

CREATE FUNCTION pg_temp.test_label_designer_draft_write_atomicity_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_save_id UUID := gen_random_uuid();
  v_publish_probe_id UUID := gen_random_uuid();
  v_foreign_id UUID := gen_random_uuid();
  v_fork_id UUID;
  v_version_id UUID;
  v_value JSONB;
  v_result JSONB;
  v_version_count INT;
  v_immutable_message TEXT := 'Published and archived label drafts are immutable; create a new draft';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES
    (v_org, 'Label Atomicity Test', 'label-atomic-' || v_org::text, 'active'),
    (v_foreign_org, 'Label Atomicity Foreign', 'label-atomic-' || v_foreign_org::text, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (v_user, v_org, 'label-atomic-' || v_user::text || '@example.com', 'Label Atomicity Writer', 'ops_admin', 'active', 'tenant', NULL);
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, '{"source":"pgtap"}'::jsonb
  FROM public.rbac_roles r WHERE r.organization_id = v_org AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  -- Tenant bootstrap uses wall time; this transaction's publish uses workflow_now().
  UPDATE public.settings_versions
     SET effective_from = LEAST(effective_from, public.workflow_now() - INTERVAL '1 microsecond')
   WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org
     AND effective_until IS NULL AND approved_at IS NOT NULL;

  v_value := public.resolve_settings_merged('label_design', 'tenant', v_org);
  INSERT INTO public.label_design_drafts (id, organization_id, scope_type, scope_id, label_type, draft_value, created_by)
  VALUES
    (v_save_id, v_org, 'tenant', v_org, 'shipping', '{}'::jsonb, v_user),
    (v_publish_probe_id, v_org, 'tenant', v_org, 'shipping', '{}'::jsonb, v_user),
    (v_foreign_id, v_foreign_org, 'tenant', v_foreign_org, 'shipping', '{}'::jsonb, NULL);

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(public.user_has_capability_v1('label_design.write', 'tenant', v_org), 'fixture uses a real authenticated label writer');
  RETURN NEXT ok(
    (SELECT bool_and(d.xmax::text = '0') FROM public.label_design_drafts d
     WHERE d.organization_id = v_org AND d.id IN (v_save_id, v_publish_probe_id)),
    'both probes start without tuple locks'
  );

  v_result := api.label_designer_update_draft(v_save_id, NULL, NULL, '[]'::jsonb);
  RETURN NEXT is(v_result #>> '{error,code}', 'invalid_draft_value', 'invalid save retains its existing validation error');
  RETURN NEXT ok(
    (SELECT d.xmax::text::bigint = txid_current() % 4294967296 AND d.draft_value = '{}'::jsonb
       FROM public.label_design_drafts d WHERE d.id = v_save_id AND d.organization_id = v_org),
    'rejected save holds the tuple lock until transaction end without changing content'
  );

  v_result := api.label_designer_publish_label_design_draft(v_publish_probe_id, 'invalid probe');
  RETURN NEXT is(v_result #>> '{error,code}', 'validation_failed', 'invalid publish retains its existing validation error');
  RETURN NEXT ok(
    (SELECT d.xmax::text::bigint = txid_current() % 4294967296 AND d.status = 'draft' AND d.draft_value = '{}'::jsonb
       FROM public.label_design_drafts d WHERE d.id = v_publish_probe_id AND d.organization_id = v_org),
    'rejected publish holds its own tuple lock before any publication write'
  );

  v_result := api.label_designer_update_draft(v_save_id, 'shipping', 'Saved version', v_value);
  RETURN NEXT ok((v_result->>'ok')::boolean AND v_result #> '{draft,draft_value}' = v_value, 'editable draft saves its complete design without normalization');
  v_result := api.label_designer_publish_label_design_draft(v_save_id, 'atomicity regression');
  RETURN NEXT ok((v_result->>'ok')::boolean, 'saved draft publishes through the unchanged validation gate');
  v_version_id := (v_result->>'settings_version_id')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';
  SELECT count(*) INTO v_version_count FROM public.settings_versions
  WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org;
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.label_design_drafts d JOIN public.settings_versions sv ON sv.id = d.published_settings_version_id
            JOIN public.settings s ON s.settings_version_id = sv.id
            WHERE d.id = v_save_id AND d.organization_id = v_org AND d.status = 'published'
              AND sv.id = v_version_id AND sv.value = v_value AND d.draft_value = v_value AND s.cached_value = v_value),
    'published draft, immutable version, and effective settings have the exact saved value'
  );
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_result := api.label_designer_update_draft(v_save_id, NULL, NULL, '{}'::jsonb);
  RETURN NEXT is(v_result #>> '{error,code}', 'draft_not_editable', 'a later save cannot rewrite a published row');
  v_result := api.label_designer_publish_label_design_draft(v_save_id, 'repeat');
  RETURN NEXT is(v_result #>> '{error,code}', 'draft_not_publishable', 'a second publish rejects the same row');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.settings_versions WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org),
    v_version_count, 'rejected save and repeat publish do not create a settings version'
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET draft_value = ''{}''::jsonb WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'authenticated API-view update cannot bypass published content immutability'
  );
  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET status = ''draft'' WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'authenticated API-view update cannot reopen a published row'
  );
  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET draft_name = ''rewritten'', label_type = ''rewritten'' WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'published design identity and metadata cannot be rewritten'
  );
  RETURN NEXT lives_ok(
    format('UPDATE api.label_design_drafts SET updated_at = now() WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    'published rows retain harmless timestamp updates'
  );
  RETURN NEXT lives_ok(
    format('UPDATE api.label_design_drafts SET status = ''archived'', updated_at = now() WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    'published rows can still be archived'
  );
  RETURN NEXT ok(
    (SELECT d.status = 'archived' AND d.draft_value = v_value AND d.published_settings_version_id = v_version_id
       FROM public.label_design_drafts d WHERE d.id = v_save_id AND d.organization_id = v_org),
    'archive preserves the exact published payload and version identity'
  );
  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET draft_value = ''{}''::jsonb WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'archived content cannot be rewritten through the API view'
  );
  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET status = ''published'' WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'an archived row cannot reopen as published'
  );
  RETURN NEXT throws_ok(
    format('UPDATE api.label_design_drafts SET status = ''draft'' WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    '55000', v_immutable_message, 'an archived row cannot reopen as editable'
  );

  v_result := api.label_designer_create_draft('tenant', v_org, 'shipping', 'Fork', v_value);
  v_fork_id := (v_result #>> '{draft,id}')::uuid;
  RETURN NEXT ok((v_result->>'ok')::boolean AND v_fork_id IS DISTINCT FROM v_save_id AND v_result #>> '{draft,status}' = 'draft', 'fork creates a separate editable row');
  v_result := api.label_designer_update_draft(v_fork_id, NULL, 'Edited fork', v_value);
  RETURN NEXT ok(
    (v_result->>'ok')::boolean AND EXISTS (
      SELECT 1 FROM public.label_design_drafts d WHERE d.id = v_save_id AND d.organization_id = v_org
        AND d.status = 'archived' AND d.draft_value = v_value AND d.draft_name = 'Saved version'
    ), 'editing a fork leaves its published original unchanged'
  );
  v_result := api.label_designer_update_draft(v_foreign_id, NULL, NULL, '{}'::jsonb);
  RETURN NEXT is(v_result #>> '{error,code}', 'draft_not_found', 'save still hides rows in another tenant');
  v_result := api.label_designer_publish_label_design_draft(v_foreign_id, 'foreign');
  RETURN NEXT is(v_result #>> '{error,code}', 'draft_not_found', 'publish still hides rows in another tenant');

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.users SET status = 'suspended' WHERE id = v_user;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT ok(
    api.label_designer_update_draft(v_fork_id, NULL, NULL, '{}'::jsonb) #>> '{error,code}' = 'org_required'
    AND api.label_designer_publish_label_design_draft(v_fork_id, 'suspended') #>> '{error,code}' = 'org_required',
    'inactive accounts retain their fail-closed organization guard'
  );
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  RETURN NEXT ok(
    api.label_designer_update_draft(v_fork_id, NULL, NULL, '{}'::jsonb) #>> '{error,code}' = 'auth_required'
    AND api.label_designer_publish_label_design_draft(v_fork_id, 'unauthenticated') #>> '{error,code}' = 'auth_required',
    'both RPCs still require an authenticated identity'
  );
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT lives_ok(
    format('DELETE FROM public.label_design_drafts WHERE id = %L::uuid AND organization_id = %L::uuid', v_save_id, v_org),
    'existing explicit cleanup can still delete the archived row'
  );
END;
$function$;

SELECT * FROM pg_temp.test_label_designer_draft_write_atomicity_v1();
SELECT * FROM finish();
ROLLBACK;
