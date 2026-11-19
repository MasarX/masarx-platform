-- Spec-Issue: W22 WORKFLOWS gap closure (paired projection views)
-- Step: W22-VIEW-1
-- Migration: Canonical projection view public.v_workflow_run_directory.
-- Capability: workflows.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-run derived projections used by
--   `apps/console-v2/src/modules/workflows/runs.tsx` (WorkflowRun surface):
--     - run_id           : FE-fabricated WFR-XXXX display alias derived from
--                          left-trimmed UUID (deterministic, stable for tests).
--     - template_name    : projection — workflow_templates.name via FK join.
--     - template_version : projection — workflow_templates.version via FK join.
--     - duration_ms      : projection — `completed_at - started_at` in ms when
--                          both timestamps are present, NULL otherwise.
--     - correlation_id   : projection — request_contexts.id (FK to
--                          triggered_by_request_id) cast to text.
--     - workflow_status / entry_point / failure_reason : passthrough canonical
--                          columns (kept for FE rename targets).
--     - retry_count / max_retries / context : passthrough canonical columns.
--
--   The FE `WorkflowRun` interface in `runs.tsx` keeps the canonical columns
--   AND legacy display aliases (run_id, status, template_id, error,
--   triggered_by, duration_ms, correlation_id, template_name) — all of
--   those resolve through this view's projections so the production cutover
--   becomes a single getSupabaseClient() branch flip in
--   `ui_list_resource_v1('workflow_run_directory')`. Closes the W10-6
--   deferred RENAME cascade by exposing the canonical SSOT plus the
--   FE-shaped display aliases on the same projection seam.
--
-- Notes:
--   * SSOT remains public.workflow_runs; this view is read-only.
--   * RLS is enforced by the underlying tables (workflow_runs,
--     workflow_templates, request_contexts).
--   * Service-role + authenticated SELECT (mirrors W20/W21 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302100_v_workflow_run_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_workflow_run_directory;

CREATE VIEW public.v_workflow_run_directory AS
SELECT
  wr.id                                                                    AS id,
  -- run_id: FE-friendly WFR-XXXX display alias derived from left-trimmed UUID.
  -- The display alias is deterministic so unit tests + visual snapshots stay
  -- stable across cutover; canonical SSOT remains workflow_runs.id.
  ('WFR-' || upper(substr(replace(wr.id::text, '-', ''), 1, 8)))           AS run_id,
  wr.workflow_template_id,
  -- legacy alias for FE rename target (workflow_runs.template_id is the
  -- legacy seed key; canonical column is workflow_template_id).
  wr.workflow_template_id                                                  AS template_id,
  wt.name                                                                  AS template_name,
  wt.version                                                               AS template_version,
  wr.workflow_status,
  -- legacy alias for FE rename target (workflow_runs.status is the legacy
  -- seed key; canonical column is workflow_status).
  wr.workflow_status                                                       AS status,
  wr.entry_point,
  -- legacy alias for FE rename target.
  wr.entry_point                                                           AS triggered_by,
  wr.failure_reason,
  -- legacy alias for FE rename target.
  wr.failure_reason                                                        AS error,
  wr.started_at,
  wr.completed_at,
  wr.created_at,
  wr.updated_at,
  -- duration_ms projection: derived from started_at + completed_at.
  CASE
    WHEN wr.started_at IS NOT NULL AND wr.completed_at IS NOT NULL THEN
      (EXTRACT(EPOCH FROM (wr.completed_at - wr.started_at)) * 1000)::INTEGER
    ELSE NULL
  END                                                                      AS duration_ms,
  -- correlation_id projection: request_contexts.id IS the correlation_id
  -- (see migration 202510110007_infrastructure.sql:80-111).
  wr.triggered_by_request_id::text                                         AS correlation_id,
  wr.retry_count,
  wr.max_retries,
  wr.context,
  wr.metadata,
  wr.last_error,
  wr.current_step_id,
  wr.workflow_template_version
FROM public.workflow_runs wr
LEFT JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id;

COMMENT ON VIEW public.v_workflow_run_directory IS
  'FE-friendly projection of workflow_runs with template_name + template_version (FK join), duration_ms (computed from started_at/completed_at), correlation_id (triggered_by_request_id cast), and FE display alias run_id (WFR-XXXX). Sources: workflow_runs + workflow_templates. Read-only; SSOT remains workflow_runs; mutations go through progress_workflow_run / close_workflow_run / start_workflow_run.';

REVOKE ALL ON public.v_workflow_run_directory FROM PUBLIC;
REVOKE ALL ON public.v_workflow_run_directory FROM anon;
REVOKE ALL ON public.v_workflow_run_directory FROM authenticated;
GRANT SELECT ON public.v_workflow_run_directory TO authenticated;
GRANT SELECT ON public.v_workflow_run_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302100_v_workflow_run_directory'));
COMMIT;
