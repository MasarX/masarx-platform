BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202605220405_vehicle_maintenance_default_window_policy_v1'));

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'vehicle_maintenance_default_window',
  'Default vehicle maintenance scheduling window for Console V2 Fleet Vehicles.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'vehicle_maintenance_default_window',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Vehicle Maintenance Default Window",
    "type": "object",
    "additionalProperties": true,
    "required": ["default_offset_hours", "default_window_start", "default_window_end"],
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "default_offset_hours": { "type": "integer", "minimum": 0 },
      "default_window_start": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
      "default_window_end": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" }
    }
  }'::jsonb,
  'Default vehicle maintenance scheduling window for Console V2 Fleet Vehicles.',
  '[{"version":1,"default_offset_hours":24,"default_window_start":"08:00","default_window_end":"10:00"}]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

DO $$
DECLARE
  v_category CONSTANT TEXT := 'vehicle_maintenance_default_window';
  v_nil CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'default_offset_hours', 24,
    'default_window_start', '08:00',
    'default_window_end', '10:00'
  );
  v_row RECORD;
  v_next_value JSONB;
  v_next_version INTEGER;
  v_settings_version_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings_versions sv
     WHERE sv.category = v_category
       AND sv.scope_type = 'global'
       AND sv.scope_hash = v_nil
       AND sv.approved_at IS NOT NULL
       AND sv.effective_until IS NULL
  ) THEN
    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      v_category,
      'global',
      NULL::uuid,
      v_nil,
      1,
      v_default,
      1,
      'Console V2 Fleet Vehicles maintenance scheduling default window',
      now(),
      now()
    )
    RETURNING id INTO v_settings_version_id;

    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      v_category,
      'global',
      NULL::uuid,
      v_nil,
      v_settings_version_id,
      v_default,
      now()
    )
    ON CONFLICT (category, scope_type, scope_id) DO UPDATE
    SET
      settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = now();
  END IF;

  FOR v_row IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      COALESCE(s.scope_hash, v_nil) AS scope_hash,
      s.cached_value
      FROM public.settings s
     WHERE s.category = v_category
  LOOP
    v_next_value := COALESCE(v_row.cached_value, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('version', COALESCE((v_row.cached_value->>'version')::integer, 1)))
      || CASE
           WHEN NULLIF(v_row.cached_value->>'default_offset_hours', '') IS NULL
             THEN jsonb_build_object('default_offset_hours', 24)
           ELSE '{}'::jsonb
         END
      || CASE
           WHEN NULLIF(v_row.cached_value->>'default_window_start', '') IS NULL
             THEN jsonb_build_object('default_window_start', '08:00')
           ELSE '{}'::jsonb
         END
      || CASE
           WHEN NULLIF(v_row.cached_value->>'default_window_end', '') IS NULL
             THEN jsonb_build_object('default_window_end', '10:00')
           ELSE '{}'::jsonb
         END;

    IF v_next_value = v_row.cached_value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET effective_until = CASE
             WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
             ELSE now()
           END
     WHERE category = v_category
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash
       AND approved_at IS NOT NULL
       AND effective_until IS NULL;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = v_category
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash;

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      v_category,
      v_row.scope_type,
      v_row.scope_id,
      v_row.scope_hash,
      v_next_version,
      v_next_value,
      1,
      'Console V2 Fleet Vehicles maintenance scheduling window completion',
      now(),
      now()
    )
    RETURNING id INTO v_settings_version_id;

    UPDATE public.settings
       SET settings_version_id = v_settings_version_id,
           cached_value = v_next_value,
           last_updated = now()
     WHERE category = v_category
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash;
  END LOOP;
END $$;

COMMIT;
