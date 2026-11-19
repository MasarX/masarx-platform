-- UC11 webhook intake request header redaction repair.
-- Keep source-token/auth/signature headers available for validation only; persist
-- redacted headers in inbox rows and workflow context/readback.

SELECT pg_advisory_lock(hashtext('202607060045_webhook_intake_request_header_redaction_v1'));

CREATE OR REPLACE FUNCTION public.webhook_intake_redact_headers_v1(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT COALESCE(public.redact_sensitive_json(public.normalize_headers(COALESCE(p_headers, '{}'::jsonb))), '{}'::jsonb);
$$;

COMMENT ON FUNCTION public.webhook_intake_redact_headers_v1(JSONB)
  IS 'Redacts webhook intake request headers before persistence or workflow context readback while leaving validation-time headers unchanged.';

DO $$
DECLARE
  v_def TEXT;
  v_new TEXT;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  IF v_def NOT LIKE '%v_headers JSONB := normalize_headers(COALESCE(p_headers, ''{}''::jsonb));%' THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 header declaration marker not found';
  END IF;

  v_new := replace(
    v_def,
    'v_headers JSONB := normalize_headers(COALESCE(p_headers, ''{}''::jsonb));',
    'v_headers JSONB := normalize_headers(COALESCE(p_headers, ''{}''::jsonb));
  v_safe_headers JSONB := public.webhook_intake_redact_headers_v1(p_headers);'
  );

  v_new := replace(v_new, 'COALESCE(v_payload, ''{}''::jsonb),
    v_headers,
    CASE WHEN v_ack_outcome = ''ack_failed'' THEN ''failed'' ELSE v_processing_status END', 'COALESCE(v_payload, ''{}''::jsonb),
    v_safe_headers,
    CASE WHEN v_ack_outcome = ''ack_failed'' THEN ''failed'' ELSE v_processing_status END');

  v_new := replace(v_new, '''headers'', v_headers,', '''headers'', v_safe_headers,');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 redaction patch made no changes';
  END IF;

  IF v_new NOT LIKE '%v_safe_headers JSONB := public.webhook_intake_redact_headers_v1(p_headers);%' THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 safe header declaration not applied';
  END IF;

  IF v_new LIKE '%COALESCE(v_payload, ''{}''::jsonb),
    v_headers,
    CASE WHEN v_ack_outcome = ''ack_failed'' THEN ''failed'' ELSE v_processing_status END%' THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 inbox insert still uses raw headers';
  END IF;

  EXECUTE v_new;
END $$;

CREATE OR REPLACE FUNCTION public.insert_webhook_inbox_record(
    p_id UUID,
    p_webhook_source_id UUID,
    p_provider_type TEXT,
    p_raw_payload JSONB,
    p_headers JSONB,
    p_processing_status TEXT,
    p_correlation_id UUID,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_id UUID := COALESCE(p_id, gen_random_uuid());
BEGIN
    -- Set trace context early so any downstream changes within the same transaction
    -- are captured by audit_table_changes even for tables without correlation_id columns.
    IF p_correlation_id IS NOT NULL THEN
      PERFORM set_config('request.correlation_id', p_correlation_id::text, true);
    END IF;

    INSERT INTO webhook_inbox (
        id,
        webhook_source_id,
        provider_type,
        raw_payload,
        headers,
        processing_status,
        correlation_id,
        idempotency_key
    )
    VALUES (
        v_id,
        p_webhook_source_id,
        p_provider_type,
        COALESCE(p_raw_payload, '{}'::jsonb),
        public.webhook_intake_redact_headers_v1(p_headers),
        COALESCE(p_processing_status, 'pending'),
        p_correlation_id,
        p_idempotency_key
    );

    RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT)
  IS 'Creates webhook_inbox rows with request headers redacted before canonical persistence.';

SELECT pg_advisory_unlock(hashtext('202607060045_webhook_intake_request_header_redaction_v1'));
