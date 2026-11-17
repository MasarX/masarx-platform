-- Plan: PLAN-202512-label-print-sync-fast-bundle / Step: S95
-- Migration: label_design schema v4 (line blocks + hex colors + boolean human_readable)
-- Purpose:
--   - Align label_design schema_registry contract with the MasarX waybill v1.8.5 (185)
--     renderer_config snapshot shape (line blocks + hex colors).
--   - Keep schema validation deterministic for global defaults tests.
BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- label_design schema v4
--   - allow blocks.type: line (in addition to v3 rect/text/barcode/image)
--   - allow blocks.color: hex string OR {r,g,b}
--   - allow templates.shipping.barcode.human_readable: boolean OR string
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'label_design'
    AND version = 3
  LIMIT 1
),
patched_color AS (
  SELECT
    jsonb_build_object(
      'oneOf',
      jsonb_build_array(
        jsonb_build_object(
          'type', 'string',
          'pattern', '^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$'
        ),
        base.schema #> '{properties,templates,additionalProperties,properties,blocks,items,properties,color}'
      )
    ) AS schema_color,
    base.schema,
    base.description,
    base.examples
  FROM base
),
patched_barcode AS (
  SELECT
    jsonb_build_object(
      'oneOf',
      jsonb_build_array(
        jsonb_build_object('type', 'string'),
        jsonb_build_object('type', 'boolean')
      )
    ) AS schema_human_readable,
    patched_color.schema_color,
    patched_color.schema,
    patched_color.description,
    patched_color.examples
  FROM patched_color
),
patched AS (
  SELECT
    jsonb_set(
      jsonb_set(
        jsonb_set(
          patched_barcode.schema,
          '{properties,templates,additionalProperties,properties,blocks,items,properties,type,enum}',
          '["text","barcode","image","rect","line"]'::jsonb,
          TRUE
        ),
        '{properties,templates,additionalProperties,properties,blocks,items,properties,color}',
        patched_barcode.schema_color,
        TRUE
      ),
      '{properties,templates,additionalProperties,properties,barcode,properties,human_readable}',
      patched_barcode.schema_human_readable,
      TRUE
    ) AS schema,
    patched_barcode.description,
    patched_barcode.examples
  FROM patched_barcode
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT
  'label_design',
  4,
  patched.schema,
  COALESCE(patched.description, 'label_design schema') || ' (v4: line + hex colors + boolean human_readable)',
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
SET is_active = CASE WHEN version = 4 THEN TRUE ELSE FALSE END
WHERE category = 'label_design';

-- Ensure settings_versions.schema_version stays aligned for default validators
UPDATE public.settings_versions
SET schema_version = 4
WHERE category = 'label_design'
  AND schema_version IS DISTINCT FROM 4;

COMMIT;
