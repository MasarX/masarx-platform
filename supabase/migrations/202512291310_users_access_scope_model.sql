-- Migration: User access scope model (dynamic multi-tenant RLS foundation)
-- Purpose:
--   - Support enterprise-grade, dynamic authorization with a single active scope per user:
--       platform (all orgs) | tenant (one org) | client (one client) | sender (one sender)
--   - Enable reusable RLS helpers so policies are not duplicated/hardcoded.
BEGIN;

SELECT pg_advisory_lock(hashtext('202512291310_users_access_scope_model'));
SET search_path TO public, pg_temp;

-- 1) Extend users with a single-scope access model.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS access_scope_type TEXT NOT NULL DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS access_scope_id UUID;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_access_scope_type_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_access_scope_type_check
  CHECK (access_scope_type IN ('platform', 'tenant', 'client', 'sender'));

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_access_scope_consistency_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_access_scope_consistency_check
  CHECK (
    (access_scope_type IN ('platform', 'tenant') AND access_scope_id IS NULL)
    OR (access_scope_type IN ('client', 'sender') AND access_scope_id IS NOT NULL)
  );

-- 2) Trigger guard: ensure client/sender scopes belong to the same organization.
CREATE OR REPLACE FUNCTION public.validate_user_access_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_ok boolean := false;
BEGIN
  IF NEW.access_scope_type IS NULL OR NEW.access_scope_type = '' THEN
    NEW.access_scope_type := 'tenant';
  END IF;

  IF NEW.access_scope_type NOT IN ('platform', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'Unsupported access_scope_type %', NEW.access_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF NEW.access_scope_type IN ('platform', 'tenant') THEN
    IF NEW.access_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'access_scope_id must be NULL for access_scope_type=%', NEW.access_scope_type
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.access_scope_id IS NULL THEN
    RAISE EXCEPTION 'access_scope_id must be set for access_scope_type=%', NEW.access_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF NEW.access_scope_type = 'client' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = NEW.access_scope_id
        AND c.organization_id = NEW.organization_id
    )
      INTO v_ok;
  ELSIF NEW.access_scope_type = 'sender' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = NEW.access_scope_id
        AND c.organization_id = NEW.organization_id
    )
      INTO v_ok;
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Invalid access scope %/% for user %', NEW.access_scope_type, NEW.access_scope_id, NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_access_scope_guard ON public.users;
CREATE CONSTRAINT TRIGGER users_access_scope_guard
AFTER INSERT OR UPDATE ON public.users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_user_access_scope();

-- 3) Helper functions for RLS (reusable, non-hardcoded).
CREATE OR REPLACE FUNCTION public.current_user_scope_type()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope TEXT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.access_scope_type
    INTO v_scope
    FROM public.users u
   WHERE u.id = v_user_id;

  RETURN v_scope;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_scope_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope_id UUID;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.access_scope_id
    INTO v_scope_id
    FROM public.users u
   WHERE u.id = v_user_id;

  RETURN v_scope_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_platform_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT public.current_user_scope_type() = 'platform';
$$;

CREATE OR REPLACE FUNCTION public.current_user_sender_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT CASE
    WHEN public.current_user_scope_type() = 'sender' THEN public.current_user_scope_id()
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_client_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_scope TEXT;
  v_scope_id UUID;
  v_client UUID;
BEGIN
  v_scope := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();

  IF v_scope = 'client' THEN
    RETURN v_scope_id;
  ELSIF v_scope = 'sender' THEN
    SELECT s.client_id
      INTO v_client
      FROM public.senders s
     WHERE s.id = v_scope_id;
    RETURN v_client;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_can_write()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
  SELECT public.is_platform_user() OR public.current_user_scope_type() = 'tenant';
$$;

-- Restrict execute privileges (least privilege); policies rely on authenticated.
REVOKE EXECUTE ON FUNCTION public.current_user_scope_type() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_scope_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_platform_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_sender_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_client_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_can_write() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_user_scope_type() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_scope_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_sender_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_client_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_write() TO authenticated, service_role;

COMMENT ON FUNCTION public.current_user_scope_type()
  IS 'Returns current authenticated user access_scope_type from public.users.';
COMMENT ON FUNCTION public.current_user_scope_id()
  IS 'Returns current authenticated user access_scope_id from public.users.';
COMMENT ON FUNCTION public.is_platform_user()
  IS 'Returns TRUE when current authenticated user is a platform-scoped user (all organizations).';
COMMENT ON FUNCTION public.current_user_sender_id()
  IS 'Returns sender_id when current authenticated user is sender-scoped (NULL otherwise).';
COMMENT ON FUNCTION public.current_user_client_id()
  IS 'Returns client_id for client-scoped users; for sender-scoped users resolves the sender->client_id; NULL otherwise.';
COMMENT ON FUNCTION public.user_can_write()
  IS 'Returns TRUE when current authenticated user is permitted to write user-facing tables (tenant or platform scope).';

SELECT pg_advisory_unlock(hashtext('202512291310_users_access_scope_model'));

COMMIT;
