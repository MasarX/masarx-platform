-- pgTAP: Label designer parity + SaaS onboarding defaults bootstrap

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(16);

CREATE OR REPLACE FUNCTION pg_temp.test_label_designer_onboarding_defaults_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_org_slug TEXT := 'ld-onboard-' || left(replace(gen_random_uuid()::text, '-', ''), 16);
  v_client UUID := gen_random_uuid();
  v_client_slug TEXT := 'ld-client-' || left(replace(gen_random_uuid()::text, '-', ''), 16);
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings_category_registry
      WHERE category = 'saas_onboarding_policy'
    ),
    'saas_onboarding_policy category is registered'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.schema_registry
      WHERE category = 'saas_onboarding_policy'
        AND version = 1
        AND is_active = TRUE
    ),
    'saas_onboarding_policy schema v1 is active'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'saas_onboarding_policy'
        AND scope_type = 'global'
        AND scope_id IS NULL
    ),
    'saas_onboarding_policy global default is seeded'
  );

  RETURN NEXT is(
    jsonb_array_length(COALESCE(public.ensure_required_global_defaults_v1()->'skipped_categories', '[]'::jsonb)),
    0,
    'required global defaults reconciliation reports no skipped categories'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'ui_navigation'
        AND scope_type = 'global'
        AND scope_id IS NULL
        AND cached_value::text LIKE '%/platform/labels%'
        AND cached_value::text LIKE '%Label Designer & templates%'
    ),
    'ui_navigation includes canonical Console V2 Label Designer workbench route'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings
      WHERE category = 'ui_navigation'
        AND scope_type = 'global'
        AND scope_id IS NULL
        AND cached_value::text LIKE '%/portal/labels/designer%'
    ),
    'ui_navigation includes portal label designer route'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
          ELSE '[]'::jsonb
        END
      ) AS cap(value)
      WHERE s.category = 'access_control_policy'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND role->>'key' = 'account_manager'
        AND cap.value IN ('label_design.read', '*')
    ),
    'account_manager includes label_design.read'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
          ELSE '[]'::jsonb
        END
      ) AS cap(value)
      WHERE s.category = 'access_control_policy'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND role->>'key' = 'client_admin'
        AND cap.value IN ('label_design.write', '*')
    ),
    'client_admin includes label_design.write'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(role->'capability_keys') = 'array' THEN role->'capability_keys'
          ELSE '[]'::jsonb
        END
      ) AS cap(value)
      WHERE s.category = 'access_control_policy'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND role->>'key' = 'sender_user'
        AND cap.value IN ('label_design.read', '*')
    ),
    'sender_user includes label_design.read'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'label_design_drafts'
        AND policyname = 'label_design_drafts_select'
        AND COALESCE(qual, '') ILIKE '%label_design.read%'
    ),
    'label_design_drafts_select policy is capability-gated'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'label_design_drafts'
        AND policyname = 'label_design_drafts_insert'
        AND COALESCE(with_check, '') ILIKE '%label_design.write%'
    ),
    'label_design_drafts_insert policy is capability-gated'
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Label Designer Onboarding Org', v_org_slug);

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.rbac_roles r
      WHERE r.organization_id = v_org
        AND r.key = 'ops_admin'
    ),
    'organization insert bootstraps ops_admin role template'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'ui_navigation'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org
    ),
    'organization insert materializes tenant ui_navigation defaults'
  );

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Label Designer Client', v_client_slug);

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.senders s
      WHERE s.client_id = v_client
    ),
    'client insert creates default sender by onboarding policy'
  );

  RETURN NEXT ok(
    to_regprocedure('public.bootstrap_tenant_onboarding_v1(uuid,text)') IS NOT NULL
    AND to_regprocedure('public.bootstrap_client_onboarding_v1(uuid,text)') IS NOT NULL
    AND to_regprocedure('public.bootstrap_sender_onboarding_v1(uuid,text)') IS NOT NULL,
    'onboarding bootstrap RPCs exist for tenant/client/sender'
  );

  RETURN NEXT ok(
    to_regprocedure('public.label_designer_is_service_role_v1()') IS NOT NULL,
    'label designer service-role helper exists'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_label_designer_onboarding_defaults_v1();

SELECT * FROM finish();

ROLLBACK;
