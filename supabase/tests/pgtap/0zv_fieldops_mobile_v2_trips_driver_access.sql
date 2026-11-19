-- Test Suite: FieldOps Mobile V2 Trips driver access
-- Ensures Trips stays reachable through row-driven access policy instead of
-- direct-route or fixture fallback navigation.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'trips.read'
       AND lv.status = 'active'
  ),
  'trips.read is registered as an active RBAC permission'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp
        ON tp.role_template_id = t.id
      JOIN public.lookup_values lv
        ON lv.id = tp.permission_id
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE t.key = 'fieldops_money_driver'
       AND ld.category = 'rbac_permission'
       AND lv.value = 'trips.read'
  ),
  'fieldops_money_driver template grants trips.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
      JOIN public.rbac_role_template_permissions tp
        ON tp.role_template_id = t.id
      JOIN public.lookup_values lv
        ON lv.id = tp.permission_id
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE t.key = 'driver'
       AND ld.category = 'rbac_permission'
       AND lv.value = 'trips.read'
  ),
  'driver template grants trips.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) role
     WHERE sv.category = 'access_control_policy'
       AND sv.approved_at IS NOT NULL
       AND COALESCE(sv.effective_until, 'infinity'::timestamptz) > now()
       AND role->>'key' = 'fieldops_money_driver'
       AND COALESCE(role->'capability_keys', '[]'::jsonb) @> to_jsonb('trips.read'::text)
  ),
  'active access policy fieldops_money_driver role includes trips.read'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions sv,
           jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) role
     WHERE sv.category = 'access_control_policy'
       AND sv.approved_at IS NOT NULL
       AND COALESCE(sv.effective_until, 'infinity'::timestamptz) > now()
       AND role->>'key' = 'driver'
       AND COALESCE(role->'capability_keys', '[]'::jsonb) @> to_jsonb('trips.read'::text)
  ),
  'active access policy driver role includes trips.read'
);

DO $$
DECLARE
  v_org_id UUID := gen_random_uuid();
  v_driver_id UUID := gen_random_uuid();
  v_client_id UUID := gen_random_uuid();
  v_sender_id UUID := gen_random_uuid();
  v_nav JSONB;
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (
    v_org_id,
    'pgTAP Mobile V2 Trips access',
    'pgtap-mobile-v2-trips-' || substr(v_org_id::text, 1, 8)
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client_id,
    v_org_id,
    'pgTAP Mobile V2 Trips client',
    'pgtap-mobile-v2-trips-client-' || substr(v_client_id::text, 1, 8),
    'active'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender_id,
    v_client_id,
    'pgTAP Mobile V2 Trips sender',
    'pgTAP Mobile V2 Trips sender',
    TRUE,
    'active'
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:fieldops-mobile-v2-trips-driver-access-fixture-bootstrap'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (
    v_driver_id,
    v_org_id,
    'pgt-trips-' || substr(v_driver_id::text, 1, 8) || '@e.test',
    'FieldOps Trips Driver',
    'fieldops_money_driver',
    'active'
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_org_id,
    ARRAY['fieldops_money_driver']::TEXT[],
    v_driver_id
  );

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_org_id,
    v_driver_id,
    r.id,
    v_driver_id,
    jsonb_build_object('source', 'fieldops_mobile_v2_trips_driver_access_pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org_id
     AND r.key = 'fieldops_money_driver'
  ON CONFLICT DO NOTHING;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver_id::text, 'role', 'authenticated')::text,
    TRUE
  );
  PERFORM set_config('request.jwt.claim.sub', v_driver_id::text, TRUE);

  PERFORM ok(
    public.user_has_capability_v1('trips.read', 'tenant', v_org_id),
    'fieldops money driver has trips.read through access policy'
  );

  SELECT public.ui_navigation_v1('mobile') INTO v_nav;

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_nav->'sections', '[]'::jsonb)) section,
             jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
       WHERE item->>'id' = 'mobile-trips'
         AND item->>'capability' = 'trips.read'
         AND NOT (item ? 'disabled_reason')
    ),
    'ui_navigation returns enabled Mobile V2 Trips for fieldops money driver'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(v_nav->'sections', '[]'::jsonb)) section,
             jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
       WHERE item->>'id' = 'mobile-trip-nav'
         AND item->>'capability' = 'trips.read'
         AND NOT (item ? 'disabled_reason')
    ),
    'ui_navigation returns enabled Mobile V2 Trip Nav for fieldops money driver'
  );

  PERFORM set_config('request.jwt.claims', '', TRUE);
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
END $$;

SELECT * FROM finish();
ROLLBACK;
