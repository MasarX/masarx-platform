-- Console V2 plugin deactivate lifecycle.
-- Adds a row-driven deactivate action for active plugin versions, disables
-- runtime bindings through the existing runtime toggle helper, and preserves
-- the version as approved so operators can reactivate it later.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292230_console_v2_plugin_deactivate_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'plugin_status'
),
active_status AS (
  SELECT lv.id,
         COALESCE(lv.metadata, '{}'::jsonb) AS metadata
    FROM public.lookup_values lv
    JOIN def ON def.id = lv.lookup_definition_id
   WHERE lv.value = 'active'
)
UPDATE public.lookup_values lv
   SET metadata = CASE
         WHEN COALESCE(active_status.metadata->'next_actions', '[]'::jsonb) ? 'deactivate'
           THEN active_status.metadata
         ELSE jsonb_set(
           active_status.metadata,
           '{next_actions}',
           COALESCE(active_status.metadata->'next_actions', '[]'::jsonb) || '["deactivate"]'::jsonb,
           TRUE
         )
       END,
       updated_at = now()
  FROM active_status
 WHERE lv.id = active_status.id;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'integration_plugin_status'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from
)
SELECT
  def.id,
  'disabled',
  'Disabled',
  'Plugin runtime bindings are disabled and no version is active.',
  45,
  FALSE,
  'active',
  '{}'::jsonb,
  now()
FROM def
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    effective_until = NULL,
    retired_at = NULL,
    updated_at = now();

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'integration_plugin_approval_action'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from
)
SELECT
  def.id,
  'deactivated',
  'Deactivated',
  'Active plugin runtime bindings disabled and active version cleared.',
  55,
  FALSE,
  'active',
  '{}'::jsonb,
  now()
FROM def
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    effective_until = NULL,
    retired_at = NULL,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.plugin_deactivate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_user_id uuid := auth.uid();
  v_correlation_id uuid := gen_random_uuid();
  v_settings_resolution_id uuid := gen_random_uuid();
  v_plugin_id uuid;
  v_requested_version_id uuid;
  v_active_version_id uuid;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_changed integer := 0;
  v_binding_count integer := 0;
  v_reason text;
  v_artifact_hash text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires p_args object'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_plugin_id := COALESCE(
      NULLIF(v_args->>'plugin_id', ''),
      NULLIF(v_args->>'integration_plugin_id', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_plugin_id := NULL;
  END;

  IF v_plugin_id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 requires plugin_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_requested_version_id := COALESCE(
      NULLIF(v_args->>'plugin_version_id', ''),
      NULLIF(v_args->>'integration_plugin_version_id', ''),
      NULLIF(v_args->>'active_version_id', '')
    )::uuid;
  EXCEPTION WHEN others THEN
    v_requested_version_id := NULL;
  END;

  v_reason := NULLIF(btrim(COALESCE(v_args->>'reason', '')), '');

  SELECT *
    INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_plugin_id
   FOR UPDATE;

  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 plugin % not found', v_plugin_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  v_active_version_id := v_plugin.active_version_id;
  IF v_active_version_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'already_processed', TRUE,
      'plugin_id', v_plugin.id,
      'integration_plugin_id', v_plugin.id,
      'status', v_plugin.status,
      'changed_count', 0,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_settings_resolution_id
    );
  END IF;

  IF v_requested_version_id IS NOT NULL AND v_requested_version_id <> v_active_version_id THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 version % is not active for plugin %', v_requested_version_id, v_plugin.id
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = v_active_version_id
     AND plugin_id = v_plugin.id
   FOR UPDATE;

  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'plugin_deactivate_v1 active version % not found for plugin %', v_active_version_id, v_plugin.id
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*)::integer
    INTO v_binding_count
    FROM public.integration_plugin_bindings
   WHERE plugin_version_id = v_version.id;

  v_changed := public.integration_plugin_set_binding_runtime_enabled_v1(v_version.id, FALSE, NULL, NULL);

  v_artifact_hash := COALESCE(
    v_version.artifact_hash,
    public.integration_plugin_hash_payload_v1(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id
    ))
  );

  UPDATE public.integration_plugin_versions
     SET status = CASE WHEN status = 'active' THEN 'approved' ELSE status END,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{deactivation}',
           jsonb_strip_nulls(jsonb_build_object(
             'deactivated_at', now(),
             'deactivated_by', v_user_id,
             'reason', v_reason,
             'changed_count', v_changed,
             'binding_count', v_binding_count
           )),
           TRUE
         ),
         updated_by = v_user_id,
         updated_at = now()
   WHERE id = v_version.id;

  UPDATE public.integration_plugins
     SET status = 'disabled',
         active_version_id = NULL,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{deactivation}',
           jsonb_strip_nulls(jsonb_build_object(
             'plugin_version_id', v_version.id,
             'deactivated_at', now(),
             'deactivated_by', v_user_id,
             'reason', v_reason,
             'changed_count', v_changed,
             'binding_count', v_binding_count
           )),
           TRUE
         ),
         updated_by = v_user_id,
         updated_at = now()
   WHERE id = v_plugin.id;

  INSERT INTO public.integration_plugin_approval_events (
    plugin_version_id,
    organization_id,
    action,
    actor_user_id,
    reason,
    diff_hash,
    artifact_hash,
    payload
  )
  VALUES (
    v_version.id,
    v_plugin.organization_id,
    'deactivated',
    v_user_id,
    v_reason,
    public.integration_plugin_hash_payload_v1(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'previous_status', v_plugin.status,
      'previous_active_version_id', v_plugin.active_version_id,
      'changed_count', v_changed,
      'binding_count', v_binding_count
    )),
    v_artifact_hash,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'previous_status', v_plugin.status,
      'previous_active_version_id', v_plugin.active_version_id,
      'version_status', 'approved',
      'status', 'disabled',
      'changed_count', v_changed,
      'binding_count', v_binding_count
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'action', 'deactivated',
    'plugin_id', v_plugin.id,
    'integration_plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'integration_plugin_version_id', v_version.id,
    'status', 'disabled',
    'version_status', 'approved',
    'changed_count', v_changed,
    'binding_count', v_binding_count,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.plugin_deactivate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.plugin_deactivate_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION public.plugin_deactivate_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plugin_deactivate_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.plugin_deactivate_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.plugin_deactivate_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.plugin_deactivate_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.plugin_deactivate_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.plugin_deactivate_v1(jsonb)
  IS 'Console V2 plugin lifecycle RPC: disables active runtime bindings, clears active_version_id, preserves the active version as approved, and writes a deactivated approval event. Capability: integration_plugins.activate.';
COMMENT ON FUNCTION api.plugin_deactivate_v1(jsonb)
  IS 'Console V2 api-schema wrapper for public.plugin_deactivate_v1.';
COMMENT ON VIEW public.v_integration_plugin_directory
  IS 'FE-friendly projection of integration_plugins with derived jsonb-path projections (vendor via metadata.vendor), version metadata (version_label as v{version_no}, version_count, latest_version_no, latest_version_status, active_version_status via integration_plugin_versions), binding usage counters (binding_count + install_count alias, active_binding_count via integration_plugin_bindings), and status flags (has_active_version, is_pending_review). Sources: integration_plugins + integration_plugin_versions + integration_plugin_bindings. Read-only; SSOT remains integration_plugins; mutations go through integration_plugin_generate_draft_v1 / submit / approve / activate / deactivate / set_binding_v1 / rollback_v1.';

SELECT pg_advisory_unlock(hashtext('202605292230_console_v2_plugin_deactivate_lifecycle_v1'));
COMMIT;
