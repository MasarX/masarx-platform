-- pgTAP: public.v_label_template_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W28 (paired projection views - PLATFORM)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

-- 1) View exists
SELECT has_view(
  'public', 'v_label_template_directory',
  'public.v_label_template_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_label_template_directory',
  ARRAY[
    'id', 'organization_id', 'template_key', 'version',
    'template_scope_type', 'template_scope_id',
    'renderer_config', 'asset_refs',
    'created_by', 'created_at',
    'dimensions', 'dpi', 'barcode_format', 'active_version_id',
    'tenant_label', 'tenant_slug',
    'created_by_label', 'created_by_email',
    'render_count', 'render_count_24h', 'last_used_at',
    'completed_count', 'failed_count',
    'version_count', 'is_active_version',
    'asset_count'
  ],
  'v_label_template_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_label_template_directory', 'SELECT'),
  'service_role has SELECT on v_label_template_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_label_template_directory', 'SELECT'),
  'anon has no SELECT on v_label_template_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_label_template_directory', 'SELECT'),
  'authenticated has SELECT on v_label_template_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'label_template_specs'
       AND c.relkind = 'p'
  ),
  'public.label_template_specs remains a base partitioned table (SSOT preserved)'
);

-- 7) Projection: insert template + 2 jobs.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000028b001';
  v_user     UUID := '00000000-0000-0000-0000-00000028b002';
  v_client   UUID := '00000000-0000-0000-0000-00000028b003';
  v_template UUID := '00000000-0000-0000-0000-00000028b004';
  v_job_a    UUID := '00000000-0000-0000-0000-00000028b005';
  v_job_b    UUID := '00000000-0000-0000-0000-00000028b006';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W28 Label Org', 'w28-lt-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w28-lt-u-main@example.com',
    'W28 Label Designer', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W28 Label Client',
    'w28-lt-client',
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.label_template_specs (
    id, organization_id, template_key, version,
    template_scope_type, template_scope_id,
    renderer_config, asset_refs,
    created_by, created_at
  )
  VALUES (
    v_template, v_org, 'w28-tpl-main', 1,
    'tenant', v_org,
    jsonb_build_object(
      'dimensions', '4x6',
      'dpi', '203',
      'barcode_format', 'CODE128',
      'active_version_id', 'lblv_w28_001'
    ),
    jsonb_build_array('logo_url'),
    v_user,
    now() - INTERVAL '5 days'
  )
  ON CONFLICT (id, organization_id) DO NOTHING;

  INSERT INTO public.label_jobs (
    id, organization_id, client_id, shipment_id, label_type,
    template_id, template_version, template_snapshot,
    status, scheduled_at, idempotency_key
  )
  VALUES (
    v_job_a, v_org, v_client, '00000000-0000-0000-0000-00000000ab28',
    'shipping', v_template, 1,
    jsonb_build_object('snapshot', 1),
    'succeeded',
    now() - INTERVAL '12 hours',
    'w28-job-a-main'
  )
  ON CONFLICT (id, organization_id) DO NOTHING;

  INSERT INTO public.label_jobs (
    id, organization_id, client_id, shipment_id, label_type,
    template_id, template_version, template_snapshot,
    status, scheduled_at, idempotency_key
  )
  VALUES (
    v_job_b, v_org, v_client, '00000000-0000-0000-0000-00000000ab29',
    'shipping', v_template, 1,
    jsonb_build_object('snapshot', 2),
    'failed',
    now() - INTERVAL '6 hours',
    'w28-job-b-main'
  )
  ON CONFLICT (id, organization_id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_label_template_directory
    WHERE id = '00000000-0000-0000-0000-00000028b004'::UUID
      AND dimensions = '4x6'
      AND dpi = 203
      AND barcode_format = 'CODE128'
      AND active_version_id = 'lblv_w28_001'
      AND tenant_label = 'W28 Label Org'
      AND created_by_label = 'W28 Label Designer'
      AND render_count = 2
      AND completed_count = 1
      AND failed_count = 1
      AND last_used_at IS NOT NULL
      AND last_used_at > now() - INTERVAL '7 hours'
      AND asset_count = 1
      AND version_count = 1
      AND is_active_version = TRUE
  ),
  'v_label_template_directory derives dimensions + dpi + barcode_format + active_version_id + tenant_label + created_by_label + render_count + completed_count + failed_count + last_used_at + asset_count + version_count + is_active_version'
);

