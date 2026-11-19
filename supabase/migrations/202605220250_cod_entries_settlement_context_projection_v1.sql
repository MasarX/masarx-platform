-- Plan: First-tenant Console V2 production readiness
-- Step: COD settlement start readiness projection
--
-- The Console COD settlement action requires shipment branch and driver
-- context. Project that context into cod_entries metadata so the operator sees
-- an upfront disabled action instead of discovering the missing context only
-- after a workflow-start attempt.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605220250_cod_entries_settlement_context_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.cod_entries
WITH (security_invoker = true) AS
WITH remitted AS (
  SELECT
    fe.organization_id,
    fe.subject_id,
    SUM(fe.amount) FILTER (
      WHERE fe.event_type = 'deposit'
         OR (
              fe.event_type = 'cod_handover'
          AND COALESCE(NULLIF(fe.metadata->>'side', ''), 'to') = 'to'
            )
    ) AS remitted_amount
  FROM public.finance_events fe
  WHERE fe.subject_type = 'shipment'
  GROUP BY fe.organization_id, fe.subject_id
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
  'Console V2 COD reconciliation projection over shipment_actions payment_collection plus finance_events remittance, signed collected-amount adjustments, and shipment settlement-start context.';

SELECT pg_advisory_unlock(hashtext('202605220250_cod_entries_settlement_context_projection_v1'));

COMMIT;
