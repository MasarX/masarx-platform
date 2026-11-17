-- Migration: CI Observability Summary View
-- Purpose: Provide a single-row view the CI script can query for engine/observability summary.
-- Date: 2025-11-23

BEGIN;

SET search_path TO public;

CREATE OR REPLACE VIEW ci_observability_summary_v AS
SELECT
  (SELECT COUNT(*)::INT FROM non_engine_outbound_calls_v) AS non_engine_outbound_count,
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('decision_category', decision_category, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT decision_category, COUNT(*)::INT AS cnt
      FROM decision_log
      WHERE timestamp > now() - interval '24 hours'
      GROUP BY decision_category
      ORDER BY cnt DESC
    ) s
  ) AS decision_counts,
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('response_outcome', response_outcome, 'cnt', cnt)), '[]'::jsonb)
    FROM (
      SELECT response_outcome, COUNT(*)::INT AS cnt
      FROM webhook_response_events
      WHERE response_created_at > now() - interval '24 hours'
      GROUP BY response_outcome
      ORDER BY cnt DESC
    ) s2
  ) AS webhook_responses;

COMMENT ON VIEW ci_observability_summary_v IS 'CI summary: non-engine outbound count + decision counts + webhook response outcomes (24h).';

GRANT SELECT ON ci_observability_summary_v TO authenticated, service_role;

COMMIT;

