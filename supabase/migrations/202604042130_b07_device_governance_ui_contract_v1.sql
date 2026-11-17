-- Plan: PLAN-202604-b07-device-governance-ui-contract / Step: S01
-- Migration: B07 device governance UI contract v1
-- Date: 2026-04-04
--
-- Goals:
--   - Make tenant ops users with capability-based access able to read organization user_devices.
--   - Allow authorized Console/Portal operators to revoke visible devices without widening ui_execute_command_v1.
--   - Expose user_devices through access_control_policy, ui_read_registry, ui_command_registry, and ui_navigation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604042130_b07_device_governance_ui_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) user_devices visibility + revoke authorization
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS user_devices_select ON public.user_devices;
CREATE POLICY user_devices_select ON public.user_devices
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND (
        user_id = auth.uid()
        OR public.user_has_capability_v1(
          'user_devices.read',
          public.current_user_scope_type(),
          public.current_user_scope_id()
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.revoke_user_device_v1(
  p_device JSONB
)
RETURNS TABLE (
  device_id UUID,
  revoked BOOLEAN,
  revoked_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_claims JSONB;
  v_role TEXT := NULL;
  v_in JSONB := COALESCE(p_device, '{}'::jsonb);
  v_device_id UUID := NULL;
  v_reason TEXT := NULL;
  v_device RECORD;
  v_revoke_at TIMESTAMPTZ := NULL;
  v_revoke_changed BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'revoke_user_device_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  v_device_id := NULLIF(btrim(COALESCE(v_in->>'device_id', '')), '')::UUID;
  v_reason := NULLIF(btrim(COALESCE(v_in->>'revoked_reason', '')), '');

  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 missing device_id' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 missing revoked_reason' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := lower(NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''));

  SELECT ud.id, ud.organization_id, ud.user_id, ud.revoked_at
    INTO v_device
    FROM public.user_devices ud
   WHERE ud.id = v_device_id
   LIMIT 1;

  IF v_device.id IS NULL THEN
    RAISE EXCEPTION 'revoke_user_device_v1 device % not found', v_device_id USING ERRCODE = '23503';
  END IF;

  IF v_role IS DISTINCT FROM 'service_role' THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'revoke_user_device_v1 requires an authenticated user' USING ERRCODE = '42501';
    END IF;

    IF v_device.user_id IS DISTINCT FROM v_user THEN
      IF v_org IS NULL OR v_device.organization_id IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'revoke_user_device_v1 device % is outside current organization', v_device_id USING ERRCODE = '42501';
      END IF;

      PERFORM public.assert_capability_v1('user_devices.write', v_scope_type, v_scope_id);
    END IF;
  END IF;

  IF v_device.revoked_at IS NULL THEN
    UPDATE public.user_devices d
       SET revoked_at = now(),
           revoked_by_user_id = COALESCE(v_user, d.revoked_by_user_id),
           revoked_reason = v_reason,
           push_token = NULL,
           updated_at = now()
     WHERE d.id = v_device_id
     RETURNING d.revoked_at INTO v_revoke_at;
    v_revoke_changed := TRUE;
  ELSE
    v_revoke_at := v_device.revoked_at;
  END IF;

  RETURN QUERY
  SELECT v_device_id, v_revoke_changed, v_revoke_at;
END;
$function$;

COMMENT ON FUNCTION public.revoke_user_device_v1(JSONB)
  IS 'Sticky revoke for a registered user device. Owners may self-revoke, and authorized same-org operators may revoke visible devices for support/governance flows.';
REVOKE ALL ON FUNCTION public.revoke_user_device_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_device_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_user_device_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Dedicated UI revoke executor (same UI payload contract; separate RPC)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_user_device_revoke_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_reason TEXT := NULL;
  v_selection_id_text TEXT;
  v_selection_uuid UUID := NULL;
  v_visible_device JSONB := NULL;
  v_revocation_row RECORD;
  v_results JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  v_reason := NULLIF(btrim(COALESCE(v_params->>'revoked_reason', '')), '');

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 requires revoked_reason';
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::uuid;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 invalid device id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    v_visible_device := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
    IF v_visible_device IS NULL THEN
      RAISE EXCEPTION 'ui_execute_user_device_revoke_v1 device % is not visible in resource %', v_selection_uuid, p_resource_key
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_revocation_row
      FROM public.revoke_user_device_v1(
        jsonb_build_object(
          'device_id', v_selection_uuid,
          'revoked_reason', v_reason
        )
      )
     LIMIT 1;

    v_results := v_results || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'device_id', v_revocation_row.device_id,
          'revoked', v_revocation_row.revoked,
          'revoked_at', v_revocation_row.revoked_at
        )
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'revoked',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', jsonb_array_length(v_results),
    'items', v_results
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_user_device_revoke_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Revoke visible user_devices from Console/Portal without widening ui_execute_command_v1.';

CREATE OR REPLACE FUNCTION api.ui_execute_user_device_revoke_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_execute_user_device_revoke_v1($1, $2, $3, $4, $5, $6);
$$;

REVOKE ALL ON FUNCTION api.ui_execute_user_device_revoke_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_user_device_revoke_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_user_device_revoke_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) access_control_policy: capabilities, role wiring, resource map
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_role_caps JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_capability JSONB;
  v_new_capabilities JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'user_devices.read',
      'label', 'User devices read',
      'category', 'operations',
      'description', 'Read registered Field Ops device records and revocation state.'
    ),
    jsonb_build_object(
      'key', 'user_devices.write',
      'label', 'User devices write',
      'category', 'operations',
      'description', 'Revoke registered Field Ops devices for governance and support flows.'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_capabilities) IS DISTINCT FROM 'array' THEN
      v_capabilities := '[]'::jsonb;
    END IF;

    FOR v_capability IN
      SELECT value
      FROM jsonb_array_elements(v_new_capabilities) AS value
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_capabilities) AS item
        WHERE item->>'key' = v_capability->>'key'
      ) THEN
        v_capabilities := v_capabilities || jsonb_build_array(v_capability);
      END IF;
    END LOOP;

    v_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) AS value
    LOOP
      IF lower(COALESCE(v_role->>'key', '')) = 'ops_admin' THEN
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
          v_role_caps := '[]'::jsonb;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_role_caps) AS value
          WHERE value IN ('user_devices.read', '*')
        ) THEN
          v_role_caps := v_role_caps || jsonb_build_array('user_devices.read');
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_role_caps) AS value
          WHERE value IN ('user_devices.write', '*')
        ) THEN
          v_role_caps := v_role_caps || jsonb_build_array('user_devices.write');
        END IF;

        v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      END IF;

      v_roles := v_roles || jsonb_build_array(v_role);
    END LOOP;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{user_devices}',
      public.deep_merge_jsonb(
        jsonb_build_object(
          'read', 'user_devices.read',
          'write', 'user_devices.write'
        ),
        COALESCE(v_resource_map->'user_devices', '{}'::jsonb)
      ),
      TRUE
    );

    v_next := jsonb_set(v_current, '{capabilities}', v_capabilities, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);
    v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose user_devices governance capabilities through access_control_policy.',
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

