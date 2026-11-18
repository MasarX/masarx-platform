-- Plan: First-tenant Console V2 production readiness
-- Step: COD cashier-count no-reload correctness
--
-- COD handover writes append paired ledger rows: one driver-side movement and
-- one company/cashier-side movement. The Console COD projection must count the
-- received side once, otherwise one cashier count doubles the visible remitted
-- amount and can mark incorrect variance state.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605150700_cod_entries_remitted_amount_pair_direction_v1'));
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
)
SELECT
  sa.id,
  sa.organization_id,
  'shipment'::TEXT AS subject_type,
  sa.shipment_id AS subject_id,
  sa.shipment_id,
  COALESCE(sa.payment_currency, s.cod_currency) AS currency,
  sa.timestamp AS collected_at,
  sa.created_at,
  jsonb_strip_nulls(
    jsonb_build_object(
      'tracking', s.tracking_number,
      'expected', COALESCE(sa.payment_expected_amount, s.cod_amount, 0),
      'collected', COALESCE(sa.payment_collected_amount, 0),
      'remitted', COALESCE(r.remitted_amount, 0),
      'status',
        CASE
          WHEN COALESCE(r.remitted_amount, 0) >= COALESCE(sa.payment_collected_amount, 0)
               AND COALESCE(sa.payment_collected_amount, 0) > 0
            THEN 'remitted'
          WHEN COALESCE(sa.payment_has_discrepancy, FALSE)
               OR COALESCE(sa.payment_variance_amount, 0) <> 0
            THEN 'shortfall'
          WHEN COALESCE(sa.payment_collected_amount, 0) > 0
            THEN 'collected'
          ELSE 'pending'
        END,
      'driver', NULL,
      'discrepancy',
        COALESCE(
          sa.payment_variance_amount,
          COALESCE(sa.payment_collected_amount, 0) - COALESCE(sa.payment_expected_amount, s.cod_amount, 0)
        )
    )
  ) AS metadata
FROM public.shipment_actions sa
LEFT JOIN public.shipments s
  ON s.id = sa.shipment_id
LEFT JOIN remitted r
  ON r.organization_id = sa.organization_id
 AND r.subject_id = sa.shipment_id
WHERE sa.payment_expected_amount IS NOT NULL
   OR sa.payment_collected_amount IS NOT NULL
   OR sa.payment_collection_outcome IS NOT NULL;

REVOKE ALL ON public.cod_entries FROM PUBLIC;
REVOKE ALL ON public.cod_entries FROM anon;
GRANT SELECT ON public.cod_entries TO authenticated, service_role;

COMMENT ON VIEW public.cod_entries IS
  'Console V2 COD reconciliation projection over shipment_actions payment_collection plus finance_events remittance. Paired cod_handover rows count only the company/cashier received side.';

SELECT pg_advisory_unlock(hashtext('202605150700_cod_entries_remitted_amount_pair_direction_v1'));

COMMIT;
