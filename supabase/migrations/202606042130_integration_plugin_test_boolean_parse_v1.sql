-- Harden integration plugin tester against row-driven JSON boolean strings.
-- Prevents raw cast errors when policy/config rows store "true"/"false" text.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042130_integration_plugin_test_boolean_parse_v1'));

DO $do$
DECLARE
  v_def text;
  v_old text := $old$  v_signature_required := COALESCE(
    (v_version.inbound_config #> '{webhook,signature_required}')::BOOLEAN,
    FALSE
  );$old$;
  v_new text := $new$  v_signature_required := COALESCE(
    lower(NULLIF(btrim(COALESCE(v_version.inbound_config #>> '{webhook,signature_required}', '')), ''))
      IN ('true', 't', '1', 'yes', 'on'),
    FALSE
  );$new$;
BEGIN
  SELECT pg_get_functiondef('public.test_integration_plugin_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'integration plugin tester boolean parser marker is not available'
      USING ERRCODE = '2F000';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$do$;

COMMENT ON FUNCTION public.test_integration_plugin_v1(jsonb)
  IS 'Canonical integration plugin tester. Parses webhook signature_required from row-driven JSON booleans or boolean-like strings without leaking raw cast errors.';

SELECT pg_advisory_unlock(hashtext('202606042130_integration_plugin_test_boolean_parse_v1'));

COMMIT;
