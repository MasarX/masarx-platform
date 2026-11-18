-- Console V2 onboarding bootstrap: keep archived runtime bindings inert.
--
-- Integration plugin activation is allowed to re-enable reusable runtime
-- artifacts, but archived webhook sources are terminal lifecycle records and
-- must never be revived by bootstrap.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605220900_console_v2_onboarding_bootstrap_archived_plugin_binding_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(
  p_plugin_version_id UUID,
  p_enabled BOOLEAN,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(NULLIF(COALESCE(p_scope_type, ''), ''));
  v_binding RECORD;
  v_archived BOOLEAN := FALSE;
  v_changed INTEGER := 0;
  v_row_count INTEGER := 0;
BEGIN
  IF p_plugin_version_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_set_binding_runtime_enabled_v1 requires plugin_version_id';
  END IF;

  FOR v_binding IN
    SELECT b.id, b.runtime_resource_type, b.runtime_resource_id, b.enabled
    FROM public.integration_plugin_bindings b
    WHERE b.plugin_version_id = p_plugin_version_id
      AND (
        v_scope_type IS NULL
        OR (
          lower(b.scope_type) = v_scope_type
          AND b.scope_id IS NOT DISTINCT FROM p_scope_id
        )
      )
  LOOP
    v_archived := FALSE;

    IF v_binding.runtime_resource_id IS NOT NULL THEN
      CASE lower(COALESCE(v_binding.runtime_resource_type, ''))
        WHEN 'webhook_sources' THEN
          SELECT public.webhook_source_metadata_is_archived_v1(COALESCE(ws.managed_metadata, '{}'::jsonb))
            INTO v_archived
            FROM public.webhook_sources ws
           WHERE ws.id = v_binding.runtime_resource_id;

          v_archived := COALESCE(v_archived, FALSE);

          IF NOT v_archived THEN
            UPDATE public.webhook_sources
               SET enabled = p_enabled,
                   updated_at = now()
             WHERE id = v_binding.runtime_resource_id
               AND enabled IS DISTINCT FROM p_enabled;
          END IF;

        WHEN 'api_routes' THEN
          UPDATE public.api_routes
             SET enabled = p_enabled,
                 updated_at = now()
           WHERE id = v_binding.runtime_resource_id
             AND enabled IS DISTINCT FROM p_enabled;

        WHEN 'api_route_packs' THEN
          UPDATE public.api_route_packs
             SET enabled = p_enabled,
                 updated_at = now()
           WHERE id = v_binding.runtime_resource_id
             AND enabled IS DISTINCT FROM p_enabled;

        WHEN 'providers' THEN
          UPDATE public.providers
             SET enabled = p_enabled,
                 updated_at = now()
           WHERE id = v_binding.runtime_resource_id
             AND enabled IS DISTINCT FROM p_enabled;

        ELSE
          -- Not all resource types expose an `enabled` flag.
          NULL;
      END CASE;
    END IF;

    UPDATE public.integration_plugin_bindings b
       SET enabled = CASE
             WHEN v_archived AND p_enabled THEN FALSE
             ELSE p_enabled
           END,
           updated_at = now()
     WHERE b.id = v_binding.id
       AND b.enabled IS DISTINCT FROM CASE
             WHEN v_archived AND p_enabled THEN FALSE
             ELSE p_enabled
           END;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_changed := v_changed + v_row_count;
  END LOOP;

  RETURN v_changed;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_set_binding_runtime_enabled_v1(UUID, BOOLEAN, TEXT, UUID) IS
  'Enables/disables integration plugin runtime bindings without reviving archived webhook sources; archived webhook source bindings stay disabled until an explicit restore lifecycle exists.';

SELECT pg_advisory_unlock(hashtext('202605220900_console_v2_onboarding_bootstrap_archived_plugin_binding_guard_v1'));
COMMIT;
