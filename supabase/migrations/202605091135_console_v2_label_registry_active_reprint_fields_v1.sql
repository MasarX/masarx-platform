-- Console V2 label registry active-version and target-lineage repair.
--
-- Purpose:
--   Reprint UX must resolve canonical labels.id only when a label has an
--   active version. Live ui_read_registry rows therefore need to expose
--   labels.active_version_id / active_version_number and full label_jobs target
--   lineage instead of relying on seed aliases or raw table fallback behavior.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091135_console_v2_label_registry_active_reprint_fields_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_seen INT := 0;
  v_labels JSONB := jsonb_build_object(
    'key', 'labels',
    'label', 'Labels',
    'relation', 'public.labels',
    'id_column', 'id',
    'capability_read', 'labels.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
    'select', jsonb_build_array(
      'id', 'organization_id', 'client_id', 'shipment_id', 'label_type',
      'barcode', 'barcode_format', 'layout_template_id', 'file_url',
      'file_size_bytes', 'generated_by', 'generated_at', 'print_count',
      'last_printed_at', 'metadata', 'renderer_metadata', 'active_version_id',
      'active_version_number', 'created_at', 'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'label_type', 'column', 'label_type', 'op', 'eq'),
      jsonb_build_object('key', 'barcode', 'column', 'barcode', 'op', 'ilike'),
      jsonb_build_object('key', 'active_version_id', 'column', 'active_version_id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'generated_at', 'direction', 'desc')
  );
  v_label_jobs JSONB := jsonb_build_object(
    'key', 'label_jobs',
    'label', 'Label jobs',
    'relation', 'public.label_jobs',
    'id_column', 'id',
    'capability_read', 'labels.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
    'select', jsonb_build_array(
      'id', 'organization_id', 'client_id', 'shipment_id', 'shipment_box_id',
      'label_id', 'label_type', 'template_id', 'template_version', 'status',
      'attempts', 'max_attempts', 'scheduled_at', 'last_attempt_at',
      'job_purpose', 'requested_by', 'requested_source', 'renderer_hint',
      'output_file_url', 'output_file_size_bytes', 'renderer_metadata',
      'error_reason', 'retry_state', 'completed_at', 'workflow_run_step_id',
      'target_type', 'target_id', 'target_box_id', 'target_metadata',
      'reprint_reason', 'source_label_version_id', 'created_at', 'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_box_id', 'column', 'shipment_box_id', 'op', 'eq'),
      jsonb_build_object('key', 'label_id', 'column', 'label_id', 'op', 'eq'),
      jsonb_build_object('key', 'target_type', 'column', 'target_type', 'op', 'eq'),
      jsonb_build_object('key', 'target_id', 'column', 'target_id', 'op', 'eq'),
      jsonb_build_object('key', 'target_box_id', 'column', 'target_box_id', 'op', 'eq'),
      jsonb_build_object('key', 'job_purpose', 'column', 'job_purpose', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'scheduled_at', 'direction', 'desc')
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

    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' NOT IN ('labels', 'label_jobs');

    v_resources := v_filtered || jsonb_build_array(v_labels, v_label_jobs);
    v_current := jsonb_set(v_current, '{resources}', v_resources, true);

    IF v_current IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions sv
         SET value = v_current,
             version = v_row.version + 1,
             change_reason = 'Expose active label version and label job target lineage to Console V2',
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

SELECT pg_advisory_unlock(hashtext('202605091135_console_v2_label_registry_active_reprint_fields_v1'));

COMMIT;
