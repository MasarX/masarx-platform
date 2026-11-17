-- Test Suite: validate_label_template basic geometry + section containment

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- Create a temp org and template for validation checks
WITH org AS (
  INSERT INTO organizations (name, slug)
  VALUES ('Validation Org', 'validation-org')
  RETURNING id
), tpl AS (
  INSERT INTO label_template_specs (
    organization_id,
    template_key,
    version,
    template_scope_type,
    template_scope_id,
    renderer_config,
    asset_refs
  )
  SELECT
    org.id,
    'validation_template',
    1,
    'global',
    NULL,
    jsonb_build_object(
      'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'margin_inch', 0.1),
      'blocks', jsonb_build_array(
        jsonb_build_object('type','text','x',20,'y',20,'width',50,'height',20, 'section_key','header'),
        jsonb_build_object('type','text','x',20,'y',60,'width',50,'height',20, 'section_key','body')
      )
    ),
    '[]'::jsonb
  FROM org
  RETURNING id, organization_id
), sections AS (
  INSERT INTO label_sections (
    organization_id, template_id, section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left
  )
  SELECT t.organization_id, t.id, 'header', 10, 10, 100, 40, 2, 2, 2, 2 FROM tpl t
  UNION ALL
  SELECT t.organization_id, t.id, 'body', 10, 50, 100, 40, 2, 2, 2, 2 FROM tpl t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_band', 10, 100, 120, 40, 2, 2, 2, 2 FROM tpl t
  RETURNING 1
), tokens AS (
  INSERT INTO label_design_tokens (organization_id, template_id, token_key, token_type, value)
  SELECT t.organization_id, t.id, 'min_font_size', 'font_size', '10'::jsonb FROM tpl t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_min_module_width', 'barcode_min_width', '0.5'::jsonb FROM tpl t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_min_height', 'barcode_min_height', '20'::jsonb FROM tpl t
  RETURNING 1
)
SELECT ok(TRUE, 'Seeded template and sections');

-- Should validate cleanly
SELECT lives_ok(
  $$ SELECT validate_label_template(id, organization_id) FROM label_template_specs WHERE template_key = 'validation_template' $$,
  'validate_label_template runs (passing case)'
);

SELECT is(
  (SELECT validation_status FROM label_template_validation v
   JOIN label_template_specs t ON t.id = v.template_id AND t.organization_id = v.organization_id
   WHERE t.template_key = 'validation_template'),
  'passed',
  'validation_status is passed'
);

-- Create a failing template (block exceeds section)
WITH org AS (
  SELECT id FROM organizations WHERE slug = 'validation-org' LIMIT 1
), tpl_bad AS (
  INSERT INTO label_template_specs (
    organization_id,
    template_key,
    version,
    template_scope_type,
    template_scope_id,
    renderer_config,
    asset_refs
  )
  SELECT
    org.id,
    'validation_template_bad',
    1,
    'global',
    NULL,
    jsonb_build_object(
      'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'margin_inch', 0.1),
      'blocks', jsonb_build_array(
        jsonb_build_object('type','text','x',500,'y',500,'width',10,'height',10, 'section_key','header', 'font_size', 8),
        jsonb_build_object('type','barcode','x',12,'y',120,'width',30,'height',10,'module_width',0.2,'section_key','barcode_band')
      )
    ),
    '[]'::jsonb
  FROM org
  RETURNING id, organization_id
), sections AS (
  INSERT INTO label_sections (
    organization_id, template_id, section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left
  )
  SELECT t.organization_id, t.id, 'header', 10, 10, 100, 40, 2, 2, 2, 2 FROM tpl_bad t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_band', 10, 100, 120, 40, 2, 2, 2, 2 FROM tpl_bad t
  RETURNING 1
), tokens AS (
  INSERT INTO label_design_tokens (organization_id, template_id, token_key, token_type, value)
  SELECT t.organization_id, t.id, 'min_font_size', 'font_size', '10'::jsonb FROM tpl_bad t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_min_module_width', 'barcode_min_width', '0.5'::jsonb FROM tpl_bad t
  UNION ALL
  SELECT t.organization_id, t.id, 'barcode_min_height', 'barcode_min_height', '20'::jsonb FROM tpl_bad t
  RETURNING 1
)
SELECT ok(TRUE, 'Seeded failing template and sections');

SELECT lives_ok(
  $$ SELECT validate_label_template(id, organization_id) FROM label_template_specs WHERE template_key = 'validation_template_bad' $$,
  'validate_label_template runs (failing case)'
);

SELECT is(
  (SELECT validation_status FROM label_template_validation v
   JOIN label_template_specs t ON t.id = v.template_id AND t.organization_id = v.organization_id
   WHERE t.template_key = 'validation_template_bad'),
  'failed',
  'validation_status is failed when block exceeds section'
);
SELECT lives_ok(
  $$ SELECT validate_label_template(id, organization_id) FROM label_template_specs WHERE template_key = 'validation_template_bad' $$,
  'validate_label_template runs (failing case)'
);

SELECT is(
  (SELECT validation_status FROM label_template_validation v
   JOIN label_template_specs t ON t.id = v.template_id AND t.organization_id = v.organization_id
   WHERE t.template_key = 'validation_template_bad'),
  'failed',
  'validation_status is failed when block exceeds section or token minimums'
);

SELECT finish();

ROLLBACK;
