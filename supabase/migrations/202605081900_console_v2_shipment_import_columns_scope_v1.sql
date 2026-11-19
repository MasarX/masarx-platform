-- Console V2 shipment file imports need a real row-driven shipment field
-- contract. The previous repair enabled shipments.import but left the live
-- resource with an empty columns array, so CSV/XLS/XLSX rows could prepare
-- without mapping into shipment creation fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605081900_console_v2_shipment_import_columns_scope_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated JSONB;
  v_resource JSONB;
  v_columns JSONB;
  v_column JSONB;
  v_existing JSONB;
  v_next_columns JSONB;
  v_import JSONB := jsonb_build_object(
    'enabled', TRUE,
    'capability', 'shipments.write',
    'accepted_formats', jsonb_build_array('csv', 'xls', 'xlsx'),
    'allow_upsert', FALSE,
    'identity_columns', jsonb_build_array('tracking_number', 'client_reference_number'),
    'default_write_mode', 'create'
  );
  v_required_columns JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'tracking_number',
      'label', 'Tracking #',
      'sortable', TRUE,
      'filterable', TRUE,
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', TRUE,
        'identity', TRUE,
        'aliases', jsonb_build_array('tracking_number', 'tracking', 'tracking #', 'awb', 'waybill', 'shipment_number'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'client_reference_number',
      'label', 'Client ref',
      'sortable', TRUE,
      'filterable', TRUE,
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', TRUE,
        'aliases', jsonb_build_array('client_reference_number', 'client_ref', 'order_number', 'order_id', 'reference'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'carrier_reference_number',
      'label', 'Carrier ref',
      'sortable', TRUE,
      'filterable', TRUE,
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('carrier_reference_number', 'carrier_ref', 'provider_reference', 'provider_ref'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'client_id',
      'label', 'Client',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('client_id', 'client'),
        'coercions', jsonb_build_array('trim', 'null'),
        'reference', jsonb_build_object(
          'resource', 'clients',
          'relation', 'public.clients',
          'id_column', 'id',
          'label', 'Clients',
          'label_column', 'name',
          'display_columns', jsonb_build_array('name', 'slug', 'status')
        )
      )
    ),
    jsonb_build_object(
      'key', 'sender_id',
      'label', 'Sender',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('sender_id', 'sender'),
        'coercions', jsonb_build_array('trim', 'null'),
        'reference', jsonb_build_object(
          'resource', 'senders',
          'relation', 'public.senders',
          'id_column', 'id',
          'label', 'Senders',
          'label_column', 'name',
          'display_columns', jsonb_build_array('name', 'brand_name', 'status')
        )
      )
    ),
    jsonb_build_object(
      'key', 'recipient_id',
      'label', 'Recipient',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('recipient_id', 'recipient'),
        'coercions', jsonb_build_array('trim', 'null'),
        'reference', jsonb_build_object(
          'resource', 'recipients',
          'relation', 'public.recipients',
          'id_column', 'id',
          'label', 'Recipients',
          'label_column', 'name',
          'display_columns', jsonb_build_array('name', 'phone_number', 'external_id'),
          'allow_inline_node', TRUE,
          'inline_node_key', 'recipient',
          'inline_node_label', 'Recipient',
          'mapping_prefixes', jsonb_build_array('recipient', 'recipient_'),
          'match_fields', jsonb_build_array('external_id', 'phone_number', 'email'),
          'create_mode', 'match_or_create'
        )
      )
    ),
    jsonb_build_object(
      'key', 'destination_address_id',
      'label', 'Destination address',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('destination_address_id', 'destination_address', 'address'),
        'coercions', jsonb_build_array('trim', 'null'),
        'reference', jsonb_build_object(
          'resource', 'addresses',
          'relation', 'public.addresses',
          'id_column', 'id',
          'label', 'Addresses',
          'label_column', 'raw_input',
          'display_columns', jsonb_build_array('raw_input', 'city', 'district', 'postal_code'),
          'allow_inline_node', TRUE,
          'inline_node_key', 'destination_address',
          'inline_node_label', 'Destination address',
          'mapping_prefixes', jsonb_build_array('destination_address', 'destination', 'address'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        )
      )
    ),
    jsonb_build_object(
      'key', 'origin_address_id',
      'label', 'Origin address',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('origin_address_id', 'origin_address', 'origin'),
        'coercions', jsonb_build_array('trim', 'null'),
        'reference', jsonb_build_object(
          'resource', 'addresses',
          'relation', 'public.addresses',
          'id_column', 'id',
          'label', 'Addresses',
          'label_column', 'raw_input',
          'display_columns', jsonb_build_array('raw_input', 'city', 'district', 'postal_code'),
          'allow_inline_node', TRUE,
          'inline_node_key', 'origin_address',
          'inline_node_label', 'Origin address',
          'mapping_prefixes', jsonb_build_array('origin_address', 'origin'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        )
      )
    ),
    jsonb_build_object(
      'key', 'service_type',
      'label', 'Service',
      'filterable', TRUE,
      'lookup', 'service_type',
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('service_type', 'service'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'status',
      'label', 'Status',
      'filterable', TRUE,
      'lookup', 'shipment_status',
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('status', 'shipment_status'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'box_count',
      'label', 'Boxes',
      'align', 'right',
      'mono', TRUE,
      'edit_mode', 'inline',
      'edit_type', 'number',
      'render_type', 'number',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('box_count', 'boxes', 'pieces'),
        'coercions', jsonb_build_array('trim', 'null', 'number')
      )
    ),
    jsonb_build_object(
      'key', 'cod_amount',
      'label', 'COD',
      'align', 'right',
      'mono', TRUE,
      'format', 'currency',
      'edit_mode', 'inline',
      'edit_type', 'number',
      'render_type', 'currency',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('cod_amount', 'cod', 'cash_on_delivery'),
        'coercions', jsonb_build_array('trim', 'null', 'number')
      )
    ),
    jsonb_build_object(
      'key', 'cod_currency',
      'label', 'COD currency',
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('cod_currency', 'currency'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    ),
    jsonb_build_object(
      'key', 'promised_delivery_date',
      'label', 'Promised',
      'format', 'date',
      'edit_mode', 'inline',
      'edit_type', 'date',
      'render_type', 'date',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('promised_delivery_date', 'promised_date', 'delivery_date'),
        'coercions', jsonb_build_array('trim', 'null', 'date')
      )
    ),
    jsonb_build_object(
      'key', 'special_instructions',
      'label', 'Instructions',
      'edit_mode', 'inline',
      'edit_type', 'text',
      'render_type', 'text',
      'import', jsonb_build_object(
        'enabled', TRUE,
        'required', FALSE,
        'identity', FALSE,
        'aliases', jsonb_build_array('special_instructions', 'instructions', 'notes'),
        'coercions', jsonb_build_array('trim', 'null')
      )
    )
  );
