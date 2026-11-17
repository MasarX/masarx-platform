-- Migration: label_render_policy schema update (hard_min_font_size + arabic.direction)
-- Purpose:
--  - Add optional `text_defaults.hard_min_font_size` to control absolute shrink floor (prevents unreadable microtext).
--  - Add optional `arabic.direction` to keep the policy schema aligned with renderer usage (auto|rtl|ltr).
--  - Update global label_render_policy defaults to include `hard_min_font_size`.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- 1) schema_registry: label_render_policy v1 additions (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE schema_registry
SET
  schema = jsonb_set(
    jsonb_set(
      schema,
      '{properties,text_defaults,properties,hard_min_font_size}',
      '{"type":"number","exclusiveMinimum":0}'::jsonb,
      TRUE
    ),
    '{properties,arabic,properties,direction}',
    '{"type":"string","enum":["auto","rtl","ltr"]}'::jsonb,
    TRUE
  ),
  examples = jsonb_set(
    jsonb_set(
      examples,
      '{0,text_defaults,hard_min_font_size}',
      '4'::jsonb,
      TRUE
    ),
    '{0,arabic,direction}',
    '"auto"'::jsonb,
    TRUE
  ),
  is_active = TRUE,
  created_at = workflow_now()
WHERE category = 'label_render_policy'
  AND version = 1;

-- -----------------------------------------------------------------------------
-- 2) Global defaults: add text_defaults.hard_min_font_size (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE settings_versions
SET
  value = jsonb_set(value, '{text_defaults,hard_min_font_size}', '4'::jsonb, TRUE),
  change_reason = 'Update global label_render_policy: add text_defaults.hard_min_font_size',
  approved_at = workflow_now(),
  effective_from = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE settings
SET
  cached_value = jsonb_set(cached_value, '{text_defaults,hard_min_font_size}', '4'::jsonb, TRUE),
  last_updated = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

