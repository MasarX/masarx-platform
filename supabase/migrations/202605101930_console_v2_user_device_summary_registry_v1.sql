-- Console V2 user-device summary registry.
--
-- The Users/RBAC drawer and Mobile policies device roster both read the
-- backend-backed v_user_device_summary projection. This keeps device activity
-- visible through the canonical ui_read_registry path instead of the planned
-- user_sessions seed-only seam.

BEGIN;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'user_device_summary',
    'relation', 'public.v_user_device_summary',
    'id_column', 'id',
    'capability_read', 'user_devices.read',
    'capability_write', 'user_devices.write',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'allow_view_relation', TRUE,
    'default_sort', jsonb_build_object('column', 'last_seen_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
      jsonb_build_object('key', 'device_id', 'column', 'device_id', 'op', 'ilike'),
      jsonb_build_object('key', 'platform', 'column', 'platform', 'op', 'eq'),
      jsonb_build_object('key', 'attestation_status', 'column', 'attestation_status', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'device_id', 'label', 'Device', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'user_id', 'label', 'User', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'platform', 'label', 'Platform', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'model', 'label', 'Model', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'os_version', 'label', 'OS', 'sortable', TRUE),
      jsonb_build_object('key', 'attestation_status', 'label', 'Attestation', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'last_seen_at', 'label', 'Last seen', 'format', 'datetime', 'sortable', TRUE)
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{"resources":[]}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      v_current := '{"resources":[]}'::jsonb;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_resources
      FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS resource(value, ordinality)
     WHERE resource.value->>'key' <> 'user_device_summary';

    v_next := jsonb_set(v_current, '{resources}', v_resources || jsonb_build_array(v_resource), TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 user_device_summary registry resource',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
