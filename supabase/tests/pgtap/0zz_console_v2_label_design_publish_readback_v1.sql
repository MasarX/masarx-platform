-- pgTAP: Console V2 label design publish returns backend readback evidence
-- and activates the tenant-scoped label_design settings version.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000e771';
  v_ops UUID := '00000000-0000-0000-0000-00000000e772';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Label Design Publish Org', 'console-v2-label-design-publish')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES (
    v_ops,
    v_org,
    'label-design-publish-ops@example.com',
    'Label Design Publish Ops',
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
     AND scope_id = v_org;

  DELETE FROM public.settings_versions
   WHERE category = 'label_design'
     AND scope_type = 'tenant'
     AND scope_id = v_org;

  DELETE FROM public.label_design_drafts
   WHERE organization_id = v_org;

  PERFORM set_config('test.label_design_publish_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.label_design_publish_ops', v_ops::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_publish_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_publish_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.user_has_capability_v1('label_design.write', 'tenant', current_setting('test.label_design_publish_org')::UUID),
  'ops user has tenant label_design.write'
);

SELECT ok(
  public.user_has_capability_v1('label_design.read', 'tenant', current_setting('test.label_design_publish_org')::UUID),
  'ops user has tenant label_design.read'
);

SELECT set_config(
  'test.label_design_publish_create',
  api.label_designer_create_draft(
    'tenant',
    current_setting('test.label_design_publish_org')::UUID,
    'shipping',
    'pgTAP publish readback label design',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'shipping',
        jsonb_build_object(
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
          'blocks', jsonb_build_array(
            jsonb_build_object(
              'type', 'text',
              'section_key', 'operator_block_1',
              'value_path', 'shipment.label_designer_visual_pgtap',
              'x', 24,
              'y', 48,
              'width', 260,
              'height', 24
            )
          ),
          'assets', jsonb_build_array(jsonb_build_object('asset_key', 'tenant_logo')),
          'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'shipment.tracking_number')
        )
      )
    )
  )::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_design_publish_create')::jsonb->>'ok')::BOOLEAN, FALSE),
  'api create draft returns ok before publish'
);

SELECT set_config(
  'test.label_design_publish_draft',
  current_setting('test.label_design_publish_create')::jsonb #>> '{draft,id}',
  TRUE
);

SELECT ok(
  COALESCE((api.label_designer_validate_label_design_draft(current_setting('test.label_design_publish_draft')::UUID)->>'ok')::BOOLEAN, FALSE),
  'api validate draft returns ok before publish'
);

SELECT set_config(
  'test.label_design_publish_result',
  api.label_designer_publish_label_design_draft(
    current_setting('test.label_design_publish_draft')::UUID,
    'pgTAP publish readback proof'
  )::TEXT,
  TRUE
);

SELECT ok(
  COALESCE((current_setting('test.label_design_publish_result')::jsonb->>'ok')::BOOLEAN, FALSE),
  'api publish draft returns ok'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_design_publish_draft')::UUID
       AND organization_id = current_setting('test.label_design_publish_org')::UUID
       AND status = 'published'
       AND published_settings_version_id = (current_setting('test.label_design_publish_result')::jsonb->>'settings_version_id')::UUID
       AND published_at IS NOT NULL
  ),
  'published draft stores settings version and published timestamp'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE id = (current_setting('test.label_design_publish_result')::jsonb->>'settings_version_id')::UUID
       AND category = 'label_design'
       AND scope_type = 'tenant'
       AND scope_id = current_setting('test.label_design_publish_org')::UUID
       AND change_reason = 'pgTAP publish readback proof'
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
  ),
  'publish creates active label_design settings version with reason'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'label_design'
       AND scope_type = 'tenant'
       AND scope_id = current_setting('test.label_design_publish_org')::UUID
       AND settings_version_id = (current_setting('test.label_design_publish_result')::jsonb->>'settings_version_id')::UUID
  ),
  'active settings row points at published settings version'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_publish_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_publish_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(api.label_designer_list_drafts('tenant', current_setting('test.label_design_publish_org')::UUID)->'drafts', '[]'::jsonb)) AS draft(value)
     WHERE draft.value->>'id' = current_setting('test.label_design_publish_draft')
       AND draft.value->>'status' = 'published'
       AND draft.value->>'published_settings_version_id' = current_setting('test.label_design_publish_result')::jsonb->>'settings_version_id'
  ),
  'api list drafts readback includes the published draft and settings version'
);

SELECT is(
  (
    SELECT draft.value #>> '{draft_value,templates,shipping,blocks,0,value_path}'
      FROM jsonb_array_elements(COALESCE(api.label_designer_list_drafts('tenant', current_setting('test.label_design_publish_org')::UUID)->'drafts', '[]'::jsonb)) AS draft(value)
     WHERE draft.value->>'id' = current_setting('test.label_design_publish_draft')
     LIMIT 1
  ),
  'shipment.label_designer_visual_pgtap',
  'api list drafts readback preserves visual block binding'
);

SELECT is(
  (
    SELECT jsonb_array_length(COALESCE(draft.value #> '{draft_value,templates,shipping,assets}', '[]'::jsonb))::TEXT
      FROM jsonb_array_elements(COALESCE(api.label_designer_list_drafts('tenant', current_setting('test.label_design_publish_org')::UUID)->'drafts', '[]'::jsonb)) AS draft(value)
     WHERE draft.value->>'id' = current_setting('test.label_design_publish_draft')
     LIMIT 1
  ),
  '1',
  'api list drafts readback preserves visual asset reference count'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
