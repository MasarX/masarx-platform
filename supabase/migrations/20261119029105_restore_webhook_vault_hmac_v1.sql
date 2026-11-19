BEGIN;
SET LOCAL lock_timeout = '10s';

-- Keep the receiver on the credential resolver and preserve sanitized rejection evidence.
DO $patch$
DECLARE
  v_core TEXT := pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure);
  v_mirror TEXT := pg_get_functiondef('public.mirror_webhook_hmac_auth_rejection_v1()'::regprocedure);
  v_secret TEXT := $old$        SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
          INTO v_secret
          FROM provider_auth_configs
         WHERE id = v_auth_config_id;$old$;
  v_vault TEXT := $new$        SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
          INTO v_secret
          FROM public.get_provider_auth_credentials(v_auth_config_id) AS resolved(credentials);$new$;
  v_persist TEXT := '  v_persisted_headers := public.redact_webhook_persisted_headers_v1(';
  v_presence TEXT := $presence$  IF v_validation ? 'hmac' THEN
    v_validation := jsonb_set(v_validation, '{hmac,provided_signature_present}',
      to_jsonb(v_headers->>lower(COALESCE(v_hmac_config->>'header', 'x-signature')) IS NOT NULL));
  END IF;

$presence$;
  v_old_presence TEXT := $old$'provided_signature_present', COALESCE(v_inbox.headers, '{}'::jsonb) ? lower(COALESCE(NULLIF(v_hmac->>'header', ''), 'x-signature')),$old$;
  v_new_presence TEXT := $new$'provided_signature_present', v_validation->'provided_signature_present',$new$;
BEGIN
  IF position(v_secret IN v_core) = 0 OR position(v_persist IN v_core) = 0
     OR position(v_old_presence IN v_mirror) = 0 THEN
    RAISE EXCEPTION 'Webhook HMAC validation or rejection contract changed';
  END IF;

  EXECUTE replace(replace(v_core, v_secret, v_vault), v_persist, v_presence || v_persist);
  EXECUTE replace(v_mirror, v_old_presence, v_new_presence);
END;
$patch$;

COMMIT;
