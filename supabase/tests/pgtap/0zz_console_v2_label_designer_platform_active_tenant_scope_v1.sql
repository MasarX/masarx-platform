-- pgTAP: Console V2 platform operators can use the label designer inside the
-- active tenant lens without falling back to the platform user's home org.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(18);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_platform_org UUID := '00000000-0000-0000-0000-00000000e781';
  v_tenant_org UUID := '00000000-0000-0000-0000-00000000e782';
  v_platform_user UUID := '00000000-0000-0000-0000-00000000e783';
  v_tenant_user UUID := '00000000-0000-0000-0000-00000000e784';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_platform_org, 'Console V2 Label Designer Platform Org', 'console-v2-label-designer-platform'),
    (v_tenant_org, 'Console V2 Label Designer Active Tenant', 'console-v2-label-designer-active-tenant')
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         slug = EXCLUDED.slug,
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
  VALUES (
    v_platform_user,
    v_platform_org,
    'label-designer-platform-operator@example.test',
    'Label Designer Platform Operator',
    'super_admin',
    'platform',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id,
         status = EXCLUDED.status,
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
  VALUES (
    v_tenant_user,
    v_platform_org,
    'label-designer-tenant-operator@example.test',
    'Label Designer Tenant Operator',
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
         status = EXCLUDED.status,
         updated_at = now();

  DELETE FROM public.settings
   WHERE category = 'label_design'
     AND scope_type = 'tenant'
     AND scope_id = v_tenant_org;

  DELETE FROM public.settings_versions
   WHERE category = 'label_design'
     AND scope_type = 'tenant'
     AND scope_id = v_tenant_org;

  DELETE FROM public.label_design_drafts
   WHERE organization_id IN (v_platform_org, v_tenant_org);

  PERFORM set_config('test.label_designer_platform_org', v_platform_org::TEXT, TRUE);
  PERFORM set_config('test.label_designer_platform_tenant', v_tenant_org::TEXT, TRUE);
  PERFORM set_config('test.label_designer_platform_user', v_platform_user::TEXT, TRUE);
  PERFORM set_config('test.label_designer_tenant_user', v_tenant_user::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_designer_platform_user'), TRUE);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.label_designer_platform_user'), 'role', 'authenticated')::TEXT,
  TRUE
);
SET LOCAL ROLE authenticated;

SELECT ok(public.is_platform_user(), 'fixture user is a platform operator');

SELECT ok(
  public.user_has_capability_v1('label_design.read', 'tenant', current_setting('test.label_designer_platform_tenant')::UUID),
  'platform operator resolves tenant label_design.read through policy'
);

SELECT ok(
  public.user_has_capability_v1('label_design.write', 'tenant', current_setting('test.label_designer_platform_tenant')::UUID),
  'platform operator resolves tenant label_design.write through policy'
);

SELECT set_config(
  'test.label_designer_platform_scope_check',
  public.label_designer_assert_scope('tenant', current_setting('test.label_designer_platform_tenant')::UUID)::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_designer_platform_scope_check')::jsonb->>'ok')::BOOLEAN, FALSE),
  'label_designer_assert_scope accepts the active tenant for platform operator'
);

SELECT is(
  current_setting('test.label_designer_platform_scope_check')::jsonb->>'organization_id',
  current_setting('test.label_designer_platform_tenant'),
  'scope check resolves owner organization from the active tenant'
);

SELECT set_config(
  'test.label_designer_platform_readiness',
  api.ui_label_renderer_readiness_v1('tenant', current_setting('test.label_designer_platform_tenant')::UUID)::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_designer_platform_readiness')::jsonb->>'ok')::BOOLEAN, FALSE),
  'renderer readiness no longer fails active-tenant scope validation'
);

SELECT is(
  current_setting('test.label_designer_platform_readiness')::jsonb #>> '{scope,scope_id}',
  current_setting('test.label_designer_platform_tenant'),
  'renderer readiness readback is scoped to the active tenant'
);

SELECT set_config(
  'test.label_designer_platform_catalog',
  api.label_designer_get_field_catalog('tenant', current_setting('test.label_designer_platform_tenant')::UUID)::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_designer_platform_catalog')::jsonb->>'ok')::BOOLEAN, FALSE)
  AND jsonb_typeof(current_setting('test.label_designer_platform_catalog')::jsonb->'value') = 'object',
  'field catalog resolves through the active tenant scope'
);

