-- Plan: PLAN-202601-label-designer-hardening / Step: S01
-- Migration: Make current_user_org_id resilient to uid/sub mismatches
-- Purpose:
--   - In some service contexts, request.jwt claim keys can be populated
--     inconsistently. `auth.uid()` may resolve to a UUID that does not match our
--     `public.users.id`, while `auth.jwt()->>'sub'` is correct (or vice versa).
--   - Ensure `current_user_org_id()` prefers whichever identifier actually maps
--     to a known `public.users` row, instead of a naive COALESCE.
BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  WITH claims AS (
    SELECT
      auth.uid() AS uid,
      NULLIF(auth.jwt() ->> 'sub', '')::uuid AS sub
  ),
  org_from_uid AS (
    SELECT u.organization_id AS org
    FROM public.users u
    JOIN claims c ON c.uid IS NOT NULL AND u.id = c.uid
    LIMIT 1
  ),
  org_from_sub AS (
    SELECT u.organization_id AS org
    FROM public.users u
    JOIN claims c ON c.sub IS NOT NULL AND u.id = c.sub
    LIMIT 1
  )
  SELECT COALESCE(
    (SELECT org FROM org_from_uid),
    (SELECT org FROM org_from_sub)
  );
$function$;

COMMENT ON FUNCTION public.current_user_org_id() IS
  'Returns the organization_id of the currently authenticated user (robust lookup across uid/sub variants)';

COMMIT;

