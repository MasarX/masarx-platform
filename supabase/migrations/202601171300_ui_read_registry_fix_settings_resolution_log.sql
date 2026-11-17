-- Migration: Fix ui_read_registry settings_resolution_log column mapping
-- Purpose: Align ui_read_registry resource definition with settings_resolution_log schema
BEGIN;
SELECT pg_advisory_lock(hashtext('202601171300_ui_read_registry_fix_settings_resolution_log'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  v_resources := (
    SELECT jsonb_agg(
      CASE
        WHEN resource->>'key' = 'settings_resolution_log' THEN
          jsonb_set(
            jsonb_set(
              resource,
              '{select}',
              (
                SELECT jsonb_agg(
                  CASE value
                    WHEN 'settings_id' THEN 'winning_settings_id'
                    WHEN 'settings_version_id' THEN 'winning_settings_version_id'
                    ELSE value
                  END
                )
                FROM jsonb_array_elements_text(
                  COALESCE(resource->'select', '[]'::jsonb)
                ) AS value
              ),
              true
            ),
            '{columns}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN col->>'key' = 'settings_id' THEN
                    jsonb_set(
                      jsonb_set(col, '{key}', to_jsonb('winning_settings_id'::text), true),
                      '{label}', to_jsonb('Winning Settings Id'::text), true
                    )
                  WHEN col->>'key' = 'settings_version_id' THEN
                    jsonb_set(
                      jsonb_set(col, '{key}', to_jsonb('winning_settings_version_id'::text), true),
                      '{label}', to_jsonb('Winning Settings Version Id'::text), true
                    )
                  ELSE col
                END
              )
              FROM jsonb_array_elements(
                COALESCE(resource->'columns', '[]'::jsonb)
              ) AS col
            ),
            true
          )
        ELSE resource
      END
    )
    FROM jsonb_array_elements(v_resources) AS resource
  );

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Fix ui_read_registry settings_resolution_log column mapping',
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

SELECT pg_advisory_unlock(hashtext('202601171300_ui_read_registry_fix_settings_resolution_log'));
COMMIT;

