BEGIN;
SELECT pg_advisory_lock(hashtext('202605181930_settlement_summary_cod_remitted_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_settlement_batch_summary
WITH (security_invoker = true) AS
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
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata #>> '{payment_collection_summary,remitted_amount}', '')), '')::NUMERIC,
    NULLIF(btrim(COALESCE(sb.metadata->>'remitted_amount', '')), '')::NUMERIC,
    bf.sum_remit,
    0
  ) AS remitted_amount,
  bp.posted_at,
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
  END AS variance_flag,
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
  'FE-friendly projection of settlement_batches with derived settlement totals. COD remitted_amount prefers canonical payment_collection_summary metadata written by settlement workflows before falling back to linked finance events.';

REVOKE ALL ON public.v_settlement_batch_summary FROM PUBLIC;
REVOKE ALL ON public.v_settlement_batch_summary FROM anon;
GRANT SELECT ON public.v_settlement_batch_summary TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605181930_settlement_summary_cod_remitted_metadata_v1'));
COMMIT;
