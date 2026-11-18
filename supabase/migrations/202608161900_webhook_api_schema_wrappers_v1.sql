-- Migration: expose canonical webhook ingress RPCs through the api schema.

BEGIN;
SET search_path TO api, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION api.workflow_intake_webhook(
  p_token TEXT,
  p_headers JSONB,
  p_raw_body TEXT,
  p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.workflow_intake_webhook(p_token, p_headers, p_raw_body, p_payload);
$function$;

CREATE OR REPLACE FUNCTION api.get_webhook_edge_dispatch_jobs(p_webhook_id UUID)
RETURNS TABLE (
  job_id UUID,
  timeout_seconds INTEGER
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT * FROM public.get_webhook_edge_dispatch_jobs(p_webhook_id);
$function$;

REVOKE ALL ON FUNCTION api.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_webhook_edge_dispatch_jobs(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA api TO edge_webhook_role, service_role;
GRANT EXECUTE ON FUNCTION api.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
  TO edge_webhook_role, service_role;
GRANT EXECUTE ON FUNCTION api.get_webhook_edge_dispatch_jobs(UUID)
  TO edge_webhook_role, service_role;

COMMENT ON FUNCTION api.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) IS
  'API-schema SECURITY INVOKER wrapper for canonical public.workflow_intake_webhook.';
COMMENT ON FUNCTION api.get_webhook_edge_dispatch_jobs(UUID) IS
  'API-schema SECURITY INVOKER wrapper for canonical public.get_webhook_edge_dispatch_jobs.';

COMMIT;
