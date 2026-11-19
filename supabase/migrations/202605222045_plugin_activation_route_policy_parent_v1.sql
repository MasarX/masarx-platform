-- Console V2 first-tenant readiness: API plugin activation must materialize
-- workflow-backed routes. jsonb_set does not create missing parent objects, so
-- activation must initialize route.policy.workflow and route.policy.delivery
-- before setting their child fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605222045_plugin_activation_route_policy_parent_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_old TEXT := $old$
    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
$old$;
  v_new TEXT := $new$
    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    IF jsonb_typeof(v_route_policy) <> 'object' THEN
      v_route_policy := '{}'::jsonb;
    END IF;
    v_route_policy := v_route_policy || jsonb_build_object(
      'workflow', COALESCE(v_route_policy->'workflow', '{}'::jsonb),
      'delivery', COALESCE(v_route_policy->'delivery', '{}'::jsonb)
    );
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
$new$;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected route policy initialization block not found in integration_plugin_activate_core_v1';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$patch$;

COMMENT ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT) IS
  'Activates approved integration plugin versions and materializes runtime bindings; API route policy parents are initialized before workflow/delivery fields are set.';

SELECT pg_advisory_unlock(hashtext('202605222045_plugin_activation_route_policy_parent_v1'));
COMMIT;
