-- Spec-Issue: W25 FINANCE gap closure (paired projection views)
-- Step: W25-VIEW-2
-- Migration: Canonical projection view public.v_dispute_directory.
-- Capability: disputes.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-dispute derived joins + counters used by
--   `apps/console-v2/src/modules/finance/disputes.tsx` (DisputeRow):
--     - opened_by_label       : derived from organizations.name
--                               (opened_by_organization_id)
--     - counterparty_label    : derived from organizations.name
--                               (counterparty_organization_id)
--     - opened_by_user_label  : derived from users.full_name (opened_by_user_id)
--     - resolved_by_user_label: derived from users.full_name (resolved_by_user_id)
--     - contract_status        : derived from marketplace_contracts.status (when set)
--     - work_package_status    : derived from marketplace_work_packages.status (when set)
--     - request_label          : derived from marketplace_requests.title (when set)
--     - shipment_ref          : passthrough from metadata->>'shipment_ref'
--     - amount_sar            : passthrough numeric from metadata->>'amount_sar'
--     - escalation_count      : derived INT — metadata->>'escalation_count'::INT (W9-3)
--     - escalation_at         : derived TIMESTAMPTZ — metadata->>'escalation_at'
--                               (set by W9-3 dispute_escalate_v1)
--     - is_escalated          : derived BOOLEAN — TRUE when escalation_count > 0
--     - is_terminal           : derived BOOLEAN — TRUE when status IN
--                               ('resolved', 'rejected')
--     - age_seconds           : derived INT — seconds since created_at
--     - age_hours              : derived INT — hours since created_at (truncated)
--
--   The FE `DisputeRow` interface at apps/console-v2/src/modules/finance/disputes.tsx
--   currently resolves shipment_ref/amount_sar through metadata jsonb helpers
--   (W13-1 closure) and uses canonical column names (`category`, `created_at`,
--   W19-4 RENAMEs). This view exposes the canonical SSOT plus the derived
--   joins and derived booleans/counters under stable keys so the live cutover
--   stays a single getSupabaseClient() branch flip.
--
-- Notes:
--   * SSOT remains public.marketplace_disputes; this view is read-only.
--   * RLS is enforced by the underlying tables (marketplace_disputes /
--     organizations / users / marketplace_contracts / marketplace_work_packages
--     / marketplace_requests).
--   * Service-role + authenticated SELECT (mirrors v_recipient_directory baseline).
--   * Idempotent: pure view; safe to re-run.
--   * `age_seconds` / `age_hours` evaluate `now()` at query time so callers
--     get a deterministic per-row state for SLA chips.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302310_v_dispute_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_dispute_directory;

CREATE VIEW public.v_dispute_directory AS
SELECT
  d.id                AS dispute_id,
  d.id                AS id,
  d.created_at,
  d.updated_at,
  d.request_id,
  d.contract_id,
  d.work_package_id,
  d.opened_by_organization_id,
  d.counterparty_organization_id,
  d.opened_by_user_id,
  d.resolved_by_user_id,
  d.status,
  d.category,
  d.title,
  d.description,
  d.resolution,
  d.resolved_at,
  d.metadata,
  -- Derived organization labels
  o_open.name        AS opened_by_label,
  o_cpty.name        AS counterparty_label,
  -- Derived user labels
  u_open.full_name   AS opened_by_user_label,
  u_resv.full_name   AS resolved_by_user_label,
  -- Derived marketplace context labels (marketplace_contracts /
  -- marketplace_work_packages have no title column — surface their status
  -- so operator drawers can show contract/work-package state at a glance).
  mc.status          AS contract_status,
  mwp.status         AS work_package_status,
  mr.title           AS request_label,
  -- Metadata projections (W13-1 — shipment_ref / amount_sar nest in metadata)
  NULLIF(d.metadata->>'shipment_ref', '')                AS shipment_ref,
  COALESCE(NULLIF(d.metadata->>'amount_sar', ''), '0')::NUMERIC AS amount_sar,
  -- W9-3 escalation counters (recorded by dispute_escalate_v1)
  COALESCE(NULLIF(d.metadata->>'escalation_count', ''), '0')::INT AS escalation_count,
  NULLIF(d.metadata->>'escalation_at', '')::TIMESTAMPTZ  AS escalation_at,
  (COALESCE(NULLIF(d.metadata->>'escalation_count', ''), '0')::INT > 0) AS is_escalated,
  -- Derived state flags
  (d.status IN ('resolved', 'rejected')) AS is_terminal,
  -- Age derivations (now() at query time)
  GREATEST(0, EXTRACT(EPOCH FROM (now() - d.created_at)))::BIGINT AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600))::INT AS age_hours
FROM public.marketplace_disputes d
LEFT JOIN public.organizations o_open ON o_open.id = d.opened_by_organization_id
LEFT JOIN public.organizations o_cpty ON o_cpty.id = d.counterparty_organization_id
LEFT JOIN public.users u_open         ON u_open.id = d.opened_by_user_id
LEFT JOIN public.users u_resv         ON u_resv.id = d.resolved_by_user_id
LEFT JOIN public.marketplace_contracts    mc  ON mc.id = d.contract_id
LEFT JOIN public.marketplace_work_packages mwp ON mwp.id = d.work_package_id
LEFT JOIN public.marketplace_requests      mr ON mr.id = d.request_id;

COMMENT ON VIEW public.v_dispute_directory IS
  'FE-friendly projection of marketplace_disputes with derived joins (opened_by_label, counterparty_label, opened_by_user_label, resolved_by_user_label, contract_status, work_package_status, request_label) and metadata-derived counters (shipment_ref, amount_sar, escalation_count, escalation_at, is_escalated, is_terminal, age_seconds, age_hours). Sources: marketplace_disputes + organizations + users + marketplace_contracts + marketplace_work_packages + marketplace_requests. Read-only; SSOT remains marketplace_disputes; mutations go through dispute_resolve_v1 / dispute_reject_v1 / dispute_escalate_v1.';

REVOKE ALL ON public.v_dispute_directory FROM PUBLIC;
REVOKE ALL ON public.v_dispute_directory FROM anon;
REVOKE ALL ON public.v_dispute_directory FROM authenticated;
GRANT SELECT ON public.v_dispute_directory TO authenticated;
GRANT SELECT ON public.v_dispute_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302310_v_dispute_directory'));
COMMIT;
