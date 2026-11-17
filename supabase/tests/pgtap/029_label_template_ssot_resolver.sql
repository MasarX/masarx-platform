-- Plan: PLAN-202601-ladder-phase3-label-template-ssot / Step: S04
-- Test: resolve_label_template uses SSOT settings resolver (no hardcoded ladder selection)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- 1) Delegates label_design config lookup to the ladder-aware resolver.
SELECT ok(
  (
    SELECT pg_get_functiondef('public.resolve_label_template(uuid, uuid, uuid, text)'::regprocedure)
           ILIKE '%resolve_settings_row_from_context(''label_design''%'
  ),
  'resolve_label_template resolves label_design via resolve_settings_row_from_context'
);

-- 2) Does not hardcode sender scope selection.
SELECT ok(
  (
    SELECT position('scope_type = ''sender''' in lower(pg_get_functiondef(
      'public.resolve_label_template(uuid, uuid, uuid, text)'::regprocedure
    ))) = 0
  ),
  'resolve_label_template does not hardcode sender scope selection'
);

-- 3) Does not query settings directly (avoids duplicated ladder logic).
SELECT ok(
  (
    SELECT position('from settings' in lower(pg_get_functiondef(
      'public.resolve_label_template(uuid, uuid, uuid, text)'::regprocedure
    ))) = 0
  ),
  'resolve_label_template does not query settings directly'
);

-- 4) Inline (schema v2) resolution must be FK-safe: template_id exists in label_template_specs.
-- Pick the fixture organization as the test runner, then switch to service_role for
-- service-owned settings/template resolution without requiring direct org table grants.
CREATE TEMP TABLE tmp_label_ssot_org (
  org_id UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_label_ssot_org (org_id)
SELECT id
FROM public.organizations
WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY id
LIMIT 1;

GRANT SELECT ON tmp_label_ssot_org TO service_role;

SET LOCAL ROLE service_role;

CREATE TEMP TABLE tmp_label_ssot_settings_version (
  settings_version_id UUID NOT NULL,
  scope_id UUID NOT NULL,
  value JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_label_ssot_settings_version (settings_version_id, scope_id, value)
SELECT
  up.settings_version_id,
  o.org_id,
  template_value.value
FROM tmp_label_ssot_org o
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'templates',
    jsonb_build_object(
      'shipping',
      jsonb_build_object(
        'page', jsonb_build_object(
          'width_mm', 100,
          'height_mm', 150,
          'dpi', 203,
          'orientation', 'portrait'
        ),
        'blocks', jsonb_build_array(
          jsonb_build_object(
            'type', 'barcode',
            'x', 10,
            'y', 10,
            'width', 80,
            'height', 40,
            'barcode_type', 'CODE128',
            'value_path', 'shipment.tracking_number'
          )
        ),
        'assets', '[]'::jsonb
      )
    )
  ) AS value
) template_value
CROSS JOIN LATERAL (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'label_design',
    'tenant',
    o.org_id,
    template_value.value,
    1,
    'pgtap: label template ssot resolver'
  )
) up;

CREATE TEMP TABLE tmp_label_ssot_resolved AS
SELECT o.org_id, r.template_id, r.template_version, r.template_snapshot
FROM tmp_label_ssot_org o
CROSS JOIN LATERAL public.resolve_label_template(o.org_id, NULL, NULL, 'shipping') r
LIMIT 1;

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
      FROM public.label_template_specs t
      WHERE t.organization_id = r.org_id
        AND t.id = r.template_id
    )
    FROM tmp_label_ssot_resolved r
  ),
  (
    SELECT format(
      'resolve_label_template returns template_id that exists in label_template_specs (FK-safe). org_id=%s template_id=%s template_version=%s snapshot.template_key=%s snapshot.template_version=%s spec_rows_for_org=%s',
      org_id::text,
      template_id::text,
      COALESCE(template_version::text, '<null>'),
      COALESCE(template_snapshot->>'template_key', '<null>'),
      COALESCE(template_snapshot->>'template_version', '<null>'),
      (
        SELECT count(*)
        FROM public.label_template_specs t
        WHERE t.organization_id = r.org_id
      )::text
    )
    FROM tmp_label_ssot_resolved r
  )
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
