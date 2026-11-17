BEGIN;

SELECT pg_advisory_lock(hashtext('202603091260_public_tracking_portal_navigation_scopes_v1'));

DO $$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_source_sections JSONB;
  v_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_has_operations BOOLEAN;
  v_operations_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-customer-shipment-changes',
      'label', 'Customer shipment changes',
      'href', '/portal/operations/customer-shipment-changes',
      'resource', 'customer_shipment_changes',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-public-tracking-requests',
      'label', 'Public tracking requests',
      'href', '/portal/operations/public-tracking-requests',
      'resource', 'customer_shipment_changes',
      'capability', 'shipments.read'
    )
  );
  v_operations_section JSONB := jsonb_build_object(
    'id', 'operations',
    'label', 'Operations',
    'items', v_operations_items
  );
BEGIN
  FOR v_settings IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      s.scope_hash,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := v_settings.value;
    v_source_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);

    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;

    FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' NOT IN (
           'portal-customer-shipment-changes',
           'portal-public-tracking-requests'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_operations_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(v_sections->0, v_operations_section) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(v_operations_section) || v_sections;
      END IF;
    END IF;

    v_current := jsonb_set(v_current, '{apps,portal,sections}', v_sections, TRUE);

    IF v_current IS NOT DISTINCT FROM v_settings.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_settings.version + 1,
           change_reason = 'Ensure portal shipment change routes are visible in every scoped ui_navigation row',
           approved_at = workflow_now(),
           effective_from = workflow_now()
     WHERE id = v_settings.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = workflow_now()
     WHERE category = v_settings.category
       AND scope_type = v_settings.scope_type
       AND scope_hash = v_settings.scope_hash;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202603091260_public_tracking_portal_navigation_scopes_v1'));

COMMIT;
