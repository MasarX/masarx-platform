-- Maps/SNA backend-lineage support slice.
-- Scope: preserve Saudi short national address lineage for manual geocode
-- requeue and API/webhook shipment-create intake without adding UI proof.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606132145_maps_sna_backend_lineage_source_slice_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.address_coordinates_from_payload_v1(p_payload JSONB)
RETURNS geography
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_raw JSONB;
  v_raw_type TEXT;
  v_lat_text TEXT;
  v_lng_text TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_wkt TEXT;
  v_geog geography;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_raw := COALESCE(p_payload->'coordinates', p_payload->'map_pin');
  IF v_raw IS NOT NULL AND v_raw <> 'null'::jsonb THEN
    v_raw_type := jsonb_typeof(v_raw);
    IF v_raw_type = 'object' THEN
      v_lat_text := COALESCE(
        NULLIF(btrim(v_raw->>'lat'), ''),
        NULLIF(btrim(v_raw->>'latitude'), '')
      );
      v_lng_text := COALESCE(
        NULLIF(btrim(v_raw->>'lng'), ''),
        NULLIF(btrim(v_raw->>'longitude'), '')
      );
    ELSIF v_raw_type = 'string' THEN
      v_wkt := NULLIF(btrim(v_raw #>> '{}'), '');
      IF v_wkt IS NOT NULL THEN
        v_geog := ST_GeogFromText(v_wkt);
        IF GeometryType(v_geog::geometry) <> 'POINT' THEN
          RAISE EXCEPTION 'address coordinates WKT must be a POINT'
            USING ERRCODE = '22023';
        END IF;
        RETURN v_geog;
      END IF;
    ELSE
      RAISE EXCEPTION 'address coordinates must be a JSON object, WKT string, or null'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_lat_text IS NULL AND v_lng_text IS NULL THEN
    v_lat_text := COALESCE(
      NULLIF(btrim(p_payload->>'lat'), ''),
      NULLIF(btrim(p_payload->>'latitude'), '')
    );
    v_lng_text := COALESCE(
      NULLIF(btrim(p_payload->>'lng'), ''),
      NULLIF(btrim(p_payload->>'longitude'), '')
    );
  END IF;

  IF v_lat_text IS NULL AND v_lng_text IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_lat_text IS NULL OR v_lng_text IS NULL THEN
    RAISE EXCEPTION 'address coordinates require both latitude and longitude'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_lat := v_lat_text::DOUBLE PRECISION;
    v_lng := v_lng_text::DOUBLE PRECISION;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'address coordinates must be numeric latitude/longitude'
        USING ERRCODE = '22023';
  END;

  IF v_lat < -90 OR v_lat > 90 OR v_lng < -180 OR v_lng > 180 THEN
    RAISE EXCEPTION 'address coordinates outside valid latitude/longitude bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography;
END;
$function$;

CREATE OR REPLACE FUNCTION public.address_sa_short_code_from_payload_v1(p_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_candidate TEXT;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN NULL;
  END IF;

  v_candidate := COALESCE(
    NULLIF(btrim(p_payload->>'sa_short_code'), ''),
    NULLIF(btrim(p_payload->>'short_national_address'), ''),
    NULLIF(btrim(p_payload->>'shortNationalAddress'), ''),
    NULLIF(btrim(p_payload->>'short_address'), ''),
    NULLIF(btrim(p_payload->>'shortAddress'), ''),
    NULLIF(btrim(p_payload->>'short_code'), ''),
    NULLIF(btrim(p_payload->>'shortCode'), ''),
    NULLIF(btrim(p_payload->>'nationalAddress'), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','sa_short_code']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','short_national_address']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['address','shortNationalAddress']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','sa_short_code']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','short_national_address']), ''),
    NULLIF(btrim(p_payload #>> ARRAY['destination','shortNationalAddress']), '')
  );

  RETURN public.geocoding_normalize_candidate_code(v_candidate, NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.address_coordinates_from_payload_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.address_coordinates_from_payload_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.address_coordinates_from_payload_v1(JSONB)
  IS 'Normalizes address payload lat/lng aliases into the canonical addresses.coordinates PostGIS point.';
COMMENT ON FUNCTION public.address_sa_short_code_from_payload_v1(JSONB)
  IS 'Normalizes Saudi short national address aliases from address payloads into addresses.sa_short_code format.';

CREATE OR REPLACE FUNCTION public.default_shipment_webhook_intake_mapping_config_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'label', 'Default shipment webhook intake',
    'target', 'shipments.create',
    'enabled', TRUE,
    'transforms', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', jsonb_build_array('shipment.external_id', 'shipment.reference', 'external_id', 'id', 'reference'),
        'reference_number', jsonb_build_array('shipment.reference_number', 'shipment.reference', 'reference_number', 'reference'),
        'tracking_number', jsonb_build_array('shipment.tracking_number', 'tracking_number', 'awb', 'waybill', 'barcode'),
        'service_type', jsonb_build_array('shipment.service_type', 'service_type'),
        'service_level', jsonb_build_array('shipment.service_level', 'service_level'),
        'cod_amount', jsonb_build_array('shipment.cod_amount', 'cod_amount', 'cash_on_delivery_amount'),
        'currency', jsonb_build_array('shipment.cod_currency', 'currency')
      ),
      'sender', jsonb_build_object(
        'external_id', 'sender.external_id',
        'name', 'sender.name'
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
        'lng', jsonb_build_array('shipment.destination.lng', 'destination.lng', 'address.lng', 'longitude', 'lng'),
        'sa_short_code', jsonb_build_array(
          'shipment.destination.sa_short_code',
          'shipment.destination.short_national_address',
          'shipment.destination.shortNationalAddress',
          'shipment.destination.nationalAddress',
          'destination.sa_short_code',
          'destination.short_national_address',
          'destination.shortNationalAddress',
          'destination.nationalAddress',
          'address.sa_short_code',
          'address.short_national_address',
          'address.shortNationalAddress',
          'address.nationalAddress',
          'sa_short_code',
          'short_national_address',
          'shortNationalAddress',
          'nationalAddress',
          'short_code',
          'shortCode'
        )
      )
    ),
    'sample_input', jsonb_build_object(
      'event', jsonb_build_object('id', 'external-webhook-sample-1001', 'type', 'shipment.created', 'timestamp', '2026-05-15T12:00:00Z'),
      'shipment', jsonb_build_object(
        'external_id', 'FT-ORDER-1001',
        'reference', 'FT-WH-EXT-1001',
        'reference_number', 'FT-REF-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'cod_currency', 'SAR',
        'currency', 'SAR',
        'recipient', jsonb_build_object(
          'external_id', 'REC-WH-EXT-1001',
          'name', 'Noura External Customer',
          'phone', '+966555010123',
          'email', 'noura.external@example.com'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'line2', 'Building 12',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'province', 'Riyadh',
          'country', 'SA',
          'short_national_address', 'RNQA7082',
          'lat', 24.7136,
          'lng', 46.6753
        )
      )
    ),
    'sample_output', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'FT-WH-EXT-1001',
        'reference_number', 'FT-WH-EXT-1001',
        'service_type', 'delivery',
        'service_level', 'next_day',
        'cod_amount', 125.50,
        'currency', 'SAR'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-WH-EXT-1001',
        'name', 'Noura External Customer',
        'phone', '+966555010123',
        'email', 'noura.external@example.com'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'line2', 'Building 12',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'province', 'Riyadh',
        'country_code', 'SA',
        'sa_short_code', 'RNQA7082',
        'lat', 24.7136,
        'lng', 46.6753
      )
    ),
    'metadata', jsonb_build_object(
      'managed_by', 'onboarding_default',
      'mapping_profile', 'shipment_webhook_intake_v1',
      'payload_shape', 'external_shipment_envelope_v1',
      'canonical_intent', 'shipment.create',
      'short_address_profile', 'sa_short_national_address_v1'
    )
  );
