BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20261106193000_call_api_revoke_public_execute_v1'));

-- pg_net wrappers are service/edge-worker helpers, never browser-callable functions.
REVOKE EXECUTE ON FUNCTION public.call_api(TEXT, TEXT, JSONB, JSONB, INT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT)
  FROM PUBLIC, anon, authenticated;

COMMIT;
