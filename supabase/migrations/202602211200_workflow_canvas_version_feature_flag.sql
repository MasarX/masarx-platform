-- Plan: workflow-canvas-parity / Step: S01
-- Feature flag: workflow_canvas_version
-- Controls which canvas renderer is used in the workflow studio.
-- Values: "legacy" (current SVG canvas, default) | "v2" (React Flow canvas).
-- Resolved via the settings override ladder (Global < Tenant < Client).

/* -------------------------------------------------------------------------
 * 1. Register the settings category.
 * -----------------------------------------------------------------------*/
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
  'workflow_canvas_version',
  'Controls which workflow studio canvas renderer is active (legacy SVG or v2 React Flow).',
  TRUE,
  TRUE,
  FALSE,
  'return_null',
  '["global","tenant","client"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description              = EXCLUDED.description,
  requires_schema          = EXCLUDED.requires_schema,
  requires_global_default  = EXCLUDED.requires_global_default,
  side_effecting           = EXCLUDED.side_effecting,
  safe_missing_behavior    = EXCLUDED.safe_missing_behavior,
  allowed_scopes           = EXCLUDED.allowed_scopes,
  updated_at               = now();

/* -------------------------------------------------------------------------
 * 2. Register the JSON schema in schema_registry.
 * -----------------------------------------------------------------------*/
WITH canvas_schema AS (
  SELECT $schema$
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "workflow_canvas_version.schema.json",
    "title": "workflow_canvas_version",
    "type": "object",
    "required": ["version", "canvas"],
    "additionalProperties": false,
    "properties": {
      "version": {
        "type": "integer",
        "minimum": 1,
        "description": "Schema version"
      },
      "canvas": {
        "type": "string",
        "enum": ["legacy", "v2"],
        "description": "Which canvas renderer to use: legacy (SVG) or v2 (React Flow)"
      }
    }
  }
  $schema$::jsonb AS schema_doc,
  $examples$
  [
    { "version": 1, "canvas": "legacy" },
    { "version": 1, "canvas": "v2" }
  ]
  $examples$::jsonb AS examples
)
INSERT INTO public.schema_registry (
  id,
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
SELECT
  'cccc0000-0000-0000-0000-000000002100',
  'workflow_canvas_version',
  1,
  canvas_schema.schema_doc,
  'Workflow canvas version feature flag — controls SVG (legacy) vs React Flow (v2) renderer.',
  canvas_schema.examples,
  TRUE,
  now()
FROM canvas_schema
ON CONFLICT (category, version) DO UPDATE
SET schema      = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples    = EXCLUDED.examples,
    is_active   = TRUE,
    created_at  = now();

/* -------------------------------------------------------------------------
 * 3. Seed the global default (canvas = legacy).
 * -----------------------------------------------------------------------*/
WITH default_value AS (
  SELECT '{"version": 1, "canvas": "legacy"}'::jsonb AS payload
)
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
SELECT
  'dddd0000-0000-0000-0000-000000002100',
  'workflow_canvas_version',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  1,
  default_value.payload,
  1,
  'Initial workflow_canvas_version baseline — default to legacy SVG canvas',
  now(),
  now()
FROM default_value
ON CONFLICT (id, scope_hash) DO UPDATE
SET value          = EXCLUDED.value,
    change_reason  = EXCLUDED.change_reason,
    approved_at    = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from;

/* Link in settings (cached_value for fast resolution). */
WITH default_value AS (
  SELECT '{"version": 1, "canvas": "legacy"}'::jsonb AS payload
)
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
SELECT
  'eeee0000-0000-0000-0000-000000002100',
  'workflow_canvas_version',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'dddd0000-0000-0000-0000-000000002100',
  default_value.payload,
  now()
FROM default_value
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value        = EXCLUDED.cached_value,
    last_updated        = EXCLUDED.last_updated;
