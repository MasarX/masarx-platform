BEGIN;

SELECT pg_advisory_lock(hashtext('202605111150_label_resource_signed_download_registry_all_scopes_v1'));
SET LOCAL lock_timeout = '30s';
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_row record;
  v_current jsonb;
  v_resources jsonb;
  v_updated jsonb;
  v_resource jsonb;
  v_key text;
  v_download jsonb;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id,
           s.scope_hash,
           s.settings_version_id,
           sv.value,
           sv.version
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := v_row.value;
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated := '[]'::jsonb;

    FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
      v_key := v_resource->>'key';
      v_download := CASE v_key
        WHEN 'labels' THEN jsonb_build_object(
          'capability', 'labels.download',
          'bucket', 'labels',
          'path_column', 'file_url',
          'expires_seconds', 900
        )
        WHEN 'label_versions' THEN jsonb_build_object(
          'capability', 'labels.download',
          'bucket', 'labels',
          'path_column', 'file_url',
          'expires_seconds', 900
        )
        WHEN 'label_jobs' THEN jsonb_build_object(
          'capability', 'labels.download',
          'bucket', 'labels',
          'path_column', 'output_file_url',
          'expires_seconds', 900
        )
        WHEN 'label_artifacts' THEN jsonb_build_object(
          'capability', 'labels.download',
          'bucket', 'labels',
          'path_column', 'file_url',
          'expires_seconds', 900
        )
        ELSE NULL
      END;

      IF v_download IS NOT NULL THEN
        v_resource := jsonb_set(v_resource, '{download}', COALESCE(v_resource->'download', '{}'::jsonb) || v_download, true);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_updated, true);

    IF v_current IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_current,
             version = v_row.version + 1,
             change_reason = 'Add signed download config for Console V2 label resources across all scopes',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id
         AND scope_hash = v_row.scope_hash;

      UPDATE public.settings
         SET cached_value = v_current,
             last_updated = now()
       WHERE id = v_row.settings_id
         AND scope_hash = v_row.scope_hash;
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605111150_label_resource_signed_download_registry_all_scopes_v1'));

COMMIT;
