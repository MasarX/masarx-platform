-- Migration: UI navigation operations + integrations + reference data
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071210_ui_navigation_integrations'));
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
  v_has_integrations BOOLEAN := FALSE;
  v_has_reference BOOLEAN := FALSE;
  v_has_label_design BOOLEAN := FALSE;
  v_has_observability BOOLEAN := FALSE;
  v_operations_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-zones',
      'label', 'Zones',
      'href', '/console/resources/zones',
      'resource', 'zones',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'console-zone-districts',
      'label', 'Zone districts',
      'href', '/console/resources/zone_districts',
      'resource', 'zone_districts',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'console-baskets',
      'label', 'Baskets',
      'href', '/console/resources/baskets',
      'resource', 'baskets',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'console-basket-items',
      'label', 'Basket items',
      'href', '/console/resources/basket_items',
      'resource', 'basket_items',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'console-basket-transitions',
      'label', 'Basket transitions',
      'href', '/console/resources/basket_transitions',
      'resource', 'basket_transitions',
      'capability', 'baskets.read'
    )
  );
  v_integrations_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-providers',
      'label', 'Providers',
      'href', '/console/resources/providers',
      'resource', 'providers',
      'capability', 'integrations.read'
    ),
    jsonb_build_object(
      'id', 'console-operation-templates',
      'label', 'Operation templates',
      'href', '/console/resources/operation_templates',
      'resource', 'operation_templates',
      'capability', 'integrations.read'
    ),
    jsonb_build_object(
      'id', 'console-mapping-configs',
      'label', 'Mapping configs',
      'href', '/console/resources/mapping_configs',
      'resource', 'mapping_configs',
      'capability', 'mappings.read'
    ),
    jsonb_build_object(
      'id', 'console-field-mappings',
      'label', 'Field mappings',
      'href', '/console/resources/field_mappings',
      'resource', 'field_mappings',
      'capability', 'mappings.read'
    ),
    jsonb_build_object(
      'id', 'console-webhook-sources',
      'label', 'Webhook sources',
      'href', '/console/resources/webhook_sources',
      'resource', 'webhook_sources',
      'capability', 'webhooks.read'
    ),
    jsonb_build_object(
      'id', 'console-webhook-rules',
      'label', 'Webhook rules',
      'href', '/console/resources/webhook_rules',
      'resource', 'webhook_rules',
      'capability', 'webhooks.read'
    ),
    jsonb_build_object(
      'id', 'console-webhook-inbox',
      'label', 'Webhook inbox',
      'href', '/console/resources/webhook_inbox',
      'resource', 'webhook_inbox',
      'capability', 'webhooks.read'
    ),
    jsonb_build_object(
      'id', 'console-webhook-responses',
      'label', 'Webhook responses',
      'href', '/console/resources/webhook_response_history',
      'resource', 'webhook_response_history',
      'capability', 'webhooks.read'
    ),
    jsonb_build_object(
      'id', 'console-api-route-packs',
      'label', 'API route packs',
      'href', '/console/resources/api_route_packs',
      'resource', 'api_route_packs',
      'capability', 'api_routes.read'
    ),
    jsonb_build_object(
      'id', 'console-api-routes',
      'label', 'API routes',
      'href', '/console/resources/api_routes',
      'resource', 'api_routes',
      'capability', 'api_routes.read'
    )
  );
  v_reference_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-lookup-definitions',
      'label', 'Lookup definitions',
      'href', '/console/resources/lookup_definitions',
      'resource', 'lookup_definitions',
      'capability', 'lookups.read'
    ),
    jsonb_build_object(
      'id', 'console-lookup-values',
      'label', 'Lookup values',
      'href', '/console/resources/lookup_values',
      'resource', 'lookup_values',
      'capability', 'lookups.read'
    )
  );
  v_label_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-label-sections',
      'label', 'Label sections',
      'href', '/console/resources/label_sections',
      'resource', 'label_sections',
      'capability', 'label_design.read'
    ),
    jsonb_build_object(
      'id', 'console-label-tokens',
      'label', 'Label tokens',
      'href', '/console/resources/label_design_tokens',
      'resource', 'label_design_tokens',
      'capability', 'label_design.read'
    ),
    jsonb_build_object(
      'id', 'console-label-validation',
      'label', 'Label validation',
      'href', '/console/resources/label_template_validation',
      'resource', 'label_template_validation',
      'capability', 'label_design.read'
    )
  );
  v_observability_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-webhook-log',
      'label', 'Webhook log',
      'href', '/console/resources/webhook_log',
      'resource', 'webhook_log',
      'capability', 'audit_log.read'
    ),
    jsonb_build_object(
      'id', 'console-api-call-log',
      'label', 'API call log',
      'href', '/console/resources/api_call_log',
      'resource', 'api_call_log',
      'capability', 'audit_log.read'
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

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_base) LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_operations_items) LOOP
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

    IF v_section->>'id' = 'integrations' THEN
      v_has_integrations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_integrations_items) LOOP
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

    IF v_section->>'id' = 'reference-data' THEN
      v_has_reference := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_reference_items) LOOP
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

    IF v_section->>'id' = 'label-design' THEN
      v_has_label_design := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_label_items) LOOP
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

    IF v_section->>'id' = 'observability' THEN
      v_has_observability := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_observability_items) LOOP
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
        'items', v_operations_items
      )
    );
  END IF;

  IF v_has_integrations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'integrations',
        'label', 'Integrations',
        'items', v_integrations_items
      )
    );
  END IF;

  IF v_has_reference IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'reference-data',
        'label', 'Reference data',
        'items', v_reference_items
      )
    );
  END IF;

  IF v_has_label_design IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'label-design',
        'label', 'Label design',
        'items', v_label_items
      )
    );
  END IF;

  IF v_has_observability IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'observability',
        'label', 'Observability',
        'items', v_observability_items
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

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
        change_reason = 'Add operations, integrations, and reference navigation',
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

SELECT pg_advisory_unlock(hashtext('202601071210_ui_navigation_integrations'));
COMMIT;
