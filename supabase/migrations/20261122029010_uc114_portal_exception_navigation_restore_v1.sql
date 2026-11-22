-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: UC114 portal navigation restore
-- Purpose:
--   - Replay the task-backed NDR exception lanes after later navigation cleanup.
--   - Keep Portal operator exception ownership and SLA queues discoverable from the shared navigation registry.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029010_uc114_portal_exception_navigation_restore_v1'));
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
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-dispatch-exception-review',
      'label', 'Dispatch Exception Review',
      'href', '/portal/operations/exceptions/dispatch_exception_review',
      'resource', 'dispatch_exception_review',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-dispatch-exception-review-mine',
      'label', 'My Exception Reviews',
      'href', '/portal/operations/exceptions/dispatch_exception_review_mine',
      'resource', 'dispatch_exception_review_mine',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-unassigned-exceptions',
      'label', 'Unassigned Exceptions',
      'href', '/portal/operations/exceptions/unassigned_exceptions',
      'resource', 'unassigned_exceptions',
      'capability', 'tasks.read'
    ),
    jsonb_build_object(
      'id', 'portal-sla-deadline-alerts',
      'label', 'SLA Deadline Alerts',
      'href', '/portal/operations/exceptions/sla_deadline_alerts',
      'resource', 'sla_deadline_alerts',
      'capability', 'tasks.read'
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

    SELECT COALESCE(jsonb_agg(candidate.value ORDER BY candidate.ordinal), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(v_portal_items) WITH ORDINALITY AS candidate(value, ordinal)
     WHERE NOT EXISTS (
       SELECT FROM jsonb_array_elements(v_source_sections) AS section(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.value->'items', '[]'::jsonb)) AS item(value)
       WHERE item.value->>'resource' = candidate.value->>'resource'
          OR item.value->>'id' = candidate.value->>'id'
     );
    IF v_items = '[]'::jsonb THEN CONTINUE; END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_navigation', v_row.scope_type, v_row.scope_id,
        v_next, v_row.schema_version, 'Restore UC114 portal task-backed exception navigation lanes after domain navigation cleanup.'
      );
    END IF;
  END LOOP;
END;
$do$;


COMMIT;
