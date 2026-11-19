-- pgTAP: Console V2 label-design write actions deny lower-permission users
-- before mutating draft state or publishing active label-design settings.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000e751';
  v_ops UUID := '00000000-0000-0000-0000-00000000e752';
  v_limited UUID := '00000000-0000-0000-0000-00000000e753';
  v_draft UUID := '00000000-0000-0000-0000-00000000e754';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Label Design Denied Org', 'console-v2-label-design-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'label-design-denied-ops@example.com', 'Label Design Denied Ops', 'ops_admin', 'tenant', NULL, 'active'),
    (v_limited, v_org, 'label-design-denied-limited@example.com', 'Label Design Denied Limited', 'sender_user', 'tenant', NULL, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.label_design_drafts (
    id,
    organization_id,
    scope_type,
    scope_id,
    label_type,
    draft_name,
    draft_value,
    status,
    created_by
  )
  VALUES (
    v_draft,
    v_org,
    'tenant',
    v_org,
    'shipping',
    'Console V2 Label Design Denied Draft',
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'shipping',
        jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())
      )
    ),
    'draft',
    v_ops
  )
  ON CONFLICT (id, organization_id) DO UPDATE
     SET scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         label_type = EXCLUDED.label_type,
         draft_name = EXCLUDED.draft_name,
         draft_value = EXCLUDED.draft_value,
         status = EXCLUDED.status,
         published_settings_version_id = NULL,
         published_at = NULL;

  PERFORM set_config('test.label_design_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.label_design_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.label_design_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.label_design_denied_draft', v_draft::TEXT, TRUE);
  PERFORM set_config(
    'test.label_design_denied_draft_count',
    (SELECT COUNT(*)::TEXT FROM public.label_design_drafts WHERE organization_id = v_org),
    TRUE
  );
  PERFORM set_config(
    'test.label_design_denied_settings_version_count',
    (SELECT COUNT(*)::TEXT FROM public.settings_versions WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org),
    TRUE
  );
  PERFORM set_config(
    'test.label_design_denied_settings_count',
    (SELECT COUNT(*)::TEXT FROM public.settings WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org),
    TRUE
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.label_designer_list_drafts(text,uuid)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_list_drafts(text,uuid)', 'EXECUTE'),
  'api.label_designer_list_drafts wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.label_designer_create_draft(text,uuid,text,text,jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_create_draft(text,uuid,text,text,jsonb)', 'EXECUTE'),
  'api.label_designer_create_draft wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.label_designer_update_draft(uuid,text,text,jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_update_draft(uuid,text,text,jsonb)', 'EXECUTE'),
  'api.label_designer_update_draft wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.label_designer_archive_draft(uuid,text)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_archive_draft(uuid,text)', 'EXECUTE'),
  'api.label_designer_archive_draft wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.label_designer_validate_label_design_draft(uuid)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_validate_label_design_draft(uuid)', 'EXECUTE'),
  'api.label_designer_validate_label_design_draft wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.label_designer_publish_label_design_draft(uuid,text)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.label_designer_publish_label_design_draft(uuid,text)', 'EXECUTE'),
  'api.label_designer_publish_label_design_draft wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  NOT public.user_has_capability_v1('label_design.write', 'tenant', current_setting('test.label_design_denied_org')::UUID),
  'limited label-design user lacks tenant label_design.write'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  public.user_has_capability_v1('label_design.write', 'tenant', current_setting('test.label_design_denied_org')::UUID),
  'ops user has tenant label_design.write'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  public.label_designer_create_draft(
    'tenant',
    current_setting('test.label_design_denied_org')::UUID,
    'shipping',
    'Denied public label design draft',
    jsonb_build_object('templates', jsonb_build_object('shipping', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied public label_designer_create_draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  api.label_designer_create_draft(
    'tenant',
    current_setting('test.label_design_denied_org')::UUID,
    'shipping',
    'Denied api label design draft',
    jsonb_build_object('templates', jsonb_build_object('shipping', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied api label_designer_create_draft'
);
RESET ROLE;

SELECT is(
  (
    SELECT COUNT(*)::TEXT
      FROM public.label_design_drafts
     WHERE organization_id = current_setting('test.label_design_denied_org')::UUID
  ),
  current_setting('test.label_design_denied_draft_count'),
  'denied create attempts write no label_design_drafts rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  public.label_designer_update_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'route',
    'Denied public label design update',
    jsonb_build_object('templates', jsonb_build_object('route', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied public label_designer_update_draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  api.label_designer_update_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'route',
    'Denied api label design update',
    jsonb_build_object('templates', jsonb_build_object('route', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied api label_designer_update_draft'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_design_denied_draft')::UUID
       AND organization_id = current_setting('test.label_design_denied_org')::UUID
       AND label_type = 'shipping'
       AND draft_name = 'Console V2 Label Design Denied Draft'
       AND status = 'draft'
       AND published_settings_version_id IS NULL
       AND published_at IS NULL
  ),
  'denied update attempts leave label design draft unchanged and unpublished'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  public.label_designer_archive_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'Denied public label design archive'
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied public label_designer_archive_draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  api.label_designer_archive_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'Denied api label design archive'
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied api label_designer_archive_draft'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_design_denied_draft')::UUID
       AND organization_id = current_setting('test.label_design_denied_org')::UUID
       AND status = 'draft'
       AND archived_at IS NULL
       AND archived_by IS NULL
       AND archive_reason IS NULL
  ),
  'denied archive attempts leave label design draft active and unarchived'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  public.label_designer_publish_label_design_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'Denied public label design publish'
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied public label_designer_publish_label_design_draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_limited'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_limited'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT is(
  api.label_designer_publish_label_design_draft(
    current_setting('test.label_design_denied_draft')::UUID,
    'Denied api label design publish'
  ) #>> '{error,code}',
  'access_denied',
  'limited user denied api label_designer_publish_label_design_draft'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_design_denied_draft')::UUID
       AND organization_id = current_setting('test.label_design_denied_org')::UUID
       AND status = 'draft'
       AND published_settings_version_id IS NULL
       AND published_at IS NULL
  )
  AND (
    SELECT COUNT(*)::TEXT
      FROM public.settings_versions
     WHERE category = 'label_design'
       AND scope_type = 'tenant'
       AND scope_id = current_setting('test.label_design_denied_org')::UUID
  ) = current_setting('test.label_design_denied_settings_version_count')
  AND (
    SELECT COUNT(*)::TEXT
      FROM public.settings
     WHERE category = 'label_design'
       AND scope_type = 'tenant'
       AND scope_id = current_setting('test.label_design_denied_org')::UUID
  ) = current_setting('test.label_design_denied_settings_count'),
  'denied publish attempts leave draft status and active label-design settings unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.label_designer_create_draft(
      'tenant',
      current_setting('test.label_design_denied_org')::UUID,
      'shipping',
      'Ops label design draft',
      jsonb_build_object('templates', jsonb_build_object('shipping', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
    )->>'ok')::BOOLEAN
  ),
  'ops user can still create label design draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.label_designer_update_draft(
      current_setting('test.label_design_denied_draft')::UUID,
      'shipping',
      'Ops label design update',
      jsonb_build_object('templates', jsonb_build_object('shipping', jsonb_build_object('page', jsonb_build_object(), 'blocks', jsonb_build_array())))
    )->>'ok')::BOOLEAN
  ),
  'ops user can still update label design draft'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.label_design_denied_ops'), TRUE);
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.label_design_denied_ops'), 'role', 'authenticated')::TEXT, TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.label_designer_archive_draft(
      current_setting('test.label_design_denied_draft')::UUID,
      'Ops stale label design cleanup'
    )->>'ok')::BOOLEAN
  ),
  'ops user can still archive label design draft'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.label_design_drafts
     WHERE id = current_setting('test.label_design_denied_draft')::UUID
       AND organization_id = current_setting('test.label_design_denied_org')::UUID
       AND status = 'archived'
       AND archived_at IS NOT NULL
       AND archived_by = current_setting('test.label_design_denied_ops')::UUID
       AND archive_reason = 'Ops stale label design cleanup'
  ),
  'authorized archive persists archived status, actor, timestamp, and reason'
);

SELECT * FROM finish();

ROLLBACK;
