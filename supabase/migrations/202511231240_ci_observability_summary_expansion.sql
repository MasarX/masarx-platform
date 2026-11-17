-- Migration: Expand ci_observability_summary_v with failure reasons, per-system decisions, and 15m histogram
-- Date: 2025-11-23

BEGIN;

SET search_path TO public;

-- Helper to sort NULL outcomes last within JSON builder
CREATE OR REPLACE FUNCTION outcome_nulls_last(text) RETURNS text LANGUAGE sql AS $$
  SELECT $1
$$;

CREATE OR REPLACE VIEW ci_observability_summary_v AS
WITH
  last24 AS (
    SELECT now() - interval '24 hours' AS since
  ),
  resp AS (
    SELECT *
    FROM webhook_response_events wre
    WHERE wre.response_created_at > (SELECT since FROM last24)
  ),
  decs AS (
    SELECT *
    FROM decision_log dl
    WHERE dl.timestamp > (SELECT since FROM last24)
  ),
  buckets AS (
    SELECT generate_series(
             date_trunc('minute', now() - interval '24 hours'),
             date_trunc('minute', now()),
             interval '15 minutes'
           ) AS bucket_start
  ),
  hist AS (
    SELECT
      b.bucket_start,
      r.response_outcome,
      COUNT(*)::int AS cnt
    FROM buckets b
    LEFT JOIN resp r
      ON r.response_created_at >= b.bucket_start
     AND r.response_created_at <  b.bucket_start + interval '15 minutes'
    GROUP BY b.bucket_start, r.response_outcome
    ORDER BY b.bucket_start
  )
SELECT
  -- Engine compliance
  (SELECT COUNT(*)::int FROM non_engine_outbound_calls_v) AS non_engine_outbound_count,

  -- Decision counts (24h)
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('decision_category', decision_category, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT decision_category, COUNT(*)::int AS cnt
      FROM decs
      GROUP BY decision_category
      ORDER BY cnt DESC
    ) s
  ) AS decision_counts,

  -- Webhook response outcomes (24h)
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('response_outcome', response_outcome, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT response_outcome, COUNT(*)::int AS cnt
      FROM resp
      GROUP BY response_outcome
      ORDER BY cnt DESC
    ) s2
  ) AS webhook_responses,

  -- Top failure reasons for webhook responses (24h)
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('reason', response_reason, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT response_reason, COUNT(*)::int AS cnt
      FROM resp
      WHERE response_outcome = 'response_failed'
      GROUP BY response_reason
      ORDER BY cnt DESC
      LIMIT 20
    ) s3
  ) AS top_failed_reasons,

  -- Decisions by performed_by_system (24h)
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('system', performed_by_system, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT performed_by_system, COUNT(*)::int AS cnt
      FROM decs
      GROUP BY performed_by_system
      ORDER BY cnt DESC
    ) s4
  ) AS decisions_by_system_24h,

  -- 15-minute histogram of webhook responses over last 24h
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'bucket_start', bucket_start,
          'counts', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome', response_outcome, 'cnt', cnt) ORDER BY outcome_nulls_last(response_outcome)), '[]'::jsonb)
            FROM (
              SELECT h2.response_outcome, h2.cnt
              FROM hist h2
              WHERE h2.bucket_start = h.bucket_start
            ) sub
          )
        ) ORDER BY bucket_start
      ), '[]'::jsonb)
    FROM (SELECT DISTINCT bucket_start FROM hist) h
  ) AS webhook_responses_hist_15m;

COMMENT ON VIEW ci_observability_summary_v IS 'CI summary: engine compliance, decision counts, webhook outcomes, top failure reasons, per-system decisions, and 15m histogram (24h).';

GRANT SELECT ON ci_observability_summary_v TO authenticated, service_role;

COMMIT;
