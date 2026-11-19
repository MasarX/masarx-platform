-- Console V2 webhook tester dynamic sample and duplicate linkage repair.
--
-- The tester sample must remain backend-owned while still creating a unique
-- provider event per live operator run. Static sample IDs caused repeated test
-- sends to reuse an existing shipment, leaving the latest inbox event without a
-- direct shipment link in the directory. Keep the sample row tokenized and make
-- the inbox directory resolve affected shipments from provider-payload lineage
-- as well as first-create lineage.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605082215_console_v2_webhook_tester_dynamic_sample_linkage_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH definition AS (
  INSERT INTO public.lookup_definitions (
    category,
    owner_role,
    approval_policy,
    is_mutable,
    description
  )
  VALUES (
    'webhook_sample_payload',
    'engineering',
    'tier_1',
    FALSE,
    'Canonical sample webhook payloads for Console V2 webhook receiver testing.'
  )
  ON CONFLICT (category) DO UPDATE
     SET owner_role = EXCLUDED.owner_role,
         approval_policy = EXCLUDED.approval_policy,
         is_mutable = EXCLUDED.is_mutable,
         description = EXCLUDED.description,
         updated_at = now()
  RETURNING id
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  'shipment_created_default',
  'Shipment created - default',
  10,
  TRUE,
  'active',
  jsonb_build_object(
    'payload',
    jsonb_build_object(
      'event', jsonb_build_object(
        'id', '{{event_id}}',
        'type', 'shipment.created',
        'timestamp', '{{timestamp_iso}}'
      ),
      'shipment', jsonb_build_object(
        'external_id', '{{shipment_external_id}}',
        'reference_number', '{{shipment_reference_number}}',
        'service_type', 'standard',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'currency', 'SAR'
      ),
      'recipient', jsonb_build_object(
        'external_id', '{{recipient_external_id}}',
        'name', 'Noura Launch Customer',
        'phone', '+12025550181',
        'email', 'noura.launch@example.com'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'line2', 'Building 12',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country_code', 'SA',
        'lat', 24.7136,
        'lng', 46.6753
      )
    )
  )
FROM definition
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order,
       is_default = EXCLUDED.is_default,
       status = EXCLUDED.status,
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       retired_at = NULL,
       archived_at = NULL,
       updated_at = now();

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
  END AS mapping_rules_count
FROM public.webhook_inbox wi
LEFT JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.workflow_runs wr ON wr.id = wi.workflow_run_id
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
  'FE-friendly projection of webhook_inbox with source labels, mapping evidence, replay counters, workflow/idempotency readback, raw/transformed payloads, ack validation, and shipment linkage from source_webhook_id or provider-payload lineage. SSOT remains webhook_inbox plus webhook_sources/mapping_configs and shipment metadata lineage; mutations go through canonical RPCs.';

REVOKE ALL ON public.v_webhook_inbox_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_inbox_directory FROM anon;
GRANT SELECT ON public.v_webhook_inbox_directory TO authenticated;
GRANT SELECT ON public.v_webhook_inbox_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605082215_console_v2_webhook_tester_dynamic_sample_linkage_v1'));

COMMIT;
