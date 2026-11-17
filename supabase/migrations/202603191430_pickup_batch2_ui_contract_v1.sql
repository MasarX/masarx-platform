-- Plan: B02 Pickup & first-mile handoff
-- Migration: Pickup batch 2 UI contract v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Expose pickup projections through the canonical api schema so Console/Portal
--     can read them through the default exposed-schema contract.
--   - Make pickup routes discoverable from row-driven ui_navigation on both
--     Console and Portal across every scoped ui_navigation row.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191430_pickup_batch2_ui_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE VIEW api.pickup_requests
WITH (security_invoker = true) AS
SELECT *
FROM public.pickup_requests;

CREATE OR REPLACE VIEW api.pickup_waves
WITH (security_invoker = true) AS
SELECT *
FROM public.pickup_waves;

CREATE OR REPLACE VIEW api.pickup_failures
WITH (security_invoker = true) AS
SELECT *
FROM public.pickup_failures;

REVOKE ALL ON api.pickup_requests FROM PUBLIC;
REVOKE ALL ON api.pickup_requests FROM anon;
REVOKE ALL ON api.pickup_requests FROM authenticated;
GRANT SELECT ON api.pickup_requests TO authenticated;
GRANT SELECT ON api.pickup_requests TO service_role;

REVOKE ALL ON api.pickup_waves FROM PUBLIC;
REVOKE ALL ON api.pickup_waves FROM anon;
REVOKE ALL ON api.pickup_waves FROM authenticated;
GRANT SELECT ON api.pickup_waves TO authenticated;
GRANT SELECT ON api.pickup_waves TO service_role;

REVOKE ALL ON api.pickup_failures FROM PUBLIC;
REVOKE ALL ON api.pickup_failures FROM anon;
REVOKE ALL ON api.pickup_failures FROM authenticated;
GRANT SELECT ON api.pickup_failures TO authenticated;
GRANT SELECT ON api.pickup_failures TO service_role;

DO $$
DECLARE
  v_settings RECORD;
  v_current JSONB;
  v_source_sections JSONB;
  v_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_has_operations BOOLEAN;
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
  v_operations_section JSONB;
BEGIN
  FOR v_settings IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_hash,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := v_settings.value;

    v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) = 'array' THEN
      v_sections := '[]'::jsonb;
      v_has_operations := FALSE;
      v_operations_section := jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_console_items
      );

      FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
        IF v_section ? 'items' THEN
          SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
            INTO v_items
            FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
           WHERE item->>'id' NOT IN (
             'console-pickup-requests',
             'console-pickup-waves',
             'console-pickup-failures'
           );
          v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
        END IF;

        IF v_section->>'id' = 'operations' THEN
          v_has_operations := TRUE;
          v_section := jsonb_set(
            v_section,
            '{items}',
            COALESCE(v_section->'items', '[]'::jsonb) || v_console_items,
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

      v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) = 'array' THEN
      v_sections := '[]'::jsonb;
      v_has_operations := FALSE;
      v_operations_section := jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', v_portal_items
      );

      FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
        IF v_section ? 'items' THEN
          SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
            INTO v_items
            FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
           WHERE item->>'id' NOT IN (
             'portal-pickup-requests',
             'portal-pickup-waves',
             'portal-pickup-failures'
           );
          v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
        END IF;

        IF v_section->>'id' = 'operations' THEN
          v_has_operations := TRUE;
          v_section := jsonb_set(
            v_section,
            '{items}',
            COALESCE(v_section->'items', '[]'::jsonb) || v_portal_items,
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
    END IF;

    IF v_current IS NOT DISTINCT FROM v_settings.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_settings.version + 1,
           change_reason = 'Expose pickup routes in every scoped ui_navigation row and api schema contract',
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

SELECT pg_advisory_unlock(hashtext('202603191430_pickup_batch2_ui_contract_v1'));
COMMIT;
