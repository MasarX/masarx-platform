-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
-- Migration: API transition_task_v1 wrapper v1
-- Date: 2026-03-19
--
-- Goals:
--   - Expose transition_task_v1 through the api schema for PostgREST clients pinned to db.schema=api.
--   - Preserve the canonical public.transition_task_v1 implementation as the single write path.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191610_api_transition_task_wrapper_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.transition_task_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.transition_task_v1(
    p_task_id,
    p_to_status,
    p_status_reason,
    COALESCE(p_payload, '{}'::jsonb),
    p_idempotency_key
  );
$function$;

COMMENT ON FUNCTION api.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'API-schema wrapper for public.transition_task_v1 used by PostgREST/mobile clients pinned to db.schema=api.';

REVOKE ALL ON FUNCTION api.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191610_api_transition_task_wrapper_v1'));
COMMIT;
