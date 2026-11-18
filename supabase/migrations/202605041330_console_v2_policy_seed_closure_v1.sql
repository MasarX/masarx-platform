-- Migration: Console V2 policy seed closure
-- Purpose:
--   - Promote Console V2 dispatch/observability settings out of frontend seed-only
--     data and into the canonical settings registry + schema registry + global
--     default rows.
--   - Keep writes append-only by using upsert_settings_value_v1 only when the
--     current global value is missing or different.
BEGIN;

SELECT pg_advisory_lock(hashtext('202605041330_console_v2_policy_seed_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  (
    'cod.float.max_per_driver',
    'Maximum COD float allowed per driver for Console V2 dispatch insight and assignment governance.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant"]'::jsonb
  ),
  (
    'live_tail_policy',
    'Live-tail buffer and synthesizer policy for Console V2 observability surfaces.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant"]'::jsonb
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
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
VALUES
  (
    'cod.float.max_per_driver',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'COD Float Max Per Driver',
      'type', 'number',
      'minimum', 0
    ),
    'Maximum COD float allowed per driver.',
    jsonb_build_array(5000),
    TRUE
  ),
  (
    'live_tail_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Console V2 Live Tail Policy',
      'type', 'object',
      'required', jsonb_build_array(
        'decisions_buffer_size',
        'api_gateway_buffer_size',
        'api_gateway_synthesizer_interval_ms'
      ),
      'additionalProperties', FALSE,
      'properties', jsonb_build_object(
        'decisions_buffer_size', jsonb_build_object('type', 'integer', 'minimum', 1),
        'api_gateway_buffer_size', jsonb_build_object('type', 'integer', 'minimum', 1),
        'api_gateway_synthesizer_interval_ms', jsonb_build_object('type', 'integer', 'minimum', 250)
      )
    ),
    'Live-tail buffer and synthetic-event cadence policy for Console V2 observability surfaces.',
    jsonb_build_array(jsonb_build_object(
      'decisions_buffer_size', 50,
      'api_gateway_buffer_size', 250,
      'api_gateway_synthesizer_interval_ms', 2000
    )),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    deprecated_at = NULL;

DO $$
DECLARE
  v_cod_float JSONB := to_jsonb(5000);
  v_live_tail JSONB := jsonb_build_object(
    'decisions_buffer_size', 50,
    'api_gateway_buffer_size', 250,
    'api_gateway_synthesizer_interval_ms', 2000
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'cod.float.max_per_driver'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND s.cached_value IS NOT DISTINCT FROM v_cod_float
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'cod.float.max_per_driver',
      'global',
      NULL,
      v_cod_float,
      1,
      'Seed Console V2 COD float maximum policy'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'live_tail_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND s.cached_value IS NOT DISTINCT FROM v_live_tail
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'live_tail_policy',
      'global',
      NULL,
      v_live_tail,
      1,
      'Seed Console V2 live-tail observability policy'
    );
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605041330_console_v2_policy_seed_closure_v1'));
COMMIT;
