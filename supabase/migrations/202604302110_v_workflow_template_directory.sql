-- Spec-Issue: W22 WORKFLOWS gap closure (paired projection views)
-- Step: W22-VIEW-2
-- Migration: Canonical projection view public.v_workflow_template_directory.
-- Capability: workflows.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-template derived projections used by
--   `apps/console-v2/src/modules/workflows/templates.tsx` (WorkflowTemplate
--   surface):
--     - template_id      : FE-fabricated TPL-XXXX display alias derived from
--                          the canonical name (slug-style; deterministic).
--     - step_count       : COUNT(workflow_template_steps WHERE template matches).
--     - active_run_count : COUNT(workflow_runs WHERE template matches AND
--                          workflow_status IN ('pending','in_progress','running')).
--     - total_run_count  : COUNT(workflow_runs WHERE template matches).
--     - last_run_at      : MAX(workflow_runs.created_at) for this template.
--     - last_run_status  : workflow_status of the most recent run.
--     - binding_count    : COUNT(workflow_binding_dispatches WHERE template
--                          matches) — binding dispatch ledger projection so the
--                          studio can show "X bindings active" without
--                          inventing FE-only fields.
--     - is_published     : derived BOOLEAN — TRUE when status='active' AND
--                          published_at IS NOT NULL.
--     - description / name / version / status / scope_type / scope_id /
--       created_by / created_at / published_at / retired_at / notes /
--       steps_checksum : passthrough canonical columns.
--
--   The FE `WorkflowTemplate` interface in templates.tsx, runs.tsx, and
--   bindings.tsx surfaces template_id (display alias), name, version,
--   status, trigger, versions[]. Moving the derivations to a canonical
--   view closes the W10-6 cascade items (template_id display alias +
--   counter projections) without inventing FE-only fields.
--
-- Notes:
--   * SSOT remains public.workflow_templates; this view is read-only.
--   * RLS is enforced by the underlying tables (workflow_templates,
--     workflow_template_steps, workflow_runs, workflow_binding_dispatches).
--   * Service-role + authenticated SELECT (mirrors W20/W21 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302110_v_workflow_template_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_workflow_template_directory;

CREATE VIEW public.v_workflow_template_directory AS
WITH steps AS (
  SELECT
    wts.workflow_template_id,
    COUNT(*)::INT AS step_count
  FROM public.workflow_template_steps wts
  GROUP BY wts.workflow_template_id
),
runs_active AS (
  SELECT
    wr.workflow_template_id,
    COUNT(*)::INT AS active_run_count
  FROM public.workflow_runs wr
  WHERE wr.workflow_status IN ('pending', 'in_progress', 'running', 'queued')
  GROUP BY wr.workflow_template_id
),
runs_total AS (
  SELECT
    wr.workflow_template_id,
    COUNT(*)::INT  AS total_run_count,
    MAX(wr.created_at) AS last_run_at
  FROM public.workflow_runs wr
  GROUP BY wr.workflow_template_id
),
last_run_status AS (
  SELECT DISTINCT ON (wr.workflow_template_id)
    wr.workflow_template_id,
    wr.workflow_status AS last_run_status
  FROM public.workflow_runs wr
  ORDER BY wr.workflow_template_id, wr.created_at DESC
),
bindings AS (
  SELECT
    wbd.workflow_template_id,
    COUNT(*)::INT AS binding_count
  FROM public.workflow_binding_dispatches wbd
  GROUP BY wbd.workflow_template_id
)
SELECT
  wt.id                                                                    AS id,
  wt.id                                                                    AS workflow_template_id,
  -- template_id: FE-friendly TPL-XXXX display alias derived from the
  -- canonical name (slug + version). Deterministic so tests + visuals
  -- stay stable; canonical SSOT remains workflow_templates.id.
  ('TPL-'
    || upper(regexp_replace(coalesce(wt.name, ''), '[^a-zA-Z0-9]+', '-', 'g'))
    || '-V' || wt.version::text
  )                                                                        AS template_id,
  wt.name,
  wt.description,
  wt.version,
  wt.status,
  wt.scope_type,
  wt.scope_id,
  wt.created_by,
  wt.created_at,
  wt.published_at,
  wt.retired_at,
  wt.notes,
  wt.steps_checksum,
  COALESCE(steps.step_count, 0)             AS step_count,
  COALESCE(runs_active.active_run_count, 0) AS active_run_count,
  COALESCE(runs_total.total_run_count, 0)   AS total_run_count,
  runs_total.last_run_at                    AS last_run_at,
  last_run_status.last_run_status           AS last_run_status,
  COALESCE(bindings.binding_count, 0)       AS binding_count,
  -- Derived is_published: status active AND published_at present.
  (wt.status = 'active' AND wt.published_at IS NOT NULL) AS is_published
FROM public.workflow_templates wt
LEFT JOIN steps           ON steps.workflow_template_id = wt.id
LEFT JOIN runs_active     ON runs_active.workflow_template_id = wt.id
LEFT JOIN runs_total      ON runs_total.workflow_template_id = wt.id
LEFT JOIN last_run_status ON last_run_status.workflow_template_id = wt.id
LEFT JOIN bindings        ON bindings.workflow_template_id = wt.id;

COMMENT ON VIEW public.v_workflow_template_directory IS
  'FE-friendly projection of workflow_templates with derived counters (step_count, active_run_count, total_run_count, last_run_at, last_run_status, binding_count, is_published) and FE display alias template_id (TPL-XXXX). Sources: workflow_templates + workflow_template_steps + workflow_runs + workflow_binding_dispatches. Read-only; SSOT remains workflow_templates; mutations go through ui_create_workflow_template_v1 / ui_set_workflow_template_status_v1.';

REVOKE ALL ON public.v_workflow_template_directory FROM PUBLIC;
REVOKE ALL ON public.v_workflow_template_directory FROM anon;
REVOKE ALL ON public.v_workflow_template_directory FROM authenticated;
GRANT SELECT ON public.v_workflow_template_directory TO authenticated;
GRANT SELECT ON public.v_workflow_template_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302110_v_workflow_template_directory'));
COMMIT;
