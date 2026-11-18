-- Console V2 API-schema wrapper for Review Queue bulk task transitions.
-- Browser clients are pinned to db.schema=api, so the public bulk task RPC
-- must be exposed through api without changing the canonical write path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605271240_console_v2_api_bulk_transition_tasks_v1'));

CREATE OR REPLACE FUNCTION api.bulk_transition_tasks_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.bulk_transition_tasks_v1(COALESCE(p_args, '{}'::jsonb));
$function$;

COMMENT ON FUNCTION api.bulk_transition_tasks_v1(jsonb)
  IS 'API-schema wrapper for public.bulk_transition_tasks_v1 used by Console V2 Review Queue clients pinned to db.schema=api.';

REVOKE ALL ON FUNCTION api.bulk_transition_tasks_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.bulk_transition_tasks_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.bulk_transition_tasks_v1(jsonb) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605271240_console_v2_api_bulk_transition_tasks_v1'));

COMMIT;
