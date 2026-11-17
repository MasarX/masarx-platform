-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Backfill missing label_template_specs rows referenced by label pipeline tables.
-- Context: Existing envs can contain label_jobs / labels rows that reference a template_id that
--          does not exist in label_template_specs. Subsequent FK migrations should not fail on
--          pre-existing data drift.
-- Approach: Insert minimal, clearly-marked stub template specs for any referenced (template_id, organization_id)
--          pair that is missing. This preserves SSOT + row-driven behavior without hardcoding
--          to a specific template.

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH referenced_templates AS (
  SELECT DISTINCT
    lj.template_id AS id,
    lj.organization_id AS organization_id
  FROM public.label_jobs lj
  WHERE lj.template_id IS NOT NULL

  UNION

  SELECT DISTINCT
    l.layout_template_id AS id,
    l.organization_id AS organization_id
  FROM public.labels l
  WHERE l.layout_template_id IS NOT NULL
),
missing_specs AS (
  SELECT
    rt.id,
    rt.organization_id
  FROM referenced_templates rt
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.label_template_specs t
    WHERE t.id = rt.id
      AND t.organization_id = rt.organization_id
  )
)
INSERT INTO public.label_template_specs (
  id,
  organization_id,
  template_key,
  version,
  template_scope_type,
  template_scope_id,
  renderer_config,
  asset_refs
)
SELECT
  ms.id,
  ms.organization_id,
  concat('backfill_missing_', ms.id::text),
  1,
  'tenant',
  ms.organization_id,
  jsonb_build_object(
    'kind', 'backfill_missing_label_template_spec',
    'template_id', ms.id::text,
    'organization_id', ms.organization_id::text,
    'note', 'Auto-created to satisfy label template reference integrity on existing data.'
  ),
  '[]'::jsonb
FROM missing_specs ms
ON CONFLICT (id, organization_id) DO NOTHING;

COMMIT;

