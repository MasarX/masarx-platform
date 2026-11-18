-- Console V2 shipment lifecycle registry scope repair.
--
-- Platform operators can switch the Console V2 tenant lens before onboarding
-- traffic. The shipment workbench and create composer must therefore be able
-- to pass explicit organization/client/sender filters to the canonical
-- ui_list_resource_v1 read path instead of relying on browser-side filtering
-- or global platform visibility.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061330_console_v2_shipment_scope_registry_filters_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
  v_lifecycle_resources JSONB[] := ARRAY[
    jsonb_build_object(
      'key', 'shipments',
      'label', 'Shipments',
      'relation', 'public.shipments',
      'id_column', 'id',
      'capability_read', 'shipments.read',
      'capability_write', 'shipments.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'sender_id', 'column', 'sender_id', 'op', 'eq'),
        jsonb_build_object('key', 'identifier', 'column', 'id', 'op', 'eq', 'resolver', 'shipment_identifier'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'tracking_number', 'column', 'tracking_number', 'op', 'ilike'),
        jsonb_build_object('key', 'client_reference_number', 'column', 'client_reference_number', 'op', 'ilike'),
        jsonb_build_object('key', 'carrier_reference_number', 'column', 'carrier_reference_number', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'shipment_directory',
      'label', 'Shipment directory',
      'relation', 'public.v_shipment_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'shipments.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'sender_id', 'column', 'sender_id', 'op', 'eq'),
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'tracking_number', 'column', 'tracking_number', 'op', 'ilike'),
        jsonb_build_object('key', 'client_reference_number', 'column', 'client_reference_number', 'op', 'ilike'),
        jsonb_build_object('key', 'carrier_reference_number', 'column', 'carrier_reference_number', 'op', 'ilike'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'service_offering_directory',
      'label', 'Service offering directory',
      'relation', 'public.v_service_offering_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'service_offerings.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
        jsonb_build_object('key', 'service_level_id', 'column', 'service_level_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'zone_id', 'column', 'zone_id', 'op', 'eq'),
        jsonb_build_object('key', 'level_key', 'column', 'level_key', 'op', 'eq'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq'),
        jsonb_build_object('key', 'effective_status', 'column', 'effective_status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'display_name', 'direction', 'asc')
    )
  ];
BEGIN
  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOREACH v_resource IN ARRAY v_lifecycle_resources
    LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS value
       WHERE value->>'key' <> v_resource->>'key';

      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Add Console V2 shipment lifecycle scope filters to ui_read_registry',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.settings_id;
    END IF;
  END LOOP;
END $do$;

SELECT pg_advisory_unlock(hashtext('202605061330_console_v2_shipment_scope_registry_filters_v1'));

COMMIT;
