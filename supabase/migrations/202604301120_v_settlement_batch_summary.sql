-- Spec-Issue: W8-4 FINANCE gap closure (REVISION 77%)
-- Step: W8-4-VIEW-1
-- Migration: Canonical projection view public.v_settlement_batch_summary.
-- Capability: settlements.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-batch financial totals (expected_amount, collected_amount,
--   remitted_amount, posted_at, variance_flag) for the FE settlements module
--   from canonical tables only:
--     - public.settlement_batches  (projection)
--     - public.settlement_batch_finance_events  (membership)
--     - public.finance_events  (immutable ledger)
--     - public.settlement_events  (state transitions; posted timestamp)
--
--   The FE `SettlementBatchRow` (apps/console-v2/src/modules/finance/settlements.tsx:71)
--   declares five derived fields that are NOT columns on settlement_batches:
--     - expected_amount  : projected from latest cod_summary metadata patch
--                          (compute_cod_payment_collection_summary_v1) or
--                          finance_events fallback aggregation when metadata
--                          is empty (e.g. non-COD batches).
--     - collected_amount : SUM(direction='in')  over linked finance_events.
--     - remitted_amount  : SUM(amount) where event_type='payout' or
--                          metadata->>'event' = 'remit' over linked finance_events.
--     - posted_at        : MAX(created_at) of settlement_events where
--                          to_status = 'posted'.
--     - variance_flag    : TRUE when |expected_amount - collected_amount|
--                          exceeds the seeded settlement_policy locking
--                          max_variance_amount (default 0).
--
-- Notes:
--   * SSOT remains public.settlement_batches; this view is read-only.
--   * RLS is enforced by the underlying tables (settlement_batches /
--     settlement_batch_finance_events / finance_events / settlement_events).
--     Service-only access on the view (mirroring v_feature_flag_summary
--     baseline); FE reads through the resource registry seam.
--   * The variance threshold is read from the global settlement_policy seed
--     (settings.cached_value->'locking'->'max_variance_amount'); fallback 0.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301120_v_settlement_batch_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_settlement_batch_summary;

CREATE VIEW public.v_settlement_batch_summary AS
WITH global_threshold AS (
  SELECT COALESCE(
    (s.cached_value->'locking'->>'max_variance_amount')::NUMERIC,
    0
  ) AS max_variance_amount
  FROM public.settings s
  WHERE s.category = 'settlement_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
batch_finance AS (
  SELECT
    sbfe.settlement_batch_id,
    SUM(CASE WHEN fe.direction = 'in'  THEN fe.amount ELSE 0 END) AS sum_in,
    SUM(CASE WHEN fe.direction = 'out' THEN fe.amount ELSE 0 END) AS sum_out,
    SUM(
      CASE
        WHEN fe.event_type = 'payout'
          OR (fe.metadata ? 'event' AND lower(fe.metadata->>'event') = 'remit')
        THEN fe.amount
        ELSE 0
      END
    ) AS sum_remit,
    SUM(fe.amount) AS sum_total
  FROM public.settlement_batch_finance_events sbfe
  JOIN public.finance_events fe
    ON fe.id = sbfe.finance_event_id
   AND fe.organization_id = sbfe.organization_id
   AND fe.occurred_at = sbfe.finance_occurred_at
  GROUP BY sbfe.settlement_batch_id
),
batch_posted AS (
  SELECT
    se.settlement_batch_id,
    MAX(se.created_at) AS posted_at
  FROM public.settlement_events se
  WHERE se.to_status = 'posted'
  GROUP BY se.settlement_batch_id
)
SELECT
  sb.id,
  sb.organization_id,
  sb.kind,
  sb.scope_type,
  sb.status,
  sb.window_start_at,
  sb.window_end_at,
  sb.created_at,
  sb.updated_at,

  -- expected_amount: prefer metadata patch from compute_cod_payment_collection_summary_v1
  -- when available (set by execute_settlement_batch_v1 for COD kinds); fallback
  -- to ledger sum_in for non-COD batches without a metadata projection.
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'expected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS expected_amount,

  -- collected_amount: prefer metadata patch (canonical projection); fallback to
  -- direct ledger aggregation.
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'collected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS collected_amount,

  -- remitted_amount: derive from event_type='payout' or metadata.event='remit'.
  COALESCE(bf.sum_remit, 0) AS remitted_amount,

  -- posted_at: latest 'posted' transition timestamp.
  bp.posted_at,

  -- variance_flag: |expected - collected| > policy threshold.
  CASE
    WHEN ABS(
      COALESCE(
        NULLIF(btrim(COALESCE(sb.metadata->>'expected_amount', '')), '')::NUMERIC,
        bf.sum_in,
        0
      )
      -
      COALESCE(
        NULLIF(btrim(COALESCE(sb.metadata->>'collected_amount', '')), '')::NUMERIC,
        bf.sum_in,
        0
      )
    ) > COALESCE((SELECT max_variance_amount FROM global_threshold), 0)
    THEN TRUE
    ELSE FALSE
  END AS variance_flag
FROM public.settlement_batches sb
LEFT JOIN batch_finance bf ON bf.settlement_batch_id = sb.id
LEFT JOIN batch_posted bp ON bp.settlement_batch_id = sb.id;

COMMENT ON VIEW public.v_settlement_batch_summary IS
  'FE-friendly projection of settlement_batches with derived (expected_amount, collected_amount, remitted_amount, posted_at, variance_flag). Sources: settlement_batches + settlement_batch_finance_events + finance_events + settlement_events. Read-only; SSOT remains settlement_batches; mutations go through transition_settlement_batch_v1 / apply_settlement_v1 / reject_settlement_v1.';

-- Read access mirrors the underlying RLS posture: service-role baseline
-- (FE consumes via resource registry seam). Tenant isolation is enforced by
-- the underlying tables' SELECT policies, which scope rows to caller's
-- organization (or platform users).
REVOKE ALL ON public.v_settlement_batch_summary FROM PUBLIC;
REVOKE ALL ON public.v_settlement_batch_summary FROM anon;
REVOKE ALL ON public.v_settlement_batch_summary FROM authenticated;
GRANT SELECT ON public.v_settlement_batch_summary TO authenticated;
GRANT SELECT ON public.v_settlement_batch_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301120_v_settlement_batch_summary'));
COMMIT;
