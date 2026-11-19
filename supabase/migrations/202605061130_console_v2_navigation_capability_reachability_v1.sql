-- Console V2 navigation capability reachability.
-- Keeps primary navigation aligned with module-level read/review contracts so
-- valid operators can discover lifecycle workbenches by clicks.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061130_console_v2_navigation_capability_reachability_v1'));

DO $$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_path TEXT;
  v_has_integrations BOOLEAN;
  v_has_mapping BOOLEAN;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    v_new_sections := '[]'::jsonb;

    v_has_integrations := FALSE;

    FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      v_new_items := '[]'::jsonb;
      v_has_mapping := FALSE;

      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
        v_path := COALESCE(v_item->>'route', v_item->>'href');

        IF v_section->>'id' = 'integrations' THEN
          v_has_integrations := TRUE;
        END IF;

        IF v_path IN ('/integrations/mapping', '/console/resources/mapping_configs', '/console/resources/field_mappings') THEN
          IF v_has_mapping THEN
            CONTINUE;
          END IF;
          v_has_mapping := TRUE;
          v_item := jsonb_build_object(
            'id', 'int-mapping',
            'key', 'int-mapping',
            'label', 'Mapping studio',
            'icon', 'git',
            'href', '/integrations/mapping',
            'route', '/integrations/mapping',
            'capability', 'mappings.read'
          );
        ELSIF v_path = '/platform/organizations' THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('organizations.read'::text), true);
          v_item := jsonb_set(
            v_item,
            '{capabilities}',
            jsonb_build_array('organizations.read', 'tenant_signup_requests.read'),
            true
          );
        END IF;

        v_new_items := v_new_items || jsonb_build_array(v_item);
      END LOOP;

      IF v_section->>'id' = 'integrations' AND v_has_mapping IS FALSE THEN
        v_new_items := v_new_items || jsonb_build_array(jsonb_build_object(
          'id', 'int-mapping',
          'key', 'int-mapping',
          'label', 'Mapping studio',
          'icon', 'git',
          'href', '/integrations/mapping',
          'route', '/integrations/mapping',
          'capability', 'mappings.read'
        ));
      END IF;

      v_new_sections := v_new_sections || jsonb_build_array(jsonb_set(v_section, '{items}', v_new_items, true));
    END LOOP;

    IF v_has_integrations IS FALSE THEN
      v_new_sections := v_new_sections || jsonb_build_array(jsonb_build_object(
        'id', 'integrations',
        'label', 'Integrations',
        'items', jsonb_build_array(jsonb_build_object(
          'id', 'int-mapping',
          'key', 'int-mapping',
          'label', 'Mapping studio',
          'icon', 'git',
          'href', '/integrations/mapping',
          'route', '/integrations/mapping',
          'capability', 'mappings.read'
        ))
      ));
    END IF;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_new_sections, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Align Console V2 navigation capability reachability',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_current IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_current IS DISTINCT FROM s.cached_value;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605061130_console_v2_navigation_capability_reachability_v1'));

COMMIT;
