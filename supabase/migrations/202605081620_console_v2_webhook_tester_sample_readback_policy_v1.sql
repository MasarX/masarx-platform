-- Console V2 webhook tester live-readiness repair.
--
-- This migration keeps the first-tenant webhook/API shipment-intake proof
-- backend-backed end to end:
--   * sample payloads are lookup rows, not frontend constants;
--   * webhook inbox directory exposes workflow/idempotency/shipment readback;
--   * default shipment webhook plugin policies enqueue the shipment-create
--     follow-up workflow instead of stopping at the ack/plugin wrapper.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081620_console_v2_webhook_tester_sample_readback_policy_v1'));
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

CREATE OR REPLACE FUNCTION public.repair_integration_plugin_webhook_policy_v1(
  p_webhook_source_id UUID,
  p_plugin_version_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source public.webhook_sources%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_target TEXT;
  v_intent TEXT;
  v_template_ref TEXT;
  v_template_id UUID;
  v_policy JSONB;
BEGIN
  IF p_webhook_source_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'missing_webhook_source_id');
  END IF;

  SELECT * INTO v_source
    FROM public.webhook_sources
   WHERE id = p_webhook_source_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'webhook_source_not_found');
  END IF;

  IF p_plugin_version_id IS NOT NULL THEN
    SELECT * INTO v_version
      FROM public.integration_plugin_versions
     WHERE id = p_plugin_version_id
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    SELECT v.*
      INTO v_version
      FROM public.integration_plugin_bindings b
      JOIN public.integration_plugin_versions v ON v.id = b.plugin_version_id
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = p_webhook_source_id
     ORDER BY b.enabled DESC, b.created_at DESC
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_version_not_found');
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;

  -- The default onboarding source keeps the general intake policy until an explicit shipment binding exists.
  IF v_plugin.plugin_key = 'default-shipment-webhook-intake'
     AND v_version.workflow_binding = '{"template_name":"webhook_intake_v1"}'::jsonb THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'general_onboarding_intake');
  END IF;

  v_target := lower(COALESCE(
    NULLIF(v_version.workflow_binding->>'intent', ''),
    NULLIF(v_version.mapping_config->>'target', ''),
    NULLIF(v_version.mapping_config#>>'{metadata,target}', '')
  ));

  v_intent := CASE
    WHEN v_target IN ('shipments.create', 'shipment.create') THEN 'shipment.create'
    ELSE NULL
  END;

  IF v_intent IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_shipment_create_plugin',
      'plugin_key', v_plugin.plugin_key
    );
  END IF;

  v_template_ref := COALESCE(
    NULLIF(v_version.workflow_binding->>'template_id', ''),
    NULLIF(v_version.workflow_binding->>'template_name', '')
  );

  IF v_template_ref IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 requires workflow_binding.template_name/template_id for %', v_version.id;
  END IF;

  v_template_id := public.resolve_active_workflow_template_ref_v1(v_template_ref);
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 could not resolve workflow template %', v_template_ref;
  END IF;

  v_policy := jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'accepted_async',
      'status_code', 202,
      'default_headers', jsonb_build_object('content-type', 'application/json')
    ),
    'workflow', jsonb_build_object(
      'template_id', v_template_id,
      'intent', v_intent,
      'templates_by_intent', jsonb_build_object(
        v_intent,
        jsonb_build_object('template_id', v_template_id::text)
      ),
      'notes', format(
        'plugin_id=%s plugin_version_id=%s target=%s',
        v_plugin.id,
        v_version.id,
        v_target
      )
    ),
    'validation', jsonb_build_object(
      'idempotency', jsonb_build_object(
        'header', 'Idempotency-Key',
        'body_path', 'event.id'
      )
    )
  );

  PERFORM public.upsert_webhook_ingest_policy('source', p_webhook_source_id, v_policy);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', p_webhook_source_id,
    'plugin_version_id', v_version.id,
    'canonical_intent', v_intent,
    'workflow_template_id', v_template_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_activate_v1(
  p_plugin_version_id UUID,
  p_scope_type TEXT DEFAULT 'tenant',
  p_scope_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_scope_type), ''), 'tenant'));
  v_scope_id UUID := p_scope_id;
  v_previous_active_version_id UUID;
  v_existing_scope_bindings INT := 0;
  v_activation_result JSONB;
  v_artifact_hash TEXT;
  v_workflow_template_name TEXT;
  v_source_id UUID;
  v_source_identifier TEXT;
  v_issued_token TEXT := NULL;
  v_route_id UUID;
  v_pack_id UUID;
  v_provider_id UUID;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires plugin_version_id';
  END IF;

  SELECT * INTO v_version
  FROM public.integration_plugin_versions
  WHERE id = p_plugin_version_id
  LIMIT 1;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 plugin version % not found', p_plugin_version_id;
  END IF;

  SELECT * INTO v_plugin
  FROM public.integration_plugins
  WHERE id = v_version.plugin_id
  LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 plugin % not found', v_version.plugin_id;
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_plugin.organization_id;
  END IF;

  IF NOT public.integration_plugin_scope_belongs_org_v1(v_scope_type, v_scope_id, v_plugin.organization_id) THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 invalid scope %/% for organization %', v_scope_type, v_scope_id, v_plugin.organization_id;
  END IF;

  IF v_version.status NOT IN ('approved', 'active') THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires approved|active status (current=%)', v_version.status;
  END IF;

  v_workflow_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(v_version.workflow_binding, '{}'::jsonb));
  IF v_workflow_template_name IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 requires valid workflow binding before activation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_templates wt
    WHERE wt.name = v_workflow_template_name
      AND wt.status = 'active'
  ) THEN
    RAISE EXCEPTION 'integration_plugin_activate_v1 workflow template % missing/inactive', v_workflow_template_name;
  END IF;

  v_previous_active_version_id := v_plugin.active_version_id;
  IF v_previous_active_version_id IS NOT NULL AND v_previous_active_version_id <> v_version.id THEN
    PERFORM public.integration_plugin_set_binding_runtime_enabled_v1(v_previous_active_version_id, FALSE, NULL, NULL);

    UPDATE public.integration_plugin_versions
    SET status = 'approved',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_previous_active_version_id
      AND status = 'active';
  END IF;

  SELECT count(*)
    INTO v_existing_scope_bindings
    FROM public.integration_plugin_bindings b
   WHERE b.plugin_version_id = v_version.id
     AND lower(b.scope_type) = v_scope_type
     AND b.scope_id IS NOT DISTINCT FROM v_scope_id;

  IF v_existing_scope_bindings > 0 THEN
    PERFORM public.integration_plugin_set_binding_runtime_enabled_v1(v_version.id, TRUE, v_scope_type, v_scope_id);

    SELECT b.runtime_resource_id
      INTO v_source_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'webhook_source'
       AND b.runtime_resource_type = 'webhook_sources'
     ORDER BY b.created_at DESC
     LIMIT 1;

    IF v_source_id IS NOT NULL THEN
      SELECT ws.source_identifier
        INTO v_source_identifier
        FROM public.webhook_sources ws
       WHERE ws.id = v_source_id
       LIMIT 1;

      PERFORM public.repair_integration_plugin_webhook_policy_v1(v_source_id, v_version.id);
    END IF;

    SELECT b.runtime_resource_id
      INTO v_route_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'api_route'
       AND b.runtime_resource_type = 'api_routes'
     ORDER BY b.created_at DESC
     LIMIT 1;

    IF v_route_id IS NOT NULL THEN
      SELECT r.pack_id
        INTO v_pack_id
        FROM public.api_routes r
       WHERE r.id = v_route_id
       LIMIT 1;
    END IF;

    SELECT b.runtime_resource_id
      INTO v_provider_id
      FROM public.integration_plugin_bindings b
     WHERE b.plugin_version_id = v_version.id
       AND lower(b.scope_type) = v_scope_type
       AND b.scope_id IS NOT DISTINCT FROM v_scope_id
       AND b.binding_type = 'provider'
       AND b.runtime_resource_type = 'providers'
     ORDER BY b.created_at DESC
     LIMIT 1;

    v_artifact_hash := COALESCE(
      v_version.artifact_hash,
      public.integration_plugin_hash_payload_v1(
        jsonb_build_object(
          'plugin_id', v_plugin.id,
          'plugin_version_id', v_version.id,
          'scope_type', v_scope_type,
          'scope_id', v_scope_id,
          'reactivated_existing_bindings', TRUE
        )
      )
    );

    UPDATE public.integration_plugin_versions
    SET status = 'active',
        activated_at = COALESCE(activated_at, now()),
        activated_by = COALESCE(activated_by, auth.uid()),
        artifact_hash = v_artifact_hash,
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_version.id;

    UPDATE public.integration_plugins
    SET status = 'active',
        active_version_id = v_version.id,
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_plugin.id;

    INSERT INTO public.integration_plugin_approval_events (
      plugin_version_id,
      organization_id,
      action,
      actor_user_id,
      reason,
      diff_hash,
      artifact_hash,
      payload
    )
    VALUES (
      v_version.id,
      v_plugin.organization_id,
      'activated',
      auth.uid(),
      NULLIF(btrim(COALESCE(p_reason, '')), ''),
      public.integration_plugin_hash_payload_v1(
        jsonb_build_object(
          'normalized_contract', v_version.normalized_contract,
          'inbound_config', v_version.inbound_config,
          'mapping_config', v_version.mapping_config,
          'workflow_binding', v_version.workflow_binding,
          'outbound_operations', v_version.outbound_operations
        )
      ),
      v_artifact_hash,
      jsonb_build_object(
        'scope_type', v_scope_type,
        'scope_id', v_scope_id,
        'reactivated_existing_bindings', TRUE,
        'webhook_source_id', v_source_id,
        'webhook_source_identifier', v_source_identifier,
        'api_route_id', v_route_id,
        'api_route_pack_id', v_pack_id,
        'provider_id', v_provider_id
      )
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'status', 'active',
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'reactivated_existing_bindings', TRUE,
      'webhook_source_id', v_source_id,
      'webhook_source_identifier', v_source_identifier,
      'issued_token', v_issued_token,
      'api_route_id', v_route_id,
      'api_route_pack_id', v_pack_id,
      'provider_id', v_provider_id,
      'artifact_hash', v_artifact_hash
    );
  END IF;

  IF v_version.status = 'active' THEN
    UPDATE public.integration_plugin_versions
    SET status = 'approved',
        updated_by = auth.uid(),
        updated_at = now()
    WHERE id = v_version.id;
  END IF;

  SELECT public.integration_plugin_activate_core_v1(
    p_plugin_version_id := v_version.id,
    p_scope_type := v_scope_type,
    p_scope_id := v_scope_id,
    p_reason := p_reason
  )
  INTO v_activation_result;

  v_source_id := NULLIF(v_activation_result->>'webhook_source_id', '')::UUID;
  IF v_source_id IS NOT NULL THEN
    PERFORM public.repair_integration_plugin_webhook_policy_v1(v_source_id, v_version.id);
  END IF;

  RETURN COALESCE(v_activation_result, '{}'::jsonb) || jsonb_build_object(
    'reactivated_existing_bindings', FALSE
  );
