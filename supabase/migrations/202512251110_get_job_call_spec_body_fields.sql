-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Extend get_job_call_spec() with body_fields auth injection
-- Purpose:
--   - Support provider auth injection into JSON request bodies (e.g., Logestechs V2 email/password fields).
--   - Preserve outbound secret hygiene: secrets are fetched from provider_auth_configs at dispatch time only.
-- Date: 2025-12-25

BEGIN;

CREATE OR REPLACE FUNCTION public.get_job_call_spec(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_job RECORD;
    v_template RECORD;
    v_template_metadata JSONB := '{}'::jsonb;
    v_spec JSONB;

    v_provider_id UUID := NULL;
    v_operation_template_id UUID := NULL;
    v_auth JSONB := '{}'::jsonb;
    v_mode TEXT := NULL;
    v_auth_type TEXT := NULL;
    v_auth_config_id UUID := NULL;
    v_credentials JSONB := NULL;

    v_url TEXT;
    v_method TEXT;
    v_headers JSONB;
    v_body JSONB;

    v_header_name TEXT;
    v_query_param TEXT;
    v_credential_key TEXT;
    v_api_key TEXT;
    v_username TEXT;
    v_password TEXT;
    v_scheme TEXT;
    v_token TEXT;

    v_field_entry RECORD;
    v_body_field TEXT;
    v_value TEXT;
BEGIN
    SELECT oc.*
    INTO v_job
    FROM public.outbound_calls oc
    WHERE oc.id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'get_job_call_spec: job % not found', p_job_id;
    END IF;

    IF v_job.target_type = 'provider' THEN
      v_provider_id := v_job.target_id;
    END IF;

    BEGIN
      v_operation_template_id := NULLIF(v_job.context->>'operation_template_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_operation_template_id := NULL;
    END;

    IF v_operation_template_id IS NOT NULL THEN
      SELECT *
      INTO v_template
      FROM public.operation_templates ot
      WHERE ot.id = v_operation_template_id
      LIMIT 1;

      IF FOUND THEN
        v_template_metadata := COALESCE(v_template.metadata, '{}'::jsonb);
      END IF;
    END IF;

    -- Prefer explicit outbound_calls spec when present; otherwise fall back to operation_templates.
    IF v_job.url IS NOT NULL THEN
      v_url := v_job.url;
      v_method := v_job.method;
      v_headers := COALESCE(v_job.headers, '{}'::jsonb);
      v_body := COALESCE(v_job.body, '{}'::jsonb);
    ELSE
      IF v_template.id IS NULL AND v_provider_id IS NOT NULL THEN
        SELECT *
          INTO v_template
          FROM public.operation_templates ot
         WHERE ot.provider_id = v_provider_id
           AND ot.operation_name = v_job.call_type
         ORDER BY ot.updated_at DESC
         LIMIT 1;

        IF FOUND THEN
          v_template_metadata := COALESCE(v_template.metadata, '{}'::jsonb);
        END IF;
      END IF;

      IF v_template.id IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: missing_spec_and_template (job_id=%)', p_job_id;
      END IF;

      v_url := v_template.url_template;
      v_method := v_template.method;
      v_headers := COALESCE(v_template.headers_template, '{}'::jsonb);
      v_body := COALESCE(v_template.body_template, '{}'::jsonb);
    END IF;

    -- Auth config can come from job context (direct jobs) or operation template metadata.
    v_auth := COALESCE(
      v_job.context->'auth',
      v_template_metadata->'auth',
      '{}'::jsonb
    );

    v_mode := NULLIF(v_auth->>'mode', '');
    v_auth_type := NULLIF(v_auth->>'auth_type', '');

    -- Optionally select an auth_config_id (explicit or inferred by provider+auth_type).
    BEGIN
      v_auth_config_id := NULLIF(COALESCE(v_auth->>'auth_config_id', v_job.context->>'auth_config_id'), '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_auth_config_id := NULL;
    END;

    IF v_auth_config_id IS NULL AND v_provider_id IS NOT NULL AND v_auth_type IS NOT NULL THEN
      SELECT id
        INTO v_auth_config_id
        FROM public.provider_auth_configs
       WHERE provider_id = v_provider_id
         AND auth_type = v_auth_type
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;

    IF v_mode IS NOT NULL THEN
      IF v_auth_config_id IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_config_missing (mode=% job_id=%)', v_mode, p_job_id;
      END IF;

      SELECT credentials
        INTO v_credentials
        FROM public.provider_auth_configs
       WHERE id = v_auth_config_id;

      IF v_credentials IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: credentials_missing (auth_config_id=% job_id=%)', v_auth_config_id, p_job_id;
      END IF;
    END IF;

    IF v_mode = 'api_key_header' THEN
      v_header_name := NULLIF(v_auth->>'header', '');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'api_key');
      v_api_key := NULLIF(v_credentials->>v_credential_key, '');
      IF v_header_name IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_header_missing (job_id=%)', p_job_id;
      END IF;
      IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: api_key_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      v_headers := jsonb_set(v_headers, ARRAY[v_header_name], to_jsonb(v_api_key), TRUE);
    ELSIF v_mode = 'basic_auth_header' THEN
      v_header_name := NULLIF(v_auth->>'header', '');
      v_scheme := COALESCE(NULLIF(v_auth->>'scheme', ''), 'Basic');
      v_username := NULLIF(v_credentials->>COALESCE(NULLIF(v_auth->>'username_key', ''), 'username'), '');
      v_password := NULLIF(v_credentials->>COALESCE(NULLIF(v_auth->>'password_key', ''), 'password'), '');
      IF v_header_name IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_header_missing (job_id=%)', p_job_id;
      END IF;
      IF v_username IS NULL OR v_password IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: basic_auth_credentials_missing (job_id=%)', p_job_id;
      END IF;
      v_headers := jsonb_set(
        v_headers,
        ARRAY[v_header_name],
        to_jsonb(v_scheme || ' ' || encode(convert_to(v_username || ':' || v_password, 'utf8'), 'base64')),
        TRUE
      );
    ELSIF v_mode = 'bearer_token_header' THEN
      v_header_name := COALESCE(NULLIF(v_auth->>'header', ''), 'authorization');
      v_scheme := COALESCE(NULLIF(v_auth->>'scheme', ''), 'Bearer');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'token');
      v_token := NULLIF(v_credentials->>v_credential_key, '');
      IF v_token IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: bearer_token_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      v_headers := jsonb_set(v_headers, ARRAY[v_header_name], to_jsonb(v_scheme || ' ' || v_token), TRUE);
    ELSIF v_mode = 'api_key_query' THEN
      v_query_param := NULLIF(v_auth->>'query_param', '');
      v_credential_key := COALESCE(NULLIF(v_auth->>'credential_key', ''), 'api_key');
      v_api_key := NULLIF(v_credentials->>v_credential_key, '');
      IF v_query_param IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: auth_query_param_missing (job_id=%)', p_job_id;
      END IF;
      IF v_api_key IS NULL THEN
        RAISE EXCEPTION 'get_job_call_spec: api_key_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
      END IF;
      IF position('?' IN v_url) > 0 THEN
        v_url := v_url || '&' || public.urlencode(v_query_param) || '=' || public.urlencode(v_api_key);
      ELSE
        v_url := v_url || '?' || public.urlencode(v_query_param) || '=' || public.urlencode(v_api_key);
      END IF;
    ELSIF v_mode = 'body_fields' THEN
      IF jsonb_typeof(COALESCE(v_auth->'fields', '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'get_job_call_spec: body_fields_missing (job_id=%)', p_job_id;
      END IF;

      IF jsonb_typeof(COALESCE(v_body, '{}'::jsonb)) <> 'object' THEN
        v_body := '{}'::jsonb;
      END IF;

      FOR v_field_entry IN SELECT key, value FROM jsonb_each_text(v_auth->'fields') LOOP
        v_body_field := NULLIF(v_field_entry.key, '');
        v_credential_key := NULLIF(v_field_entry.value, '');

        IF v_body_field IS NULL OR v_credential_key IS NULL THEN
          CONTINUE;
        END IF;

        v_value := NULLIF(v_credentials->>v_credential_key, '');
        IF v_value IS NULL THEN
          RAISE EXCEPTION 'get_job_call_spec: body_fields_credential_missing (credential_key=% job_id=%)', v_credential_key, p_job_id;
        END IF;

        v_body := jsonb_set(v_body, ARRAY[v_body_field], to_jsonb(v_value), TRUE);
      END LOOP;
    END IF;

    v_spec := jsonb_build_object(
        'url', v_url,
        'method', v_method,
        'headers', COALESCE(v_headers, '{}'::jsonb),
        'body', COALESCE(v_body, '{}'::jsonb)
    );

    RETURN v_spec;
END;
$$;

COMMIT;

