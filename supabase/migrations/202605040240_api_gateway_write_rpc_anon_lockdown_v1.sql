BEGIN;

-- API-gateway operational write RPCs are browser-authenticated operator actions.
-- They must not be directly executable by anon even when older replayed grants
-- left explicit anon ACL entries on the functions.
REVOKE EXECUTE ON FUNCTION public.block_api_gateway_source_v1(JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.adjust_api_gateway_rate_limit_v1(JSONB) FROM anon;

GRANT EXECUTE ON FUNCTION public.block_api_gateway_source_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_api_gateway_rate_limit_v1(JSONB) TO authenticated, service_role;

COMMIT;
