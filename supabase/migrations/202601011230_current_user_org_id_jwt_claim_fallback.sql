-- Plan: PLAN-202601-label-designer-hardening / Step: S01
-- Migration: Make current_user_org_id resilient across request jwt claim keys
-- Purpose:
--   - Fix Storage RLS contexts where `auth.uid()` can be NULL even though
--     JWT claims are present (e.g., services setting `request.jwt.claim`).
--   - Keep a single source of truth: all org scoping continues to route through
--     `public.current_user_org_id()` (no new parallel resolver functions).
BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  SELECT organization_id
  FROM public.users
  WHERE id = COALESCE(
    auth.uid(),
    NULLIF(auth.jwt() ->> 'sub', '')::uuid
  );
$function$;

COMMENT ON FUNCTION public.current_user_org_id() IS
  'Returns the organization_id of the currently authenticated user (robust across request.jwt.claim* variants)';

COMMIT;

