BEGIN;

SELECT pg_advisory_lock(hashtext('202605131231_console_v2_webhook_directory_response_outcome_v1'));

CREATE OR REPLACE VIEW public.webhook_response_latest AS
SELECT
    e.decision_log_id,
    e.webhook_inbox_id,
    e.organization_id,
    e.response_outcome,
    e.response_reason,
    e.response_mode,
    e.http_status_code,
    e.http_headers,
    e.http_body,
    e.validation_results,
    e.idempotency_key,
    e.workflow_run_id,
    e.workflow_run_step_id,
    e.followup_workflow_run_id,
    e.response_created_at
FROM (
    SELECT
        we.*,
        ROW_NUMBER() OVER (
            PARTITION BY we.webhook_inbox_id
            ORDER BY
              we.response_created_at DESC,
              (we.response_outcome = 'response_replayed') DESC,
              we.decision_log_id DESC
        ) AS row_rank
    FROM public.webhook_response_events we
) e
WHERE e.row_rank = 1;

COMMENT ON VIEW public.webhook_response_latest
    IS 'Latest webhook HTTP response per inbox row (decision_log projection), with deterministic replay precedence when duplicate response events share a transaction timestamp.';

CREATE OR REPLACE VIEW public.v_webhook_inbox_directory
  WITH (security_invoker = true)
  AS
SELECT
  wi.id,
  wi.organization_id,
  wi.webhook_source_id,
  wi.provider_type,
  wi.external_id,
  wi.event_type,
  wi.processing_status,
  wi.correlation_id,
  wi.idempotency_key,
  wi.workflow_run_id,
  wi.lease_expires_at,
  wi.created_at,
  wi.processed_at,
  wi.error_message,
  wi.raw_payload,
  wi.transformed_payload,
  wi.ack_mode,
  wi.ack_status_code,
  wi.ack_outcome,
  wi.ack_reason,
  wi.ack_body,
  wi.ack_validation,
  wr.workflow_status AS workflow_run_status,
  COALESCE(wi.ack_validation#>>'{intent,canonical}', wi.event_type) AS canonical_intent,
  shp.id AS shipment_id,
  shp.tracking_number,
  shp.status AS shipment_status,
  length(wi.raw_payload::text) AS payload_size,
  ws.name              AS source_label,
  ws.source_identifier AS source_identifier,
  ws.provider_type     AS provider_type_label,
  COALESCE(replay_agg.replay_count, 0) AS replay_count,
  COALESCE(replay_agg.force_status_count, 0) AS force_status_count,
  replay_agg.last_replay_at,
  replay_agg.last_replay_action,
  replay_agg.last_replay_actor,
  (wi.processing_status IN ('succeeded', 'failed', 'dead_letter', 'processed')) AS is_terminal,
  (wi.processing_status IN ('pending', 'processing', 'failed', 'dead_letter', 'in_progress')) AS is_actionable,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - wi.created_at)))::BIGINT AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - wi.created_at)) / 3600.0))::BIGINT AS age_hours,
  ws.mapping_config_id,
  mc.mapping_key AS mapping_label,
  mc.mapping_config->>'target' AS mapping_target,
  mc.mapping_version AS mapping_version,
  CASE
    WHEN jsonb_typeof(mc.mapping_config->'rules') = 'array'
      THEN jsonb_array_length(mc.mapping_config->'rules')
    ELSE 0
  END AS mapping_rules_count,
  response_latest.response_outcome,
  response_latest.response_reason,
  response_latest.response_mode,
  response_latest.http_status_code AS response_status_code
FROM public.webhook_inbox wi
LEFT JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.workflow_runs wr ON wr.id = wi.workflow_run_id
LEFT JOIN public.webhook_response_latest response_latest ON response_latest.webhook_inbox_id = wi.id
LEFT JOIN LATERAL (
  SELECT s.id, s.tracking_number, s.status
    FROM public.shipments s
   WHERE s.organization_id = wi.organization_id
     AND (
       s.metadata->>'source_webhook_id' = wi.id::text
       OR s.metadata#>>'{provider_payload,webhook_id}' = wi.id::text
       OR (wi.workflow_run_id IS NOT NULL AND s.metadata->>'workflow_run_id' = wi.workflow_run_id::text)
       OR (wi.workflow_run_id IS NOT NULL AND s.metadata#>>'{provider_payload,workflow_run_id}' = wi.workflow_run_id::text)
     )
   ORDER BY
     (s.metadata->>'source_webhook_id' = wi.id::text) DESC,
     (s.metadata#>>'{provider_payload,webhook_id}' = wi.id::text) DESC,
     s.created_at DESC
   LIMIT 1
) shp ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE wir.action = 'replay') AS replay_count,
    COUNT(*) FILTER (WHERE wir.action = 'force_status') AS force_status_count,
    MAX(wir.created_at) AS last_replay_at,
    (
      SELECT wir2.action
        FROM public.webhook_inbox_replays wir2
       WHERE wir2.webhook_inbox_id = wi.id
       ORDER BY wir2.created_at DESC
       LIMIT 1
    ) AS last_replay_action,
    (
      SELECT u.full_name
        FROM public.webhook_inbox_replays wir3
        LEFT JOIN public.users u ON u.id = wir3.changed_by
       WHERE wir3.webhook_inbox_id = wi.id
       ORDER BY wir3.created_at DESC
       LIMIT 1
    ) AS last_replay_actor
    FROM public.webhook_inbox_replays wir
   WHERE wir.webhook_inbox_id = wi.id
) replay_agg ON TRUE;

COMMENT ON VIEW public.v_webhook_inbox_directory IS
  'FE-friendly projection of webhook_inbox with source labels, mapping evidence, replay counters, workflow/idempotency readback, HTTP response outcome readback from webhook_response_latest, raw/transformed payloads, ack validation, and shipment linkage from source_webhook_id or provider-payload lineage. SSOT remains webhook_inbox plus webhook_sources/mapping_configs, webhook_response_latest, and shipment metadata lineage; mutations go through canonical RPCs.';

REVOKE ALL ON public.v_webhook_inbox_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_inbox_directory FROM anon;
GRANT SELECT ON public.v_webhook_inbox_directory TO authenticated;
GRANT SELECT ON public.v_webhook_inbox_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605131231_console_v2_webhook_directory_response_outcome_v1'));

COMMIT;
