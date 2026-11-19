-- Console V2 Plugin Catalog runtime binding readback hardening.
--
-- Browser-facing generic reads must expose runtime binding governance context
-- without leaking activation secrets such as issued source tokens.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605301855_plugin_runtime_binding_redacted_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_integration_plugin_binding_directory
  WITH (security_invoker = true)
AS
SELECT
  b.id,
  b.plugin_version_id,
  b.organization_id,
  b.scope_type,
  b.scope_id,
  b.binding_type,
  b.runtime_resource_type,
  b.runtime_resource_id,
  b.enabled,
  COALESCE(public.redact_sensitive_json(b.activation_payload), '{}'::jsonb) AS activation_payload,
  COALESCE(public.redact_sensitive_json(b.metadata), '{}'::jsonb) AS metadata,
  b.created_by,
  b.created_at,
  b.updated_at
FROM public.integration_plugin_bindings b;

COMMENT ON VIEW public.v_integration_plugin_binding_directory IS
  'Browser-safe projection of integration_plugin_bindings. Runtime governance fields remain visible while activation_payload and metadata are recursively redacted. security_invoker=true preserves base-table RLS.';

REVOKE ALL ON public.v_integration_plugin_binding_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_plugin_binding_directory FROM anon;
GRANT SELECT ON public.v_integration_plugin_binding_directory TO authenticated;
GRANT SELECT ON public.v_integration_plugin_binding_directory TO service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_resources JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND jsonb_path_exists(
        COALESCE(sv.value->'resources', '[]'::jsonb),
        '$[*] ? (@.key == "integration_plugin_bindings")'
      )
  LOOP
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN item->>'key' = 'integration_plugin_bindings' THEN
            item
            || jsonb_build_object(
              'relation', 'public.v_integration_plugin_binding_directory',
              'capability_read', 'integration_plugins.read',
              'capability_write', 'integration_plugins.activate',
              'select', jsonb_build_array(
                'id',
                'plugin_version_id',
                'organization_id',
                'scope_type',
                'scope_id',
                'binding_type',
                'runtime_resource_type',
                'runtime_resource_id',
                'enabled',
                'activation_payload',
                'metadata',
                'created_by',
                'created_at',
                'updated_at'
              )
            )
          ELSE item
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_row.value->'resources', '[]'::jsonb)) WITH ORDINALITY AS resource(item, ordinality);

    v_next := jsonb_set(v_row.value, '{resources}', v_resources, true);

    IF v_next IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Route integration plugin binding reads through redacted runtime directory',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE category = v_row.category
         AND scope_type = v_row.scope_type
         AND scope_id IS NOT DISTINCT FROM v_row.scope_id
         AND settings_version_id = v_row.settings_version_id;
    END IF;
  END LOOP;
END
$registry$;

DO $guard$
DECLARE
  v_relation TEXT;
BEGIN
  SELECT resource->>'relation'
    INTO v_relation
    FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
   WHERE resource->>'key' = 'integration_plugin_bindings'
   LIMIT 1;

  IF v_relation IS DISTINCT FROM 'public.v_integration_plugin_binding_directory' THEN
    RAISE EXCEPTION 'integration_plugin_bindings registry must route to redacted binding directory, found %', v_relation;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_integration_plugin_binding_directory'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_integration_plugin_binding_directory must remain a security_invoker view';
  END IF;
END
$guard$;

SELECT pg_advisory_unlock(hashtext('202605301855_plugin_runtime_binding_redacted_readback_v1'));
COMMIT;
