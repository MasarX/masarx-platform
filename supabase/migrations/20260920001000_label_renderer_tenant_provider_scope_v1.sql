-- Keep bundle and print renderer requests on their tenant-scoped provider settings.
CREATE OR REPLACE FUNCTION public.resolve_label_renderer_organization_id_v1(
    p_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_top_org_id UUID := NULLIF(p_payload->>'organization_id', '')::UUID;
    v_bundle_org_id UUID := NULLIF(p_payload #>> '{bundle,organization_id}', '')::UUID;
    v_print_org_id UUID := NULLIF(p_payload #>> '{print,organization_id}', '')::UUID;
BEGIN
    IF (v_top_org_id IS NOT NULL AND v_bundle_org_id IS NOT NULL AND v_top_org_id <> v_bundle_org_id)
       OR (v_top_org_id IS NOT NULL AND v_print_org_id IS NOT NULL AND v_top_org_id <> v_print_org_id)
       OR (v_bundle_org_id IS NOT NULL AND v_print_org_id IS NOT NULL AND v_bundle_org_id <> v_print_org_id) THEN
        RAISE EXCEPTION 'invoke_label_renderer: conflicting organization_id values in request envelope'
          USING ERRCODE = '22023';
    END IF;
    RETURN COALESCE(v_top_org_id, v_bundle_org_id, v_print_org_id);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_label_renderer_organization_id_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_organization_id_v1(JSONB) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_organization_id_v1(JSONB) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_label_renderer(
    p_max_jobs INT DEFAULT 5,
    p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
    v_body JSONB;
    v_org_id UUID;
    v_provider JSONB;
    v_headers JSONB;
    v_response JSONB;
    v_timeout_seconds INT;
    v_existing_timeout_text TEXT;
    v_existing_timeout_ms INT;
    v_desired_timeout_ms INT;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    v_org_id := public.resolve_label_renderer_organization_id_v1(v_body);
    v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_provider->>'invoke_secret')
    );

    v_timeout_seconds := COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::INT, 15);
    v_existing_timeout_text := current_setting('statement_timeout', true);
    v_desired_timeout_ms := (v_timeout_seconds + 5) * 1000;
    IF v_existing_timeout_text IS NOT NULL THEN
        BEGIN
            v_existing_timeout_ms :=
                ROUND(EXTRACT(EPOCH FROM v_existing_timeout_text::interval) * 1000)::INT;
        EXCEPTION WHEN OTHERS THEN
            v_existing_timeout_ms := NULL;
        END;
    END IF;

    IF v_existing_timeout_ms IS NOT NULL AND v_existing_timeout_ms > 0 THEN
        v_desired_timeout_ms := GREATEST(v_existing_timeout_ms, v_desired_timeout_ms);
        PERFORM set_config('statement_timeout', v_desired_timeout_ms::TEXT, true);
    END IF;

    v_response := public.call_api_wait(
        v_provider->>'invoke_url',
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds,
        v_timeout_seconds
    );

    RETURN v_response || jsonb_build_object(
        'request_payload', v_body,
        'provider_name', v_provider->>'provider_name'
    );
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Trigger the tenant-scoped label renderer for direct, print, or bundle requests.';

REVOKE ALL ON FUNCTION public.invoke_label_renderer(INT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO edge_label_renderer_role;
  END IF;
END;
$$;
