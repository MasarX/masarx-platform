-- Repair Plugin Studio webhook shipment-create activation so runtime sources
-- always carry sender/client binding and a shipment-create mapping contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607060015_plugin_webhook_source_sender_mapping_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.integration_plugin_source_mapping_config_v1(
  p_plugin_kind TEXT,
  p_workflow_binding JSONB,
  p_mapping_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_kind TEXT := lower(COALESCE(NULLIF(btrim(p_plugin_kind), ''), ''));
  v_mapping JSONB := COALESCE(p_mapping_config, '{}'::jsonb);
  v_template_name TEXT;
  v_intent TEXT;
  v_patch JSONB := jsonb_build_object(
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
  IF jsonb_typeof(v_mapping) IS DISTINCT FROM 'object' THEN
    v_mapping := '{}'::jsonb;
  END IF;

  v_template_name := public.integration_plugin_resolve_template_name_v1(COALESCE(p_workflow_binding, '{}'::jsonb));
  v_intent := public.normalize_shipment_intent_v1(
    lower(COALESCE(
      NULLIF(p_workflow_binding #>> '{workflow,intent}', ''),
      NULLIF(p_workflow_binding->>'intent', ''),
      NULLIF(p_workflow_binding->>'canonical_intent', ''),
      NULLIF(v_mapping->>'target', ''),
      NULLIF(v_mapping#>>'{metadata,target}', '')
    )),
    NULL
  );

  IF v_kind = 'webhook'
     AND (v_template_name = 'webhook_shipment_create_v1' OR v_intent = 'shipment.create')
     AND COALESCE(v_mapping->>'target', '') = ''
  THEN
    RETURN jsonb_set(
      public.jsonb_deep_merge(v_mapping, v_patch),
      '{transforms}',
      v_patch->'transforms',
      TRUE
    );
  END IF;

  RETURN v_mapping;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_source_mapping_config_v1(TEXT, JSONB, JSONB)
  IS 'Normalizes plugin runtime source mapping configs; webhook shipment-create sources receive the backend-owned shipment mapping default when the version omits target/transforms.';

DO $resolver_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$  IF v_required IS TRUE
     AND lower(COALESCE(v_plugin.plugin_kind, '')) = 'webhook'
     AND COALESCE(v_version.metadata->>'managed_by', '') <> 'integration_plugin_studio_edge'
     AND COALESCE(v_version.mapping_config#>>'{metadata,mapping_profile}', '') <> 'plugin_studio_webhook_shipment_create_v1'
  THEN
    v_required := FALSE;
  END IF;

  IF v_required IS FALSE THEN
$from$;
  v_to TEXT := $to$  IF v_required IS FALSE THEN
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_resolve_activation_sender_v1(uuid,text,uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_resolve_activation_sender_v1 definition not found';
  END IF;

  IF position(v_from IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_from, v_to);
  END IF;
END;
$resolver_patch$;

DO $activation_patch$
DECLARE
  v_def TEXT;
  v_from TEXT := $from$    'webhook_inbound',
    format('integration_plugin:%s:source:%s:%s', v_version.id, v_scope_type, v_scope_id),
    COALESCE(v_version.mapping_config, '{}'::jsonb),
$from$;
  v_to TEXT := $to$    'webhook_inbound',
    format('integration_plugin:%s:source:%s:%s', v_version.id, v_scope_type, v_scope_id),
    public.integration_plugin_source_mapping_config_v1(
      v_plugin.plugin_kind,
      COALESCE(v_version.workflow_binding, '{}'::jsonb),
      COALESCE(v_version.mapping_config, '{}'::jsonb)
    ),
$to$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('integration_plugin_source_mapping_config_v1' IN v_def) = 0 THEN
    IF position(v_from IN v_def) = 0 THEN
      RAISE EXCEPTION 'integration_plugin_activate_core_v1 webhook source mapping marker not found';
    END IF;
    EXECUTE replace(v_def, v_from, v_to);
  END IF;
END;
$activation_patch$;

DO $backfill$
DECLARE
  v_row RECORD;
  v_sender_id UUID;
  v_client_id UUID;
BEGIN
  UPDATE public.integration_plugin_versions v
     SET mapping_config = public.integration_plugin_source_mapping_config_v1(
           p.plugin_kind,
           COALESCE(v.workflow_binding, '{}'::jsonb),
           COALESCE(v.mapping_config, '{}'::jsonb)
         ),
         updated_at = now()
    FROM public.integration_plugins p
   WHERE p.id = v.plugin_id
     AND lower(COALESCE(p.plugin_kind, '')) = 'webhook'
     AND COALESCE(v.mapping_config->>'target', '') = ''
     AND (
       public.integration_plugin_resolve_template_name_v1(COALESCE(v.workflow_binding, '{}'::jsonb)) = 'webhook_shipment_create_v1'
       OR public.normalize_shipment_intent_v1(lower(COALESCE(v.workflow_binding->>'intent', '')), NULL) = 'shipment.create'
     );

  UPDATE public.mapping_configs mc
     SET mapping_config = public.integration_plugin_source_mapping_config_v1(
           p.plugin_kind,
           COALESCE(v.workflow_binding, '{}'::jsonb),
           COALESCE(mc.mapping_config, v.mapping_config, '{}'::jsonb)
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
     AND COALESCE(mc.mapping_config->>'target', '') = ''
     AND (
       public.integration_plugin_resolve_template_name_v1(COALESCE(v.workflow_binding, '{}'::jsonb)) = 'webhook_shipment_create_v1'
       OR public.normalize_shipment_intent_v1(lower(COALESCE(v.workflow_binding->>'intent', '')), NULL) = 'shipment.create'
     );

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
      AND public.integration_plugin_activation_requires_source_sender_v1(
        p.plugin_kind,
        COALESCE(pv.workflow_binding, '{}'::jsonb),
        public.integration_plugin_resolve_policy_v1('integration_plugin_policy', p.organization_id)
      )
      AND ws.sender_id IS NULL
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
               'source_binding_source', 'integration_plugin_policy_repair'
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
               'source_binding_source', 'integration_plugin_policy_repair'
             )),
           updated_at = now()
     WHERE b.runtime_resource_type = 'webhook_sources'
       AND b.runtime_resource_id = v_row.source_id;

    PERFORM public.repair_integration_plugin_webhook_policy_v1(v_row.source_id, v_row.plugin_version_id);
  END LOOP;
END;
$backfill$;

SELECT pg_advisory_unlock(hashtext('202607060015_plugin_webhook_source_sender_mapping_repair_v1'));

COMMIT;
