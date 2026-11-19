-- Console V2 Users live registry for the user-directory projection.
--
-- The Users/RBAC drawer reads user_directory alongside users so operators see
-- organization labels and active RBAC role rollups from the canonical
-- v_user_directory projection. The projection view already exists; this makes
-- it available through the canonical ui_read_registry path for live Console V2.

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := '{}'::jsonb;
  v_resources JSONB := '[]'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_resource JSONB := jsonb_build_object(
    'key', 'user_directory',
    'relation', 'public.v_user_directory',
    'id_column', 'id',
    'capability_read', 'users.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'allow_view_relation', TRUE,
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'user_type', 'column', 'user_type', 'op', 'eq'),
      jsonb_build_object('key', 'access_scope_type', 'column', 'access_scope_type', 'op', 'eq'),
      jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike')
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      v_current := '{}'::jsonb;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_resources := (
      SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb)
        FROM jsonb_array_elements(v_resources) AS item(value)
       WHERE item.value->>'key' <> 'user_directory'
    ) || jsonb_build_array(v_resource);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'console v2 users user_directory registry',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;
