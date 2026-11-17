-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 NDR SLA breach view shape repair v1
-- Date: 2026-04-24
--
-- Purpose:
--   - Restore the canonical current SLA breach reporting projection after the
--     pre-shape compatibility migration and the original UC114 migration have
--     run in drifted shared environments.
--   - Keep the API schema boundary and dispatch exception reason projection
--     aligned with the later NDR reason projection contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604241920_uc114_sla_breach_view_shape_repair_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS api.dispatch_exception_review_sla_breaches_v;
DROP VIEW IF EXISTS public.dispatch_exception_review_sla_breaches_v;

CREATE VIEW public.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.organization_id,
  t.client_id,
  t.sender_id,
  t.resource_type,
  t.resource_id,
  t.status,
  t.queue_key,
  t.assigned_to,
  t.assigned_at,
  t.sla_minutes,
  t.sla_due_at,
  t.sla_breached_at,
  GREATEST(CEIL(EXTRACT(EPOCH FROM (COALESCE(t.sla_breached_at, now()) - t.sla_due_at)) / 60.0)::INT, 0) AS overdue_minutes,
  t.created_at,
  t.updated_at,
  COALESCE(
    NULLIF(btrim(COALESCE(t.metadata->>'dispatch_exception_reason', '')), ''),
    NULLIF(btrim(COALESCE(t.status_reason, '')), '')
  ) AS dispatch_exception_reason
FROM public.tasks t
WHERE t.task_type_key = 'dispatch_exception_review'
  AND t.sla_due_at IS NOT NULL
  AND t.sla_breached_at IS NOT NULL;

CREATE VIEW api.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT *
FROM public.dispatch_exception_review_sla_breaches_v;

REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM PUBLIC;
REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM anon;
REVOKE ALL ON api.dispatch_exception_review_sla_breaches_v FROM authenticated;
GRANT SELECT ON api.dispatch_exception_review_sla_breaches_v TO authenticated, service_role;

COMMENT ON VIEW public.dispatch_exception_review_sla_breaches_v
  IS 'Dispatch exception review tasks with breached SLA timing and canonical exception reason projection.';
COMMENT ON VIEW api.dispatch_exception_review_sla_breaches_v
  IS 'API projection for dispatch exception review SLA breach reporting.';

SELECT pg_advisory_unlock(hashtext('202604241920_uc114_sla_breach_view_shape_repair_v1'));
COMMIT;
