-- Migration: pickup navigation scope sync
-- Purpose:
--   - Restore the pickup Batch 2 navigation contract across every ui_navigation
--     scope after later navigation rewrites drifted the pickup entries out.
--   - Keep the sync limited to the pickup routes so newer operations items stay
--     intact.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102080_pickup_navigation_scope_sync_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_app_key TEXT := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_updated_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
  v_has_operations BOOLEAN := FALSE;
  v_console_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-pickup-requests',
      'label', 'Pickup requests',
      'href', '/console/operations/pickups/requests',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'console-pickup-waves',
      'label', 'Pickup waves',
      'href', '/console/operations/pickups/waves',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'console-pickup-failures',
      'label', 'Pickup failures',
      'href', '/console/operations/pickups/failures',
      'capability', 'shipments.read'
    )
  );
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-pickup-requests',
      'label', 'Pickup requests',
      'href', '/portal/operations/pickups/requests',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-pickup-waves',
      'label', 'Pickup waves',
      'href', '/portal/operations/pickups/waves',
      'capability', 'shipments.read'
    ),
    jsonb_build_object(
      'id', 'portal-pickup-failures',
      'label', 'Pickup failures',
      'href', '/portal/operations/pickups/failures',
      'capability', 'shipments.read'
    )
  );
  v_operations_section JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_next := v_current;

    FOREACH v_app_key IN ARRAY ARRAY['console', 'portal'] LOOP
      v_sections := COALESCE(v_next #> ARRAY['apps', v_app_key, 'sections'], '[]'::jsonb);
      IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
        CONTINUE;
      END IF;

      v_has_operations := FALSE;
      v_updated_sections := '[]'::jsonb;

      FOR v_section IN
        SELECT value
        FROM jsonb_array_elements(v_sections) AS value
      LOOP
        IF v_section->>'id' = 'operations' THEN
          v_has_operations := TRUE;
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
            v_items := '[]'::jsonb;
          END IF;

          v_items := (
            SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
            FROM jsonb_array_elements(v_items) AS item
            WHERE COALESCE(item->>'id', '') NOT IN (
              CASE WHEN v_app_key = 'console' THEN 'console-pickup-requests' ELSE 'portal-pickup-requests' END,
              CASE WHEN v_app_key = 'console' THEN 'console-pickup-waves' ELSE 'portal-pickup-waves' END,
              CASE WHEN v_app_key = 'console' THEN 'console-pickup-failures' ELSE 'portal-pickup-failures' END
            )
          );

          v_items := v_items || CASE
            WHEN v_app_key = 'console' THEN v_console_items
            ELSE v_portal_items
          END;

          v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
        END IF;

        v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
      END LOOP;

      IF NOT v_has_operations THEN
        v_operations_section := jsonb_build_object(
          'id', 'operations',
          'label', 'Operations',
          'items', CASE
            WHEN v_app_key = 'console' THEN v_console_items
            ELSE v_portal_items
          END
        );

        IF jsonb_array_length(v_updated_sections) > 0 AND (v_updated_sections->0->>'id') = 'home' THEN
          v_updated_sections :=
            jsonb_build_array(v_updated_sections->0, v_operations_section) || (v_updated_sections - 0);
        ELSE
          v_updated_sections := jsonb_build_array(v_operations_section) || v_updated_sections;
        END IF;
      END IF;

      v_next := jsonb_set(v_next, ARRAY['apps', v_app_key, 'sections'], v_updated_sections, TRUE);
    END LOOP;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Resync pickup routes across every scoped ui_navigation row.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604102080_pickup_navigation_scope_sync_v1'));

COMMIT;
