-- Migration: worker cadence settings (row-driven)
-- Purpose:
--   - Add worker_cadence settings category for cron_config overrides.
--   - Seed global defaults for latency-sensitive workers.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;
SET search_path TO public, extensions, pg_temp;

-- 1) Category registry metadata
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
  'worker_cadence',
  'Worker cadence overrides applied via check_throttle (cron_config sync).',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global"]'::jsonb
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

-- 2) Schema registry contract
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'worker_cadence',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'workers', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'interval_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
            'batch_size', jsonb_build_object('type', 'integer', 'minimum', 1),
            'enabled', jsonb_build_object('type', 'boolean')
          )
        )
      )
    )
  ),
  'Row-driven worker cadence overrides applied on check_throttle (cron_config).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'workers', jsonb_build_object(
        'workflow_engine_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
        'outbound_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
        'webhook_processor_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
        'edge_api_caller_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50)
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- 3) Global defaults (settings_versions + settings)
DO $$
DECLARE
  v_existing RECORD;
  v_current_sv RECORD;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
  v_new_value JSONB;
  v_worker_defaults JSONB;
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

  v_worker_defaults := jsonb_build_object(
    'workflow_engine_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
    'outbound_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
    'webhook_processor_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50),
    'edge_api_caller_worker', jsonb_build_object('interval_seconds', 5, 'batch_size', 50)
  );

  v_new_value := COALESCE(v_existing.cached_value, '{}'::jsonb);
  v_existing_workers := COALESCE(v_new_value->'workers', '{}'::jsonb);

  v_new_value := jsonb_set(
    v_new_value,
    '{workers}',
    v_worker_defaults || v_existing_workers,
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
    'seed worker_cadence defaults',
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