END;
$function$;

DROP VIEW IF EXISTS public.v_webhook_inbox_directory;

CREATE VIEW public.v_webhook_inbox_directory
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
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - wi.created_at)) / 3600.0))::BIGINT AS age_hours
FROM public.webhook_inbox wi
LEFT JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
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
  'FE-friendly projection of webhook_inbox with source labels, replay counters, workflow/idempotency readback, raw/transformed payloads, ack validation, shipment linkage, age/status derivations. SSOT remains webhook_inbox plus shipments metadata source_webhook_id; mutations go through canonical RPCs.';

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
      jsonb_build_object('key', 'external_id', 'column', 'external_id', 'op', 'ilike'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
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

    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 webhook inbox shipment readback filters',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

SELECT public.repair_integration_plugin_webhook_policy_v1(
  ws.id,
  v.id
)
FROM public.webhook_sources ws
JOIN public.integration_plugin_bindings b
  ON b.runtime_resource_type = 'webhook_sources'
 AND b.runtime_resource_id = ws.id
JOIN public.integration_plugin_versions v
  ON v.id = b.plugin_version_id
JOIN public.integration_plugins p
  ON p.id = v.plugin_id
WHERE p.plugin_key = 'default-shipment-webhook-intake'
  AND ws.managed_by = 'integration_plugin';

REVOKE ALL ON FUNCTION public.repair_integration_plugin_webhook_policy_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_integration_plugin_webhook_policy_v1(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.integration_plugin_activate_v1(UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605081620_console_v2_webhook_tester_sample_readback_policy_v1'));

COMMIT;
