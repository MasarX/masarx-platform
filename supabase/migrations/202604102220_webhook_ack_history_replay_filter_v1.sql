-- Plan: PLAN-202604-b06-closeout / Step: Keep replay audits out of webhook_ack_history compatibility rows

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102220_webhook_ack_history_replay_filter_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.webhook_ack_history AS
SELECT
  dl.resource_id AS webhook_inbox_id,
  dl.organization_id,
  wi.webhook_source_id,
  COALESCE(dl.decision_inputs->>'mode', 'accepted_async') AS ack_mode,
  NULLIF(dl.decision_inputs->>'status', '')::integer AS ack_status_code,
  COALESCE(dl.decision_inputs->'headers', '{}'::jsonb) AS ack_headers,
  dl.decision_inputs->'body' AS ack_body,
  CASE
    WHEN dl.decision_outcome = 'response_failed' THEN 'ack_failed'
    ELSE 'ack_sent'
  END AS ack_outcome,
  dl.decision_reason AS ack_reason,
  COALESCE(dl.decision_inputs->'validation_results', '{}'::jsonb) AS validation_results,
  NULL::uuid AS policy_settings_id,
  NULL::text AS policy_scope_type,
  NULL::uuid AS policy_scope_id,
  NULL::integer AS policy_version,
  NULLIF(dl.decision_inputs->>'idempotency_key', '') AS idempotency_key,
  dl.decision_inputs->>'workflow_run_id' AS workflow_run_ref,
  dl."timestamp" AS ack_sent_at
FROM public.decision_log dl
JOIN public.webhook_inbox wi
  ON wi.id = dl.resource_id
WHERE dl.resource_type = 'webhook_inbox'
  AND dl.decision_category = 'http_response_emitted'
  AND dl.decision_outcome IS DISTINCT FROM 'response_replayed';

COMMENT ON VIEW public.webhook_ack_history
  IS 'Compatibility view exposing emitted webhook HTTP responses as ack history rows. Replay audits stay in decision_log and do not duplicate emitted acknowledgement lineage.';

SELECT pg_advisory_unlock(hashtext('202604102220_webhook_ack_history_replay_filter_v1'));

COMMIT;