BEGIN
  FOR v_settings IN
    SELECT s.settings_version_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_settings.cached_value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated := '[]'::jsonb;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'shipments' THEN
        v_resource := jsonb_set(v_resource, '{capability_write}', to_jsonb('shipments.write'::text), TRUE);
        v_resource := jsonb_set(
          v_resource,
          '{import}',
          public.deep_merge_jsonb(v_import, COALESCE(v_resource->'import', '{}'::jsonb)),
          TRUE
        );

        v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
        IF jsonb_typeof(v_columns) <> 'array' THEN
          v_columns := '[]'::jsonb;
        END IF;
        v_next_columns := v_columns;

        FOR v_column IN SELECT value FROM jsonb_array_elements(v_required_columns) AS value
        LOOP
          SELECT existing.value
            INTO v_existing
            FROM jsonb_array_elements(v_next_columns) AS existing(value)
           WHERE existing.value->>'key' = v_column->>'key'
           LIMIT 1;

          IF v_existing IS NULL THEN
            v_next_columns := v_next_columns || jsonb_build_array(v_column);
          ELSE
            v_next_columns := (
              SELECT jsonb_agg(
                       CASE
                         WHEN item.value->>'key' = v_column->>'key'
                           THEN public.deep_merge_jsonb(v_column, item.value)
                         ELSE item.value
                       END
                     )
                FROM jsonb_array_elements(v_next_columns) AS item(value)
            );
          END IF;
          v_existing := NULL;
        END LOOP;

        v_resource := jsonb_set(v_resource, '{columns}', COALESCE(v_next_columns, v_required_columns), TRUE);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_updated, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = sv.version + 1,
           change_reason = 'Repair Console V2 shipments CSV/XLS/XLSX import field contract',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_settings.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.settings_version_id = v_settings.settings_version_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605081900_console_v2_shipment_import_columns_scope_v1'));
COMMIT;