$function$;

COMMENT ON FUNCTION public.default_shipment_webhook_intake_mapping_config_v1() IS
  'Canonical row-driven default mapping profile for product-authored shipment webhook/API intake, including Saudi short national address extraction into address.sa_short_code.';

CREATE OR REPLACE FUNCTION public.normalize_shipment_webhook_mapping_config_v1(
  p_mapping_type TEXT,
  p_mapping_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_config JSONB := COALESCE(p_mapping_config, '{}'::jsonb);
  v_target TEXT := lower(NULLIF(btrim(COALESCE(v_config->>'target', '')), ''));
BEGIN
  IF p_mapping_type IS DISTINCT FROM 'webhook_inbound' THEN
    RETURN v_config;
  END IF;

  IF v_target NOT IN ('shipment.create', 'shipments.create') THEN
    RETURN v_config;
  END IF;

  RETURN public.jsonb_deep_merge(
    public.default_shipment_webhook_intake_mapping_config_v1(),
    v_config
  );
END;
$function$;

COMMENT ON FUNCTION public.normalize_shipment_webhook_mapping_config_v1(TEXT, JSONB) IS
  'Normalizes shipment-create webhook mapping rows so minimal product-authored mappings still preserve canonical shipment, recipient, address, and Saudi short national address lineage.';

CREATE OR REPLACE FUNCTION public.mapping_configs_normalize_shipment_webhook_config_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  NEW.mapping_config := public.normalize_shipment_webhook_mapping_config_v1(
    NEW.mapping_type,
    NEW.mapping_config
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mapping_configs_normalize_shipment_webhook_config_v1
  ON public.mapping_configs;

CREATE TRIGGER trg_mapping_configs_normalize_shipment_webhook_config_v1
BEFORE INSERT OR UPDATE OF mapping_type, mapping_config
ON public.mapping_configs
FOR EACH ROW
EXECUTE FUNCTION public.mapping_configs_normalize_shipment_webhook_config_v1();

UPDATE public.mapping_configs mc
   SET mapping_config = public.normalize_shipment_webhook_mapping_config_v1(mc.mapping_type, mc.mapping_config),
       mapping_version = COALESCE(mc.mapping_version, 1) + 1,
       updated_at = now()
 WHERE mc.mapping_type = 'webhook_inbound'
   AND lower(COALESCE(mc.mapping_config->>'target', '')) IN ('shipment.create', 'shipments.create')
   AND mc.mapping_config IS DISTINCT FROM public.normalize_shipment_webhook_mapping_config_v1(mc.mapping_type, mc.mapping_config);

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_create_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_ctx_patch JSONB := COALESCE(v_ctx->'workflow'->'context_patch', '{}'::jsonb);
    v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
    v_transformed_payload JSONB := COALESCE(v_ctx->'transformed_payload', '{}'::jsonb);
    v_materialized_payload JSONB := CASE
      WHEN jsonb_typeof(v_transformed_payload) = 'object' AND v_transformed_payload <> '{}'::jsonb
        THEN v_transformed_payload
      ELSE v_payload
    END;
    v_resource JSONB := COALESCE(v_payload->'resource', '{}'::jsonb);
    v_payload_shipment JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'shipment') = 'object' THEN v_materialized_payload->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'shipment') = 'object' THEN v_resource->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'shipment') = 'object' THEN v_ctx_patch->'shipment' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'shipment') = 'object' THEN v_ctx->'shipment' END, '{}'::jsonb)
    );
    v_payload_recipient JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'recipient') = 'object' THEN v_materialized_payload->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient}') = 'object' THEN v_materialized_payload#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'recipient') = 'object' THEN v_resource->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource#>'{shipment,recipient}') = 'object' THEN v_resource#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'recipient') = 'object' THEN v_ctx_patch->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch#>'{shipment,recipient}') = 'object' THEN v_ctx_patch#>'{shipment,recipient}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'recipient') = 'object' THEN v_ctx->'recipient' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx#>'{shipment,recipient}') = 'object' THEN v_ctx#>'{shipment,recipient}' END, '{}'::jsonb)
    );
    v_payload_address JSONB := jsonb_strip_nulls(
      COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'address') = 'object' THEN v_materialized_payload->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload->'destination_address') = 'object' THEN v_materialized_payload->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_materialized_payload#>'{shipment,recipient,address}') = 'object' THEN v_materialized_payload#>'{shipment,recipient,address}' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'address') = 'object' THEN v_resource->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_resource->'destination_address') = 'object' THEN v_resource->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'address') = 'object' THEN v_ctx_patch->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx_patch->'destination_address') = 'object' THEN v_ctx_patch->'destination_address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'address') = 'object' THEN v_ctx->'address' END, '{}'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(v_ctx->'destination_address') = 'object' THEN v_ctx->'destination_address' END, '{}'::jsonb)
    );

    v_org UUID := COALESCE(
        NULLIF(v_ctx->>'organization_id', '')::UUID,
        NULLIF(v_ctx_patch->>'organization_id', '')::UUID
    );
    v_client UUID := COALESCE(
        NULLIF(v_ctx->>'client_id', '')::UUID,
        NULLIF(v_ctx_patch->>'client_id', '')::UUID
    );
    v_sender UUID := COALESCE(
        NULLIF(v_ctx->>'sender_id', '')::UUID,
        NULLIF(v_ctx_patch->>'sender_id', '')::UUID
    );
    v_planned_id UUID := COALESCE(
        NULLIF(v_ctx->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx->>'planned_resource_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_shipment_id', '')::UUID,
        NULLIF(v_ctx_patch->>'planned_resource_id', '')::UUID,
        NULLIF((v_ctx->'shipment'->>'id'), '')::UUID,
        NULLIF((v_ctx_patch->'shipment'->>'id'), '')::UUID
    );
    v_planned_tracking TEXT := COALESCE(
        NULLIF(v_ctx->>'planned_tracking_number', ''),
        NULLIF(v_ctx_patch->>'planned_tracking_number', ''),
        NULLIF((v_ctx->'shipment'->>'tracking_number'), ''),
        NULLIF((v_ctx_patch->'shipment'->>'tracking_number'), '')
    );
    v_service_type TEXT := COALESCE(
        NULLIF(v_ctx->>'service_type', ''),
        NULLIF(v_ctx_patch->>'service_type', ''),
        NULLIF(v_payload_shipment->>'service_type', ''),
        'delivery'
    );
    v_service_level TEXT := COALESCE(
        NULLIF(v_ctx->>'service_level', ''),
        NULLIF(v_ctx_patch->>'service_level', ''),
        NULLIF(v_payload_shipment->>'service_level', '')
    );
    v_provider_service_type TEXT;
    v_provider_service_level TEXT;
    v_status TEXT := COALESCE(NULLIF(v_ctx->>'initial_status', ''), 'pending');
    v_metadata_source UUID := COALESCE(
        NULLIF(v_ctx->>'webhook_id', '')::UUID,
        NULLIF(v_ctx_patch->>'webhook_id', '')::UUID
    );
    v_requested_by UUID := COALESCE(
        NULLIF(v_ctx->>'requested_by', '')::UUID,
        NULLIF(v_ctx_patch->>'requested_by', '')::UUID
    );

    v_client_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'client_reference_number', ''),
        NULLIF(v_ctx_patch->>'client_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,client_reference_number}', ''),
        NULLIF(v_payload_shipment->>'client_reference_number', ''),
        NULLIF(v_payload_shipment->>'reference_number', ''),
        NULLIF(v_payload_shipment->>'external_id', ''),
        NULLIF(v_resource->>'client_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,client_reference_number}', '')
    );
    v_carrier_reference TEXT := COALESCE(
        NULLIF(v_ctx->>'carrier_reference_number', ''),
        NULLIF(v_ctx_patch->>'carrier_reference_number', ''),
        NULLIF(v_ctx#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_ctx_patch#>>'{shipment,carrier_reference_number}', ''),
        NULLIF(v_payload_shipment->>'carrier_reference_number', ''),
        NULLIF(v_payload_shipment->>'carrier_reference', ''),
        NULLIF(v_resource->>'carrier_reference_number', ''),
        NULLIF(v_resource#>>'{shipment,carrier_reference_number}', '')
    );

    v_recipient_id UUID := COALESCE(
        NULLIF(v_ctx->>'recipient_id', '')::UUID,
        NULLIF(v_ctx_patch->>'recipient_id', '')::UUID,
        NULLIF(v_payload_recipient->>'id', '')::UUID
    );
    v_recipient_external_id TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'external_id', '')), '');
    v_recipient_name TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'name', '')), '');
    v_recipient_phone TEXT := COALESCE(
        NULLIF(btrim(COALESCE(v_payload_recipient->>'phone_number', '')), ''),
        NULLIF(btrim(COALESCE(v_payload_recipient->>'phone', '')), '')
    );
    v_recipient_phone_normalized TEXT;
    v_recipient_email TEXT := NULLIF(btrim(COALESCE(v_payload_recipient->>'email', '')), '');

    v_address_line1 TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'line1', v_payload_address->>'normalized_line1', '')), '');
    v_address_line2 TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'line2', v_payload_address->>'normalized_line2', '')), '');
    v_address_district TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'district', '')), '');
    v_address_city TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'city', '')), '');
    v_address_province TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'province', v_payload_address->>'region', '')), '');
    v_address_postal_code TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'postal_code', '')), '');
    v_address_country TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'country_code', v_payload_address->>'country', '')), '');
    v_address_directions TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'additional_directions', v_payload_address->>'directions', '')), '');
    v_address_lat_text TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'lat', v_payload_address->>'latitude', '')), '');
    v_address_lng_text TEXT := NULLIF(btrim(COALESCE(v_payload_address->>'lng', v_payload_address->>'longitude', '')), '');
    v_address_lat NUMERIC;
    v_address_lng NUMERIC;
    v_address_sa_short_code TEXT;
    v_address_geocoding_policy JSONB;
    v_address_short_plugin JSONB;
    v_address_coordinates geography;
    v_destination_address_id UUID;

    v_cod_amount_text TEXT := NULLIF(btrim(COALESCE(v_payload_shipment->>'cod_amount', v_payload_shipment->>'cash_on_delivery_amount', '')), '');
    v_cod_amount NUMERIC;
    v_cod_currency TEXT := COALESCE(
      NULLIF(btrim(COALESCE(v_payload_shipment->>'cod_currency', '')), ''),
      NULLIF(btrim(COALESCE(v_payload_shipment->>'currency', '')), '')
    );

    v_logistics_refs JSONB;
    v_reference_map JSONB := '{}'::jsonb;
    v_refs JSONB := '{}'::jsonb;
    v_ref_meta JSONB;
    v_input_metadata JSONB := '{}'::jsonb;

    v_correlation_id UUID;
    v_row_id UUID;
    v_tracking_number TEXT;
    v_operation TEXT := 'inserted';
    v_result public.workflow_handler_response;
