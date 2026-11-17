-- Migration: UI navigation shipment entity resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071520_ui_navigation_shipment_entities'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_base JSONB;
  v_section JSONB;
  v_items JSONB;
  v_candidate JSONB;
  v_has_operations BOOLEAN := FALSE;
  v_has_shipments BOOLEAN := FALSE;
  v_console_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-recipients',
      'label', 'Recipients',
      'href', '/console/resources/recipients',
      'resource', 'recipients',
      'capability', 'recipients.read'
    ),
    jsonb_build_object(
      'id', 'console-addresses',
      'label', 'Addresses',
      'href', '/console/resources/addresses',
      'resource', 'addresses',
      'capability', 'addresses.read'
    ),
    jsonb_build_object(
      'id', 'console-shipment-actions',
      'label', 'Shipment actions',
      'href', '/console/resources/shipment_actions',
      'resource', 'shipment_actions',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'console-shipment-boxes',
      'label', 'Shipment boxes',
      'href', '/console/resources/shipment_boxes',
      'resource', 'shipment_boxes',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'console-shipment-references',
      'label', 'Shipment references',
      'href', '/console/resources/shipment_reference_numbers',
      'resource', 'shipment_reference_numbers',
      'capability', 'shipments.read'
    )
  );
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-recipients',
      'label', 'Recipients',
      'href', '/portal/resources/recipients',
      'resource', 'recipients',
      'capability', 'recipients.read'
    ),
    jsonb_build_object(
      'id', 'portal-addresses',
      'label', 'Addresses',
      'href', '/portal/resources/addresses',
      'resource', 'addresses',
      'capability', 'addresses.read'
    ),
    jsonb_build_object(
      'id', 'portal-shipment-actions',
      'label', 'Shipment actions',
      'href', '/portal/resources/shipment_actions',
      'resource', 'shipment_actions',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-shipment-boxes',
      'label', 'Shipment boxes',
      'href', '/portal/resources/shipment_boxes',
      'resource', 'shipment_boxes',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-shipment-references',
      'label', 'Shipment references',
      'href', '/portal/resources/shipment_reference_numbers',
      'resource', 'shipment_reference_numbers',
      'capability', 'shipments.read'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_base := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
  v_sections := '[]'::jsonb;

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_console_items) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_operations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_console_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

  v_base := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
  v_sections := '[]'::jsonb;
  v_has_shipments := FALSE;

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'shipments' THEN
      v_has_shipments := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_portal_items) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_shipments IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'shipments',
        'label', 'Shipments',
        'items', v_portal_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_sections, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add shipment entity resources to ui_navigation',
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
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601071520_ui_navigation_shipment_entities'));
COMMIT;
