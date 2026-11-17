-- Migration: label_render_policy barcode gate_mode (warn_only vs enforce)
-- Purpose:
--  - Add `label_render_policy.barcode.gate_mode` so barcode quality actions can be
--    interpreted as warnings-only by default (enterprise-safe for unknown printers).
--  - Seed global defaults without overriding existing custom settings.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- 1) schema_registry: label_render_policy v1 additions (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,barcode,properties,gate_mode}',
    '{"type":"string","enum":["warn_only","enforce"]}'::jsonb,
    TRUE
  ),
  examples = jsonb_set(
    examples,
    '{0,barcode,gate_mode}',
    '"warn_only"'::jsonb,
    TRUE
  ),
  is_active = TRUE,
  created_at = workflow_now()
WHERE category = 'label_render_policy'
  AND version = 1;

-- -----------------------------------------------------------------------------
-- 2) Global defaults: seed gate_mode (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE settings_versions
SET
  value = CASE
    WHEN (value -> 'barcode') ? 'gate_mode' THEN value
    ELSE jsonb_set(
      CASE WHEN value ? 'barcode' THEN value ELSE jsonb_set(value, '{barcode}', '{}'::jsonb, TRUE) END,
      '{barcode,gate_mode}',
      '"warn_only"'::jsonb,
      TRUE
    )
  END,
  change_reason = 'Update global label_render_policy: barcode.gate_mode warn_only',
  approved_at = workflow_now(),
  effective_from = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE settings
SET
  cached_value = CASE
    WHEN (cached_value -> 'barcode') ? 'gate_mode' THEN cached_value
    ELSE jsonb_set(
      CASE WHEN cached_value ? 'barcode' THEN cached_value ELSE jsonb_set(cached_value, '{barcode}', '{}'::jsonb, TRUE) END,
      '{barcode,gate_mode}',
      '"warn_only"'::jsonb,
      TRUE
    )
  END,
  last_updated = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

