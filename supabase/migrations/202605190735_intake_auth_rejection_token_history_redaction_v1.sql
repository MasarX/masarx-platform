-- Keep intake auth rejection lineage identifiers redacted at the DB projection
-- source. The UI already masks retired token history ids, but Console reads must
-- not depend on frontend-only redaction.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605190735_intake_auth_rejection_token_history_redaction_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.redact_intake_auth_secret_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      v_result := '{}'::jsonb;
      FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
        v_key_lower := lower(v_entry.key);
        IF v_key_lower IN (
          'authorization',
          'proxy-authorization',
          'cookie',
          'set-cookie',
          'x-api-key',
          'api-key',
          'apikey',
          'd360-api-key',
          'x-auth-token',
          'x-internal-edge-token',
          'x-webhook-token',
          'token',
          'auth_token',
          'api_key',
          'secret',
          'signature',
          'hmac',
          'x_signature',
          'x-signature',
          'x-hub-signature',
          'x-hub-signature-256',
          'key',
          'password',
          'credential',
          'retired_token_history_id',
          'token_history_id'
        )
        OR v_key_lower LIKE '%token_history_id'
        THEN
          v_result := v_result || jsonb_build_object(v_entry.key, 'REDACTED');
        ELSE
          v_result := v_result || jsonb_build_object(
            v_entry.key,
            public.redact_intake_auth_secret_json(v_entry.value)
          );
        END IF;
      END LOOP;
      RETURN v_result;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(public.redact_intake_auth_secret_json(value) ORDER BY ord), '[]'::jsonb)
        INTO v_result
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ord);
      RETURN v_result;
    WHEN 'string' THEN
      RETURN to_jsonb(public.redact_intake_auth_secret_text(p_value #>> '{}'));
    ELSE
      RETURN p_value;
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.redact_intake_auth_secret_json(JSONB) TO authenticated, service_role;

UPDATE public.intake_auth_rejections
   SET metadata = public.redact_intake_auth_secret_json(metadata)
 WHERE metadata::text ILIKE '%token_history_id%';

COMMENT ON FUNCTION public.redact_intake_auth_secret_json(JSONB)
  IS 'Recursively redacts intake auth secrets and internal token lineage ids from JSON values before Console/API exposure.';

SELECT pg_advisory_unlock(hashtext('202605190735_intake_auth_rejection_token_history_redaction_v1'));

COMMIT;
