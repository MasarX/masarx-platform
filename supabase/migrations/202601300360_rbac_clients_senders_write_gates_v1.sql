-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC gates for clients + senders write paths v1
-- Date: 2026-01-30
--
-- Why:
--   - Clients/senders are tenant control-plane surfaces (customer + source setup).
--   - Prior baseline allowed any tenant-scoped user to mutate these tables.
--   - Enforce least-privilege by requiring RBAC permission `agreements.write` for authenticated writes.
--
-- Notes:
--   - Reads remain unchanged (SELECT policies remain as-is).
--   - service_role continues to own automation/workflow writes.
--   - Make grants explicit (stable contract; avoid implicit default privilege drift).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300360_rbac_clients_senders_write_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

-------------------------------------------------------------------------------
-- Table contracts (docs): reflect RBAC gating
-------------------------------------------------------------------------------

UPDATE public.table_contracts
   SET notes = 'Tenant control-plane: clients. Authenticated writes require RBAC (agreements.write); reads are scope-limited via RLS.'
 WHERE table_schema = 'public' AND table_name = 'clients';

UPDATE public.table_contracts
   SET notes = 'Tenant control-plane: senders. Authenticated writes require RBAC (agreements.write); reads are scope-limited via RLS.'
 WHERE table_schema = 'public' AND table_name = 'senders';

SELECT pg_advisory_unlock(hashtext('202601300360_rbac_clients_senders_write_gates_v1'));
COMMIT;

