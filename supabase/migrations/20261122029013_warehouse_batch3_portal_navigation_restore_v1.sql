-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: warehouse Batch 3 portal navigation restore
-- Purpose:
--   - Restore Portal discoverability for Batch 3 handling units and scan events.
--   - Preserve the newer grouped Console navigation without duplicating existing entries.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029013_warehouse_batch3_portal_navigation_restore_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_source_sections JSONB;
  v_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_has_operations BOOLEAN;
  v_existing_ids TEXT[];
  v_candidate JSONB;
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-warehouse-transfers',
      'label', 'Warehouse Transfers',
      'href', '/portal/resources/warehouse_transfers',
      'resource', 'warehouse_transfers',
      'capability', 'warehouse_transfers.read'
    ),
    jsonb_build_object(
      'id', 'portal-handling-units',
      'label', 'Handling Units',
      'href', '/portal/resources/handling_units',
      'resource', 'handling_units',
      'capability', 'handling_units.read'
    ),
    jsonb_build_object(
      'id', 'portal-scan-events',
      'label', 'Scan Events',
      'href', '/portal/resources/scan_events',
      'resource', 'scan_events',
      'capability', 'scan_events.read'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_navigation'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    SELECT COALESCE(array_agg(DISTINCT item.value->>'id'), ARRAY[]::TEXT[])
      INTO v_existing_ids
      FROM jsonb_array_elements(v_source_sections) AS section(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
     WHERE NULLIF(btrim(COALESCE(item.value->>'id', '')), '') IS NOT NULL;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_items := COALESCE(v_section->'items', '[]'::jsonb);

        FOR v_candidate IN
          SELECT value
          FROM jsonb_array_elements(v_portal_items) AS value
        LOOP
          IF NOT (COALESCE(v_candidate->>'id', '') = ANY(v_existing_ids)) THEN
            v_items := v_items || jsonb_build_array(v_candidate);
            v_existing_ids := v_existing_ids || COALESCE(v_candidate->>'id', '');
          END IF;
        END LOOP;

        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_navigation', v_row.scope_type, v_row.scope_id,
        v_next, v_row.schema_version, 'Restore Portal warehouse Batch 3 handling-unit and scan-event navigation.'
      );
    END IF;
  END LOOP;
END;
$do$;


COMMIT;
