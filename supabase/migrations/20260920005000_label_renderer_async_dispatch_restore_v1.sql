-- Restore asynchronous label-renderer dispatch after tenant provider resolution.
-- Workflow progression holds the workflow-run row until its transaction commits;
-- waiting for the renderer there prevents its completion callback from acquiring it.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260920005000_label_renderer_async_dispatch_restore_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    v_timeout_seconds INT;
    v_request_id BIGINT;
BEGIN
    v_body := CASE
        WHEN p_payload IS NOT NULL AND jsonb_typeof(p_payload) = 'object'
            THEN jsonb_strip_nulls(p_payload)
        ELSE jsonb_build_object('max_jobs', GREATEST(COALESCE(p_max_jobs, 5), 1))
    END;

    -- Preserve the canonical conflicting-envelope rejection before selecting
    -- tenant-scoped provider authority.
    v_org_id := public.resolve_label_renderer_organization_id_v1(v_body);
    v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);

    v_headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', concat('Bearer ', v_provider->>'invoke_secret')
    );
    v_timeout_seconds := COALESCE(NULLIF(v_provider->>'timeout_seconds', '')::INT, 15);

    -- Dispatch only. The renderer callback settles the exact owning step after
    -- this workflow progression transaction releases its workflow-run row lock.
    v_request_id := public.dispatch_api_request_v1(
        v_provider->>'invoke_url',
        'POST',
        v_headers,
        v_body,
        v_timeout_seconds
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
        'status', 202,
        'completed', FALSE,
        'request_id', v_request_id,
        'latency_ms', 0,
        'headers', '{}'::jsonb,
        'body', jsonb_build_object(
            'message', 'HTTP request accepted - response pending',
            'request_id', v_request_id,
            'poll_sql', format('SELECT * FROM check_async_response(%s);', v_request_id),
            'note', 'Call check_async_response(request_id) or query net._http_response for completion'
        ),
        'request_payload', v_body,
        'provider_name', v_provider->>'provider_name'
    ));
END;
$$;

COMMENT ON FUNCTION public.invoke_label_renderer(INT, JSONB)
    IS 'Dispatch the tenant-scoped label renderer asynchronously so workflow progression commits before renderer completion callbacks.';

REVOKE ALL ON FUNCTION public.invoke_label_renderer(INT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('20260920005000_label_renderer_async_dispatch_restore_v1'));
COMMIT;