-------------------------------------------------------------------------------
-- 4) ui_read_registry: user_devices resource across all scopes
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_resource_key TEXT := NULL;
  v_canonical_resource JSONB := jsonb_build_object(
    'key', 'user_devices',
    'label', 'User Devices',
    'relation', 'public.user_devices',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'user_devices.read',
    'capability_write', 'user_devices.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'user_id',
      'device_platform',
      'device_label',
      'app_version',
      'os_version',
      'last_seen_at',
      'revoked_at',
      'revoked_by_user_id',
      'revoked_reason',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
      jsonb_build_object('key', 'device_platform', 'column', 'device_platform', 'op', 'eq'),
      jsonb_build_object('key', 'device_label', 'column', 'device_label', 'op', 'ilike'),
      jsonb_build_object('key', 'revoked_reason', 'column', 'revoked_reason', 'op', 'ilike')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'user_id', 'label', 'User', 'render_type', 'id', 'detail_section', 'Ownership'),
      jsonb_build_object('key', 'device_platform', 'label', 'Platform', 'detail_section', 'Device'),
      jsonb_build_object('key', 'device_label', 'label', 'Device label', 'detail_section', 'Device'),
      jsonb_build_object('key', 'app_version', 'label', 'App version', 'detail_section', 'Device'),
      jsonb_build_object('key', 'os_version', 'label', 'OS version', 'detail_section', 'Device'),
      jsonb_build_object('key', 'last_seen_at', 'label', 'Last seen', 'detail_section', 'Activity'),
      jsonb_build_object('key', 'revoked_at', 'label', 'Revoked at', 'detail_section', 'Revocation'),
      jsonb_build_object('key', 'revoked_by_user_id', 'label', 'Revoked by', 'render_type', 'id', 'detail_section', 'Revocation'),
      jsonb_build_object('key', 'revoked_reason', 'label', 'Revoked reason', 'detail_section', 'Revocation'),
      jsonb_build_object('key', 'created_at', 'label', 'Created at', 'detail_section', 'Activity')
    ),
    'column_labels', jsonb_build_object(
      'user_id', 'User',
      'device_platform', 'Platform',
      'device_label', 'Device label',
      'app_version', 'App version',
      'os_version', 'OS version',
      'last_seen_at', 'Last seen',
      'revoked_at', 'Revoked at',
      'revoked_by_user_id', 'Revoked by',
      'revoked_reason', 'Revoked reason',
      'created_at', 'Created at'
    ),
    'default_sort', jsonb_build_object('column', 'last_seen_at', 'direction', 'desc')
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
      IF v_resource_key = 'user_devices' THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resource, v_resource);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_updated_resources) AS item
      WHERE item->>'key' = 'user_devices'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose user_devices governance resource through ui_read_registry.',
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

