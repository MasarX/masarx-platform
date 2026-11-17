-- Test Suite: label_render_policy defaults (schema + global seed)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS(SELECT 1 FROM schema_registry WHERE category='label_render_policy' AND version=1 AND is_active),
  'schema_registry label_render_policy v1 present'
);

SELECT ok(
  EXISTS(SELECT 1 FROM settings WHERE category='label_render_policy' AND scope_type='global' AND scope_id IS NULL),
  'label_render_policy seeded (global)'
);

SELECT is(
  public.resolve_settings('label_render_policy','global',NULL)->>'header_brand_mode',
  'logo',
  'label_render_policy global default header_brand_mode=logo'
);

SELECT is(
  (public.resolve_settings('label_render_policy','global',NULL)->'text_defaults'->>'min_font_size')::numeric,
  6::numeric,
  'label_render_policy text_defaults.min_font_size=6'
);

SELECT is(
  (public.resolve_settings('label_render_policy','global',NULL)->'arabic'->>'enabled')::boolean,
  true,
  'label_render_policy arabic.enabled=true by default'
);

SELECT * FROM finish();

ROLLBACK;
