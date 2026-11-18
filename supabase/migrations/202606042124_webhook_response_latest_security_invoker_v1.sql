-- Preserve the public-view security invariant for webhook response readback.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER VIEW public.webhook_response_latest SET (security_invoker = true);

COMMIT;
