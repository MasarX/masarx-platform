-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: v_support_case_summary view v1
-- Date: 2026-04-27
--
-- Purpose:
--   Provide canonical projection view that surfaces FE-driven computed fields
--   without duplicating them onto the base table:
--     - last_message_at  : MAX(support_messages.created_at) per case
--     - message_count    : COUNT(support_messages) per case
--     - sla_breached     : sla_due_at IS NOT NULL AND now() > sla_due_at AND status not in ('resolved','closed','canceled')
--   FE reads from this view; base writes still go through canonical RPCs.
--
-- Notes:
--   - Defined as `security_invoker = true` so RLS policies on the underlying
--     tables (support_cases, support_messages) govern access transparently.
--   - No business logic is hardcoded — sla_breached is purely a deterministic
--     derivation from sla_due_at + canonical statuses already shipped.
--   - View is additive; no DROP COLUMN or destructive changes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271210_v_support_case_summary_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Drop and recreate so column shape stays canonical.
DROP VIEW IF EXISTS public.v_support_case_summary;

CREATE VIEW public.v_support_case_summary
  WITH (security_invoker = true)
  AS
SELECT
  sc.id,
  sc.organization_id,
  sc.client_id,
  sc.sender_id,
  sc.resource_type,
  sc.resource_id,
  sc.status,
  sc.status_reason,
  sc.priority,
  sc.subject,
  sc.channel,
  sc.tags,
  sc.assigned_to,
  sc.assigned_at,
  sc.sla_minutes,
  sc.sla_due_at,
  sc.opened_at,
  sc.resolved_at,
  sc.closed_at,
  sc.idempotency_key,
  sc.version,
  sc.metadata,
  sc.created_at,
  sc.updated_at,
  -- Computed: last_message_at (NULL when no messages yet)
  m.last_message_at,
  -- Computed: message_count (0 when none)
  COALESCE(m.message_count, 0)::INT AS message_count,
  -- Computed: sla_breached
  --  TRUE  when sla_due_at IS NOT NULL AND case is still active AND deadline passed
  --  FALSE when deadline not passed yet OR case is terminal
  --  FALSE when no SLA was set (sla_due_at IS NULL)
  CASE
    WHEN sc.sla_due_at IS NULL THEN FALSE
    WHEN sc.status IN ('resolved', 'closed', 'canceled') THEN
      -- After case is terminal: breached only if it was already past due before terminal
      (sc.sla_due_at < COALESCE(sc.resolved_at, sc.closed_at, sc.updated_at))
    ELSE
      (now() > sc.sla_due_at)
  END AS sla_breached
FROM public.support_cases sc
LEFT JOIN LATERAL (
  SELECT
    MAX(sm.created_at) AS last_message_at,
    COUNT(*)           AS message_count
  FROM public.support_messages sm
  WHERE sm.support_case_id = sc.id
) m ON TRUE;

COMMENT ON VIEW public.v_support_case_summary
  IS 'Canonical FE-facing projection of support_cases enriched with last_message_at, message_count, and deterministic sla_breached. Security invoker so underlying RLS applies.';

REVOKE ALL ON public.v_support_case_summary FROM PUBLIC;
REVOKE ALL ON public.v_support_case_summary FROM anon;

GRANT SELECT ON public.v_support_case_summary TO authenticated;
GRANT SELECT ON public.v_support_case_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604271210_v_support_case_summary_v1'));
COMMIT;
