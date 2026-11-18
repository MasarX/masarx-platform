-- Console V2 Plugin Studio webhook activation must produce a shipment-create
-- runtime source that is sender/client bound, policy-backed, and backed by the
-- same nested shipment mapping shape the receiver materializes.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605241215_plugin_studio_webhook_source_binding_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $policy$
DECLARE
  v_setting RECORD;
  v_source_binding_webhook JSONB := jsonb_build_object(
    'enabled', TRUE,
    'required_for_templates', jsonb_build_array('webhook_shipment_create_v1'),
    'required_for_intents', jsonb_build_array('shipment.create', 'shipment_create', 'shipments.create'),
    'resolution_order', jsonb_build_array(
      'scope_sender',
      'scope_client_default_sender',
      'scope_client_first_active_sender',
      'tenant_default_sender',
      'tenant_first_active_sender'
    ),
    'default_sender_name_source', 'saas_onboarding_policy.client_defaults.default_sender_name',
    'fallback_to_first_active_sender', TRUE
  );
  v_workflow_binding_webhook JSONB := jsonb_build_object(
    'mode', 'attach_existing',
    'template_name', 'webhook_shipment_create_v1',
    'intent', 'shipment.create'
  );
  v_value JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
  LOOP
    v_value := COALESCE(v_setting.cached_value, '{}'::jsonb)
      || jsonb_build_object('studio_defaults', COALESCE(v_setting.cached_value->'studio_defaults', '{}'::jsonb));

    v_value := jsonb_set(
      v_value,
      '{studio_defaults,source_binding,webhook}',
      COALESCE(v_setting.cached_value #> '{studio_defaults,source_binding,webhook}', '{}'::jsonb)
        || v_source_binding_webhook,
      TRUE
    );

    v_value := jsonb_set(
      v_value,
      '{studio_defaults,workflow_bindings,webhook}',
      COALESCE(v_setting.cached_value #> '{studio_defaults,workflow_bindings,webhook}', '{}'::jsonb)
        || v_workflow_binding_webhook,
      TRUE
    );

    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      v_setting.scope_type,
      v_setting.scope_id,
      v_value,
      1,
      'Console V2 Plugin Studio webhook source binding defaults'
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'integration_plugin_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'integration_plugin_policy',
      'global',
      NULL,
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'studio_defaults', jsonb_build_object(
          'source_binding', jsonb_build_object('webhook', v_source_binding_webhook),
          'workflow_bindings', jsonb_build_object('webhook', v_workflow_binding_webhook)
        )
      ),
      1,
      'Console V2 Plugin Studio webhook source binding defaults'
    );
  END IF;
END;
$policy$;

DO $mapping$
DECLARE
  v_mapping_patch JSONB := jsonb_build_object(
    'target', 'shipments.create',
    'enabled', TRUE,
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'tracking_number', jsonb_build_array('shipment.tracking_number', 'tracking_number', 'awb', 'waybill', 'barcode'),
        'external_id', jsonb_build_array('shipment.external_id', 'shipment.reference', 'external_id', 'id', 'reference'),
        'reference_number', jsonb_build_array('shipment.reference_number', 'shipment.reference', 'reference_number', 'reference'),
        'service_type', jsonb_build_array('shipment.service_type', 'service_type'),
        'service_level', jsonb_build_array('shipment.service_level', 'service_level'),
        'cod_amount', jsonb_build_array('shipment.cod_amount', 'cod_amount', 'cash_on_delivery_amount'),
        'currency', jsonb_build_array('shipment.cod_currency', 'currency')
      ),
      'recipient', jsonb_build_object(
        'external_id', jsonb_build_array('shipment.recipient.external_id', 'recipient.external_id', 'customer.external_id'),
        'name', jsonb_build_array('Example Entity ntvplorhukthpmnmvgrstqzp', 'recipient.name', 'customer.name', 'customer_name'),
        'phone', jsonb_build_array('shipment.recipient.phone', 'recipient.phone', 'customer.phone', 'phone', 'mobile'),
        'email', jsonb_build_array('shipment.recipient.email', 'recipient.email', 'customer.email', 'email')
      ),
      'address', jsonb_build_object(
        'line1', jsonb_build_array('shipment.destination.line1', 'destination.line1', 'address.line1', 'line1', 'address_line_1'),
        'line2', jsonb_build_array('shipment.destination.line2', 'destination.line2', 'address.line2', 'line2', 'address_line_2'),
        'district', jsonb_build_array('shipment.destination.district', 'destination.district', 'address.district', 'district'),
        'city', jsonb_build_array('shipment.destination.city', 'destination.city', 'address.city', 'city'),
        'province', jsonb_build_array('shipment.destination.province', 'destination.province', 'address.province', 'province', 'region'),
        'country_code', jsonb_build_array('shipment.destination.country', 'destination.country', 'address.country', 'country_code', 'country'),
        'lat', jsonb_build_array('shipment.destination.lat', 'destination.lat', 'address.lat', 'latitude', 'lat'),
        'lng', jsonb_build_array('shipment.destination.lng', 'destination.lng', 'address.lng', 'longitude', 'lng')
      )
    ),
    'metadata', jsonb_build_object(
      'canonical_intent', 'shipment.create',
      'mapping_profile', 'plugin_studio_webhook_shipment_create_v1'
    )
  );
