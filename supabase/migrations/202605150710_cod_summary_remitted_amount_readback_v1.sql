-- Plan: First-tenant Console V2 production readiness
-- Step: COD cashier-count no-reload KPI readback
--
-- Console V2 refreshes the COD summary KPI after cashier-count writes. The
-- canonical summary helper must therefore expose the same remitted amount that
-- the COD row projection reads from finance_events, otherwise the row updates
-- in place while the Remitted KPI remains stale at zero.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605150710_cod_summary_remitted_amount_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  remitted_by_shipment AS (
    SELECT
      fe.organization_id,
      fe.subject_id AS shipment_id,
      SUM(fe.amount) FILTER (
        WHERE fe.event_type = 'deposit'
           OR (
                fe.event_type = 'cod_handover'
            AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
              )
      ) AS remitted_amount
    FROM public.finance_events fe
    WHERE fe.subject_type = 'shipment'
      AND fe.organization_id = p_organization_id
      AND fe.event_type IN ('deposit', 'cod_handover')
    GROUP BY fe.organization_id, fe.subject_id
  )
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'stop_count', COUNT(*)::int,
      'matched_stop_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS FALSE
          AND COALESCE(outcome, '') <> 'refused'
      )::int,
      'discrepancy_count', COUNT(*) FILTER (
        WHERE COALESCE(has_discrepancy, FALSE) IS TRUE
           OR COALESCE(outcome, '') = 'refused'
      )::int,
      'refused_count', COUNT(*) FILTER (WHERE COALESCE(outcome, '') = 'refused')::int,
      'expected_amount', COALESCE(SUM(la.expected_amount), 0),
      'collected_amount', COALESCE(SUM(la.collected_amount), 0),
      'remitted_amount', COALESCE(SUM(COALESCE(r.remitted_amount, 0)), 0),
      'variance_amount', COALESCE(SUM(la.variance_amount), 0),
      'outstanding_amount', COALESCE(SUM(GREATEST(COALESCE(la.expected_amount, 0) - COALESCE(la.collected_amount, 0), 0)), 0),
      'currency', NULLIF(MAX(la.currency), ''),
      'latest_recorded_at', MAX(la.payment_recorded_at)
    )
  )
  FROM latest_actions la
  LEFT JOIN remitted_by_shipment r
    ON r.organization_id = p_organization_id
   AND r.shipment_id = la.shipment_id;
$function$;

COMMENT ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  IS 'Summarize latest canonical COD payment_collection truth by visible route stop for settlement closeout, including backend-readback remitted_amount from received COD handover finance events.';

REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.compute_cod_payment_collection_summary_v1(UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605150710_cod_summary_remitted_amount_readback_v1'));

COMMIT;
