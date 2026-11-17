-- Migration: workflow_defaults inline kick on outbound completion
-- Purpose:
--   - Add inline_kick_on_outbound_complete to workflow_defaults schema + defaults.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
SET search_path TO public, pg_temp;

UPDATE public.schema_registry
SET schema = jsonb_set(
      schema,
      '{properties}',
      (schema->'properties') || jsonb_build_object(
        'inline_kick_on_outbound_complete', jsonb_build_object('type','boolean')
      ),
      true
    ),
    examples = jsonb_set(
      examples,
      '{0}',
      COALESCE(examples->0, '{}'::jsonb) || jsonb_build_object(
        'inline_kick_on_outbound_complete', true
      ),
      true
    )
WHERE category = 'workflow_defaults'
  AND version = 1;

DO $$
DECLARE
  v_existing RECORD;
  v_current_sv RECORD;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
  v_new_value JSONB;
BEGIN
  SELECT *
    INTO v_existing
    FROM public.settings
   WHERE category = 'workflow_defaults'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'workflow_defaults'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  v_new_value := COALESCE(v_existing.cached_value, '{}'::jsonb) || jsonb_build_object(
    'inline_kick_on_outbound_complete', true
  );

  SELECT id
    INTO v_current_sv
    FROM public.settings_versions
   WHERE category = 'workflow_defaults'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_current_sv.id IS NOT NULL THEN
    UPDATE public.settings_versions
       SET effective_until = now(),
           updated_at = now()
     WHERE id = v_current_sv.id;
  END IF;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'workflow_defaults',
    'global',
    NULL::uuid,
    COALESCE(v_existing.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
    v_next_version,
    v_new_value,
    1,
    'add workflow_defaults inline kick on outbound completion',
    now(),
    now()
  );

  IF v_existing.id IS NULL THEN
    INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
    VALUES ('workflow_defaults', 'global', NULL::uuid, v_sv_id, v_new_value, now())
    ON CONFLICT (category, scope_type, scope_id)
    DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id,
                  cached_value = EXCLUDED.cached_value,
                  last_updated = now();
  ELSE
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_new_value,
           last_updated = now()
     WHERE id = v_existing.id;
  END IF;
END $$;

COMMIT;
