-- Migration: Geocoding schema fixes and lint clean-up
-- Purpose: Align geocoding runtime objects with lint feedback (shipment linkage, timestamps, role assertions).

BEGIN;

-- Ensure geocoding_attempts can store shipment linkage (used by workflow handlers).
ALTER TABLE public.geocoding_attempts
    ADD COLUMN IF NOT EXISTS shipment_id UUID;

-- Track updates on geocodes for cache hygiene.
ALTER TABLE public.geocodes
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.geocodes
SET updated_at = COALESCE(updated_at, geocoded_at);

-- Fix role assertion helper to use pg_has_role.
CREATE OR REPLACE FUNCTION public.geocoding_assert_manual_role()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', true);

    IF NOT pg_has_role(current_user, 'geocoding_manual_role', 'member') THEN
        RAISE EXCEPTION 'geocoding manual review helpers require geocoding_manual_role membership.';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.geocoding_assert_manual_role IS 'Ensures manual review routines execute under geocoding_manual_role membership.';

-- Clean up provider dispatch address handling (avoid non-existent columns).
CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_provider RECORD;
    v_template operation_templates%ROWTYPE;
    v_template_id UUID;
    v_step_record workflow_run_steps%ROWTYPE;
    v_base_url TEXT;
    v_api_key TEXT;
    v_address RECORD;
    v_address_text TEXT;
    v_lang TEXT := COALESCE(NULLIF(v_metadata->>'lang', ''), 'en');
    v_limit INT := COALESCE((v_metadata->>'limit')::INT, 1);
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_override_url TEXT;
    v_provider_key TEXT := NULLIF(v_metadata->>'provider_key', '');
    v_provider_id UUID := (v_metadata->>'provider_id')::UUID;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    IF v_provider_id IS NULL AND v_provider_key IS NOT NULL THEN
        SELECT id, name, metadata
        INTO v_provider
        FROM public.providers
        WHERE name = v_provider_key
        LIMIT 1;
    ELSE
        SELECT id, name, metadata
        INTO v_provider
        FROM public.providers
        WHERE id = v_provider_id
        LIMIT 1;
    END IF;

    IF v_provider.id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: provider metadata missing for step %', p_step.id;
    END IF;

    IF v_provider.name IN ('google_maps') THEN
        SELECT *
        INTO v_template
        FROM operation_templates
        WHERE provider_id = v_provider.id
          AND operation_name = 'geocoding_google_forward_v1'
        LIMIT 1;
    ELSE
        SELECT *
        INTO v_template
        FROM operation_templates
        WHERE provider_id = v_provider.id
          AND operation_name = 'geocoding_here_forward_v1'
        LIMIT 1;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: operation template missing for provider %', v_provider.name;
    END IF;

    v_template_id := v_template.id;

    SELECT credentials->>'api_key'
    INTO v_api_key
    FROM provider_auth_configs
    WHERE provider_id = v_provider.id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_api_key IS NULL OR v_api_key = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: API key missing for provider %', v_provider.name;
    END IF;

    SELECT
        COALESCE(a.normalized_line1, '') AS line1,
        COALESCE(a.normalized_line2, '') AS line2,
        COALESCE(a.district, '') AS district,
        COALESCE(a.city, '') AS city,
        COALESCE(a.province, '') AS province,
        COALESCE(a.country, '') AS country
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id;

    v_address_text := COALESCE(
        NULLIF(p_run.context->'geocoding'->>'normalized_address', ''),
        NULLIF(trim(concat_ws(' ',
            NULLIF(v_address.line1, ''),
            NULLIF(v_address.line2, ''),
            NULLIF(v_address.district, ''),
            NULLIF(v_address.city, ''),
            NULLIF(v_address.province, ''),
            NULLIF(v_address.country, '')
        )), '')
    );

    IF v_address_text IS NULL OR v_address_text = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: normalized address unavailable for workflow_run_step %', p_step.id;
    END IF;

    v_base_url := COALESCE(v_template.url_template, '');
    IF v_base_url = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: template url missing for provider %', v_provider.name;
    END IF;

    IF right(v_base_url, 1) = '/' THEN
        v_base_url := left(v_base_url, length(v_base_url) - 1);
    END IF;

    IF v_provider.name = 'google_maps' THEN
        v_override_url := v_base_url ||
            CASE WHEN position('?' IN v_base_url) > 0 THEN '&' ELSE '?' END ||
            'address=' || public.urlencode(v_address_text) ||
            '&key=' || public.urlencode(v_api_key);
    ELSE
        v_override_url := v_base_url ||
            CASE WHEN position('?' IN v_base_url) > 0 THEN '&' ELSE '?' END ||
            'q=' || public.urlencode(v_address_text) ||
            '&lang=' || public.urlencode(v_lang) ||
            '&limit=' || public.urlencode(v_limit::TEXT) ||
            '&apiKey=' || public.urlencode(v_api_key);
    END IF;

    UPDATE workflow_run_steps
    SET metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_template_id', v_template_id::TEXT,
            'override_url', v_override_url,
            'provider_id', v_provider.id::TEXT,
            'provider_name', v_provider.name,
            'attempt_type', v_attempt_type
        ),
        updated_at = now()
    WHERE id = p_step.id
    RETURNING * INTO v_step_record;

    RETURN workflow_handlers.execute_outbound_http_v1(v_step_record, p_run, p_operation_result);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, JSONB)
    IS 'Dispatch geocoding provider attempts via outbound_http handler (real provider integration).';

COMMIT;