SELECT set_config(
  'test.label_designer_platform_create',
  api.label_designer_create_draft(
    'tenant',
    current_setting('test.label_designer_platform_tenant')::UUID,
    'shipping',
    'Platform active tenant label design',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'shipping',
        jsonb_build_object(
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
          'blocks', jsonb_build_array(
            jsonb_build_object(
              'type', 'text',
              'section_key', 'platform_scope_block',
              'value_path', 'shipment.platform_active_tenant_label',
              'x', 24,
              'y', 48,
              'width', 260,
              'height', 24
            )
          ),
          'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'shipment.tracking_number')
        )
      )
    )
  )::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_designer_platform_create')::jsonb->>'ok')::BOOLEAN, FALSE),
  'platform operator creates active-tenant label draft'
);

SELECT is(
  current_setting('test.label_designer_platform_create')::jsonb #>> '{draft,organization_id}',
  current_setting('test.label_designer_platform_tenant'),
  'created draft is stored under active tenant organization, not platform home org'
);

SELECT set_config(
  'test.label_designer_platform_draft',
  current_setting('test.label_designer_platform_create')::jsonb #>> '{draft,id}',
  TRUE
);

SELECT set_config(
  'test.label_designer_platform_update',
  api.label_designer_update_draft(
    current_setting('test.label_designer_platform_draft')::UUID,
    'returns',
    'Platform active tenant updated label design',
    NULL
  )::TEXT,
  TRUE
);

-- Migration 202610190901 makes draft update and publish home-organization scoped.
SELECT is(
  current_setting('test.label_designer_platform_update')::jsonb #>> '{error,code}',
  'draft_not_found',
  'platform operator outside the draft organization receives a generic update denial'
);

SELECT ok(
  COALESCE((api.label_designer_validate_label_design_draft(current_setting('test.label_designer_platform_draft')::UUID)->>'ok')::BOOLEAN, FALSE),
  'platform operator validates active-tenant label draft'
);

SELECT set_config(
  'test.label_designer_platform_publish',
  api.label_designer_publish_label_design_draft(
    current_setting('test.label_designer_platform_draft')::UUID,
    'pgTAP platform active tenant label design publish'
  )::TEXT,
  TRUE
);

SELECT is(
  current_setting('test.label_designer_platform_publish')::jsonb #>> '{error,code}',
  'draft_not_found',
  'platform operator outside the draft organization receives a generic publication denial'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_designer_platform_draft')::UUID
       AND organization_id = current_setting('test.label_designer_platform_tenant')::UUID
       AND status = 'draft'
       AND label_type = 'shipping'
       AND published_settings_version_id IS NULL
  ),
  'denied writes leave the active tenant draft intact'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'label_design'
       AND scope_type = 'tenant'
       AND scope_id = current_setting('test.label_designer_platform_tenant')::UUID
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
  ),
  'denied publication does not create approved tenant label settings'
);

SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.label_designer_platform_archive_create',
  api.label_designer_create_draft(
    'tenant',
    current_setting('test.label_designer_platform_tenant')::UUID,
    'shipping',
    'Platform active tenant archive label design',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'shipping',
        jsonb_build_object('page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203), 'blocks', jsonb_build_array())
      )
    )
  )::TEXT,
  TRUE
);

SELECT set_config(
  'test.label_designer_platform_archive',
  api.label_designer_archive_draft(
    (current_setting('test.label_designer_platform_archive_create')::jsonb #>> '{draft,id}')::UUID,
    'pgTAP platform active tenant archive'
  )::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_designer_platform_archive')::jsonb->>'ok')::BOOLEAN, FALSE)
  AND current_setting('test.label_designer_platform_archive')::jsonb #>> '{draft,organization_id}' = current_setting('test.label_designer_platform_tenant')
  AND current_setting('test.label_designer_platform_archive')::jsonb #>> '{draft,status}' = 'archived',
  'platform operator archives an active-tenant draft with same RPC readback'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('test.label_designer_tenant_user'), TRUE);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.label_designer_tenant_user'), 'role', 'authenticated')::TEXT,
  TRUE
);
SET LOCAL ROLE authenticated;

SELECT ok(
  COALESCE((public.label_designer_assert_scope('tenant', current_setting('test.label_designer_platform_tenant')::UUID)->>'ok')::BOOLEAN, FALSE) IS NOT TRUE,
  'non-platform tenant operator cannot assert a foreign tenant scope'
);

SELECT ok(
  COALESCE((api.label_designer_create_draft(
    'tenant',
    current_setting('test.label_designer_platform_tenant')::UUID,
    'shipping',
    'Foreign tenant attempt',
    jsonb_build_object('templates', jsonb_build_object('shipping', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
  )->>'ok')::BOOLEAN, FALSE) IS NOT TRUE,
  'non-platform tenant operator cannot create a foreign tenant label draft'
);

SELECT * FROM finish();

ROLLBACK;
