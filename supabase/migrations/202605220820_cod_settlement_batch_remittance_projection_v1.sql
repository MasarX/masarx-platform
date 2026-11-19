-- Plan: First-tenant Console V2 production readiness
-- Step: Fresh shipment-to-ledger COD closeout readback
--
-- Workflow-driven COD settlement posts finance_events against the settlement
-- batch, then links those events to the batch membership table. The operator
-- COD reconciliation row must still reconcile the shipment-level remitted
-- amount from that canonical batch lineage without requiring a reload or a
-- duplicate shipment-subject finance event.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605220820_cod_settlement_batch_remittance_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.cod_entries
WITH (security_invoker = true) AS
WITH direct_remitted AS (
  SELECT
    fe.organization_id,
    fe.subject_id,
    SUM(
      CASE
        WHEN fe.event_type = 'deposit'
          OR (
            fe.event_type = 'cod_handover'
            AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
          )
          THEN fe.amount
        ELSE 0
      END
    ) AS remitted_amount
  FROM public.finance_events fe
  WHERE fe.subject_type = 'shipment'
    AND fe.event_type IN ('deposit', 'cod_handover')
  GROUP BY fe.organization_id, fe.subject_id
),
settlement_batch_remitted AS (
  SELECT
    fe.organization_id,
    (sb.metadata->>'shipment_id')::uuid AS subject_id,
    SUM(
      CASE
        WHEN fe.event_type = 'deposit'
          OR (
            fe.event_type = 'cod_handover'
            AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
          )
          THEN fe.amount
        ELSE 0
      END
    ) AS remitted_amount
  FROM public.finance_events fe
  JOIN public.settlement_batch_finance_events sbfe
    ON sbfe.organization_id = fe.organization_id
   AND sbfe.finance_event_id = fe.id
   AND sbfe.finance_occurred_at = fe.occurred_at
  JOIN public.settlement_batches sb
    ON sb.organization_id = sbfe.organization_id
   AND sb.id = sbfe.settlement_batch_id
  WHERE fe.subject_type = 'settlement_batch'
    AND fe.subject_id = sb.id
    AND fe.event_type IN ('deposit', 'cod_handover')
    AND COALESCE(sb.metadata->>'shipment_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  GROUP BY fe.organization_id, (sb.metadata->>'shipment_id')::uuid
),
remitted AS (
  SELECT
    combined.organization_id,
    combined.subject_id,
    SUM(combined.remitted_amount) AS remitted_amount
  FROM (
    SELECT organization_id, subject_id, remitted_amount
    FROM direct_remitted
    UNION ALL
    SELECT organization_id, subject_id, remitted_amount
    FROM settlement_batch_remitted
  ) combined
  GROUP BY combined.organization_id, combined.subject_id
),
adjustments AS (
  SELECT
    fe.organization_id,
    fe.subject_id,
    SUM(COALESCE(NULLIF(fe.metadata->>'adjustment_amount', '')::numeric, 0)) AS adjustment_amount
  FROM public.finance_events fe
  WHERE fe.subject_type = 'shipment'
    AND fe.event_type = 'adjustment'
    AND fe.metadata->>'adjustment_type' = 'cod_collected_amount'
  GROUP BY fe.organization_id, fe.subject_id
),
base AS (
  SELECT
    sa.id,
    sa.organization_id,
    sa.shipment_id,
    COALESCE(sa.payment_currency, s.cod_currency) AS currency,
    sa.timestamp AS collected_at,
    sa.created_at,
    s.tracking_number,
    s.branch_id,
    s.driver_user_id,
    COALESCE(sa.payment_expected_amount, s.cod_amount, 0) AS expected_amount,
    COALESCE(sa.payment_collected_amount, 0) + COALESCE(a.adjustment_amount, 0) AS collected_amount,
    COALESCE(r.remitted_amount, 0) AS remitted_amount,
    COALESCE(
      sa.payment_variance_amount,
      COALESCE(sa.payment_collected_amount, 0) - COALESCE(sa.payment_expected_amount, s.cod_amount, 0)
    ) + COALESCE(a.adjustment_amount, 0) AS discrepancy_amount,
    COALESCE(sa.payment_has_discrepancy, FALSE) AS payment_has_discrepancy
  FROM public.shipment_actions sa
  LEFT JOIN public.shipments s
    ON s.id = sa.shipment_id
  LEFT JOIN remitted r
    ON r.organization_id = sa.organization_id
   AND r.subject_id = sa.shipment_id
  LEFT JOIN adjustments a
    ON a.organization_id = sa.organization_id
   AND a.subject_id = sa.shipment_id
  WHERE sa.payment_expected_amount IS NOT NULL
     OR sa.payment_collected_amount IS NOT NULL
     OR sa.payment_collection_outcome IS NOT NULL
)
SELECT
  b.id,
  b.organization_id,
  'shipment'::TEXT AS subject_type,
  b.shipment_id AS subject_id,
  b.shipment_id,
  b.currency,
  b.collected_at,
  b.created_at,
  jsonb_strip_nulls(
    jsonb_build_object(
      'tracking', b.tracking_number,
      'expected', b.expected_amount,
      'collected', b.collected_amount,
      'remitted', b.remitted_amount,
      'status',
        CASE
          WHEN b.payment_has_discrepancy
               OR COALESCE(b.discrepancy_amount, 0) <> 0
            THEN 'shortfall'
          WHEN b.remitted_amount >= b.collected_amount
               AND b.collected_amount > 0
            THEN 'remitted'
          WHEN b.collected_amount > 0
            THEN 'collected'
          ELSE 'pending'
        END,
      'driver', NULL,
      'branch_id', b.branch_id,
      'driver_user_id', b.driver_user_id,
      'settlement_context_ready', b.branch_id IS NOT NULL AND b.driver_user_id IS NOT NULL,
      'discrepancy', b.discrepancy_amount
    )
  ) AS metadata
FROM base b;

REVOKE ALL ON public.cod_entries FROM PUBLIC;
REVOKE ALL ON public.cod_entries FROM anon;
GRANT SELECT ON public.cod_entries TO authenticated, service_role;

COMMENT ON VIEW public.cod_entries IS
  'Console V2 COD reconciliation projection over shipment_actions payment_collection plus direct and settlement-batch-linked finance_events remittance, signed collected-amount adjustments, and shipment settlement-start context.';

CREATE OR REPLACE FUNCTION public.compute_cod_payment_collection_summary_v1(
  p_organization_id UUID,
  p_branch_id UUID DEFAULT NULL,
  p_subject_type TEXT DEFAULT NULL,
  p_subject_id UUID DEFAULT NULL,
  p_window_start_at TIMESTAMPTZ DEFAULT NULL,
  p_window_end_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  WITH candidate_actions AS (
    SELECT
      rs.id AS route_stop_id,
      rr.id AS route_run_id,
      rr.driver_user_id,
      rr.branch_id,
      sa.shipment_id,
      sa.payment_expected_amount AS expected_amount,
      sa.payment_collected_amount AS collected_amount,
      sa.payment_variance_amount AS variance_amount,
      sa.payment_collection_outcome AS outcome,
      sa.payment_has_discrepancy AS has_discrepancy,
      sa.payment_discrepancy_kind AS discrepancy_kind,
      sa.payment_currency AS currency,
      COALESCE(sa.timestamp, sa.created_at) AS payment_recorded_at,
      row_number() OVER (
        PARTITION BY rs.id
        ORDER BY COALESCE(sa.timestamp, sa.created_at) DESC, sa.created_at DESC, sa.id DESC
      ) AS rn
    FROM public.shipment_actions sa
    JOIN public.route_stops rs
      ON rs.id = COALESCE(
        NULLIF(sa.action_data->>'route_stop_id', '')::uuid,
        NULLIF(sa.action_data #>> '{delivery_completion,route_stop_id}', '')::uuid
      )
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
    WHERE sa.organization_id = p_organization_id
      AND sa.payment_collection_outcome IS NOT NULL
      AND (p_branch_id IS NULL OR rr.branch_id = p_branch_id)
      AND (
        p_subject_type IS NULL
        OR p_subject_id IS NULL
        OR (
          lower(COALESCE(p_subject_type, '')) IN ('driver', 'user')
          AND rr.driver_user_id = p_subject_id
        )
        OR (
          lower(COALESCE(p_subject_type, '')) = 'branch'
          AND rr.branch_id = p_subject_id
        )
      )
      AND (p_window_start_at IS NULL OR COALESCE(sa.timestamp, sa.created_at) >= p_window_start_at)
      AND (p_window_end_at IS NULL OR COALESCE(sa.timestamp, sa.created_at) <= p_window_end_at)
  ),
  latest_actions AS (
    SELECT *
    FROM candidate_actions
    WHERE rn = 1
  ),
  direct_remitted_by_shipment AS (
    SELECT
      fe.organization_id,
      fe.subject_id AS shipment_id,
      SUM(
        CASE
          WHEN fe.event_type = 'deposit'
            OR (
              fe.event_type = 'cod_handover'
              AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
            )
            THEN fe.amount
          ELSE 0
        END
      ) AS remitted_amount
    FROM public.finance_events fe
    WHERE fe.subject_type = 'shipment'
      AND fe.organization_id = p_organization_id
      AND fe.event_type IN ('deposit', 'cod_handover')
    GROUP BY fe.organization_id, fe.subject_id
  ),
  settlement_batch_remitted_by_shipment AS (
    SELECT
      fe.organization_id,
      (sb.metadata->>'shipment_id')::uuid AS shipment_id,
      SUM(
        CASE
          WHEN fe.event_type = 'deposit'
            OR (
              fe.event_type = 'cod_handover'
              AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
            )
            THEN fe.amount
          ELSE 0
        END
      ) AS remitted_amount
    FROM public.finance_events fe
    JOIN public.settlement_batch_finance_events sbfe
      ON sbfe.organization_id = fe.organization_id
     AND sbfe.finance_event_id = fe.id
     AND sbfe.finance_occurred_at = fe.occurred_at
    JOIN public.settlement_batches sb
      ON sb.organization_id = sbfe.organization_id
     AND sb.id = sbfe.settlement_batch_id
    WHERE fe.subject_type = 'settlement_batch'
      AND fe.subject_id = sb.id
      AND fe.organization_id = p_organization_id
      AND fe.event_type IN ('deposit', 'cod_handover')
      AND COALESCE(sb.metadata->>'shipment_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    GROUP BY fe.organization_id, (sb.metadata->>'shipment_id')::uuid
  ),
  remitted_by_shipment AS (
    SELECT
      combined.organization_id,
      combined.shipment_id,
      SUM(combined.remitted_amount) AS remitted_amount
    FROM (
      SELECT organization_id, shipment_id, remitted_amount
      FROM direct_remitted_by_shipment
      UNION ALL
      SELECT organization_id, shipment_id, remitted_amount
      FROM settlement_batch_remitted_by_shipment
    ) combined
    GROUP BY combined.organization_id, combined.shipment_id
  ),
  adjustments_by_shipment AS (
    SELECT
      fe.organization_id,
      fe.subject_id AS shipment_id,
      SUM(COALESCE(NULLIF(fe.metadata->>'adjustment_amount', '')::numeric, 0)) AS adjustment_amount
    FROM public.finance_events fe
    WHERE fe.subject_type = 'shipment'
      AND fe.organization_id = p_organization_id
      AND fe.event_type = 'adjustment'
      AND fe.metadata->>'adjustment_type' = 'cod_collected_amount'
    GROUP BY fe.organization_id, fe.subject_id
  )
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'stop_count', COUNT(*)::int,
      'matched_stop_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS FALSE
          AND COALESCE(outcome, '') <> 'refused'
          AND COALESCE(variance_amount, 0) + COALESCE(a.adjustment_amount, 0) = 0
      )::int,
      'discrepancy_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS TRUE
           OR COALESCE(outcome, '') = 'refused'
           OR COALESCE(variance_amount, 0) + COALESCE(a.adjustment_amount, 0) <> 0
      )::int,
      'refused_count', COUNT(*) FILTER (WHERE COALESCE(outcome, '') = 'refused')::int,
      'expected_amount', COALESCE(SUM(la.expected_amount), 0),
      'collected_amount', COALESCE(SUM(COALESCE(la.collected_amount, 0) + COALESCE(a.adjustment_amount, 0)), 0),
      'remitted_amount', COALESCE(SUM(COALESCE(r.remitted_amount, 0)), 0),
      'variance_amount', COALESCE(SUM(COALESCE(la.variance_amount, 0) + COALESCE(a.adjustment_amount, 0)), 0),
      'outstanding_amount', COALESCE(SUM(GREATEST(COALESCE(la.expected_amount, 0) - (COALESCE(la.collected_amount, 0) + COALESCE(a.adjustment_amount, 0)), 0)), 0),
      'currency', NULLIF(MAX(la.currency), ''),
      'latest_recorded_at', MAX(la.payment_recorded_at)
    )
  )
  FROM latest_actions la
  LEFT JOIN remitted_by_shipment r
    ON r.organization_id = p_organization_id
   AND r.shipment_id = la.shipment_id
  LEFT JOIN adjustments_by_shipment a
    ON a.organization_id = p_organization_id
   AND a.shipment_id = la.shipment_id;
