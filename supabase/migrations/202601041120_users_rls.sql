-- Migration: Users RLS policies
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041120_users_rls'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.users FROM PUBLIC;
REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;

DROP POLICY IF EXISTS users_service_policy ON public.users;
CREATE POLICY users_service_policy
  ON public.users
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS users_authenticated_select ON public.users;
CREATE POLICY users_authenticated_select
  ON public.users
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR (
      public.user_has_capability_v1('users.read')
      AND (
        public.is_platform_user()
        OR organization_id = public.current_user_org_id()
      )
    )
  );

SELECT pg_advisory_unlock(hashtext('202601041120_users_rls'));
COMMIT;
