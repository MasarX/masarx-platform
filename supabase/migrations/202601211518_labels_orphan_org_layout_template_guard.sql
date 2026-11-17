-- Plan: PLAN-202602-deploy-approvals-and-frontend-cd / Step: S99
-- Migration: Guard label template reference backfills from orphan labels with missing organizations.
--
-- Context:
-- - `labels` historically did not have an FK to `organizations`, so environments can contain
--   orphan label rows where `organization_id` no longer exists.
-- - Later migrations backfill `label_template_specs` from `labels.layout_template_id`, but
--   `label_template_specs.organization_id` has an FK to `organizations`, so orphan labels can
--   cause migration failures.
--
-- Policy:
-- - This is a data fixup only (no schema changes).
-- - We intentionally preserve labels, but null `layout_template_id` for orphan orgs so later
--   integrity migrations can proceed deterministically.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Defensive cleanup: label_jobs should have an FK to organizations, but historical environments
-- can contain drifted rows (e.g., constraints previously disabled). Remove any orphan jobs so
-- downstream template backfills can't fail on label_template_specs FK enforcement.
DELETE FROM public.label_jobs lj
WHERE NOT EXISTS (
  SELECT 1
  FROM public.organizations o
  WHERE o.id = lj.organization_id
);

UPDATE public.labels l
SET layout_template_id = NULL
WHERE l.layout_template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = l.organization_id
  );

COMMIT;
