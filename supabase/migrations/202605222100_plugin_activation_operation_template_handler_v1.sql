-- Console V2 first-tenant readiness: API plugin activation outbound operation
-- templates must satisfy workflow handler governance. Operation templates are
-- executable HTTP calls, so they use the canonical outbound_http handler.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605222100_plugin_activation_operation_template_handler_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_activate_core_v1 definition not found';
  END IF;

  IF position('handler_key,' IN v_def) = 0 THEN
    v_def := replace(
      v_def,
      $old$
        timeout_seconds,
        call_type,
        metadata
      )
$old$,
      $new$
        timeout_seconds,
        call_type,
        handler_key,
        handler_version,
        metadata
      )
$new$
    );

    v_def := replace(
      v_def,
      $old$
        GREATEST(v_op_timeout, 1),
        'provider_api',
        jsonb_build_object(
$old$,
      $new$
        GREATEST(v_op_timeout, 1),
        'provider_api',
        'outbound_http',
        'v1',
        jsonb_build_object(
$new$
    );

    v_def := replace(
      v_def,
      $old$
        call_type = EXCLUDED.call_type,
        metadata = EXCLUDED.metadata,
$old$,
      $new$
        call_type = EXCLUDED.call_type,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
$new$
    );
  END IF;

  IF position('handler_key,' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Failed to patch operation_templates handler_key in integration_plugin_activate_core_v1';
  END IF;

  EXECUTE v_def;
END;
$patch$;

COMMENT ON FUNCTION public.integration_plugin_activate_core_v1(UUID, TEXT, UUID, TEXT) IS
  'Activates approved integration plugin versions and materializes runtime bindings; API route policies and outbound operation handler metadata are workflow-governed.';

SELECT pg_advisory_unlock(hashtext('202605222100_plugin_activation_operation_template_handler_v1'));
COMMIT;