BEGIN
    BEGIN
      v_correlation_id := NULLIF(v_ctx->>'correlation_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_correlation_id := NULL;
    END;
    IF v_correlation_id IS NULL THEN
      BEGIN
        v_correlation_id := NULLIF(v_ctx_patch->>'correlation_id', '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_correlation_id := NULL;
      END;
    END IF;

    IF v_recipient_phone IS NOT NULL THEN
      v_recipient_phone_normalized := public.normalize_phone_number(v_recipient_phone);
    END IF;

    IF v_cod_amount_text IS NOT NULL THEN
      IF v_cod_amount_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_cod_amount := v_cod_amount_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 cod_amount must be numeric';
      END IF;
    END IF;

    IF v_address_lat_text IS NOT NULL THEN
      IF v_address_lat_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_address_lat := v_address_lat_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 address.lat must be numeric';
      END IF;
    END IF;
    IF v_address_lng_text IS NOT NULL THEN
      IF v_address_lng_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        v_address_lng := v_address_lng_text::NUMERIC;
      ELSE
        RAISE EXCEPTION 'execute_shipment_create_v1 address.lng must be numeric';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.lookup_values lv
        JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
       WHERE ld.category = 'service_type'
         AND lv.value = v_service_type
         AND COALESCE(lv.status, 'active') = 'active'
    ) THEN
      v_provider_service_type := v_service_type;
      v_service_type := 'delivery';
    END IF;

    IF v_service_level IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.lookup_values lv
           JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
          WHERE ld.category = 'service_level'
            AND lv.value = v_service_level
            AND COALESCE(lv.status, 'active') = 'active'
       ) THEN
      v_provider_service_level := v_service_level;
      IF v_provider_service_type IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.lookup_values lv
             JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
            WHERE ld.category = 'service_level'
              AND lv.value = v_provider_service_type
              AND COALESCE(lv.status, 'active') = 'active'
         ) THEN
        v_service_level := v_provider_service_type;
      ELSE
        v_service_level := NULL;
      END IF;
    END IF;

    IF v_provider_service_type IS NOT NULL OR v_provider_service_level IS NOT NULL THEN
      v_input_metadata := v_input_metadata || jsonb_strip_nulls(jsonb_build_object(
        'provider_service_type', v_provider_service_type,
        'provider_service_level', v_provider_service_level
      ));
    END IF;

    IF v_org IS NULL OR v_client IS NULL OR v_planned_tracking IS NULL THEN
        v_result.status := 'failed';
        v_result.last_error := format(
          'execute_shipment_create_v1: missing required context (org %s, client %s, tracking %s)',
          COALESCE(v_org::TEXT, '<NULL>'),
          COALESCE(v_client::TEXT, '<NULL>'),
          COALESCE(v_planned_tracking, '<NULL>')
        );
        v_result.operation_result := jsonb_build_object(
          'reason', 'missing_required_context_failed_webhook_inbox',
          'error', v_result.last_error,
          'webhook_id', v_metadata_source,
          'organization_id', v_org,
          'client_id', v_client,
          'planned_tracking_number', v_planned_tracking
        );
        v_result.context_patch := jsonb_build_object(
          'shipment_create_error', v_result.operation_result
        );

        IF v_metadata_source IS NOT NULL THEN
          UPDATE public.webhook_inbox wi
             SET processing_status = 'failed',
                 processed_at = COALESCE(wi.processed_at, now()),
                 error_message = v_result.last_error,
                 updated_at = now()
           WHERE wi.id = v_metadata_source
             AND wi.processing_status IS DISTINCT FROM 'succeeded';

          IF v_org IS NOT NULL THEN
            PERFORM public.log_decision(
              p_organization_id := v_org,
              p_decision_category := 'webhook_processing',
              p_resource_type := 'webhook_inbox',
              p_resource_id := v_metadata_source,
              p_decision_point := 'shipment_create_context',
              p_decision_outcome := 'failed',
              p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
              p_correlation_id := v_correlation_id,
              p_decision_inputs := v_result.operation_result,
              p_decision_reason := v_result.last_error
            );
          END IF;
        END IF;

        RETURN v_result;
    END IF;

    IF v_planned_id IS NULL THEN
        v_planned_id := gen_random_uuid();
    END IF;

    v_address_sa_short_code := public.address_sa_short_code_from_payload_v1(v_payload_address);
    v_address_coordinates := public.address_coordinates_from_payload_v1(v_payload_address);
    IF v_address_sa_short_code IS NOT NULL THEN
      v_address_geocoding_policy := COALESCE(
        public.resolve_settings('geocoding_policy', 'client', v_client),
        public.resolve_settings('geocoding_policy', 'tenant', v_org),
        public.resolve_settings('geocoding_policy', 'global', NULL),
        '{}'::jsonb
      );
      v_address_short_plugin := workflow_handlers.geocoding_get_plugin(v_address_geocoding_policy, 'short_code');
      v_address_sa_short_code := public.geocoding_normalize_candidate_code(
        v_address_sa_short_code,
        NULLIF(v_address_short_plugin->'params'->>'code_regex', '')
      );
    END IF;

    IF v_recipient_id IS NOT NULL THEN
      PERFORM 1
        FROM public.recipients r
       WHERE r.id = v_recipient_id
         AND r.client_id = v_client
         AND r.organization_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_shipment_create_v1 recipient % is outside shipment client scope', v_recipient_id;
      END IF;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_external_id IS NOT NULL THEN
      SELECT r.id
        INTO v_recipient_id
        FROM public.recipients r
       WHERE r.client_id = v_client
         AND r.external_id = v_recipient_external_id
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_phone_normalized IS NOT NULL THEN
      SELECT r.id
        INTO v_recipient_id
        FROM public.recipients r
       WHERE r.client_id = v_client
         AND r.phone_number_normalized = v_recipient_phone_normalized
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1;
    END IF;

    IF v_recipient_id IS NULL AND v_recipient_name IS NOT NULL AND v_recipient_phone IS NOT NULL THEN
      INSERT INTO public.recipients (
        organization_id,
        client_id,
        external_id,
        name,
        phone_number,
        phone_validation_status,
        email
      )
      VALUES (
        v_org,
        v_client,
        v_recipient_external_id,
        v_recipient_name,
        v_recipient_phone,
        'pending',
        v_recipient_email
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_recipient_id;

      IF v_recipient_id IS NULL AND v_recipient_phone_normalized IS NOT NULL THEN
        SELECT r.id
          INTO v_recipient_id
          FROM public.recipients r
         WHERE r.client_id = v_client
           AND r.phone_number_normalized = v_recipient_phone_normalized
         ORDER BY r.created_at ASC, r.id ASC
         LIMIT 1;
      END IF;
    END IF;

    IF v_address_line1 IS NOT NULL
       OR v_address_city IS NOT NULL
       OR v_address_district IS NOT NULL
       OR v_address_postal_code IS NOT NULL THEN
      INSERT INTO public.addresses (
        organization_id,
        client_id,
        raw_input,
        sa_short_code,
        normalized_line1,
        normalized_line2,
        line1,
        line2,
        district,
        city,
        province,
        postal_code,
        country,
        additional_directions,
        validation_status,
        is_pii,
        coordinates
      )
      VALUES (
        v_org,
        v_client,
        NULLIF(btrim(concat_ws(', ', v_address_line1, v_address_line2, v_address_district, v_address_city, v_address_province, v_address_country)), ''),
        v_address_sa_short_code,
        v_address_line1,
        v_address_line2,
        v_address_line1,
        v_address_line2,
        v_address_district,
        v_address_city,
        v_address_province,
        v_address_postal_code,
        COALESCE(v_address_country, 'SA'),
        v_address_directions,
        'pending',
        TRUE,
        COALESCE(
          v_address_coordinates,
          CASE
            WHEN v_address_lat IS NOT NULL AND v_address_lng IS NOT NULL
              THEN ST_SetSRID(ST_MakePoint(v_address_lng, v_address_lat), 4326)::geography
            ELSE NULL
          END
        )
      )
      RETURNING id INTO v_destination_address_id;
    END IF;

    IF jsonb_typeof(v_resource->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_resource->'references';
    END IF;
    IF jsonb_typeof(v_ctx->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx->'references';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_ctx_patch->'references';
    END IF;
    IF jsonb_typeof(v_payload_shipment->'references') = 'object' THEN
      v_reference_map := v_reference_map || v_payload_shipment->'references';
    END IF;
    IF jsonb_typeof(v_resource->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_resource->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx->'metadata';
    END IF;
    IF jsonb_typeof(v_ctx_patch->'metadata') = 'object' THEN
      v_input_metadata := v_input_metadata || v_ctx_patch->'metadata';
    END IF;

    v_logistics_refs := NULL;
    IF jsonb_typeof(v_resource->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_resource->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_resource->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_resource->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx->'logistics_reference_number';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_numbers') = 'array' THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_numbers';
    ELSIF jsonb_typeof(v_ctx_patch->'logistics_reference_number') IN ('array', 'string') THEN
      v_logistics_refs := v_ctx_patch->'logistics_reference_number';
    END IF;

    v_refs := jsonb_strip_nulls(
      v_reference_map || jsonb_build_object(
        'client_reference_number', NULLIF(btrim(v_client_reference), ''),
        'carrier_reference_number', NULLIF(btrim(v_carrier_reference), '')
      )
    );
    IF v_logistics_refs IS NOT NULL THEN
      v_refs := jsonb_strip_nulls(v_refs || jsonb_build_object('logistics_reference_number', v_logistics_refs));
    END IF;

    SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
      INTO v_row_id, v_tracking_number, v_operation
      FROM public.resolve_shipment_create_duplicate_v1(
        v_client,
        v_planned_tracking,
        v_client_reference
      ) AS resolved
     LIMIT 1;

    IF v_row_id IS NULL THEN
      BEGIN
        INSERT INTO public.shipments (
            id,
            organization_id,
            client_id,
            sender_id,
            service_type,
            service_level,
            tracking_number,
            carrier_reference_number,
            client_reference_number,
            recipient_id,
            destination_address_id,
            cod_amount,
            cod_currency,
            status,
            box_count,
            metadata
        )
        VALUES (
            v_planned_id,
            v_org,
            v_client,
            v_sender,
            v_service_type,
            v_service_level,
            v_planned_tracking,
            NULLIF(btrim(v_carrier_reference), ''),
            NULLIF(btrim(v_client_reference), ''),
            v_recipient_id,
            v_destination_address_id,
            v_cod_amount,
            COALESCE(v_cod_currency, 'SAR'),
            v_status,
            1,
            jsonb_strip_nulls(
              v_input_metadata ||
              jsonb_build_object(
                'created_by', 'workflow',
                'workflow_run_id', p_run.id,
                'source_webhook_id', v_metadata_source,
                'requested_by', v_requested_by,
                'correlation_id', v_correlation_id,
                'provider_payload', jsonb_strip_nulls(jsonb_build_object(
                  'shipment', NULLIF(v_payload_shipment, '{}'::jsonb),
                  'recipient_external_id', v_recipient_external_id,
                  'destination_address_id', v_destination_address_id
                ))
              )
            )
        );
      EXCEPTION
        WHEN unique_violation THEN
          SELECT resolved.shipment_id, resolved.tracking_number, resolved.operation
            INTO v_row_id, v_tracking_number, v_operation
            FROM public.resolve_shipment_create_duplicate_v1(
              v_client,
              v_planned_tracking,
              v_client_reference
            ) AS resolved
           LIMIT 1;

          IF v_row_id IS NULL THEN
            RAISE;
          END IF;
      END;

      IF v_row_id IS NULL THEN
        v_row_id := v_planned_id;
        v_tracking_number := v_planned_tracking;
      END IF;
    END IF;

    UPDATE public.shipments
       SET recipient_id = COALESCE(public.shipments.recipient_id, v_recipient_id),
           destination_address_id = COALESCE(public.shipments.destination_address_id, v_destination_address_id),
           cod_amount = COALESCE(public.shipments.cod_amount, v_cod_amount),
           cod_currency = COALESCE(NULLIF(public.shipments.cod_currency, ''), v_cod_currency, 'SAR'),
           service_level = COALESCE(NULLIF(public.shipments.service_level, ''), v_service_level),
           metadata = jsonb_strip_nulls(
             COALESCE(public.shipments.metadata, '{}'::jsonb)
             || v_input_metadata
             || jsonb_build_object(
               'provider_payload', jsonb_strip_nulls(jsonb_build_object(
                 'shipment', NULLIF(v_payload_shipment, '{}'::jsonb),
                 'recipient_external_id', v_recipient_external_id,
                 'recipient_id', v_recipient_id,
                 'destination_address_id', v_destination_address_id,
                 'workflow_run_id', p_run.id,
                 'webhook_id', v_metadata_source,
                 'correlation_id', v_correlation_id
               ))
             )
           ),
           updated_at = now()
     WHERE id = v_row_id
       AND client_id = v_client;

    IF v_operation = 'reused' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'tracking_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), '')
        )),
        p_decision_reason := 'tracking_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    ELSIF v_operation = 'reused_client_reference' THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'shipment_create',
        p_resource_type := 'shipment',
        p_resource_id := v_row_id,
        p_decision_point := 'client_reference_unique',
        p_decision_outcome := 'reused_existing_shipment',
        p_performed_by_system := 'workflow_handlers.execute_shipment_create_v1',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'planned_shipment_id', v_planned_id,
          'planned_tracking_number', v_planned_tracking,
          'client_reference_number', NULLIF(btrim(v_client_reference), ''),
          'existing_tracking_number', v_tracking_number
        )),
        p_decision_reason := 'client_reference_number already exists for this client',
        p_settings_resolution_id := NULL
      );
    END IF;

    UPDATE public.shipments
       SET client_reference_number = COALESCE(NULLIF(btrim(public.shipments.client_reference_number), ''), NULLIF(btrim(v_client_reference), ''), public.shipments.client_reference_number),
           carrier_reference_number = COALESCE(NULLIF(btrim(public.shipments.carrier_reference_number), ''), NULLIF(btrim(v_carrier_reference), ''), public.shipments.carrier_reference_number),
           updated_at = now()
     WHERE id = v_row_id
       AND client_id = v_client
       AND (
         ((public.shipments.client_reference_number IS NULL OR btrim(public.shipments.client_reference_number) = '') AND NULLIF(btrim(v_client_reference), '') IS NOT NULL)
         OR ((public.shipments.carrier_reference_number IS NULL OR btrim(public.shipments.carrier_reference_number) = '') AND NULLIF(btrim(v_carrier_reference), '') IS NOT NULL)
       );

    IF v_row_id IS NOT NULL AND v_refs IS NOT NULL AND v_refs <> '{}'::jsonb THEN
      v_ref_meta := jsonb_strip_nulls(jsonb_build_object(
        'source', 'workflow',
        'workflow_run_id', p_run.id,
        'workflow_run_step_id', p_step.id,
        'webhook_id', v_metadata_source,
        'requested_by', v_requested_by,
        'correlation_id', v_correlation_id
      ));

      PERFORM public.upsert_shipment_reference_numbers_v1(
        p_organization_id := v_org,
        p_client_id := v_client,
        p_shipment_id := v_row_id,
        p_reference_map := v_refs,
        p_source_type := 'workflow',
        p_source_id := NULL,
        p_metadata := v_ref_meta
      );
    END IF;

    IF v_metadata_source IS NOT NULL THEN
      UPDATE public.webhook_inbox wi
         SET processing_status = 'succeeded',
             processed_at = COALESCE(wi.processed_at, now()),
             error_message = NULL
       WHERE wi.id = v_metadata_source
         AND wi.processing_status IS DISTINCT FROM 'failed';
    END IF;

    v_result.status := 'completed';
    v_result.workflow_status := CASE
      WHEN v_operation IN ('reused', 'reused_client_reference')
           AND v_planned_id IS NOT NULL
           AND v_row_id <> v_planned_id THEN 'completed'
      ELSE NULL
    END;
    v_result.next_run_at := NULL;
    v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', v_row_id,
        'tracking_number', v_tracking_number,
        'operation', v_operation,
        'recipient_id', v_recipient_id,
        'destination_address_id', v_destination_address_id,
        'cod_amount', v_cod_amount,
        'cod_currency', v_cod_currency
    ));
    v_result.context_patch := jsonb_build_object(
        'shipment', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row_id,
            'tracking_number', v_tracking_number,
            'client_reference_number', NULLIF(btrim(v_client_reference), '')
        )),
        'recipient_id', v_recipient_id,
        'destination_address_id', v_destination_address_id
    );
    v_result.last_error := NULL;
    v_result.retry_attempt := 1;
    v_result.max_retries := 1;

    RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Workflow-owned shipment creation handler. Materializes API/webhook shipment, recipient, destination address, COD, reference, SNA address lineage, and workflow lineage data from canonical workflow context.';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_address_id UUID := NULL;
  v_address RECORD;
  v_template_name TEXT := COALESCE(NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard');
  v_template_id UUID;
  v_workflow_run_id UUID;
  v_nested_context JSONB := '{}'::jsonb;
  v_nested_progress JSONB := '{}'::jsonb;
  v_nested_status TEXT := NULL;
  v_nested_last_error JSONB := NULL;
  v_action_id UUID;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_nested_idempotency_key TEXT := NULL;
  v_manual_review_task_id UUID := NULL;
  v_geocoding_attempt_id UUID := NULL;
  v_geocode_id UUID := NULL;
  v_geocoding_policy JSONB := '{}'::jsonb;
  v_short_plugin JSONB := NULL;
  v_code_regex TEXT := '^[A-Z]{4}[0-9]{4}$';
  v_short_code TEXT := NULL;
  v_reverse_geocode BOOLEAN := FALSE;
  v_provided_coordinates JSONB := NULL;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;

  BEGIN
    v_address_id := COALESCE(NULLIF(v_ctx->>'address_id', '')::UUID, NULLIF(v_ctx->>'destination_address_id', '')::UUID);
  EXCEPTION
    WHEN others THEN
      v_address_id := NULL;
  END;

  IF v_address_id IS NULL THEN
    v_address_id := v_target.destination_address_id;
  END IF;

  IF v_address_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'address_id_missing';
    v_result.operation_result := jsonb_build_object('error', 'address_id_missing');
    RETURN v_result;
  END IF;

  SELECT a.id, a.client_id, a.sa_short_code, a.coordinates
    INTO v_address
    FROM public.addresses a
   WHERE a.id = v_address_id
     AND (v_target.client_id IS NULL OR a.client_id = v_target.client_id)
   LIMIT 1;

  IF FOUND THEN
    v_short_code := NULLIF(btrim(COALESCE(v_address.sa_short_code, '')), '');

    IF v_address.coordinates IS NOT NULL THEN
      v_provided_coordinates := jsonb_build_object(
        'latitude', ST_Y(v_address.coordinates::geometry),
        'longitude', ST_X(v_address.coordinates::geometry)
      );
    END IF;
  END IF;

  IF v_short_code IS NOT NULL THEN
    v_geocoding_policy := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_short_plugin := workflow_handlers.geocoding_get_plugin(COALESCE(v_geocoding_policy, '{}'::jsonb), 'short_code');
    v_code_regex := COALESCE(NULLIF(v_short_plugin->'params'->>'code_regex', ''), v_code_regex);
    v_short_code := public.geocoding_normalize_candidate_code(v_short_code, v_code_regex);
    v_reverse_geocode := lower(COALESCE(v_short_plugin->'params'->>'reverse_geocode_on_hit', 'false')) = 'true';
  END IF;

  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = v_template_name
     AND status = 'active'
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_template_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'geocode_template_missing';
    v_result.operation_result := jsonb_build_object('error', 'geocode_template_missing', 'template_name', v_template_name);
    RETURN v_result;
  END IF;

  v_nested_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_ctx->>'geocode_idempotency_key', '')), ''),
    format('shipment-update-geocode:nested:%s:%s', p_run.id, v_address_id)
  );

  v_nested_context := jsonb_strip_nulls(jsonb_build_object(
    'idempotency_key', v_nested_idempotency_key,
    'organization_id', COALESCE(v_target.organization_id, NULLIF(v_ctx->>'organization_id', '')::UUID),
    'client_id', COALESCE(v_target.client_id, NULLIF(v_ctx->>'client_id', '')::UUID),
    'sender_id', COALESCE(v_target.sender_id, NULLIF(v_ctx->>'sender_id', '')::UUID),
    'shipment_id', v_target.shipment_id,
    'destination_address_id', v_address_id,
    'address_id', v_address_id,
    'actor_user_id', NULLIF(v_ctx->>'actor_user_id', ''),
    'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode'),
    'trigger_source', 'manual',
    'parent_workflow_run_id', p_run.id,
    'parent_workflow_step_id', p_step.id
  ));

  IF v_short_code IS NOT NULL THEN
    v_nested_context := jsonb_set(
      v_nested_context,
      '{geocoding}',
      jsonb_strip_nulls(jsonb_build_object(
        'short_code', v_short_code,
        'sa_short_code', v_short_code,
        'provided_coordinates', v_provided_coordinates,
        'reverse_geocode', CASE
          WHEN v_provided_coordinates IS NOT NULL THEN v_reverse_geocode
          ELSE NULL
        END
      )),
      TRUE
    );
  END IF;

  v_workflow_run_id := public.start_workflow_run(v_template_id, v_nested_context);

  v_nested_progress := public.progress_workflow_run_until_wait_v1(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_target.shipment_id,
      'client_id', v_target.client_id,
      'destination_address_id', v_address_id,
      'address_id', v_address_id,
      'actor_system', COALESCE(NULLIF(v_ctx->>'actor_system', ''), 'shipment_update_geocode')
    )),
    2500,
    20
  );

  SELECT wr.workflow_status, wr.last_error
    INTO v_nested_status, v_nested_last_error
    FROM public.workflow_runs wr
   WHERE wr.id = v_workflow_run_id;

  SELECT mrt.id
    INTO v_manual_review_task_id
    FROM public.manual_review_tasks mrt
   WHERE mrt.address_id = v_address_id
     AND (
       mrt.metadata->>'workflow_run_id' = v_workflow_run_id::text
       OR mrt.shipment_id = v_target.shipment_id
     )
   ORDER BY mrt.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT ga.id
    INTO v_geocoding_attempt_id
    FROM public.geocoding_attempts ga
    JOIN public.workflow_run_steps wrs
      ON wrs.id = ga.workflow_run_step_id
   WHERE ga.address_id = v_address_id
     AND wrs.workflow_run_id = v_workflow_run_id
   ORDER BY ga.created_at DESC NULLS LAST
   LIMIT 1;

  SELECT g.id
    INTO v_geocode_id
    FROM public.geocodes g
   WHERE g.address_id = v_address_id
     AND g.client_id = v_target.client_id
     AND g.is_primary IS TRUE
     AND (g.expires_at IS NULL OR g.expires_at > now())
   ORDER BY g.geocoded_at DESC NULLS LAST
   LIMIT 1;

  IF v_target.shipment_id IS NOT NULL THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_target.shipment_id,
      'geocode_request',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'idempotency_key', v_event_id,
        'address_id', v_address_id,
        'workflow_run_id', v_workflow_run_id,
        'workflow_status', v_nested_status,
        'workflow_last_error', v_nested_last_error,
        'manual_review_task_id', v_manual_review_task_id,
        'geocoding_attempt_id', v_geocoding_attempt_id,
        'geocode_id', v_geocode_id,
        'nested_idempotency_key', v_nested_idempotency_key
      )),
      NULL::TEXT,
      NULL::TEXT,
      'workflow_handlers.execute_shipment_update_geocode_v1',
      NULL::UUID,
      NULL::timestamptz
    );
  END IF;

  IF lower(COALESCE(v_nested_status, '')) IN ('failed', 'cancelled', 'blocked') THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(
      NULLIF(v_nested_progress->>'error', ''),
      NULLIF(v_nested_last_error->>'error', ''),
      'nested_geocode_workflow_' || lower(COALESCE(v_nested_status, 'failed'))
    );
  ELSE
    v_result.status := 'completed';
  END IF;

  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'shipment_id', v_target.shipment_id,
    'address_id', v_address_id,
    'geocode_workflow_run_id', v_workflow_run_id,
    'geocode_workflow_status', v_nested_status,
    'geocode_workflow_last_error', v_nested_last_error,
    'manual_review_task_id', v_manual_review_task_id,
    'geocoding_attempt_id', v_geocoding_attempt_id,
    'geocode_id', v_geocode_id,
    'geocode_progress', v_nested_progress,
    'shipment_action_id', v_action_id
  ));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO public, workflow_handlers, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps, public.workflow_runs, JSONB) IS
  'Starts a fresh nested geocoding workflow for each operator shipment geocode refresh, carries policy-backed Saudi short-address reverse-geocode intent, progresses it inline, records geocode_request lineage, propagates terminal failures, and returns same-context readback ids for manual review, attempts, and geocode rows.';

