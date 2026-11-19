-- Console V2 import jobs read registry scope repair.
--
-- Some local/provisioned tenants carry scoped ui_read_registry rows. Update
-- every ui_read_registry settings row, not only the global fallback, so scoped
-- Console users resolve import_jobs through the live backend registry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051950_console_v2_import_jobs_read_registry_all_scopes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB;
  v_filtered JSONB;
  v_import_jobs JSONB := jsonb_build_object(
    'key', 'import_jobs',
    'label', 'Import jobs',
    'relation', 'public.import_jobs',
    'id_column', 'id',
    'capability_read', 'imports.read',
    'capability_write', 'imports.write',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'select', jsonb_build_array(
      'id', 'organization_id', 'kind', 'source', 'status', 'submitted_at',
      'started_at', 'completed_at', 'submitted_by_user_id', 'row_count',
      'error_count', 'error_summary', 'correlation_id', 'cancelled_reason',
      'created_at', 'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
      jsonb_build_object('key', 'source', 'column', 'source', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'submitted_by_user_id', 'column', 'submitted_by_user_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'submitted_at', 'direction', 'desc')
  );
  v_import_job_directory JSONB := jsonb_build_object(
    'key', 'import_job_directory',
    'label', 'Import job directory',
    'relation', 'public.v_import_job_directory',
    'id_column', 'id',
    'capability_read', 'imports.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'select', jsonb_build_array(
      'id', 'organization_id', 'kind', 'source', 'status', 'submitted_at',
      'started_at', 'completed_at', 'submitted_by_user_id', 'row_count',
      'error_count', 'error_summary', 'correlation_id', 'cancelled_reason',
      'created_at', 'updated_at', 'tenant_label', 'tenant_slug',
      'submitted_by_label', 'submitted_by_email', 'row_count_value',
      'error_count_value', 'is_terminal', 'is_active', 'is_failed',
      'has_errors', 'duration_seconds', 'queue_wait_seconds', 'age_seconds',
      'error_summary_count'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
      jsonb_build_object('key', 'source', 'column', 'source', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'submitted_by_email', 'column', 'submitted_by_email', 'op', 'ilike')
    ),
    'default_sort', jsonb_build_object('column', 'submitted_at', 'direction', 'desc')
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
    v_current := COALESCE(v_row.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

    FOR v_resource IN SELECT * FROM (VALUES (v_import_jobs), (v_import_job_directory)) AS r(value)
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
             change_reason = 'Add Console V2 import jobs resources to scoped ui_read_registry',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_row.settings_version_id;

      UPDATE public.settings s
         SET cached_value = v_current,
             last_updated = now()
       WHERE s.id = v_row.settings_id;
    END IF;
  END LOOP;
END $do$;

SELECT pg_advisory_unlock(hashtext('202605051950_console_v2_import_jobs_read_registry_all_scopes_v1'));

COMMIT;
