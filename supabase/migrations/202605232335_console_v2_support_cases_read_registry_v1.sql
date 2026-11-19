-- Console V2 Support Cases read-registry repair.
-- The Support Cases module reads canonical Support queue resources through
-- ui_read_registry; keep those resources gated by support.read instead of
-- unrelated operational capabilities or missing registry rows.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605232335_console_v2_support_cases_read_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $registry$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resource JSONB;
  v_updated INTEGER := 0;
  v_resources JSONB := '[
    {
      "key": "support_cases",
      "relation": "public.support_cases",
      "id_column": "id",
      "capability_read": "support.read",
      "capability_write": "support.write",
      "scope_columns": {"tenant": "organization_id", "client": "client_id", "sender": "sender_id"},
      "default_sort": {"column": "opened_at", "direction": "desc"},
      "filters": [
        {"key": "status", "column": "status", "op": "eq"},
        {"key": "priority", "column": "priority", "op": "eq"},
        {"key": "client_id", "column": "client_id", "op": "eq"},
        {"key": "sender_id", "column": "sender_id", "op": "eq"}
      ]
    },
    {
      "key": "support_case_directory",
      "relation": "public.v_support_case_directory",
      "id_column": "id",
      "capability_read": "support.read",
      "scope_columns": {"tenant": "organization_id", "client": "client_id", "sender": "sender_id"},
      "default_sort": {"column": "opened_at", "direction": "desc"},
      "filters": [
        {"key": "status", "column": "status", "op": "eq"},
        {"key": "priority", "column": "priority", "op": "eq"},
        {"key": "client_id", "column": "client_id", "op": "eq"},
        {"key": "sender_id", "column": "sender_id", "op": "eq"},
        {"key": "assigned_to", "column": "assigned_to", "op": "eq"},
        {"key": "shipment_tracking_number", "column": "shipment_tracking_number", "op": "ilike"}
      ]
    },
    {
      "key": "support_messages",
      "relation": "public.support_messages",
      "id_column": "id",
      "capability_read": "support.read",
      "capability_write": "support.write",
      "scope_columns": {"tenant": "organization_id"},
      "default_sort": {"column": "created_at", "direction": "asc"},
      "filters": [
        {"key": "support_case_id", "column": "support_case_id", "op": "eq"},
        {"key": "direction", "column": "direction", "op": "eq"},
        {"key": "channel", "column": "channel", "op": "eq"}
      ]
    },
    {
      "key": "support_message_directory",
      "relation": "public.v_support_message_directory",
      "id_column": "id",
      "capability_read": "support.read",
      "scope_columns": {"tenant": "organization_id"},
      "default_sort": {"column": "sent_at", "direction": "asc"},
      "filters": [
        {"key": "support_case_id", "column": "support_case_id", "op": "eq"},
        {"key": "direction", "column": "direction", "op": "eq"},
        {"key": "channel", "column": "channel", "op": "eq"}
      ]
    },
    {
      "key": "support_case_events",
      "relation": "public.support_case_events",
      "id_column": "id",
      "capability_read": "support.read",
      "scope_columns": {"tenant": "organization_id"},
      "default_sort": {"column": "created_at", "direction": "asc"},
      "filters": [
        {"key": "support_case_id", "column": "support_case_id", "op": "eq"},
        {"key": "event_type", "column": "event_type", "op": "eq"}
      ]
    },
    {
      "key": "support_users",
      "relation": "public.support_users",
      "id_column": "id",
      "capability_read": "support.read",
      "scope_columns": {"tenant": "organization_id"},
      "default_sort": {"column": "sort_order", "direction": "asc"},
      "filters": [
        {"key": "role", "column": "role", "op": "eq"},
        {"key": "status", "column": "status", "op": "eq"},
        {"key": "name", "column": "name", "op": "ilike"}
      ]
    }
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS registry_value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.registry_value, '{"resources":[]}'::jsonb);

    FOR v_resource IN
      SELECT value FROM jsonb_array_elements(v_resources) AS value
    LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
       WHERE value->>'key' <> v_resource->>'key';

      v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
    END LOOP;

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_row.settings_id;

    v_updated := v_updated + 1;
  END LOOP;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'ui_read_registry settings missing';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%';
END;
$registry$;

SELECT pg_advisory_unlock(hashtext('202605232335_console_v2_support_cases_read_registry_v1'));

COMMIT;
