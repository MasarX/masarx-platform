BEGIN;

SELECT pg_advisory_lock(hashtext('202605111125_label_resource_signed_download_registry_v1'));
SET LOCAL lock_timeout = '30s';
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_current jsonb;
  v_resources jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_resource jsonb;
  v_key text;
  v_download jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

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

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add signed download config for Console V2 label resources',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202605111125_label_resource_signed_download_registry_v1'));

COMMIT;
