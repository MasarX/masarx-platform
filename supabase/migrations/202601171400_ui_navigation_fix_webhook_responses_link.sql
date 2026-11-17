-- Migration: Fix console navigation webhook responses link to use decision_log (RLS-safe)
-- Purpose:
-- - Remove ui_read_registry resource that points at a view (webhook_response_events), which is disallowed by ui_list_resource_v1.
-- - Add a console navigation item that links to decision_log filtered to http_response_emitted webhook inbox events.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601171400_ui_navigation_fix_webhook_responses_link'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  v_resources := COALESCE(
    (
      SELECT jsonb_agg(resource)
      FROM jsonb_array_elements(v_resources) AS resource
      WHERE resource->>'key' <> 'webhook_response_events'
    ),
    '[]'::jsonb
  );

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Remove webhook_response_events UI resource (view is not RLS-safe)',
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
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_item JSONB := jsonb_build_object(
    'id', 'console-webhook-responses',
    'label', 'Webhook responses',
    'href', '/console/resources/decision_log?decision_category=http_response_emitted&resource_type=webhook_inbox',
    'resource', 'decision_log',
    'capability', 'audit_log.read'
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

  FOR v_section IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_current->'apps'->'console'->'sections', '[]'::jsonb))
  LOOP
    v_items := COALESCE(v_section->'items', '[]'::jsonb);
    v_items := COALESCE(
      (
        SELECT jsonb_agg(item)
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'resource' <> 'webhook_response_events'
      ),
      '[]'::jsonb
    );

    IF v_section->>'id' = 'observability' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'console-webhook-responses'
      ) THEN
        v_items := v_items || jsonb_build_array(v_item);
      END IF;
    END IF;

    v_section := jsonb_set(v_section, '{items}', v_items, true);
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

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
        change_reason = 'Fix console webhook responses nav link (use decision_log filtered)',
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

SELECT pg_advisory_unlock(hashtext('202601171400_ui_navigation_fix_webhook_responses_link'));
COMMIT;

