-- Migration: Console V2 customer navigation discoverability
-- Purpose:
--   Clients, senders, and recipients are first-tenant P0 lifecycle surfaces.
--   Keep the live ui_navigation settings row-driven and canonical so operators
--   reach the customer workbenches through the Console V2 shell instead of
--   legacy raw resource routes or direct URLs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605111420_console_v2_customer_navigation_discoverability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_clean_items JSONB;
  v_section_id TEXT;
  v_has_customers BOOLEAN;
  v_customer_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'customers-clients',
      'key', 'customers-clients',
      'label', 'Clients',
      'href', '/customers/clients',
      'route', '/customers/clients',
      'resource', 'clients',
      'capability', 'clients.read',
      'icon', 'building'
    ),
    jsonb_build_object(
      'id', 'customers-senders',
      'key', 'customers-senders',
      'label', 'Senders',
      'href', '/customers/senders',
      'route', '/customers/senders',
      'resource', 'senders',
      'capability', 'senders.read',
      'icon', 'user_out'
    ),
    jsonb_build_object(
      'id', 'customers-recipients',
      'key', 'customers-recipients',
      'label', 'Recipients',
      'href', '/customers/recipients',
      'route', '/customers/recipients',
      'resource', 'recipients',
      'capability', 'recipients.read',
      'icon', 'user_in'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_customers := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := COALESCE(v_section->>'id', '');
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
        INTO v_clean_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
               '/console/resources/clients',
               '/console/resources/senders',
               '/console/resources/recipients',
               '/customers/clients',
               '/customers/senders',
               '/customers/recipients'
             )
         AND COALESCE(item.value->>'key', item.value->>'id', '') NOT IN (
               'clients',
               'senders',
               'recipients',
               'customers-clients',
               'customers-senders',
               'customers-recipients'
             );

      IF v_section_id = 'customers' THEN
        v_has_customers := TRUE;
        v_section := jsonb_set(
          v_section || jsonb_build_object('id', 'customers', 'label', 'Customers'),
          '{items}',
          v_clean_items || v_customer_items,
          TRUE
        );
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_clean_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_customers THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'customers',
          'label', 'Customers',
          'items', v_customer_items
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 customer workbenches in live navigation',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605111420_console_v2_customer_navigation_discoverability_v1'));

COMMIT;
