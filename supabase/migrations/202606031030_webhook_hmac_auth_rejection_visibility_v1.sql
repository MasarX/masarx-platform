-- External Intake HMAC auth-failure visibility.
--
-- HMAC failures already fail closed and keep a terminal webhook_inbox row for
-- inbound-request operations. Console V2 Auth failures also promises
-- signature-failed source authentication readback, so mirror those HMAC
-- failures into the canonical redacted intake_auth_rejections ledger without
-- removing the existing failed inbound event.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606031030_webhook_hmac_auth_rejection_visibility_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_old TEXT;
  v_new TEXT;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF position('hmac_signature_mismatch' IN v_def) > 0
     AND position('auth_surface'', ''hmac_signature' IN v_def) > 0 THEN
    RETURN;
  END IF;

  v_old := $old$
      v_secret TEXT;
      v_credentials JSONB;
      v_computed BYTEA;
      v_expected TEXT;
$old$;

  v_new := $new$
      v_secret TEXT;
      v_credentials JSONB;
      v_computed BYTEA;
      v_expected TEXT;
      v_hmac_failure_code TEXT := NULL;
      v_hmac_failure_message TEXT := NULL;
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 HMAC declaration marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', format('Missing signature header %s', v_signature_header)));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := format('Missing signature header %s', v_signature_header);
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
$old$;

  v_new := $new$
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', format('Missing signature header %s', v_signature_header)));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := format('Missing signature header %s', v_signature_header);
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
        v_hmac_failure_code := 'hmac_signature_missing';
        v_hmac_failure_message := v_ack_reason;
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 missing-signature marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Missing auth_config reference for HMAC validation'));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := 'Missing auth_config reference for HMAC validation';
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
$old$;

  v_new := $new$
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Missing auth_config reference for HMAC validation'));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := 'Missing auth_config reference for HMAC validation';
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
        v_hmac_failure_code := 'hmac_auth_config_missing';
        v_hmac_failure_message := v_ack_reason;
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 missing-auth-config marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
          v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Signing secret missing in provider_auth_configs.credentials'));
          v_ack_outcome := 'ack_failed';
          v_ack_reason := 'Signing secret missing';
          v_ack_status := GREATEST(v_ack_status, v_bad_status);
$old$;

  v_new := $new$
          v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Signing secret missing in provider_auth_configs.credentials'));
          v_ack_outcome := 'ack_failed';
          v_ack_reason := 'Signing secret missing';
          v_ack_status := GREATEST(v_ack_status, v_bad_status);
          v_hmac_failure_code := 'hmac_credential_unavailable';
          v_hmac_failure_message := v_ack_reason;
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 missing-secret marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'HMAC signature mismatch'));
            v_ack_outcome := 'ack_failed';
            v_ack_reason := 'HMAC signature mismatch';
            v_ack_status := GREATEST(v_ack_status, v_bad_status);
$old$;

  v_new := $new$
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'HMAC signature mismatch'));
            v_ack_outcome := 'ack_failed';
            v_ack_reason := 'HMAC signature mismatch';
            v_ack_status := GREATEST(v_ack_status, v_bad_status);
            v_hmac_failure_code := 'hmac_signature_mismatch';
            v_hmac_failure_message := v_ack_reason;
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 signature-mismatch marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := $old$
      END IF;
    END;
  END IF;

  PERFORM insert_webhook_inbox_record(
$old$;

  v_new := $new$
      END IF;

      IF v_hmac_failure_code IS NOT NULL THEN
        PERFORM public.record_intake_auth_rejection_v1(
          jsonb_strip_nulls(jsonb_build_object(
            'service', 'webhook_receiver',
            'surface', 'webhook_receiver',
            'credential_kind', 'hmac_signature',
            'token', p_token,
            'http_status', v_ack_status,
            'failure_code', v_hmac_failure_code,
            'failure_message', v_hmac_failure_message,
            'method', 'POST',
            'headers', v_headers,
            'correlation_id', v_correlation_id,
            'request_id', COALESCE(v_idempotency_key, v_correlation_id::text),
            'provider_auth_config_id', v_auth_config_id,
            'metadata', jsonb_strip_nulls(jsonb_build_object(
              'edge_stage', 'workflow_intake_webhook_core_v1',
              'source_resolution', 'active_webhook_source_token',
              'auth_surface', 'hmac_signature',
              'hmac_header', v_signature_header,
              'hmac_algorithm', v_algorithm,
              'hmac_signature_encoding', v_signature_encoding,
              'webhook_inbox_id', v_webhook_id,
              'idempotency_key', v_idempotency_key,
              'provided_signature_present', v_provided_signature IS NOT NULL,
              'validation_results', v_validation->'hmac'
            ))
          ))
        );
      END IF;
    END;
  END IF;

  PERFORM insert_webhook_inbox_record(
$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 HMAC auth-rejection insertion marker not found';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  IF position('hmac_signature_mismatch' IN v_def) = 0
     OR position('auth_surface'', ''hmac_signature' IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 HMAC auth-rejection patch did not apply';
  END IF;

  EXECUTE v_def;
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Canonical webhook intake engine. HMAC auth failures remain terminal inbound events and are also mirrored into the redacted intake_auth_rejections ledger for Console V2 Auth failures readback.';

SELECT pg_advisory_unlock(hashtext('202606031030_webhook_hmac_auth_rejection_visibility_v1'));

COMMIT;
