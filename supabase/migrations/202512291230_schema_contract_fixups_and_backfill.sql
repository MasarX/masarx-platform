-- Plan: PLAN-202512-system-defaults-prod-ready / Step: S04
-- Migration: Schema contract fixups + schema_version backfill for global defaults
-- Purpose:
--   - Backfill missing settings_versions.schema_version for core global defaults.
--   - Align schema_registry contracts with current seeded default shapes:
--       * webhook_ingest_policy: include schema metadata block
--       * geocoding_policy: include local lookup + matching plugins + alias auto-learning knobs
--       * label_design: allow rect blocks (used by the seeded template)
-- Notes:
--   - This migration is additive + idempotent. It does not hardcode tenant/client ids.
--   - Schema validation is enforced in CI/tests; DB enforces schema presence only.
BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Backfill missing schema_version on legacy global defaults
-- ---------------------------------------------------------------------------
UPDATE public.settings_versions sv
SET schema_version = sr.version
FROM (
  SELECT category, max(version) AS version
  FROM public.schema_registry
  WHERE is_active = TRUE
    AND category IN (
      'error_policy',
      'idempotency_defaults',
      'rate_limit_policy',
      'response_policy',
      'retry_backoff_policy',
      'schedule_policy',
      'tracking_policy'
    )
  GROUP BY category
) sr
WHERE sv.category = sr.category
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.schema_version IS NULL;

-- ---------------------------------------------------------------------------
-- 2) webhook_ingest_policy schema v2 (adds schema metadata block)
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'webhook_ingest_policy'
    AND version = 1
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      base.schema,
      '{properties,schema}',
      jsonb_build_object(
        'type', 'object',
        'required', jsonb_build_array('version', 'registry'),
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'version', jsonb_build_object('type', 'string', 'minLength', 1),
          'registry', jsonb_build_object('type', 'string', 'minLength', 1)
        )
      ),
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'webhook_ingest_policy',
  2,
  patched.schema,
  COALESCE(patched.description, 'webhook_ingest_policy schema') || ' (v2: schema metadata)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 2 THEN TRUE ELSE FALSE END
WHERE category = 'webhook_ingest_policy';

UPDATE public.settings_versions
SET schema_version = 2
WHERE category = 'webhook_ingest_policy'
  AND schema_version = 1;

-- ---------------------------------------------------------------------------
-- 3) geocoding_policy schema v2 (adds matching_plugins/local_lookup/logging + alias auto-learning)
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'geocoding_policy'
    AND version = 1
  LIMIT 1
),
auto_learning_v2 AS (
  SELECT jsonb_build_object(
    'oneOf',
    jsonb_build_array(
      base.schema #> '{properties,auto_learning}',
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'alias_confidence_min', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
          'alias_review_threshold', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
          'alias_max_per_run', jsonb_build_object('type', 'integer', 'minimum', 0)
        )
      )
    )
  ) AS schema
  FROM base
),
patched AS (
  SELECT
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              base.schema,
              '{properties,auto_learning}',
              auto_learning_v2.schema,
              TRUE
            ),
            '{properties,logging}',
            jsonb_build_object(
              'type', 'object',
              'additionalProperties', FALSE,
              'properties', jsonb_build_object(
                'log_tokens', jsonb_build_object('type', 'boolean'),
                'log_scoring_details', jsonb_build_object('type', 'boolean')
              )
            ),
            TRUE
          ),
          '{properties,local_lookup}',
          jsonb_build_object(
            'type', 'object',
            'additionalProperties', FALSE,
            'properties', jsonb_build_object(
              'enabled', jsonb_build_object('type', 'boolean'),
              'min_confidence', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
              'allow_provider_fallback', jsonb_build_object('type', 'boolean'),
              'prefer_district_centroid', jsonb_build_object('type', 'boolean')
            )
          ),
          TRUE
        ),
        '{properties,matching_plugins}',
        jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'additionalProperties', FALSE,
            'required', jsonb_build_array('name', 'enabled'),
            'properties', jsonb_build_object(
              'name', jsonb_build_object('type', 'string', 'minLength', 1),
              'enabled', jsonb_build_object('type', 'boolean'),
              'params', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
            )
          )
        ),
        TRUE
      ),
      '{properties,cache_ttl_minutes}',
      jsonb_build_object('type', 'integer', 'minimum', 0),
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
  CROSS JOIN auto_learning_v2
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'geocoding_policy',
  2,
  patched.schema,
  COALESCE(patched.description, 'geocoding_policy schema') || ' (v2: plugins + alias auto-learning)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 2 THEN TRUE ELSE FALSE END
WHERE category = 'geocoding_policy';

UPDATE public.settings_versions
SET schema_version = 2
WHERE category = 'geocoding_policy'
  AND scope_type = 'global'
  AND scope_id IS NULL
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND schema_version = 1;

-- ---------------------------------------------------------------------------
-- 4) label_design schema v3 (allow rect blocks)
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'label_design'
    AND version = 2
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      base.schema,
      '{properties,templates,additionalProperties,properties,blocks,items,properties,type,enum}',
      '["text","barcode","image","rect"]'::jsonb,
      TRUE
    ) AS schema,
    base.description,
    base.examples
  FROM base
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'label_design',
  3,
  patched.schema,
  COALESCE(patched.description, 'label_design schema') || ' (v3: rect blocks)',
  patched.examples,
  TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE;

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 3 THEN TRUE ELSE FALSE END
WHERE category = 'label_design';

UPDATE public.settings_versions
SET schema_version = 3
WHERE category = 'label_design'
  AND schema_version = 2;

COMMIT;