CREATE OR REPLACE FUNCTION public.resolve_active_workflow_template_ref_v1(
  p_template_ref TEXT
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_template_ref TEXT := NULLIF(btrim(COALESCE(p_template_ref, '')), '');
  v_template_id UUID := NULL;
BEGIN
  IF v_template_ref IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_template_id := v_template_ref::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  IF v_template_id IS NOT NULL THEN
    SELECT wt.id
      INTO v_template_id
      FROM public.workflow_templates wt
     WHERE wt.id = v_template_id
       AND wt.status = 'active';
    RETURN v_template_id;
  END IF;

  SELECT wt.id
    INTO v_template_id
    FROM public.workflow_templates wt
   WHERE wt.name = v_template_ref
     AND wt.status = 'active'
   ORDER BY wt.updated_at DESC NULLS LAST
   LIMIT 1;

  RETURN v_template_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_active_workflow_template_ref_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_active_workflow_template_ref_v1(TEXT) TO service_role;

COMMENT ON FUNCTION public.resolve_active_workflow_template_ref_v1(TEXT) IS
  'Resolve an active workflow template from a UUID or name; missing, draft, archived, and retired references return NULL.';

CREATE OR REPLACE FUNCTION public.webhook_policy_applies_to_shipment_intent_v1(
  p_policy JSONB,
  p_intent TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT CASE
    WHEN NULLIF(btrim(COALESCE(p_intent, '')), '') IS NULL THEN FALSE
    WHEN jsonb_typeof(COALESCE(p_policy, '{}'::jsonb)#>'{workflow,templates_by_intent}') = 'object'
         AND (COALESCE(p_policy, '{}'::jsonb)#>'{workflow,templates_by_intent}') ? p_intent THEN TRUE
    WHEN NULLIF(btrim(COALESCE(p_policy#>>'{workflow,intent}', '')), '') IS NULL THEN TRUE
    ELSE lower(btrim(p_policy#>>'{workflow,intent}')) ~ '^(shipment|shipments|update)([._]|$)'
  END;
$function$;

REVOKE ALL ON FUNCTION public.webhook_policy_applies_to_shipment_intent_v1(JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.webhook_policy_applies_to_shipment_intent_v1(JSONB, TEXT) TO service_role;

COMMENT ON FUNCTION public.webhook_policy_applies_to_shipment_intent_v1(JSONB, TEXT) IS
  'True only for an explicit per-intent binding or an absent/generic shipment-domain workflow intent; explicit non-shipment policies are preserved byte-for-byte.';

CREATE OR REPLACE FUNCTION public.workflow_template_supports_shipment_intent_v1(
  p_template_id UUID,
  p_intent TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.id = p_template_id
       AND wt.status = 'active'
       AND lower(COALESCE(wt.metadata->>'provider_dispatch', 'false')) <> 'true'
       AND EXISTS (
         SELECT 1
           FROM public.workflow_template_steps materialize
          WHERE materialize.workflow_template_id = wt.id
            AND materialize.enabled IS TRUE
            AND materialize.handler_key = CASE lower(NULLIF(btrim(COALESCE(p_intent, '')), ''))
              WHEN 'shipment.create' THEN 'shipment_create'
              WHEN 'shipment.delete' THEN 'shipment_delete'
              WHEN 'shipment.reschedule' THEN 'shipment_reschedule'
              ELSE '__unsupported_shipment_intent__'
            END
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.workflow_template_steps outbound
          WHERE outbound.workflow_template_id = wt.id
            AND outbound.enabled IS TRUE
            AND (
              lower(COALESCE(outbound.handler_key, '')) IN ('provider_dispatch', 'outbound_http', 'call_supplier_api')
              OR lower(COALESCE(outbound.operation_name, '')) IN ('provider_dispatch', 'outbound_http', 'call_supplier_api')
            )
       )
  );
$function$;

REVOKE ALL ON FUNCTION public.workflow_template_supports_shipment_intent_v1(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_template_supports_shipment_intent_v1(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.workflow_template_supports_shipment_intent_v1(UUID, TEXT) IS
  'Fail-closed compatibility check for an active typed shipment materializer with no enabled provider/outbound dispatch step.';

CREATE OR REPLACE FUNCTION public.workflow_template_supports_inbound_shipment_create_v1(
  p_template_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.workflow_template_supports_shipment_intent_v1(p_template_id, 'shipment.create');
$function$;

REVOKE ALL ON FUNCTION public.workflow_template_supports_inbound_shipment_create_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_template_supports_inbound_shipment_create_v1(UUID) TO service_role;

COMMENT ON FUNCTION public.workflow_template_supports_inbound_shipment_create_v1(UUID) IS
  'Fail-closed compatibility check for an active shipment materializer with no enabled provider/outbound dispatch step.';

UPDATE public.schema_registry
   SET schema = jsonb_set(
     schema,
     '{properties,workflow}',
     $schema${
       "type": ["object", "null"],
       "additionalProperties": false,
       "properties": {
         "template_id": { "type": "string", "format": "uuid" },
         "template_name": { "type": "string", "minLength": 1 },
         "templates_by_intent": {
           "type": "object",
           "additionalProperties": {
             "oneOf": [
               { "type": "string", "minLength": 1 },
               {
                 "type": "object",
                 "additionalProperties": false,
                 "properties": {
                   "template_id": { "type": "string", "format": "uuid" },
                   "template_name": { "type": "string", "minLength": 1 }
                 }
               }
             ]
           }
         },
         "context_patch": { "type": ["object", "null"] },
         "intent": { "type": "string" },
         "notes": { "type": "string" },
         "launch_mode": { "enum": ["in_background", "sync_only"] }
       }
     }$schema$::jsonb,
     TRUE
   )
 WHERE category = 'webhook_ingest_policy'
   AND is_active IS TRUE;

DO $schema_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.schema_registry sr
     WHERE sr.category = 'webhook_ingest_policy'
       AND sr.is_active IS TRUE
       AND sr.schema#>'{properties,workflow,properties,template_name}' IS NOT NULL
       AND sr.schema#>'{properties,workflow,properties,intent}' IS NOT NULL
       AND sr.schema#>'{properties,workflow,properties,templates_by_intent}' IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'active webhook_ingest_policy schema is missing current workflow binding fields';
  END IF;
END;
$schema_guard$;

DO $do$
DECLARE
  v_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770002'::uuid;
  v_scope RECORD;
  v_policy JSONB;
  v_workflow JSONB;
  v_templates JSONB;
  v_existing_binding JSONB;
  v_existing_ref TEXT;
  v_top_intent TEXT;
  v_resolved_binding UUID;
  v_should_rebind BOOLEAN;
  v_policy_applicable BOOLEAN;
  v_policy_count INTEGER := 0;
BEGIN
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    notes,
    metadata,
    published_at,
    updated_at
  )
  VALUES (
    v_template_id,
    'webhook_shipment_create_v1',
    'Materialize and geocode a shipment from an authenticated webhook shipment.create payload without outbound provider dispatch.',
    1,
    'active',
    'global',
    NULL,
    'Current-generation inbound shipment-create follow-up workflow.',
    jsonb_build_object(
      'intent', 'shipment.create',
      'entry_point', 'webhook',
      'provider_dispatch', FALSE,
      'shipment_create_geocode_lineage', 'shipment_update_geocode_v1'
    ),
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
     SET description = EXCLUDED.description,
         status = 'active',
         scope_type = 'global',
         scope_id = NULL,
         notes = EXCLUDED.notes,
         metadata = COALESCE(public.workflow_templates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         published_at = COALESCE(public.workflow_templates.published_at, EXCLUDED.published_at),
         updated_at = now();

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.id = v_template_id
       AND wt.name = 'webhook_shipment_create_v1'
       AND wt.status = 'active'
       AND wt.scope_type = 'global'
       AND wt.scope_id IS NULL
  ) THEN
    RAISE EXCEPTION 'webhook_shipment_create_v1 canonical template identity is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.workflow_template_steps wts
     WHERE wts.id IN (
       '77770000-0000-0000-0000-000000770021'::uuid,
       '77770000-0000-0000-0000-000000770022'::uuid,
       '77770000-0000-0000-0000-000000770023'::uuid,
       '77770000-0000-0000-0000-000000770024'::uuid,
       '77770000-0000-0000-0000-000000770025'::uuid
     )
       AND wts.workflow_template_id <> v_template_id
  ) THEN
    RAISE EXCEPTION 'webhook_shipment_create_v1 canonical step ids belong to another template';
  END IF;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    condition_jsonlogic,
    next_operation_name,
    next_operation_priority,
    next_operation_delay_seconds,
    manual_action_required,
    metadata,
    enabled,
    created_at,
    updated_at,
    handler_key,
    handler_version
  )
  VALUES
    (
      '77770000-0000-0000-0000-000000770021'::uuid,
      v_template_id,
      0,
      'context_extract_from_mapping',
      'workflow',
      'always',
      NULL,
      'reserve_identifiers',
      90,
      NULL,
      FALSE,
      '{}'::jsonb,
      TRUE,
      now(),
      now(),
      'context_extract_from_mapping',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770022'::uuid,
      v_template_id,
      1,
      'reserve_identifiers',
      'workflow',
      'always',
      NULL,
      'create_shipment',
      85,
      NULL,
      FALSE,
      jsonb_build_object('resource_type', 'shipment'),
      TRUE,
      now(),
      now(),
      'reserve_shipment_identifiers',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770023'::uuid,
      v_template_id,
      2,
      'create_shipment',
      'workflow',
      'always',
      NULL,
      'geocode_created_shipment',
      80,
      NULL,
      FALSE,
      '{}'::jsonb,
      TRUE,
      now(),
      now(),
      'shipment_create',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770025'::uuid,
      v_template_id,
      3,
      'geocode_created_shipment',
      'workflow',
      'always',
      NULL,
      'record_workflow_completion',
      75,
      NULL,
      FALSE,
      jsonb_build_object(
        'source', 'webhook_shipment_create_v1',
        'trigger_source', 'webhook_intake_v1',
        'lineage', 'shipment_create_address_geocode'
      ),
      TRUE,
      now(),
      now(),
      'shipment_update_geocode',
      'v1'
    ),
    (
      '77770000-0000-0000-0000-000000770024'::uuid,
      v_template_id,
      4,
      'record_workflow_completion',
      'workflow',
      'always',
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      jsonb_build_object(
        'action', 'complete',
        'status', 'completed',
        'handler_key', 'workflow_control'
      ),
      TRUE,
      now(),
      now(),
      'workflow_control',
      'v1'
    )
  ON CONFLICT (id) DO UPDATE
     SET workflow_template_id = EXCLUDED.workflow_template_id,
         sequence_order = EXCLUDED.sequence_order,
         operation_name = EXCLUDED.operation_name,
         operation_settings_category = EXCLUDED.operation_settings_category,
         transition_condition = EXCLUDED.transition_condition,
         condition_jsonlogic = EXCLUDED.condition_jsonlogic,
         next_operation_name = EXCLUDED.next_operation_name,
         next_operation_priority = EXCLUDED.next_operation_priority,
         next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
         manual_action_required = EXCLUDED.manual_action_required,
         metadata = EXCLUDED.metadata,
         enabled = EXCLUDED.enabled,
         updated_at = now(),
         handler_key = EXCLUDED.handler_key,
         handler_version = EXCLUDED.handler_version;

  UPDATE public.workflow_template_steps wts
     SET enabled = FALSE,
         metadata = jsonb_strip_nulls(
           COALESCE(wts.metadata, '{}'::jsonb)
           || jsonb_build_object('disabled_reason', 'superseded_noncanonical_inbound_step')
         ),
         updated_at = now()
   WHERE wts.workflow_template_id = v_template_id
     AND wts.id NOT IN (
       '77770000-0000-0000-0000-000000770021'::uuid,
       '77770000-0000-0000-0000-000000770022'::uuid,
       '77770000-0000-0000-0000-000000770023'::uuid,
       '77770000-0000-0000-0000-000000770024'::uuid,
       '77770000-0000-0000-0000-000000770025'::uuid
     )
     AND wts.enabled IS TRUE;

  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           COALESCE(sv.schema_version, 1) AS schema_version,
           COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'webhook_ingest_policy'
  LOOP
    v_policy_count := v_policy_count + 1;
    v_policy := COALESCE(v_scope.value, '{}'::jsonb);
    v_workflow := CASE
      WHEN jsonb_typeof(v_policy->'workflow') = 'object' THEN v_policy->'workflow'
      ELSE '{}'::jsonb
    END;
    v_templates := CASE
      WHEN jsonb_typeof(v_workflow->'templates_by_intent') = 'object' THEN v_workflow->'templates_by_intent'
      ELSE '{}'::jsonb
    END;
    v_existing_binding := v_templates->'shipment.create';
    v_existing_ref := NULL;
    v_top_intent := lower(NULLIF(btrim(COALESCE(v_workflow->>'intent', '')), ''));
    v_resolved_binding := NULL;
    v_should_rebind := FALSE;
    v_policy_applicable := public.webhook_policy_applies_to_shipment_intent_v1(
      v_policy,
      'shipment.create'
    );

    IF NOT v_policy_applicable THEN
      CONTINUE;
    END IF;

    IF v_existing_binding IS NULL
       AND v_top_intent IN ('shipment.create', 'shipment.created', 'shipment_create') THEN
      v_existing_ref := COALESCE(
        NULLIF(btrim(v_workflow->>'template_id'), ''),
        NULLIF(btrim(v_workflow->>'template_name'), '')
      );
      v_should_rebind := v_existing_ref IS NULL;
    ELSIF v_existing_binding IS NULL OR v_existing_binding = 'null'::jsonb THEN
      v_should_rebind := TRUE;
    ELSIF jsonb_typeof(v_existing_binding) = 'string' THEN
      v_existing_ref := NULLIF(btrim(v_existing_binding #>> '{}'), '');
      v_should_rebind := v_existing_ref IS NULL;
    ELSIF jsonb_typeof(v_existing_binding) = 'object' THEN
      v_existing_ref := COALESCE(
        NULLIF(btrim(v_existing_binding->>'template_id'), ''),
        NULLIF(btrim(v_existing_binding->>'template_name'), '')
      );
      v_should_rebind := v_existing_ref IS NULL;
    ELSE
      RAISE EXCEPTION
        'webhook shipment.create follow-up binding has unsupported shape for scope %/%',
        v_scope.scope_type,
        COALESCE(v_scope.scope_id::text, '<global>');
    END IF;

    IF NOT v_should_rebind THEN
      IF v_existing_ref IN (
        v_template_id::text,
        'webhook_shipment_create_v1'
      ) THEN
        v_should_rebind := FALSE;
      ELSIF v_existing_ref IN (
        '99990000-0000-0000-0000-000000300002',
        'async_provider_dispatch_v1'
      ) THEN
        v_should_rebind := TRUE;
      ELSE
        v_resolved_binding := public.resolve_active_workflow_template_ref_v1(v_existing_ref);
        IF v_resolved_binding IS NULL THEN
          RAISE EXCEPTION
            'webhook shipment.create custom follow-up is missing or inactive for scope %/%',
            v_scope.scope_type,
            COALESCE(v_scope.scope_id::text, '<global>');
        END IF;

        IF NOT public.workflow_template_supports_inbound_shipment_create_v1(v_resolved_binding) THEN
          RAISE EXCEPTION
            'webhook shipment.create custom follow-up is not an inbound shipment materializer for scope %/%',
            v_scope.scope_type,
            COALESCE(v_scope.scope_id::text, '<global>');
        END IF;
      END IF;
    END IF;

    IF v_should_rebind THEN
      v_templates := v_templates || jsonb_build_object(
        'shipment.create',
        jsonb_build_object(
          'template_id', v_template_id::text,
          'template_name', 'webhook_shipment_create_v1'
        )
      );
      v_policy := v_policy || jsonb_build_object(
        'workflow',
        v_workflow || jsonb_build_object('templates_by_intent', v_templates)
      );

      PERFORM 1
        FROM public.upsert_settings_value_v1(
          'webhook_ingest_policy',
          v_scope.scope_type,
          v_scope.scope_id,
          v_policy,
          v_scope.schema_version,
          'Bind shipment.create webhook follow-up to the current inbound materialization workflow'
        );
    END IF;
  END LOOP;

  IF v_policy_count = 0 THEN
    RAISE EXCEPTION 'webhook_ingest_policy settings missing';
  END IF;

  IF (
    SELECT array_agg(wts.id ORDER BY wts.sequence_order)
      FROM public.workflow_template_steps wts
     WHERE wts.workflow_template_id = v_template_id
       AND wts.enabled IS TRUE
  ) IS DISTINCT FROM ARRAY[
    '77770000-0000-0000-0000-000000770021'::uuid,
    '77770000-0000-0000-0000-000000770022'::uuid,
    '77770000-0000-0000-0000-000000770023'::uuid,
    '77770000-0000-0000-0000-000000770025'::uuid,
    '77770000-0000-0000-0000-000000770024'::uuid
  ] THEN
    RAISE EXCEPTION 'webhook_shipment_create_v1 enabled step sequence is not canonical';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL (
        SELECT public.resolve_webhook_followup_template_id_v1(
          COALESCE(s.cached_value, sv.value, '{}'::jsonb),
          'shipment.create'
        ) AS template_id
      ) resolved
      LEFT JOIN public.workflow_templates wt ON wt.id = resolved.template_id
     WHERE s.category = 'webhook_ingest_policy'
       AND public.webhook_policy_applies_to_shipment_intent_v1(
         COALESCE(s.cached_value, sv.value, '{}'::jsonb),
         'shipment.create'
       )
       AND (
         resolved.template_id IS NULL
         OR wt.id IS NULL
         OR wt.status <> 'active'
         OR (
           wt.id <> v_template_id
           AND NOT public.workflow_template_supports_inbound_shipment_create_v1(wt.id)
         )
       )
  ) THEN
    RAISE EXCEPTION 'webhook shipment.create follow-up policy contains an unresolved, inactive, or shared-dispatch binding';
  END IF;

  PERFORM public.workflow_refresh_steps_checksum(v_template_id, FALSE);
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202606132145_maps_sna_backend_lineage_source_slice_v1'));

COMMIT;
