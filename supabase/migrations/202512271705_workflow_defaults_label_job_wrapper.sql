-- Migration: workflow_defaults legacy label job wrapper id
-- Purpose: Seed workflow_defaults with legacy label job wrapper template id for row-driven fallback.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_scope_hash CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_current JSONB;
  v_patched JSONB;
  v_payload JSONB := jsonb_build_object(
    'legacy_label_job_template_id', '99990000-0000-0000-0000-000000360000'
  );
BEGIN
  SELECT id, settings_version_id, cached_value
  INTO v_settings_id, v_settings_version_id, v_current
  FROM settings
  WHERE category = 'workflow_defaults'
    AND scope_type = 'global'
    AND scope_hash = v_scope_hash
  LIMIT 1;

  v_patched := jsonb_strip_nulls(COALESCE(v_current, '{}'::jsonb) || v_payload);

  IF v_settings_version_id IS NULL THEN
    INSERT INTO settings_versions (
      id,
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
      gen_random_uuid(),
      'workflow_defaults',
      'global',
      NULL,
      v_scope_hash,
      1,
      v_patched,
      1,
      'Seed legacy label job wrapper template id',
      now(),
      now()
    )
    RETURNING id INTO v_settings_version_id;
  ELSE
    UPDATE settings_versions
    SET value = v_patched,
        change_reason = COALESCE(change_reason, 'Seed legacy label job wrapper template id'),
        approved_at = COALESCE(approved_at, now())
    WHERE id = v_settings_version_id
      AND scope_hash = v_scope_hash;
  END IF;

  INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    COALESCE(v_settings_id, gen_random_uuid()),
    'workflow_defaults',
    'global',
    NULL,
    v_scope_hash,
    v_settings_version_id,
    v_patched,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();
END;
$$;

COMMIT;
