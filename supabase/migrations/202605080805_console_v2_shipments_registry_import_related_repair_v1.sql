-- Console V2 shipment intake/read registry repair.
--
-- Shipment import and drawer context must be backend-configured through
-- ui_read_registry. This keeps manual/import intake and shipment supervision
-- screens row-driven instead of relying on frontend literals.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605080805_console_v2_shipments_registry_import_related_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated JSONB;
  v_resource JSONB;
  v_related JSONB;
  v_required_related JSONB := jsonb_build_array(
    jsonb_build_object(
      'resource', 'shipment_boxes',
      'label', 'Boxes',
      'filter_key', 'shipment_id',
      'from', 'id',
      'limit', 25
    ),
    jsonb_build_object(
      'resource', 'labels',
      'label', 'Labels',
      'filter_key', 'shipment_id',
      'from', 'id',
      'limit', 25
    ),
    jsonb_build_object(
      'resource', 'shipment_reference_numbers',
      'label', 'References',
      'filter_key', 'shipment_id',
      'from', 'id',
      'limit', 25
    )
  );
  v_related_item JSONB;
  v_import JSONB := jsonb_build_object(
    'enabled', TRUE,
    'capability', 'shipments.write',
    'accepted_formats', jsonb_build_array('csv', 'xls', 'xlsx'),
    'allow_upsert', FALSE,
    'identity_columns', jsonb_build_array('tracking_number', 'client_reference_number'),
    'default_write_mode', 'create'
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

        v_related := COALESCE(v_resource->'related', '[]'::jsonb);
        IF jsonb_typeof(v_related) <> 'array' THEN
          v_related := '[]'::jsonb;
        END IF;

        FOR v_related_item IN SELECT value FROM jsonb_array_elements(v_required_related) AS value
        LOOP
          IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(v_related) AS existing(value)
             WHERE existing.value->>'resource' = v_related_item->>'resource'
          ) THEN
            v_related := v_related || jsonb_build_array(v_related_item);
          END IF;
        END LOOP;

        v_resource := jsonb_set(v_resource, '{related}', v_related, TRUE);
      END IF;

      v_updated := v_updated || jsonb_build_array(v_resource);
    END LOOP;

    v_current := jsonb_set(v_current, '{resources}', v_updated, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = sv.version + 1,
           change_reason = 'Repair Console V2 shipments import and related drawer registry',
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

SELECT pg_advisory_unlock(hashtext('202605080805_console_v2_shipments_registry_import_related_repair_v1'));
COMMIT;
