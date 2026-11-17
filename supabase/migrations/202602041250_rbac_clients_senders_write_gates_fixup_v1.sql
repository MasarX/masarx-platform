-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: RBAC gates for clients + senders write paths fixup v1
-- Purpose:
--   - Repair drift in long-lived environments where legacy broad RLS policies or pre-RBAC
--     write policies allow authenticated users to insert/update/delete clients/senders without
--     RBAC permission.
--   - Canonical contract: authenticated writes require RBAC permission `agreements.write`.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041250_rbac_clients_senders_write_gates_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- Drop legacy broad policies (if any remain).
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS clients_rls_policy ON public.clients;
DROP POLICY IF EXISTS senders_rls_policy ON public.senders;

-------------------------------------------------------------------------------
-- Grants (explicit contract): authenticated can write only when RLS permits.
-------------------------------------------------------------------------------

REVOKE ALL ON TABLE public.clients FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clients TO authenticated;

REVOKE ALL ON TABLE public.senders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.senders TO authenticated;

-------------------------------------------------------------------------------
-- Clients: authenticated writes require agreements.write (RBAC)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS clients_insert ON public.clients;
CREATE POLICY clients_insert ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS clients_update ON public.clients;
CREATE POLICY clients_update ON public.clients
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS clients_delete ON public.clients;
CREATE POLICY clients_delete ON public.clients
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', organization_id)
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- Senders: authenticated writes require agreements.write (RBAC)
-- (org derived via clients)
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS senders_insert ON public.senders;
CREATE POLICY senders_insert ON public.senders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS senders_update ON public.senders;
CREATE POLICY senders_update ON public.senders
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS senders_delete ON public.senders;
CREATE POLICY senders_delete ON public.senders
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_permission_v1('agreements.write', public.current_user_org_id())
    AND (
      public.is_platform_user()
      OR EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

SELECT pg_advisory_unlock(hashtext('202602041250_rbac_clients_senders_write_gates_fixup_v1'));
COMMIT;