$function$;

COMMENT ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  IS 'Summarize latest canonical COD payment_collection truth by visible route stop, including direct and settlement-batch-linked remitted_amount plus signed collected-amount adjustments.';

REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- Calculate the flag without exposing the underlying policy to callers.
CREATE FUNCTION public.settlement_summary_variance_flag_v1(
  p_organization_id uuid,
  p_batch_id uuid,
  p_variance numeric
)
RETURNS boolean
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $variance$
  SELECT p_variance > COALESCE((
    SELECT (s.cached_value#>>'{locking,max_variance_amount}')::numeric
    FROM public.settings s
    WHERE s.category = 'settlement_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
  ), 0)
  WHERE public.request_role_is_service_v1()
     OR (session_user = 'postgres' AND current_setting('role', true) = 'postgres' AND auth.uid() IS NULL)
     OR EXISTS (
       SELECT 1
       FROM public.settlement_batches sb
       WHERE sb.organization_id = p_organization_id AND sb.id = p_batch_id
         AND public.can_read_settlement_batch_v1(sb.organization_id, sb.id)
     );
$variance$;

REVOKE ALL ON FUNCTION public.settlement_summary_variance_flag_v1(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_summary_variance_flag_v1(uuid, uuid, numeric) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_settlement_batch_summary
WITH (security_invoker = true) AS
WITH batch_finance AS (
  SELECT
    sbfe.settlement_batch_id,
    SUM(CASE WHEN fe.direction = 'in'  THEN fe.amount ELSE 0 END) AS sum_in,
    SUM(CASE WHEN fe.direction = 'out' THEN fe.amount ELSE 0 END) AS sum_out,
    SUM(
      CASE
        WHEN fe.event_type = 'payout'
          OR (fe.metadata ? 'event' AND lower(fe.metadata->>'event') = 'remit')
          OR (
            fe.event_type = 'cod_handover'
            AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
          )
        THEN fe.amount
        ELSE 0
      END
    ) AS sum_remit,
    COUNT(*) AS event_count,
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
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'expected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS expected_amount,
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'collected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS collected_amount,
  CASE
    WHEN COALESCE(bf.event_count, 0) > 0 THEN COALESCE(bf.sum_remit, 0)
    ELSE COALESCE(
      NULLIF(btrim(COALESCE(sb.metadata #>> '{payment_collection_summary,remitted_amount}', '')), '')::NUMERIC,
      NULLIF(btrim(COALESCE(sb.metadata->>'remitted_amount', '')), '')::NUMERIC,
      0
    )
  END AS remitted_amount,
  bp.posted_at,
  COALESCE(public.settlement_summary_variance_flag_v1(
    sb.organization_id,
    sb.id,
    ABS(
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
    )
  ), FALSE) AS variance_flag,
  sb.branch_id,
  sb.client_id,
  sb.sender_id,
  sb.subject_type,
  sb.subject_id,
  COALESCE(
    NULLIF(sb.metadata->>'partner_id', ''),
    CASE WHEN sb.subject_type = 'partner' THEN sb.subject_id::text ELSE NULL END
  ) AS partner_id,
  COALESCE(NULLIF(sb.metadata->>'participant_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS participant_id,
  COALESCE(NULLIF(sb.metadata->>'supplier_participant_profile_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS supplier_participant_profile_id
FROM public.settlement_batches sb
LEFT JOIN batch_finance bf ON bf.settlement_batch_id = sb.id
LEFT JOIN batch_posted bp ON bp.settlement_batch_id = sb.id;

COMMENT ON VIEW public.v_settlement_batch_summary IS
  'FE-friendly projection of settlement_batches with derived settlement totals. Remitted amount prefers linked finance-event truth when membership exists, including COD handover received-side events, and falls back to metadata snapshots only for batches without ledger membership.';

REVOKE ALL ON public.v_settlement_batch_summary FROM PUBLIC;
REVOKE ALL ON public.v_settlement_batch_summary FROM anon;
GRANT SELECT ON public.v_settlement_batch_summary TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605220820_cod_settlement_batch_remittance_projection_v1'));

COMMIT;
