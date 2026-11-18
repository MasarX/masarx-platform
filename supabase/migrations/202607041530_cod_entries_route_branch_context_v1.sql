-- Plan: First-tenant Console V2 production readiness
-- Step: UC22 COD settlement context from canonical route branch lineage
--
-- Delivery-created COD rows may originate from route-stop closeout before a
-- shipment branch projection is populated. The route run remains the canonical
-- dispatch branch context for the delivered stop, so cod_entries must expose
-- that branch for settlement workflow start without frontend fallbacks.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607041530_cod_entries_route_branch_context_v1'));
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
action_route_keys AS (
  SELECT
    sa.id AS shipment_action_id,
    CASE
      WHEN COALESCE(
        NULLIF(sa.action_data->>'route_stop_id', ''),
        NULLIF(sa.action_data #>> '{delivery_completion,route_stop_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,route_stop_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,delivery_completion,route_stop_id}', '')
      ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN COALESCE(
        NULLIF(sa.action_data->>'route_stop_id', ''),
        NULLIF(sa.action_data #>> '{delivery_completion,route_stop_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,route_stop_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,delivery_completion,route_stop_id}', '')
      )::uuid
      ELSE NULL
    END AS route_stop_id,
    CASE
      WHEN COALESCE(
        NULLIF(sa.action_data->>'route_run_id', ''),
        NULLIF(sa.action_data #>> '{delivery_completion,route_run_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,route_run_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,delivery_completion,route_run_id}', '')
      ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN COALESCE(
        NULLIF(sa.action_data->>'route_run_id', ''),
        NULLIF(sa.action_data #>> '{delivery_completion,route_run_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,route_run_id}', ''),
        NULLIF(sa.action_data #>> '{task_event_payload,delivery_completion,route_run_id}', '')
      )::uuid
      ELSE NULL
    END AS route_run_id
  FROM public.shipment_actions sa
),
route_context AS (
  SELECT
    ark.shipment_action_id,
    rr.branch_id AS route_branch_id,
    rr.driver_user_id AS route_driver_user_id
  FROM action_route_keys ark
  LEFT JOIN public.route_stops rs
    ON rs.id = ark.route_stop_id
  LEFT JOIN public.route_runs rr
    ON rr.id = COALESCE(rs.route_run_id, ark.route_run_id)
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
    COALESCE(s.branch_id, rc.route_branch_id) AS branch_id,
    COALESCE(s.driver_user_id, rc.route_driver_user_id) AS driver_user_id,
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
  LEFT JOIN route_context rc
    ON rc.shipment_action_id = sa.id
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
  'Console V2 COD reconciliation projection over shipment_actions payment_collection plus direct and settlement-batch-linked finance_events remittance, signed collected-amount adjustments, and shipment/route-derived settlement-start context.';

SELECT pg_advisory_unlock(hashtext('202607041530_cod_entries_route_branch_context_v1'));

COMMIT;