-- 8) Edge case: empty renderer_config and multi-version template.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000028b001';
  v_user2    UUID := '00000000-0000-0000-0000-00000028b012';
  v_tpl_old  UUID := '00000000-0000-0000-0000-00000028b013';
  v_tpl_new  UUID := '00000000-0000-0000-0000-00000028b014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user2, v_org, 'w28-lt-u2-main@example.com',
    'W28 Label Designer 2', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.label_template_specs (
    id, organization_id, template_key, version,
    template_scope_type, template_scope_id,
    renderer_config, asset_refs,
    created_by, created_at
  )
  VALUES (
    v_tpl_old, v_org, 'w28-multi-main', 1,
    'tenant', v_org,
    '{}'::jsonb,
    '[]'::jsonb,
    v_user2,
    now() - INTERVAL '10 days'
  )
  ON CONFLICT (id, organization_id) DO NOTHING;

  INSERT INTO public.label_template_specs (
    id, organization_id, template_key, version,
    template_scope_type, template_scope_id,
    renderer_config, asset_refs,
    created_by, created_at
  )
  VALUES (
    v_tpl_new, v_org, 'w28-multi-main', 2,
    'tenant', v_org,
    jsonb_build_object('dimensions', '4x4'),
    '[]'::jsonb,
    v_user2,
    now() - INTERVAL '1 day'
  )
  ON CONFLICT (id, organization_id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_label_template_directory old_tpl
    JOIN public.v_label_template_directory new_tpl
      ON new_tpl.id = '00000000-0000-0000-0000-00000028b014'::UUID
    WHERE old_tpl.id = '00000000-0000-0000-0000-00000028b013'::UUID
      AND old_tpl.dimensions IS NULL
      AND old_tpl.render_count = 0
      AND old_tpl.version_count = 2
      AND old_tpl.is_active_version = FALSE
      AND new_tpl.is_active_version = TRUE
  ),
  'v_label_template_directory: empty renderer_config resolves NULL projections; multi-version template resolves version_count=2 with only the highest-version row marked is_active_version=TRUE'
);

-- 9) Console V2 live registry exposes the operator-facing directory resource.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value)
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND resource.value->>'key' = 'label_template_directory'
       AND resource.value->>'relation' = 'public.v_label_template_directory'
       AND COALESCE((resource.value->>'allow_view_relation')::boolean, FALSE) = TRUE
       AND resource.value->>'capability_read' = 'labels.read'
  ),
  'ui_read_registry exposes label_template_directory through the operator-facing view with labels.read'
);

-- 10) Operator status lookup maps friendly chips to canonical label_jobs.status values.
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'label_render_job_status'
       AND lv.value = 'completed'
       AND lv.metadata->'backend_values' ? 'succeeded'
  ),
  'label_render_job_status.completed maps to canonical label_jobs.status=succeeded'
);

-- 11) Nested renderer_config.page/barcode fields are projected for real waybill templates.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000028b001';
  v_user     UUID := '00000000-0000-0000-0000-00000028b002';
  v_template UUID := '00000000-0000-0000-0000-00000028b024';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.label_template_specs (
    id, organization_id, template_key, version,
    template_scope_type, template_scope_id,
    renderer_config, asset_refs,
    created_by, created_at
  )
  VALUES (
    v_template, v_org, 'w28-nested-main', 1,
    'tenant', v_org,
    jsonb_build_object(
      'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
      'barcode', jsonb_build_object('type', 'CODE128')
    ),
    '[]'::jsonb,
    v_user,
    now()
  )
  ON CONFLICT (id, organization_id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_label_template_directory
     WHERE id = '00000000-0000-0000-0000-00000028b024'::UUID
       AND dimensions = '4 x 6'
       AND dpi = 203
       AND barcode_format = 'CODE128'
  ),
  'v_label_template_directory projects nested renderer_config.page/barcode metadata'
);

SELECT * FROM finish();
ROLLBACK;