BEGIN
  UPDATE public.integration_plugin_versions v
     SET workflow_binding = jsonb_set(
           jsonb_set(
             jsonb_set(
               COALESCE(v.workflow_binding, '{}'::jsonb),
               '{mode}',
               to_jsonb('attach_existing'::text),
               TRUE
             ),
             '{template_name}',
             to_jsonb('webhook_shipment_create_v1'::text),
             TRUE
           ),
           '{intent}',
           to_jsonb('shipment.create'::text),
           TRUE
         ),
         mapping_config = jsonb_set(
           public.jsonb_deep_merge(COALESCE(v.mapping_config, '{}'::jsonb), v_mapping_patch),
           '{transforms}',
           v_mapping_patch->'transforms',
           TRUE
         ),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
     AND (
       COALESCE(v.metadata->>'endpoint', '') = 'integration-plugin-studio'
       OR COALESCE(v.metadata->>'managed_by', '') = 'integration_plugin_studio_edge'
       OR COALESCE(v.mapping_config#>>'{metadata,mapping_profile}', '') = 'plugin_studio_webhook_shipment_create_v1'
     )
     AND (
       public.integration_plugin_resolve_template_name_v1(COALESCE(v.workflow_binding, '{}'::jsonb)) = 'webhook_shipment_create_v1'
       OR lower(COALESCE(v.workflow_binding->>'intent', v.mapping_config->>'target', '')) IN ('shipment.create', 'shipments.create', 'shipment_create')
       OR COALESCE(v.mapping_config#>>'{metadata,mapping_profile}', '') = 'plugin_studio_webhook_shipment_create_v1'
     );

  UPDATE public.mapping_configs mc
     SET mapping_config = jsonb_set(
           public.jsonb_deep_merge(COALESCE(mc.mapping_config, '{}'::jsonb), v_mapping_patch),
           '{transforms}',
           v_mapping_patch->'transforms',
           TRUE
         ),
         mapping_version = COALESCE(mc.mapping_version, 1) + 1,
         updated_at = now()
    FROM public.integration_plugin_versions v
    JOIN public.integration_plugins p
      ON p.id = v.plugin_id
   WHERE mc.mapping_type = 'webhook_inbound'
     AND mc.managed_by = 'integration_plugin'
     AND mc.managed_metadata->>'plugin_version_id' = v.id::text
     AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
     AND (
       COALESCE(v.metadata->>'endpoint', '') = 'integration-plugin-studio'
       OR COALESCE(v.metadata->>'managed_by', '') = 'integration_plugin_studio_edge'
       OR COALESCE(v.mapping_config#>>'{metadata,mapping_profile}', '') = 'plugin_studio_webhook_shipment_create_v1'
     )
     AND public.integration_plugin_resolve_template_name_v1(COALESCE(v.workflow_binding, '{}'::jsonb)) = 'webhook_shipment_create_v1'
     AND (
       COALESCE(mc.mapping_config->>'target', '') = ''
       OR COALESCE(mc.mapping_config#>>'{metadata,mapping_profile}', '') <> 'plugin_studio_webhook_shipment_create_v1'
       OR COALESCE(mc.mapping_config#>>'{transforms,shipment,tracking_number,0}', '') = ''
       OR jsonb_typeof(mc.mapping_config#>'{transforms,recipient,phone}') IS DISTINCT FROM 'array'
       OR COALESCE(mc.mapping_config#>>'{transforms,recipient,phone,0}', '') NOT IN ('shipment.recipient.phone', 'recipient.phone')
     );

  UPDATE public.integration_plugin_versions v
     SET mapping_config = jsonb_set(
           COALESCE(v.mapping_config, '{}'::jsonb),
           '{metadata,mapping_profile}',
           to_jsonb('shipment_webhook_intake_v1'::text),
           TRUE
         ),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
     AND p.plugin_key = 'default-shipment-webhook-intake'
     AND COALESCE(v.mapping_config#>>'{metadata,mapping_profile}', '') = 'plugin_studio_webhook_shipment_create_v1';
END;
$mapping$;

DO $activation_policy_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$    v_webhook_policy := jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_build_object(
        'template_id', v_workflow_template_id,
        'intent', 'integration_plugin',
        'notes', format('plugin_id=%s plugin_version_id=%s', v_plugin.id, v_version.id)
      )
    );
$from$;
  v_to TEXT := $to$    v_webhook_policy := jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object(
        'mode', 'accepted_async',
        'status_code', 202,
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'workflow', jsonb_strip_nulls(jsonb_build_object(
        'template_id', v_workflow_template_id,
        'template_name', v_workflow_template_name,
        'intent', COALESCE(NULLIF(btrim(v_version.workflow_binding->>'intent'), ''), 'integration_plugin'),
        'templates_by_intent',
          CASE
            WHEN NULLIF(btrim(v_version.workflow_binding->>'intent'), '') IS NULL THEN NULL
            ELSE jsonb_build_object(
              NULLIF(btrim(v_version.workflow_binding->>'intent'), ''),
              jsonb_build_object(
                'template_id', v_workflow_template_id::text,
                'template_name', v_workflow_template_name
              )
            )
          END,
        'notes', format('plugin_id=%s plugin_version_id=%s', v_plugin.id, v_version.id)
      ))
    );
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position($marker$'template_name', v_workflow_template_name$marker$ IN v_def) > 0
     AND position($marker$'templates_by_intent'$marker$ IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 webhook policy marker not found';
  END IF;

  EXECUTE replace(v_def, v_from, v_to);
END;
$activation_policy_patch$;

DO $resolver_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$  v_source_policy := COALESCE(v_policy #> ARRAY['studio_defaults', 'source_binding', lower(v_plugin.plugin_kind)], '{}'::jsonb);
$from$;
  v_to TEXT := $to$  IF v_required IS TRUE
     AND lower(COALESCE(v_plugin.plugin_kind, '')) = 'webhook'
     AND COALESCE(v_version.metadata->>'managed_by', '') <> 'integration_plugin_studio_edge'
     AND COALESCE(v_version.mapping_config#>>'{metadata,mapping_profile}', '') <> 'plugin_studio_webhook_shipment_create_v1'
  THEN
    v_required := FALSE;
  END IF;

  IF v_required IS FALSE THEN
    IF v_scope_type = 'sender' THEN
      RETURN v_scope_id;
    END IF;
    RETURN NULL;
  END IF;

  v_source_policy := COALESCE(v_policy #> ARRAY['studio_defaults', 'source_binding', lower(v_plugin.plugin_kind)], '{}'::jsonb);
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_resolve_activation_sender_v1(uuid,text,uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 definition not found';
  END IF;

  IF position('plugin_studio_webhook_shipment_create_v1' IN v_def) > 0
     AND position(E'v_required := FALSE;\n  END IF;\n\n  IF v_required IS FALSE' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_from IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 source policy marker not found';
  END IF;

  EXECUTE replace(v_def, v_from, v_to);
END;
$resolver_patch$;

DO $sample$
DECLARE
  v_definition_id UUID;
BEGIN
  SELECT id
    INTO v_definition_id
    FROM public.lookup_definitions
   WHERE category = 'webhook_sample_payload'
   LIMIT 1;

  IF v_definition_id IS NOT NULL THEN
    UPDATE public.lookup_values lv
       SET metadata = jsonb_set(
             COALESCE(lv.metadata, '{}'::jsonb),
             '{payload,shipment,tracking_number}',
             to_jsonb('{{tracking_number}}'::text),
             TRUE
           ),
           updated_at = now()
     WHERE lv.lookup_definition_id = v_definition_id
       AND lv.value = 'shipment_created_default'
       AND COALESCE(lv.status, 'active') = 'active';
  END IF;
END;
$sample$;

DO $repair$
DECLARE
  v_row RECORD;
  v_sender_id UUID;
  v_client_id UUID;
BEGIN
  FOR v_row IN
    SELECT
      pv.id AS plugin_version_id,
      b.scope_type,
      b.scope_id,
      ws.id AS source_id
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions pv
      ON pv.id = b.plugin_version_id
    JOIN public.integration_plugins p
      ON p.id = pv.plugin_id
    JOIN public.webhook_sources ws
      ON ws.id = b.runtime_resource_id
     AND b.runtime_resource_type = 'webhook_sources'
    WHERE b.binding_type = 'webhook_source'
      AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
      AND p.status = 'active'
      AND pv.status = 'active'
      AND p.active_version_id = pv.id
      AND ws.sender_id IS NULL
      AND public.integration_plugin_activation_requires_source_sender_v1(
        p.plugin_kind,
        COALESCE(pv.workflow_binding, '{}'::jsonb),
        public.integration_plugin_resolve_policy_v1('integration_plugin_policy', p.organization_id)
      )
  LOOP
    BEGIN
      v_sender_id := public.integration_plugin_resolve_activation_sender_v1(
        v_row.plugin_version_id,
        v_row.scope_type,
        v_row.scope_id
      );
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_sender_id
     LIMIT 1;

    UPDATE public.webhook_sources ws
       SET sender_id = v_sender_id,
           managed_metadata = COALESCE(ws.managed_metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id,
               'source_binding_source', 'integration_plugin_webhook_policy_repair'
             )),
           updated_at = now()
     WHERE ws.id = v_row.source_id;

    UPDATE public.integration_plugin_bindings b
       SET activation_payload = COALESCE(b.activation_payload, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id
             )),
           metadata = COALESCE(b.metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'source_sender_id', v_sender_id,
               'source_client_id', v_client_id,
               'source_binding_source', 'integration_plugin_webhook_policy_repair'
             )),
           updated_at = now()
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = v_row.source_id;
  END LOOP;

  FOR v_row IN
    SELECT
      ws.id AS source_id,
      pv.id AS plugin_version_id
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions pv
      ON pv.id = b.plugin_version_id
    JOIN public.integration_plugins p
      ON p.id = pv.plugin_id
    JOIN public.webhook_sources ws
      ON ws.id = b.runtime_resource_id
     AND b.runtime_resource_type = 'webhook_sources'
    WHERE b.binding_type = 'webhook_source'
      AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
      AND p.status = 'active'
      AND pv.status = 'active'
      AND p.active_version_id = pv.id
  LOOP
    PERFORM public.repair_integration_plugin_webhook_policy_v1(v_row.source_id, v_row.plugin_version_id);
  END LOOP;
END;
$repair$;

COMMENT ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT)
  IS 'Activates approved integration plugin versions, materializes runtime source/route/provider assets, resolves required source sender/client bindings, and writes shipment-create webhook policies from row-driven workflow bindings.';

SELECT pg_advisory_unlock(hashtext('202605241215_plugin_studio_webhook_source_binding_v1'));

COMMIT;
