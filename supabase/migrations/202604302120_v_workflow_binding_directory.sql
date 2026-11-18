-- Spec-Issue: W22 WORKFLOWS gap closure (paired projection views)
-- Step: W22-VIEW-3
-- Migration: Canonical projection view public.v_workflow_binding_directory.
-- Capability: workflows.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-binding derived projections used by
--   `apps/console-v2/src/modules/workflows/bindings.tsx` (WorkflowBinding
--   surface):
--     - stage_count             : COUNT(workflow_binding_stage_registry rows
--                                  for this binding_key).
--     - dispatch_count          : COUNT(workflow_binding_dispatches WHERE
--                                  binding_key matches).
--     - last_dispatch_at        : MAX(workflow_binding_dispatches.created_at)
--                                  per binding_key.
--     - last_dispatch_outcome   : outcome of the most recent dispatch.
--     - completed_dispatch_count / failed_dispatch_count / waiting_dispatch_count
--                                : per-outcome dispatch counters.
--     - default_workflow_template_id : the canonical workflow_template_id
--                                  resolved from the most recent dispatch row.
--                                  This is a projection — the registry itself
--                                  doesn't own a template_id, but the latest
--                                  resolved dispatch is the operational SSOT.
--     - default_template_name   : projection — workflow_templates.name via FK.
--     - is_active               : derived BOOLEAN — TRUE when
--                                  configurability_status = 'workflow_configurable'.
--     - binding_key / label / description / resource_type / actor_surface /
--       entrypoint_type / current_execution_kind / configurability_status /
--       owner / migration_phase / is_business_affecting / created_at /
--       updated_at  : passthrough canonical columns.
--
--   The FE `WorkflowBinding` interface in bindings.tsx exposes a legacy seed
--   shape (id/event/template_id/condition/priority/status). This view exposes
--   the canonical SSOT (binding_key + the derived dispatch counters) so the
--   FE row interface can collapse to canonical column names + projection
--   columns when the cutover lands. Closes the W10-6 deferred binding
--   structural mismatch by exposing the canonical SSOT plus the operationally-
--   meaningful counters on a single projection seam.
--
-- Notes:
--   * SSOT remains public.workflow_binding_registry; this view is read-only.
--   * RLS is enforced by the underlying tables. workflow_binding_registry,
--     workflow_binding_stage_registry, and workflow_binding_dispatches are
--     all service-only base tables (RLS enabled, no anon grants); the FE
--     reads through this canonical projection seam.
--   * Service-role + authenticated SELECT (mirrors W20/W21 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302120_v_workflow_binding_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_workflow_binding_directory;

CREATE VIEW public.v_workflow_binding_directory AS
WITH stages AS (
  SELECT
    wbsr.binding_key,
    COUNT(*)::INT AS stage_count
  FROM public.workflow_binding_stage_registry wbsr
  GROUP BY wbsr.binding_key
),
dispatch_counters AS (
  SELECT
    wbd.binding_key,
    COUNT(*)::INT AS dispatch_count,
    MAX(wbd.created_at) AS last_dispatch_at,
    SUM(CASE WHEN wbd.outcome = 'completed' THEN 1 ELSE 0 END)::INT AS completed_dispatch_count,
    SUM(CASE WHEN wbd.outcome = 'failed' THEN 1 ELSE 0 END)::INT    AS failed_dispatch_count,
    SUM(CASE WHEN wbd.outcome = 'waiting' THEN 1 ELSE 0 END)::INT   AS waiting_dispatch_count,
    SUM(CASE WHEN wbd.outcome = 'started' THEN 1 ELSE 0 END)::INT   AS started_dispatch_count
  FROM public.workflow_binding_dispatches wbd
  GROUP BY wbd.binding_key
),
last_dispatch AS (
  SELECT DISTINCT ON (wbd.binding_key)
    wbd.binding_key,
    wbd.outcome AS last_dispatch_outcome,
    wbd.workflow_template_id AS default_workflow_template_id,
    wbd.workflow_run_id AS last_workflow_run_id
  FROM public.workflow_binding_dispatches wbd
  ORDER BY wbd.binding_key, wbd.created_at DESC
)
SELECT
  wbr.binding_key                            AS binding_key,
  wbr.binding_key                            AS id,
  wbr.label,
  wbr.description,
  wbr.resource_type,
  wbr.actor_surface,
  wbr.entrypoint_type,
  wbr.current_execution_kind,
  wbr.configurability_status,
  wbr.owner,
  wbr.migration_phase,
  wbr.is_business_affecting,
  wbr.created_at,
  wbr.updated_at,
  COALESCE(stages.stage_count, 0) AS stage_count,
  COALESCE(dispatch_counters.dispatch_count, 0) AS dispatch_count,
  dispatch_counters.last_dispatch_at,
  last_dispatch.last_dispatch_outcome,
  last_dispatch.default_workflow_template_id,
  wt.name AS default_template_name,
  last_dispatch.last_workflow_run_id,
  COALESCE(dispatch_counters.completed_dispatch_count, 0) AS completed_dispatch_count,
  COALESCE(dispatch_counters.failed_dispatch_count, 0)    AS failed_dispatch_count,
  COALESCE(dispatch_counters.waiting_dispatch_count, 0)   AS waiting_dispatch_count,
  COALESCE(dispatch_counters.started_dispatch_count, 0)   AS started_dispatch_count,
  -- Derived is_active: configurability_status indicates the binding is
  -- configurable AND the most recent dispatch did not fail.
  (wbr.configurability_status = 'workflow_configurable') AS is_active
FROM public.workflow_binding_registry wbr
LEFT JOIN stages            ON stages.binding_key = wbr.binding_key
LEFT JOIN dispatch_counters ON dispatch_counters.binding_key = wbr.binding_key
LEFT JOIN last_dispatch     ON last_dispatch.binding_key = wbr.binding_key
LEFT JOIN public.workflow_templates wt ON wt.id = last_dispatch.default_workflow_template_id;

COMMENT ON VIEW public.v_workflow_binding_directory IS
  'FE-friendly projection of workflow_binding_registry with stage_count + dispatch counters (dispatch_count, completed/failed/waiting/started_dispatch_count, last_dispatch_at, last_dispatch_outcome) and default_workflow_template_id resolved from the most recent dispatch (default_template_name via workflow_templates FK join). Sources: workflow_binding_registry + workflow_binding_stage_registry + workflow_binding_dispatches + workflow_templates. Read-only; SSOT remains workflow_binding_registry; mutations go through register_workflow_binding_v1 / simulate_binding_dispatch_v1.';

REVOKE ALL ON public.v_workflow_binding_directory FROM PUBLIC;
REVOKE ALL ON public.v_workflow_binding_directory FROM anon;
REVOKE ALL ON public.v_workflow_binding_directory FROM authenticated;
GRANT SELECT ON public.v_workflow_binding_directory TO authenticated;
GRANT SELECT ON public.v_workflow_binding_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302120_v_workflow_binding_directory'));
COMMIT;
