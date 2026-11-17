-- Migration: UI read registry shipment entities
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071430_ui_read_registry_shipment_entities'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','recipients',
      'label','Recipients',
      'relation','public.recipients',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id'),
      'capability_read','recipients.read',
      'select', jsonb_build_array(
        'id','organization_id','client_id','external_id','name','phone_number',
        'email','preferred_language','preferred_comm_channel','phone_validation_status',
        'phone_validation_message','phone_validated_at','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','name','column','name','op','ilike'),
        jsonb_build_object('key','phone_number','column','phone_number','op','ilike'),
        jsonb_build_object('key','email','column','email','op','ilike'),
        jsonb_build_object('key','external_id','column','external_id','op','ilike'),
        jsonb_build_object('key','client_id','column','client_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','addresses',
      'label','Addresses',
      'relation','public.addresses',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id'),
      'capability_read','addresses.read',
      'select', jsonb_build_array(
        'id','organization_id','client_id','raw_input','normalized_line1',
        'normalized_line2','district','city','province','postal_code','country',
        'building_number','additional_directions','validation_status',
        'correction_count','last_corrected_at','is_pii','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','raw_input','column','raw_input','op','ilike'),
        jsonb_build_object('key','district','column','district','op','ilike'),
        jsonb_build_object('key','city','column','city','op','ilike'),
        jsonb_build_object('key','province','column','province','op','ilike'),  
        jsonb_build_object('key','postal_code','column','postal_code','op','ilike'),
        jsonb_build_object('key','country','column','country','op','ilike'),    
        jsonb_build_object('key','validation_status','column','validation_status','op','eq'),
        jsonb_build_object('key','client_id','column','client_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','shipment_actions',
      'label','Shipment actions',
      'relation','public.shipment_actions',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id'),
      'capability_read','shipments.read',
      'select', jsonb_build_array(
        'id','shipment_id','action_type','action_category','canonical_status',
        'location_type','location_id','requires_investigation','investigation_status',
        'root_cause','resolution','resolved_at','performed_by_user_id',
        'performed_by_system','timestamp','created_at','organization_id','client_id'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
        jsonb_build_object('key','canonical_status','column','canonical_status','op','eq'),
        jsonb_build_object('key','action_type','column','action_type','op','eq'),
        jsonb_build_object('key','action_category','column','action_category','op','eq'),
        jsonb_build_object('key','requires_investigation','column','requires_investigation','op','eq')
      ),
      'default_sort', jsonb_build_object('column','timestamp','direction','desc')
    ),
    jsonb_build_object(
      'key','shipment_boxes',
      'label','Shipment boxes',
      'relation','public.shipment_boxes',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id'),
      'capability_read','shipments.read',
      'select', jsonb_build_array(
        'id','shipment_id','box_number','barcode','weight_kg','length_cm','width_cm',
        'height_cm','volumetric_weight_kg','fragile','hazmat','contents_description',
        'status','scanned_at','delivered_at','created_at','organization_id',
        'client_id'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
        jsonb_build_object('key','barcode','column','barcode','op','ilike'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','fragile','column','fragile','op','eq'),
        jsonb_build_object('key','hazmat','column','hazmat','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key','shipment_reference_numbers',
      'label','Shipment references',
      'relation','public.shipment_reference_numbers',
      'id_column','id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id'),
      'capability_read','shipments.read',
      'select', jsonb_build_array(
        'id','organization_id','client_id','shipment_id','reference_type',
        'reference_value','reference_value_upper','source_type','source_id',
        'created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
        jsonb_build_object('key','reference_type','column','reference_type','op','eq'),
        jsonb_build_object('key','reference_value','column','reference_value','op','ilike'),
        jsonb_build_object('key','source_type','column','source_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    )
  );
  v_resource JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = v_resource->>'key'
    ) THEN
      v_resources := v_resources || jsonb_build_array(v_resource);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add shipment entity resources to ui_read_registry',
        approved_at = now(),
        effective_from = now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = now()
  FROM applied
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601071430_ui_read_registry_shipment_entities'));
COMMIT;
