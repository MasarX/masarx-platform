-- Migration: Fix current_user_org_id resolution and schema qualification
-- Purpose:
--   - Ensure current_user_org_id() always resolves the organization_id of the
--     currently authenticated user using the application users table.
--   - Avoid relying on bare search_path resolution for "users", which can
--     lead to ambiguous lookups in environments that also include auth.users.
--
-- Behaviour:
--   - For authenticated callers (auth.uid() not null), returns the
--     organization_id from public.users where id = auth.uid().
--   - For anonymous/system callers, returns NULL.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_org_id  UUID;
BEGIN
  -- Rely on Supabase auth.uid() to identify the current user, if any.
  SELECT auth.uid() INTO v_user_id;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Explicitly qualify public.users to avoid ambiguity with auth.users.
  SELECT u.organization_id
  INTO v_org_id
  FROM public.users AS u
  WHERE u.id = v_user_id;

  RETURN v_org_id;
END;
$$;

COMMENT ON FUNCTION public.current_user_org_id IS
  'Returns the organization_id of the currently authenticated user from public.users (NULL for anonymous).';

COMMIT;

