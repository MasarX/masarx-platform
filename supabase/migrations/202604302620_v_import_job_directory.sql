-- Spec-Issue: W28 PLATFORM gap closure (paired projection views)
-- Step: W28-VIEW-3
-- Migration: Canonical projection view public.v_import_job_directory.
-- Capability: imports.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-job derived projections + lifecycle status flags used by
--   `apps/console-v2/src/modules/platform/imports.tsx` (ImportJobRow):
--     - submitted_by_label  : human-readable user label resolved via
--                               public.users.full_name (FK join).
--     - submitted_by_email  : derived projection from public.users.email.
--     - tenant_label        : human-readable tenant label resolved via
--                               organizations.name (FK join).
--     - error_count_value   : derived non-NULL value of error_count (defaults
--                               to 0 when canonical column is NULL); FE chip
--                               vocabulary expects a numeric, not nullable.
--     - row_count_value     : derived non-NULL value of row_count (defaults
--                               to 0 when canonical column is NULL).
--     - is_terminal         : derived BOOLEAN — TRUE when status IN
--                               ('completed', 'failed', 'cancelled').
--     - is_active           : derived BOOLEAN — TRUE when status IN
--                               ('queued', 'running').
--     - is_failed           : derived BOOLEAN — TRUE when status = 'failed'.
--     - has_errors          : derived BOOLEAN — TRUE when error_count > 0.
--     - duration_seconds    : derived NUMERIC — completed_at - started_at
--                               (NULL when either is NULL).
--     - queue_wait_seconds  : derived NUMERIC — started_at - submitted_at
--                               (NULL when started_at is NULL).
--     - age_seconds         : derived NUMERIC — now() - submitted_at
--                               (always non-NULL).
--     - error_summary_count : derived INT — count of error entries in
--                               error_summary jsonb (entries[] array length;
--                               0 when no errors).
--
--   The FE `ImportJobRow` interface at apps/console-v2/src/modules/platform/imports.tsx
--   currently exposes the canonical column shape 1:1 (no FE-fictional fields)
--   but lacks the derived label/flag projections needed for compact
--   DataTable chip rendering and KPI strip aggregates. Moving to a canonical
--   view exposes the canonical SSOT columns AND the FE-shaped projection
--   aliases on the same seam, so the production cutover becomes a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('import_job_directory')`.
--
-- Notes:
--   * SSOT remains public.import_jobs; this view is read-only.
--   * RLS is enforced by the underlying tables (import_jobs, organizations,
--     users) via security_invoker = true.
--   * Service-role + authenticated SELECT (mirrors W22-W27 paired projection
--     grants).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - FE shape: apps/console-v2/src/modules/platform/imports.tsx:52
--   - Canonical table: 202604301900_import_jobs.sql:25
--   - Sibling RPCs: 202604301905_import_job_rpcs_v1.sql

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302620_v_import_job_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_import_job_directory;

CREATE VIEW public.v_import_job_directory
  WITH (security_invoker = true)
  AS
SELECT
  ij.id,
  ij.organization_id,
  ij.kind,
  ij.source,
  ij.status,
  ij.submitted_at,
  ij.started_at,
  ij.completed_at,
  ij.submitted_by_user_id,
  ij.row_count,
  ij.error_count,
  ij.error_summary,
  ij.correlation_id,
  ij.cancelled_reason,
  ij.created_at,
  ij.updated_at,
  -- Derived: tenant + submitter labels
  o.name                                                                  AS tenant_label,
  o.slug                                                                  AS tenant_slug,
  u.full_name                                                             AS submitted_by_label,
  u.email                                                                 AS submitted_by_email,
  -- Derived: NULL-safe numeric defaults (FE chip vocabulary expects numeric)
  COALESCE(ij.row_count, 0)::INT                                          AS row_count_value,
  COALESCE(ij.error_count, 0)::INT                                        AS error_count_value,
  -- Derived: lifecycle flags
  (ij.status IN ('completed', 'failed', 'cancelled'))                     AS is_terminal,
  (ij.status IN ('queued', 'running'))                                    AS is_active,
  (ij.status = 'failed')                                                  AS is_failed,
  (COALESCE(ij.error_count, 0) > 0)                                       AS has_errors,
  -- Derived: timing aggregates
  CASE
    WHEN ij.completed_at IS NOT NULL AND ij.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (ij.completed_at - ij.started_at))::NUMERIC
    ELSE NULL
  END                                                                     AS duration_seconds,
  CASE
    WHEN ij.started_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (ij.started_at - ij.submitted_at))::NUMERIC
    ELSE NULL
  END                                                                     AS queue_wait_seconds,
  EXTRACT(EPOCH FROM (now() - ij.submitted_at))::NUMERIC                  AS age_seconds,
  -- Derived: error_summary jsonb introspection
  CASE
    WHEN jsonb_typeof(COALESCE(ij.error_summary, '{}'::jsonb)) = 'object'
      AND jsonb_typeof(ij.error_summary->'errors') = 'array'
      THEN jsonb_array_length(ij.error_summary->'errors')
    ELSE 0
  END::INT                                                                AS error_summary_count
FROM public.import_jobs ij
LEFT JOIN public.organizations o ON o.id = ij.organization_id
LEFT JOIN public.users u ON u.id = ij.submitted_by_user_id;

COMMENT ON VIEW public.v_import_job_directory IS
  'FE-friendly projection of import_jobs with organization join (tenant_label / tenant_slug), submitter user join (submitted_by_label / submitted_by_email via users.full_name/email), NULL-safe numeric defaults (row_count_value, error_count_value), lifecycle flags (is_terminal, is_active, is_failed, has_errors), timing aggregates (duration_seconds, queue_wait_seconds, age_seconds), and error_summary introspection (error_summary_count). Sources: import_jobs + organizations + users. Read-only; SSOT remains import_jobs; mutations go through import_job_create_v1 / import_job_cancel_v1.';

REVOKE ALL ON public.v_import_job_directory FROM PUBLIC;
REVOKE ALL ON public.v_import_job_directory FROM anon;
GRANT SELECT ON public.v_import_job_directory TO authenticated;
GRANT SELECT ON public.v_import_job_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302620_v_import_job_directory'));
COMMIT;
