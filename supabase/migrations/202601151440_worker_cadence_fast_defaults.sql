-- Migration: worker cadence fast defaults
-- Purpose:
--   - Reduce worker cadence defaults for latency-sensitive workers via worker_cadence.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_existing RECORD;
  v_current_sv RECORD;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
  v_new_value JSONB;
  v_workers JSONB;
  v_existing_workers JSONB;
BEGIN
  SELECT *
    INTO v_existing
    FROM public.settings
   WHERE category = 'worker_cadence'
     AND scope_type = 'global'
     AND scope_id IS NULL
   LIMIT 1;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'worker_cadence'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  v_workers := jsonb_build_object(
    'workflow_engine_worker', jsonb_build_object('interval_seconds', 2, 'batch_size', 50),
    'outbound_worker', jsonb_build_object('interval_seconds', 2, 'batch_size', 50),
    'webhook_processor_worker', jsonb_build_object('interval_seconds', 2, 'batch_size', 50),
    'edge_api_caller_worker', jsonb_build_object('interval_seconds', 2, 'batch_size', 50),
    'label_job_renderer', jsonb_build_object('interval_seconds', 5, 'batch_size', 50)
  );

  v_new_value := COALESCE(v_existing.cached_value, '{}'::jsonb);
  v_existing_workers := COALESCE(v_new_value->'workers', '{}'::jsonb);

  v_new_value := jsonb_set(
    v_new_value,
    '{workers}',
    v_existing_workers || v_workers,
    true
  );

  IF v_new_value ? 'version' THEN
    v_new_value := jsonb_set(
      v_new_value,
      '{version}',
      to_jsonb(COALESCE(NULLIF(v_new_value->>'version', '')::INT, 1)),
      true
    );
  ELSE
    v_new_value := v_new_value || jsonb_build_object('version', 1);
  END IF;

  SELECT id
    INTO v_current_sv
    FROM public.settings_versions
   WHERE category = 'worker_cadence'
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
  ) VALUES (
    v_sv_id,
    'worker_cadence',
    'global',
    NULL::uuid,
    COALESCE(v_existing.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
    v_next_version,
    v_new_value,
    1,
    'tune worker_cadence defaults for low-latency processing',
    now(),
    now()
  );

  IF v_existing.id IS NULL THEN
    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      'worker_cadence',
      'global',
      NULL::uuid,
      v_sv_id,
      v_new_value,
      now()
    )
    ON CONFLICT (category, scope_type, scope_id)
    DO UPDATE SET
      settings_version_id = EXCLUDED.settings_version_id,
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
