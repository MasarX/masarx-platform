-- Console V2 webhook/API intake mapping evidence.
--
-- Operators must be able to see which mapping profile/source produced a
-- webhook-created shipment without reconstructing joins in the frontend.
-- Keep the webhook inbox directory as the read projection and append the
-- mapping columns at the end of the view shape.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081901_console_v2_webhook_intake_mapping_evidence_v1'));

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
       OR (wi.workflow_run_id IS NOT NULL AND s.metadata->>'workflow_run_id' = wi.workflow_run_id::text)
     )
   ORDER BY s.created_at DESC
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
  'FE-friendly projection of webhook_inbox with source labels, mapping evidence, replay counters, workflow/idempotency readback, raw/transformed payloads, ack validation, shipment linkage, age/status derivations. SSOT remains webhook_inbox plus webhook_sources/mapping_configs and shipments metadata source_webhook_id; mutations go through canonical RPCs.';

REVOKE ALL ON public.v_webhook_inbox_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_inbox_directory FROM anon;
GRANT SELECT ON public.v_webhook_inbox_directory TO authenticated;
GRANT SELECT ON public.v_webhook_inbox_directory TO service_role;

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'webhook_inbox_directory',
    'relation', 'public.v_webhook_inbox_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'processing_status', 'column', 'processing_status', 'op', 'eq'),
      jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq'),
      jsonb_build_object('key', 'webhook_source_id', 'column', 'webhook_source_id', 'op', 'eq'),
      jsonb_build_object('key', 'workflow_run_id', 'column', 'workflow_run_id', 'op', 'eq'),
      jsonb_build_object('key', 'idempotency_key', 'column', 'idempotency_key', 'op', 'eq'),
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_config_id', 'column', 'mapping_config_id', 'op', 'eq'),
      jsonb_build_object('key', 'external_id', 'column', 'external_id', 'op', 'ilike'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'created_at', 'label', 'When', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'source_label', 'label', 'Source', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'source_identifier', 'label', 'Source ID', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'mapping_label', 'label', 'Mapping', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'mapping_target', 'label', 'Target', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'event_type', 'label', 'Event', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'payload_size', 'label', 'Size', 'align', 'right', 'sortable', TRUE),
      jsonb_build_object('key', 'external_id', 'label', 'External ID', 'mono', TRUE),
      jsonb_build_object('key', 'processing_status', 'label', 'Status', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'shipment_id', 'label', 'Shipment', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'tracking_number', 'label', 'Tracking', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'is_terminal', 'label', 'Terminal', 'filterable', TRUE, 'sortable', TRUE),
      jsonb_build_object('key', 'is_actionable', 'label', 'Actionable', 'filterable', TRUE, 'sortable', TRUE),
      jsonb_build_object('key', 'replay_count', 'label', 'Replays', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'force_status_count', 'label', 'Force-status', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'last_replay_at', 'label', 'Last replay', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'last_replay_actor', 'label', 'Last actor', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'age_seconds', 'label', 'Age (s)', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number'),
      jsonb_build_object('key', 'age_hours', 'label', 'Age (h)', 'align', 'right', 'mono', TRUE, 'sortable', TRUE, 'type', 'number')
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_filtered := (
      SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
        FROM jsonb_array_elements(v_resources) AS resource
       WHERE resource->>'key' <> 'webhook_inbox_directory'
    );
    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions
       SET value = v_current
     WHERE id = v_scope.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current
     WHERE id = v_scope.settings_id;
  END LOOP;
END
$read_registry$;

SELECT pg_advisory_unlock(hashtext('202605081901_console_v2_webhook_intake_mapping_evidence_v1'));

COMMIT;
