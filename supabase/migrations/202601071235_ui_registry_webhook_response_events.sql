-- Migration: Align UI registry/nav with webhook response events view
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071235_ui_registry_webhook_response_events'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_response_resource JSONB := jsonb_build_object(
    'key','webhook_response_events',
    'label','Webhook responses',
    'relation','public.webhook_response_events',
    'id_column','decision_log_id',
    'scope_columns', jsonb_build_object('tenant','organization_id'),
    'capability_read','webhooks.read',
    'select', jsonb_build_array(
      'decision_log_id','webhook_inbox_id','organization_id','response_outcome','response_reason',
      'response_mode','http_status_code','http_headers','http_body','validation_results',
      'idempotency_key','workflow_run_id','workflow_run_step_id','followup_workflow_run_id',
      'response_created_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','webhook_inbox_id','column','webhook_inbox_id','op','eq'),
      jsonb_build_object('key','response_outcome','column','response_outcome','op','eq'),
      jsonb_build_object('key','response_mode','column','response_mode','op','eq'),
      jsonb_build_object('key','http_status_code','column','http_status_code','op','eq')
    ),
    'default_sort', jsonb_build_object('column','response_created_at','direction','desc')
  );
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
      SELECT jsonb_agg(value)
      FROM jsonb_array_elements(v_resources) AS value
      WHERE value->>'key' NOT IN ('webhook_rules', 'webhook_response_history')
    ),
    '[]'::jsonb
  );

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resources) AS value
    WHERE value->>'key' = 'webhook_response_events'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_response_resource);
  END IF;

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
        change_reason = 'Align ui_read_registry webhook responses to events view',
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
  v_response_item JSONB := jsonb_build_object(
    'id', 'console-webhook-responses',
    'label', 'Webhook responses',
    'href', '/console/resources/webhook_response_events',
    'resource', 'webhook_response_events',
    'capability', 'webhooks.read'
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
        WHERE item->>'resource' NOT IN ('webhook_rules', 'webhook_response_history')
      ),
      '[]'::jsonb
    );

    IF v_section->>'id' = 'integrations' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'resource' = 'webhook_response_events'
      ) THEN
        v_items := v_items || jsonb_build_array(v_response_item);
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
        change_reason = 'Align ui_navigation webhook responses to events view',
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

DO $$
DECLARE
  v_current JSONB;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  v_resource_map := v_resource_map - 'webhook_rules';
  v_resource_map := v_resource_map - 'webhook_response_history';

  IF NOT (v_resource_map ? 'webhook_response_events') THEN
    v_resource_map := jsonb_set(
      v_resource_map,
      '{webhook_response_events}',
      jsonb_build_object('read','webhooks.read'),
      true
    );
  END IF;

  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Align access_control_policy webhook responses to events view',
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
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601071235_ui_registry_webhook_response_events'));
COMMIT;
