-- pgTAP: F619 G3 FieldOps active-role authorization.
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE OR REPLACE FUNCTION pg_temp.test_fieldops_active_role_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_other_user UUID := gen_random_uuid();
  v_role UUID;
  v_unassigned_role UUID;
  v_device UUID := gen_random_uuid();
  v_foreign_device UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_column('public', 'user_devices', 'active_role_id', 'user_devices has active_role_id');
  RETURN NEXT has_function('public', 'ui_get_fieldops_active_role_v1', ARRAY['uuid'], 'public getter exists');
  RETURN NEXT has_function('public', 'ui_set_fieldops_active_role_v1', ARRAY['uuid','uuid'], 'public setter exists');
  RETURN NEXT has_function('api', 'ui_get_fieldops_active_role_v1', ARRAY['uuid'], 'api getter exists');
  RETURN NEXT has_function('api', 'ui_set_fieldops_active_role_v1', ARRAY['uuid','uuid'], 'api setter exists');

  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'FieldOps Role Org', 'fieldops-role-' || left(v_org::text, 8)),
    (v_other_org, 'FieldOps Other Org', 'fieldops-role-' || left(v_other_org::text, 8));
  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type) VALUES
    (v_user, v_org, 'fieldops-role-' || left(v_user::text, 8) || '@example.com', 'FieldOps Role User', 'tenant'),
    (v_other_user, v_other_org, 'fieldops-role-' || left(v_other_user::text, 8) || '@example.com', 'FieldOps Other User', 'tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_org, ARRAY['driver','fleet_manager'], v_user);
  SELECT id INTO STRICT v_role FROM public.rbac_roles
  WHERE organization_id=v_org AND key='driver';
  SELECT id INTO STRICT v_unassigned_role FROM public.rbac_roles
  WHERE organization_id=v_org AND key='fleet_manager';
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
  VALUES (v_org, v_user, v_role);
  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'fieldops-role', 'FieldOps Role Branch');
  INSERT INTO public.branch_memberships (branch_id, user_id, role_key)
  VALUES (v_branch, v_user, 'driver');
  INSERT INTO public.user_devices (
    id, organization_id, user_id, device_platform, device_identifier_sha256
  ) VALUES
    (v_device, v_org, v_user, 'android', 'fieldops-role-owned'),
    (v_foreign_device, v_other_org, v_other_user, 'android', 'fieldops-role-foreign');

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_result := api.ui_get_fieldops_active_role_v1(v_device);
  RETURN NEXT is(v_result->>'selection_state', 'single_eligible', 'single eligible role is neutral until selected');
  RETURN NEXT is((v_result->'eligible_roles'->0->>'role_id')::uuid, v_role, 'getter returns only assigned active role');
  RETURN NEXT is((v_result->'eligible_roles'->0->'branch_ids'->>0)::uuid, v_branch, 'getter includes effective branch membership');

  v_result := api.ui_set_fieldops_active_role_v1(v_device, v_role);
  RETURN NEXT is(v_result->>'selection_state', 'selected', 'eligible role can be selected');
  RETURN NEXT is((v_result->>'selected_role_id')::uuid, v_role, 'selection persists on owned device');

  RETURN NEXT throws_ok(
    format('SELECT api.ui_set_fieldops_active_role_v1(%L::uuid, %L::uuid)', v_device, v_unassigned_role),
    '42501', 'ui_set_fieldops_active_role_v1 role is not eligible'
  );
  RETURN NEXT throws_ok(
    format('SELECT api.ui_get_fieldops_active_role_v1(%L::uuid)', v_foreign_device),
    '42501', 'ui_get_fieldops_active_role_v1 device is not active and owned'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  UPDATE public.user_devices SET revoked_at = now(), revoked_reason = 'test' WHERE id = v_device;
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format('SELECT api.ui_set_fieldops_active_role_v1(%L::uuid, %L::uuid)', v_device, v_role),
    '42501', 'ui_set_fieldops_active_role_v1 device is not active and owned'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_fieldops_active_role_v1();
SELECT * FROM finish();
ROLLBACK;
