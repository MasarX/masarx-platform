-- Migration: Dynamic RLS scope policies (tenant/client/sender/platform)
-- Purpose:
--   - Enforce least-privilege access for authenticated users based on their single active scope.
--   - Keep policies reusable and non-hardcoded by relying on shared helper functions.
BEGIN;

SELECT pg_advisory_lock(hashtext('202512291320_dynamic_rls_scope_policies'));
SET search_path TO public, pg_temp;

-- Drop prior org-only policies (created by earlier hardening migrations).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('organizations', 'clients', 'senders', 'shipments', 'recipients', 'addresses')
      AND policyname IN (
        'organizations_select','organizations_insert','organizations_update','organizations_delete',
        'clients_select','clients_insert','clients_update','clients_delete',
        'senders_select','senders_insert','senders_update','senders_delete',
        'shipments_select','shipments_insert','shipments_update','shipments_delete',
        'recipients_select','recipients_insert','recipients_update','recipients_delete',
        'addresses_select','addresses_insert','addresses_update','addresses_delete'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END;
$$;

-- organizations
CREATE POLICY organizations_select ON public.organizations
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR id = public.current_user_org_id()
  );

CREATE POLICY organizations_insert ON public.organizations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_platform_user());

CREATE POLICY organizations_update ON public.organizations
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND id = public.current_user_org_id()
    )
  );

CREATE POLICY organizations_delete ON public.organizations
  FOR DELETE
  TO authenticated
  USING (public.is_platform_user());

-- clients
CREATE POLICY clients_select ON public.clients
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() IN ('client', 'sender')
      AND id = public.current_user_client_id()
    )
  );

CREATE POLICY clients_insert ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY clients_update ON public.clients
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY clients_delete ON public.clients
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- senders (org is derived via clients)
CREATE POLICY senders_select ON public.senders
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND senders.client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND senders.id = public.current_user_sender_id()
    )
  );

CREATE POLICY senders_insert ON public.senders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

CREATE POLICY senders_update ON public.senders
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

CREATE POLICY senders_delete ON public.senders
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.clients c
        WHERE c.id = senders.client_id
          AND c.organization_id = public.current_user_org_id()
      )
    )
  );

-- shipments
CREATE POLICY shipments_select ON public.shipments
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id = public.current_user_sender_id()
    )
  );

CREATE POLICY shipments_insert ON public.shipments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY shipments_update ON public.shipments
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY shipments_delete ON public.shipments
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- recipients
CREATE POLICY recipients_select ON public.recipients
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.shipments s
        WHERE s.sender_id = public.current_user_sender_id()
          AND s.client_id = recipients.client_id
          AND s.recipient_id = recipients.id
        LIMIT 1
      )
    )
  );

CREATE POLICY recipients_insert ON public.recipients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY recipients_update ON public.recipients
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY recipients_delete ON public.recipients
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- addresses
CREATE POLICY addresses_select ON public.addresses
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.shipments s
        WHERE s.sender_id = public.current_user_sender_id()
          AND s.client_id = addresses.client_id
          AND (
            s.origin_address_id = addresses.id
            OR s.destination_address_id = addresses.id
          )
        LIMIT 1
      )
    )
  );

CREATE POLICY addresses_insert ON public.addresses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY addresses_update ON public.addresses
  FOR UPDATE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

CREATE POLICY addresses_delete ON public.addresses
  FOR DELETE
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

-- shipment_actions (read-only, dynamic scope; sender is shipment-linked)
DROP POLICY IF EXISTS shipment_actions_select_authenticated ON public.shipment_actions;
CREATE POLICY shipment_actions_select_authenticated ON public.shipment_actions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.shipments s
        WHERE s.id = shipment_actions.shipment_id
          AND s.client_id = shipment_actions.client_id
          AND s.sender_id = public.current_user_sender_id()
        LIMIT 1
      )
    )
  );

COMMENT ON POLICY shipment_actions_select_authenticated ON public.shipment_actions IS 'Dynamic scope SELECT: platform/tenant/client; sender limited via shipment linkage.';

-- Comments
COMMENT ON POLICY organizations_select ON public.organizations IS 'Dynamic scope SELECT: platform or current org.';
COMMENT ON POLICY clients_select ON public.clients IS 'Dynamic scope SELECT: platform/tenant/client/sender.';
COMMENT ON POLICY senders_select ON public.senders IS 'Dynamic scope SELECT: platform/tenant/client/sender.';
COMMENT ON POLICY shipments_select ON public.shipments IS 'Dynamic scope SELECT: platform/tenant/client/sender.';
COMMENT ON POLICY recipients_select ON public.recipients IS 'Dynamic scope SELECT: platform/tenant/client; sender limited via shipment linkage.';
COMMENT ON POLICY addresses_select ON public.addresses IS 'Dynamic scope SELECT: platform/tenant/client; sender limited via shipment linkage.';

SELECT pg_advisory_unlock(hashtext('202512291320_dynamic_rls_scope_policies'));

COMMIT;
