-- Console V2 webhook source plugin-binding repair.
--
-- UI-created webhook sources choose a real mapping profile and sender, but
-- they previously did not get the integration-plugin runtime binding that the
-- default onboarding source receives. Without that source-scoped policy,
-- webhook-receiver accepted the event but left the inbox in progress without a
-- materialized shipment. Keep source creation backend-backed by resolving the
-- selected mapping profile back to its active plugin version, creating the
-- binding, and repairing the source-level ingest policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605082030_console_v2_webhook_source_plugin_binding_repair_v1'));

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

DO $patch$
DECLARE
  v_def TEXT;
  v_updated BOOLEAN := FALSE;
BEGIN
  SELECT pg_get_functiondef('public.ui_upsert_webhook_source_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ui_upsert_webhook_source_v1(jsonb) is required before patching source policy repair';
  END IF;

  IF position('v_binding_repair JSONB' IN v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'  v_action TEXT;\nBEGIN',
      E'  v_action TEXT;\n  v_binding_repair JSONB := ''{}''::jsonb;\nBEGIN'
    );
    v_updated := TRUE;
  END IF;

  IF position('PERFORM public.ensure_webhook_source_plugin_binding_v1(v_resource_id);' IN v_def) > 0 THEN
    v_def := replace(
      v_def,
      E'  PERFORM public.ensure_webhook_source_plugin_binding_v1(v_resource_id);\n\n  INSERT INTO public.decision_log (',
      E'  v_binding_repair := public.ensure_webhook_source_plugin_binding_v1(v_resource_id);\n  IF COALESCE((v_binding_repair->>''ok'')::boolean, FALSE) IS DISTINCT FROM TRUE THEN\n    RAISE EXCEPTION ''ui_upsert_webhook_source_v1 could not bind source policy: %'', COALESCE(v_binding_repair->>''reason'', ''unknown'')\n      USING ERRCODE = ''P0001'';\n  END IF;\n\n  INSERT INTO public.decision_log ('
    );
    v_updated := TRUE;
  ELSIF position('ensure_webhook_source_plugin_binding_v1(v_resource_id)' IN v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'  END IF;\n\n  INSERT INTO public.decision_log (',
      E'  END IF;\n\n  v_binding_repair := public.ensure_webhook_source_plugin_binding_v1(v_resource_id);\n  IF COALESCE((v_binding_repair->>''ok'')::boolean, FALSE) IS DISTINCT FROM TRUE THEN\n    RAISE EXCEPTION ''ui_upsert_webhook_source_v1 could not bind source policy: %'', COALESCE(v_binding_repair->>''reason'', ''unknown'')\n      USING ERRCODE = ''P0001'';\n  END IF;\n\n  INSERT INTO public.decision_log ('
    );
    v_updated := TRUE;
  END IF;

  IF position('source_binding_repair' IN v_def) = 0 THEN
    v_def := replace(
      v_def,
      E'    ''settings_resolution_id'', v_decision_id\n  ));',
      E'    ''settings_resolution_id'', v_decision_id,\n    ''source_binding_repair'', v_binding_repair\n  ));'
    );
    v_updated := TRUE;
  END IF;

  IF position('ensure_webhook_source_plugin_binding_v1(v_resource_id)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'could not patch ui_upsert_webhook_source_v1 with source policy repair';
  END IF;

  IF v_updated THEN
    EXECUTE v_def;
  END IF;
END;
$patch$;

SELECT public.ensure_webhook_source_plugin_binding_v1(ws.id)
FROM public.webhook_sources ws
JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
WHERE ws.enabled
  AND lower(COALESCE(mc.mapping_config->>'target', '')) IN ('shipment.create', 'shipments.create');

REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID)
  IS 'Ensures UI-created shipment webhook sources have a plugin runtime binding and source-level webhook_ingest_policy so receiver POSTs can materialize shipments through the workflow engine.';

SELECT pg_advisory_unlock(hashtext('202605082030_console_v2_webhook_source_plugin_binding_repair_v1'));

COMMIT;
