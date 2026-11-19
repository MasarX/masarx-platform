-- Console V2 label history registry repair.
--
-- The shipment drawer Labels tab reads the canonical label queue, active
-- labels, and immutable label-version history through ui_list_resource_v1.
-- Some provisioned tenants have scoped ui_read_registry rows, so update every
-- scope instead of only the global fallback.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605072000_console_v2_label_history_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB;
  v_filtered JSONB;
  v_seen INT := 0;
  v_label_versions JSONB := jsonb_build_object(
    'key', 'label_versions',
    'label', 'Label versions',
    'relation', 'public.label_versions',
    'id_column', 'id',
    'capability_read', 'labels.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
    'select', jsonb_build_array(
      'id', 'label_id', 'shipment_id', 'organization_id', 'client_id',
      'label_job_id', 'version_number', 'version_status', 'job_purpose',
      'requested_source', 'reprint_reason', 'supersedes_version_id',
      'superseded_by_version_id', 'superseded_at', 'label_type', 'barcode',
      'barcode_format', 'layout_template_id', 'file_url', 'file_size_bytes',
      'generated_by', 'generated_at', 'print_count', 'last_printed_at',
      'metadata', 'renderer_metadata', 'created_at', 'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'label_id', 'column', 'label_id', 'op', 'eq'),
      jsonb_build_object('key', 'label_job_id', 'column', 'label_job_id', 'op', 'eq'),
      jsonb_build_object('key', 'version_status', 'column', 'version_status', 'op', 'eq'),
      jsonb_build_object('key', 'job_purpose', 'column', 'job_purpose', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'generated_at', 'direction', 'desc')
  );
  v_label_artifacts JSONB := jsonb_build_object(
    'key', 'label_artifacts',
    'label', 'Label artifacts',
    'relation', 'public.label_artifacts',
    'id_column', 'id',
    'capability_read', 'labels.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
    'select', jsonb_build_array(
      'id', 'organization_id', 'client_id', 'target_type', 'target_id',
      'target_box_id', 'label_type', 'barcode', 'barcode_format',
      'layout_template_id', 'file_url', 'file_size_bytes', 'generated_by',
      'generated_at', 'print_count', 'last_printed_at', 'source_label_job_id',
      'metadata', 'renderer_metadata', 'created_at', 'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'target_type', 'column', 'target_type', 'op', 'eq'),
      jsonb_build_object('key', 'target_id', 'column', 'target_id', 'op', 'eq'),
      jsonb_build_object('key', 'target_box_id', 'column', 'target_box_id', 'op', 'eq'),
      jsonb_build_object('key', 'source_label_job_id', 'column', 'source_label_job_id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'generated_at', 'direction', 'desc')
  );
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.value,
           sv.version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_seen := v_seen + 1;
    v_current := COALESCE(v_row.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

    FOR v_resource IN
      SELECT value FROM (VALUES (v_label_versions), (v_label_artifacts)) AS resource(value)
    LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS value
       WHERE value->>'key' <> v_resource->>'key';

      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_resources, true);

    IF v_current IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions sv
         SET value = v_current,
             version = v_row.version + 1,
             change_reason = 'Add Console V2 label history resources to ui_read_registry',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_row.settings_version_id;

      UPDATE public.settings s
         SET cached_value = v_current,
             last_updated = now()
       WHERE s.id = v_row.settings_id;
    END IF;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'ui_read_registry settings missing';
  END IF;
END $do$;

SELECT pg_advisory_unlock(hashtext('202605072000_console_v2_label_history_registry_v1'));

COMMIT;
