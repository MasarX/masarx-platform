-- Preserve ACK response mapping when plugin/operator webhook policies are repaired.
--
-- Later webhook workflow-policy normalization recreated the policy repair
-- functions after the HTTP readback contract patch. Re-apply the narrow ACK
-- response mapping preservation so source/plugin repairs do not drop the
-- inherited response mapping used by the HTTP response layer.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042055_webhook_ack_response_mapping_preserve_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_marker_4 TEXT := $marker$'default_headers', jsonb_build_object('content-type', 'application/json')
    ),$marker$;
  v_replacement_4 TEXT := $replacement$'default_headers', jsonb_build_object('content-type', 'application/json'),
      'response_mapping_id', COALESCE(
        NULLIF(v_existing_policy#>>'{ack,response_mapping_id}', ''),
        NULLIF(v_existing_policy#>>'{response,response_mapping_id}', '')
      )
    ),$replacement$;
  v_marker_8 TEXT := $marker$'default_headers', jsonb_build_object('content-type', 'application/json')
        ),$marker$;
  v_replacement_8 TEXT := $replacement$'default_headers', jsonb_build_object('content-type', 'application/json'),
          'response_mapping_id', COALESCE(
            NULLIF(v_existing_policy#>>'{ack,response_mapping_id}', ''),
            NULLIF(v_existing_policy#>>'{response,response_mapping_id}', '')
          )
        ),$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.repair_integration_plugin_webhook_policy_v1(uuid,uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.repair_integration_plugin_webhook_policy_v1(uuid,uuid) not found';
  END IF;

  IF position('v_existing_policy#>>''{ack,response_mapping_id}''' IN v_def) = 0 THEN
    IF position(v_marker_4 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_4, v_replacement_4);
    ELSIF position(v_marker_8 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_8, v_replacement_8);
    ELSE
      RAISE EXCEPTION 'expected plugin webhook policy ACK marker not found';
    END IF;

    EXECUTE v_def;
  END IF;

  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ensure_webhook_source_plugin_binding_v1(uuid) not found';
  END IF;

  IF position('v_existing_policy#>>''{ack,response_mapping_id}''' IN v_def) = 0 THEN
    IF position(v_marker_4 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_4, v_replacement_4);
    ELSIF position(v_marker_8 IN v_def) > 0 THEN
      v_def := replace(v_def, v_marker_8, v_replacement_8);
    ELSE
      RAISE EXCEPTION 'expected source plugin binding ACK marker not found';
    END IF;

    EXECUTE v_def;
  END IF;
END;
$patch$;

DO $assert$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.repair_integration_plugin_webhook_policy_v1(uuid,uuid)'::regprocedure)
    INTO v_def;

  IF position('v_existing_policy#>>''{ack,response_mapping_id}''' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'repair_integration_plugin_webhook_policy_v1 does not preserve inherited ACK response mapping';
  END IF;

  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF position('v_existing_policy#>>''{ack,response_mapping_id}''' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 does not preserve inherited ACK response mapping';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606042055_webhook_ack_response_mapping_preserve_v1'));

COMMIT;
