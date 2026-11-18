-- Console V2 webhook source remediation must support operator-created
-- webhook-inbound mappings, not only plugin-backed mappings. The source write
-- path still fails closed unless the mapping is enabled, shipment-create
-- targeted, sender/client bound by ui_upsert_webhook_source_v1, and backed by a
-- source-scoped webhook_ingest_policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605141130_console_v2_webhook_source_operator_mapping_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ensure_webhook_source_plugin_binding_v1(
  p_webhook_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source public.webhook_sources%ROWTYPE;
  v_mapping public.mapping_configs%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_candidate_version_id UUID;
  v_mapping_key_version TEXT;
  v_binding_id UUID;
  v_repair JSONB := '{}'::jsonb;
  v_template_id UUID;
  v_existing_policy JSONB := '{}'::jsonb;
  v_validation JSONB;
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

  IF COALESCE(v_source.enabled, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'webhook_source_disabled');
  END IF;

  IF v_source.mapping_config_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'missing_mapping_config_id');
  END IF;

  SELECT * INTO v_mapping
    FROM public.mapping_configs
   WHERE id = v_source.mapping_config_id
   LIMIT 1;

  IF v_mapping.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'mapping_config_not_found');
  END IF;

  IF lower(COALESCE(v_mapping.mapping_config->>'target', '')) NOT IN ('shipment.create', 'shipments.create') THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_shipment_create_mapping',
      'mapping_config_id', v_mapping.id
    );
  END IF;

  IF COALESCE(v_source.managed_metadata->>'plugin_version_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_candidate_version_id := (v_source.managed_metadata->>'plugin_version_id')::UUID;
  ELSIF COALESCE(v_mapping.managed_metadata->>'plugin_version_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_candidate_version_id := (v_mapping.managed_metadata->>'plugin_version_id')::UUID;
  ELSE
    v_mapping_key_version := split_part(COALESCE(v_mapping.mapping_key, ''), ':', 2);
    IF v_mapping.mapping_key LIKE 'integration_plugin:%'
       AND v_mapping_key_version ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_candidate_version_id := v_mapping_key_version::UUID;
    END IF;
  END IF;

  IF v_candidate_version_id IS NOT NULL THEN
    SELECT * INTO v_version
      FROM public.integration_plugin_versions
     WHERE id = v_candidate_version_id
       AND organization_id = v_source.organization_id
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    SELECT ipv.*
      INTO v_version
      FROM public.integration_plugin_versions ipv
      JOIN public.integration_plugins ip ON ip.id = ipv.plugin_id
     WHERE ipv.organization_id = v_source.organization_id
       AND ipv.status IN ('active', 'approved')
       AND lower(COALESCE(ip.plugin_kind, '')) = 'webhook'
       AND lower(COALESCE(
             NULLIF(ipv.workflow_binding->>'intent', ''),
             NULLIF(ipv.mapping_config->>'target', ''),
             NULLIF(ipv.mapping_config#>>'{metadata,target}', '')
           )) IN ('shipment.create', 'shipments.create')
       AND ipv.mapping_config = v_mapping.mapping_config
     ORDER BY (ipv.status = 'active') DESC,
              ipv.activated_at DESC NULLS LAST,
              ipv.updated_at DESC,
              ipv.version_no DESC
     LIMIT 1;
  END IF;

  IF v_version.id IS NULL THEN
    IF v_mapping.mapping_type = 'webhook_inbound'
       AND COALESCE(v_mapping.mapping_config->>'target', '') IN ('shipment.create', 'shipments.create')
       AND COALESCE((v_mapping.mapping_config->>'enabled')::boolean, TRUE) IS TRUE THEN
      v_template_id := public.resolve_active_workflow_template_ref_v1('webhook_shipment_create_v1');

      IF v_template_id IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'workflow_template_not_found');
      END IF;

      SELECT p.policy
        INTO v_existing_policy
        FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id) AS p
       LIMIT 1;

      v_validation := jsonb_build_object(
        'idempotency', jsonb_build_object(
          'header', 'Idempotency-Key',
          'body_path', 'event.id'
        )
      );

      IF jsonb_typeof(v_existing_policy#>'{validation,hmac}') = 'object' THEN
        v_validation := v_validation || jsonb_build_object('hmac', v_existing_policy#>'{validation,hmac}');
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
          'intent', 'shipment.create',
          'templates_by_intent', jsonb_build_object(
            'shipment.create',
            jsonb_build_object('template_id', v_template_id::text)
          ),
          'notes', format(
            'mapping_config_id=%s mapping_key=%s target=%s',
            v_mapping.id,
            v_mapping.mapping_key,
            v_mapping.mapping_config->>'target'
          )
        ),
        'validation', v_validation
      );

      PERFORM public.upsert_webhook_ingest_policy('source', v_source.id, v_policy);

      UPDATE public.integration_plugin_bindings
         SET enabled = FALSE,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'disabled_by', 'console_webhook_source_operator_mapping_policy',
               'operator_mapping_config_id', v_mapping.id
             ),
             updated_at = now()
       WHERE runtime_resource_type = 'webhook_sources'
         AND runtime_resource_id = v_source.id
         AND enabled IS TRUE;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'webhook_source_id', v_source.id,
        'mapping_config_id', v_mapping.id,
        'policy_repair', jsonb_build_object(
          'ok', TRUE,
          'mode', 'operator_webhook_inbound_mapping',
          'canonical_intent', 'shipment.create',
          'workflow_template_id', v_template_id
        )
      );
    END IF;

    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_version_not_found');
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
     AND organization_id = v_source.organization_id
   LIMIT 1;

  IF v_plugin.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'plugin_not_found');
  END IF;

  INSERT INTO public.integration_plugin_bindings (
    plugin_version_id,
    organization_id,
    scope_type,
    scope_id,
    binding_type,
    runtime_resource_type,
    runtime_resource_id,
    enabled,
    activation_payload,
    metadata,
    created_by
  )
  VALUES (
    v_version.id,
    v_source.organization_id,
    'tenant',
    v_source.organization_id,
    'webhook_source',
    'webhook_sources',
    v_source.id,
    v_source.enabled,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_source.source_identifier,
      'mapping_config_id', v_source.mapping_config_id,
      'sender_id', v_source.sender_id
    )),
    jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'managed_by', 'console_webhook_source_upsert'
    ),
    auth.uid()
  )
  ON CONFLICT ON CONSTRAINT integration_plugin_bindings_unique_scope_resource
  DO UPDATE SET
    enabled = EXCLUDED.enabled,
    activation_payload = EXCLUDED.activation_payload,
    metadata = COALESCE(public.integration_plugin_bindings.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now()
  RETURNING id INTO v_binding_id;

  v_repair := public.repair_integration_plugin_webhook_policy_v1(v_source.id, v_version.id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'webhook_source_id', v_source.id,
    'mapping_config_id', v_mapping.id,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'binding_id', v_binding_id,
    'policy_repair', v_repair
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID)
  IS 'Ensures UI-created shipment webhook sources have a source-level webhook_ingest_policy. Plugin-backed mappings also get runtime bindings; enabled operator webhook_inbound mappings repair the source policy directly.';

SELECT pg_advisory_unlock(hashtext('202605141130_console_v2_webhook_source_operator_mapping_policy_v1'));

COMMIT;
