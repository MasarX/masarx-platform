-- Migration: Expose the label template directory through Console V2's live read registry.
-- Purpose:
--   Platform > Labels must load tenant label design templates from the
--   operator-facing projection public.v_label_template_directory. The raw
--   label_template_specs table remains the SSOT, but Console reads the
--   directory view so renderer_config, lifecycle counters, tenant labels, and
--   version state are shown from one backend-backed domain surface.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605160155_console_v2_label_template_directory_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_resource JSONB := jsonb_build_object(
    'key', 'label_template_directory',
    'label', 'Label template directory',
    'relation', 'public.v_label_template_directory',
    'id_column', 'id',
    'capability_read', 'labels.read',
    'allow_view_relation', true,
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'template_key',
      'version',
      'template_scope_type',
      'template_scope_id',
      'renderer_config',
      'asset_refs',
      'created_by',
      'created_at',
      'dimensions',
      'dpi',
      'barcode_format',
      'active_version_id',
      'tenant_label',
      'tenant_slug',
      'created_by_label',
      'created_by_email',
      'render_count',
      'render_count_24h',
      'last_used_at',
      'completed_count',
      'failed_count',
      'version_count',
      'is_active_version',
      'asset_count'
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'template_key', 'label', 'Spec', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'dimensions', 'label', 'Dimensions', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'dpi', 'label', 'DPI', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'barcode_format', 'label', 'Barcode', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'active_version_id', 'label', 'Active version', 'mono', true, 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'render_count', 'label', 'Renders', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'render_count_24h', 'label', 'Renders 24h', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'last_used_at', 'label', 'Last used', 'format', 'datetime', 'sortable', true),
      jsonb_build_object('key', 'completed_count', 'label', 'Completed', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'failed_count', 'label', 'Failed', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'version_count', 'label', 'Versions', 'mono', true, 'align', 'right', 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'is_active_version', 'label', 'Active?', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'tenant_label', 'label', 'Tenant', 'sortable', true, 'filterable', true)
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'template_key', 'column', 'template_key', 'op', 'ilike'),
      jsonb_build_object('key', 'template_scope_type', 'column', 'template_scope_type', 'op', 'eq'),
      jsonb_build_object('key', 'barcode_format', 'column', 'barcode_format', 'op', 'eq'),
      jsonb_build_object('key', 'is_active_version', 'column', 'is_active_version', 'op', 'eq')
    )
  );
  v_row RECORD;
  v_filtered JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_row.cached_value->'resources', '[]'::jsonb))
        WITH ORDINALITY AS resource(value, ordinality)
     WHERE resource.value->>'key' <> 'label_template_directory';

    v_next := jsonb_set(
      v_row.cached_value,
      '{resources}',
      v_filtered || jsonb_build_array(v_resource),
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Expose Console V2 label template directory projection for Platform Labels'
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605160155_console_v2_label_template_directory_registry_v1'));
COMMIT;
