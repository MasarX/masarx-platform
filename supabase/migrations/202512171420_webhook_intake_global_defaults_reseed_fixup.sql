-- Migration: Re-seed webhook_intake global defaults (fixup)
-- Purpose:
--   - Ensure global webhook_intake settings always exist (and are non-null)
--     even if rows were deleted/drifted after prior seed migrations ran.
--   - Keeps workflow_intake_webhook deterministic for pgTAP + CI gating.
-- Date: 2025-12-17

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_scope_hash CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_entry_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770001'::uuid;
  v_fallback_settings_version_id CONSTANT UUID := '99990000-0000-0000-0000-000000770002'::uuid;
  v_fallback_settings_id CONSTANT UUID := '99990000-0000-0000-0000-000000770102'::uuid;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_defaults JSONB := jsonb_build_object(
    'accepted_async_status', 202,
    'synchronous_success_status', 200,
    'bad_request_status', 400,
    'error_status', 500,
    'poll_attempts', 5,
    'poll_interval_ms', 50
  );
  v_value JSONB;
  v_existing_entry_template_id UUID;
BEGIN
  SELECT id, settings_version_id
    INTO v_settings_id, v_settings_version_id
    FROM public.settings
   WHERE category = 'webhook_intake'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    SELECT id
      INTO v_settings_version_id
      FROM public.settings_versions
     WHERE category = 'webhook_intake'
       AND scope_type = 'global'
       AND scope_hash = v_scope_hash
       AND scope_id IS NULL
     ORDER BY approved_at DESC NULLS LAST, effective_from DESC, created_at DESC
     LIMIT 1;
  END IF;

  IF v_settings_version_id IS NULL THEN
    v_settings_version_id := v_fallback_settings_version_id;
    INSERT INTO public.settings_versions (
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
      v_settings_version_id,
      'webhook_intake',
      'global',
      NULL,
      v_scope_hash,
      1,
      jsonb_build_object(
        'entry_template_id', v_entry_template_id,
        'defaults', v_defaults
      ),
      1,
      'Re-seed webhook_intake global defaults (fixup)',
      now(),
      now()
    )
    ON CONFLICT ON CONSTRAINT settings_versions_id_scope_hash_unique DO NOTHING;
  END IF;

  SELECT value
    INTO v_value
    FROM public.settings_versions
   WHERE id = v_settings_version_id
     AND scope_hash = v_scope_hash;

  IF v_value IS NULL THEN
    v_value := '{}'::jsonb;
  END IF;

  BEGIN
    v_existing_entry_template_id := NULLIF(v_value->>'entry_template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_existing_entry_template_id := NULL;
  END;

  IF v_existing_entry_template_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.workflow_templates wt WHERE wt.id = v_existing_entry_template_id) THEN
    v_value := jsonb_set(v_value, '{entry_template_id}', to_jsonb(v_entry_template_id), true);
  END IF;

  v_value := jsonb_set(
    v_value,
    '{defaults}',
    v_defaults || COALESCE(v_value->'defaults', '{}'::jsonb),
    true
  );

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = COALESCE(approved_at, now()),
         effective_from = COALESCE(effective_from, now())
   WHERE sv.id = v_settings_version_id
     AND sv.scope_hash = v_scope_hash;

  INSERT INTO public.settings (
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
    COALESCE(v_settings_id, v_fallback_settings_id),
    'webhook_intake',
    'global',
    NULL,
    v_scope_hash,
    v_settings_version_id,
    v_value,
    now()
  )
  ON CONFLICT ON CONSTRAINT settings_scope_hash_unique DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END $$;

COMMIT;

