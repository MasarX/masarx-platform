-- Console V2 first-tenant readiness: API Gateway accepted-async routes must
-- carry row-driven timeout policy into the outbound api-caller dispatch.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_api_gateway_outbound_timeout_context_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_route_id uuid;
  v_timeout_seconds integer;
BEGIN
  IF NEW.context IS NULL
     OR NOT (NEW.context ? 'api_gateway_route_id')
     OR NEW.context #> '{edge_dispatch,timeout_seconds}' IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_route_id := NULLIF(NEW.context->>'api_gateway_route_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      RETURN NEW;
  END;

  BEGIN
    SELECT NULLIF(policy #>> '{delivery,timeout_seconds}', '')::integer
      INTO v_timeout_seconds
      FROM public.api_routes
     WHERE id = v_route_id;
  EXCEPTION
    WHEN others THEN
      RETURN NEW;
  END;

  IF v_timeout_seconds IS NULL OR v_timeout_seconds <= 0 THEN
    RETURN NEW;
  END IF;

  NEW.context := jsonb_set(
    jsonb_set(
      COALESCE(NEW.context, '{}'::jsonb),
      '{edge_dispatch}',
      COALESCE(NEW.context->'edge_dispatch', '{}'::jsonb),
      true
    ),
    '{edge_dispatch,timeout_seconds}',
    to_jsonb(v_timeout_seconds),
    true
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_api_gateway_outbound_timeout_context_v1 ON public.outbound_calls;

CREATE TRIGGER trg_api_gateway_outbound_timeout_context_v1
BEFORE INSERT OR UPDATE OF context ON public.outbound_calls
FOR EACH ROW
EXECUTE FUNCTION public.apply_api_gateway_outbound_timeout_context_v1();

COMMENT ON FUNCTION public.apply_api_gateway_outbound_timeout_context_v1()
  IS 'Copies api_routes.policy.delivery.timeout_seconds into outbound_calls.context.edge_dispatch.timeout_seconds for API Gateway accepted-async jobs so api-caller enforces row-driven provider timeouts.';

CREATE OR REPLACE FUNCTION public.get_outbound_edge_dispatch_timeout_v1(
  p_job_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_timeout integer;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT NULLIF(oc.context #>> '{edge_dispatch,timeout_seconds}', '')::integer
    INTO v_timeout
    FROM public.outbound_calls oc
   WHERE oc.id = p_job_id
   LIMIT 1;

  IF v_timeout IS NULL OR v_timeout <= 0 THEN
    RETURN NULL;
  END IF;

  RETURN v_timeout;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.get_outbound_edge_dispatch_timeout_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_outbound_edge_dispatch_timeout_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_outbound_edge_dispatch_timeout_v1(uuid) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_outbound_edge_dispatch_timeout_v1(uuid) TO edge_api_caller_role';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS api;

CREATE OR REPLACE FUNCTION api.get_outbound_edge_dispatch_timeout_v1(
  p_job_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.get_outbound_edge_dispatch_timeout_v1(p_job_id);
$$;

REVOKE ALL ON FUNCTION api.get_outbound_edge_dispatch_timeout_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.get_outbound_edge_dispatch_timeout_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION api.get_outbound_edge_dispatch_timeout_v1(uuid) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_api_caller_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION api.get_outbound_edge_dispatch_timeout_v1(uuid) TO edge_api_caller_role';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_outbound_edge_dispatch_timeout_v1(uuid)
  IS 'Returns the queued outbound edge_dispatch timeout for api-caller job_id-only dispatch so row-driven API Gateway timeout policy is enforced.';

UPDATE public.outbound_calls oc
   SET context = jsonb_set(
     jsonb_set(
       COALESCE(oc.context, '{}'::jsonb),
       '{edge_dispatch}',
       COALESCE(oc.context->'edge_dispatch', '{}'::jsonb),
       true
     ),
     '{edge_dispatch,timeout_seconds}',
     to_jsonb(NULLIF(ar.policy #>> '{delivery,timeout_seconds}', '')::integer),
     true
   )
  FROM public.api_routes ar
 WHERE oc.context->>'api_gateway_route_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND (oc.context->>'api_gateway_route_id')::uuid = ar.id
   AND oc.context #> '{edge_dispatch,timeout_seconds}' IS NULL
   AND COALESCE(ar.policy #>> '{delivery,timeout_seconds}', '') ~ '^[0-9]+$'
   AND NULLIF(ar.policy #>> '{delivery,timeout_seconds}', '')::integer > 0
   AND oc.status IN ('pending_edge', 'in_progress_edge');

COMMIT;