-------------------------------------------------------------------------------
-- 5) ui_command_registry: user_devices revoke command across all scopes
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['user_devices.revoke'],
    jsonb_build_object(
      'key', 'user_devices.revoke',
      'label', 'Revoke device',
      'description', 'Revoke the selected device so future Field Ops ingest is blocked.',
      'capability', 'user_devices.write',
      'schema_category', 'resource:user_devices',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_user_device_revoke_v1',
        'params', jsonb_build_object(
          'revoked_reason', 'revoked by console or portal operator'
        ),
        'confirm', jsonb_build_object(
          'title', 'Revoke device?',
          'description', 'This blocks future Field Ops ingest and clears the selected device push token.',
          'confirm_label', 'Revoke device',
          'cancel_label', 'Cancel',
          'tone', 'danger'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'user_devices.revoke' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item
      WHERE item->>'key' = 'user_devices.revoke'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'user_devices.revoke');
    END IF;

    v_next_commands := COALESCE(v_next_commands, '[]'::jsonb);
    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose user_devices revoke command through ui_command_registry.',
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

-------------------------------------------------------------------------------
-- 6) ui_navigation: user_devices in Console + Portal operations
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_source_sections JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB := '[]'::jsonb;
  v_has_operations BOOLEAN := FALSE;
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-user-devices',
    'label', 'User Devices',
    'href', '/console/resources/user_devices',
    'resource', 'user_devices',
    'capability', 'user_devices.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-user-devices',
    'label', 'User Devices',
    'href', '/portal/resources/user_devices',
    'resource', 'user_devices',
    'capability', 'user_devices.read'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' <> 'console-user-devices';
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || jsonb_build_array(v_console_item),
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_console_item))
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_console_item))
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

    v_source_sections := COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE item->>'id' <> 'portal-user-devices';
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || jsonb_build_array(v_portal_item),
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_portal_item))
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', jsonb_build_array(v_portal_item))
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose user_devices governance lane through ui_navigation.',
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

SELECT pg_advisory_unlock(hashtext('202604042130_b07_device_governance_ui_contract_v1'));
COMMIT;
