-- Console V2 navigation route closure.
-- Keeps the DB-backed ui_navigation registry aligned with Console V2 domain
-- workbenches so live command-palette discovery does not fall back to stale
-- legacy /console/resources/* routes or omit operator modules.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605052055_console_v2_navigation_routes_v1'));

DO $$
DECLARE
  v_routes JSONB := jsonb_build_array(
    jsonb_build_object('section_id', 'network', 'section_label', 'Network', 'id', 'network-geocoding', 'label', 'Geocoding', 'icon', 'pin', 'path', '/network/geocoding', 'capability', 'addresses.read'),
    jsonb_build_object('section_id', 'network', 'section_label', 'Network', 'id', 'network-zones', 'label', 'Zones', 'icon', 'map', 'path', '/network/zones', 'capability', 'zones.read'),
    jsonb_build_object('section_id', 'network', 'section_label', 'Network', 'id', 'network-marketplace', 'label', 'Marketplace', 'icon', 'shopping-bag', 'path', '/network/marketplace', 'capability', 'marketplace.read'),
    jsonb_build_object('section_id', 'network', 'section_label', 'Network', 'id', 'network-branches', 'label', 'Branches', 'icon', 'building', 'path', '/network/branches', 'capability', 'branches.read'),
    jsonb_build_object('section_id', 'support', 'section_label', 'Support', 'id', 'support-cases', 'label', 'Support cases', 'icon', 'message', 'path', '/support/cases', 'capability', 'support.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-settlements', 'label', 'Settlements', 'icon', 'bolt', 'path', '/finance/settlements', 'capability', 'settlements.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-cod', 'label', 'COD reconciliation', 'icon', 'check', 'path', '/finance/cod', 'capability', 'cod.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-ledger', 'label', 'Ledger', 'icon', 'file', 'path', '/finance/ledger', 'capability', 'finance.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-bank-recon', 'label', 'Bank reconciliation', 'icon', 'database', 'path', '/finance/bank-recon', 'capability', 'finance.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-disputes', 'label', 'Disputes', 'icon', 'flag', 'path', '/finance/disputes', 'capability', 'disputes.read'),
    jsonb_build_object('section_id', 'finance', 'section_label', 'Finance', 'id', 'finance-billing', 'label', 'Billing', 'icon', 'invoice', 'path', '/finance/billing', 'capability', 'billing.read'),
    jsonb_build_object('section_id', 'integrations', 'section_label', 'Integrations', 'id', 'integrations-plugin-studio', 'label', 'Plugin studio', 'icon', 'edit', 'path', '/integrations/plugin-studio', 'capability', 'integrations.write'),
    jsonb_build_object('section_id', 'integrations', 'section_label', 'Integrations', 'id', 'integrations-sources', 'label', 'Webhook sources', 'icon', 'plug', 'path', '/integrations/sources', 'capability', 'webhooks.read'),
    jsonb_build_object('section_id', 'integrations', 'section_label', 'Integrations', 'id', 'integrations-rules', 'label', 'Routing rules', 'icon', 'route', 'path', '/integrations/rules', 'capability', 'webhooks.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-config', 'label', 'Configuration', 'icon', 'settings', 'path', '/platform/config', 'capability', 'settings.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-organizations', 'label', 'Organizations', 'icon', 'building', 'path', '/platform/organizations', 'capability', 'organizations.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-mobile-policy', 'label', 'Mobile policies', 'icon', 'shield', 'path', '/platform/mobile-policy', 'capability', 'settings.write'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-labels', 'label', 'Labels & templates', 'icon', 'file', 'path', '/platform/labels', 'capability', 'labels.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-warehouse', 'label', 'Warehouse transfers', 'icon', 'warehouse', 'path', '/platform/warehouse', 'capability', 'warehouse.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-auth-email', 'label', 'Auth email policy', 'icon', 'lock', 'path', '/platform/auth-email', 'capability', 'settings.write'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-release-proof', 'label', 'Release proof', 'icon', 'shield', 'path', '/platform/release-proof', 'capability', 'settings.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-planning-os', 'label', 'Planning OS', 'icon', 'kanban', 'path', '/platform/planning-os', 'capability', NULL),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-commands', 'label', 'Commands', 'icon', 'cmd', 'path', '/platform/commands', 'capability', NULL),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-alerts', 'label', 'Alerts', 'icon', 'bell', 'path', '/platform/alerts', 'capability', 'alerts.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-feature-flags', 'label', 'Feature flags', 'icon', 'flag', 'path', '/platform/feature-flags', 'capability', 'feature_flags.read'),
    jsonb_build_object('section_id', 'platform', 'section_label', 'Platform', 'id', 'platform-users', 'label', 'Users', 'icon', 'user', 'path', '/platform/users', 'capability', 'users.read')
  );
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_route JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_found_section BOOLEAN;
  v_found_item BOOLEAN;
  v_route_item JSONB;
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

    FOR v_route IN SELECT * FROM jsonb_array_elements(v_routes) LOOP
      v_route_item := jsonb_strip_nulls(jsonb_build_object(
        'id', v_route->>'id',
        'key', v_route->>'id',
        'label', v_route->>'label',
        'icon', v_route->>'icon',
        'href', v_route->>'path',
        'route', v_route->>'path',
        'capability', v_route->'capability'
      ));
      v_new_sections := '[]'::jsonb;
      v_found_section := FALSE;

      FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
        IF v_section->>'id' = v_route->>'section_id' THEN
          v_found_section := TRUE;
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          v_new_items := '[]'::jsonb;
          v_found_item := FALSE;

          FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
            IF v_item->>'id' = v_route->>'id'
               OR v_item->>'key' = v_route->>'id'
               OR v_item->>'href' = v_route->>'path'
               OR v_item->>'route' = v_route->>'path' THEN
              v_new_items := v_new_items || jsonb_build_array(v_item || v_route_item);
              v_found_item := TRUE;
            ELSE
              v_new_items := v_new_items || jsonb_build_array(v_item);
            END IF;
          END LOOP;

          IF v_found_item IS FALSE THEN
            v_new_items := v_new_items || jsonb_build_array(v_route_item);
          END IF;

          v_section := jsonb_set(
            v_section || jsonb_build_object(
              'id', v_route->>'section_id',
              'label', v_route->>'section_label'
            ),
            '{items}',
            v_new_items,
            true
          );
        END IF;

        v_new_sections := v_new_sections || jsonb_build_array(v_section);
      END LOOP;

      IF v_found_section IS FALSE THEN
        v_new_sections := v_new_sections || jsonb_build_array(jsonb_build_object(
          'id', v_route->>'section_id',
          'label', v_route->>'section_label',
          'items', jsonb_build_array(v_route_item)
        ));
      END IF;

      v_sections := v_new_sections;
    END LOOP;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Align Console V2 navigation routes',
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

SELECT pg_advisory_unlock(hashtext('202605052055_console_v2_navigation_routes_v1'));

COMMIT;
