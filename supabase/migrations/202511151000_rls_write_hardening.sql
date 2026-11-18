-- Migration: RLS policy hardening for authenticated tenants
-- Purpose: Replace broad FOR ALL policies with explicit read/write/delete guards.
-- Date: 2025-11-15

BEGIN;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE policyname IN (
            'organizations_rls_policy',
            'clients_rls_policy',
            'senders_rls_policy',
            'providers_rls_policy',
            'webhook_sources_rls_policy',
            'shipments_rls_policy',
            'recipients_rls_policy',
            'addresses_rls_policy'
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
    USING (id = current_user_org_id());

CREATE POLICY organizations_delete ON public.organizations
    FOR DELETE
    TO authenticated
    USING (id = current_user_org_id());

CREATE POLICY organizations_insert ON public.organizations
    FOR INSERT
    TO authenticated
    WITH CHECK (id = current_user_org_id());

CREATE POLICY organizations_update ON public.organizations
    FOR UPDATE
    TO authenticated
    USING (id = current_user_org_id())
    WITH CHECK (id = current_user_org_id());

COMMENT ON POLICY organizations_select ON public.organizations IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY organizations_delete ON public.organizations IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY organizations_insert ON public.organizations IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY organizations_update ON public.organizations IS 'Org-level isolation (UPDATE).';

-- clients
CREATE POLICY clients_select ON public.clients
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY clients_delete ON public.clients
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY clients_insert ON public.clients
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY clients_update ON public.clients
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY clients_select ON public.clients IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY clients_delete ON public.clients IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY clients_insert ON public.clients IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY clients_update ON public.clients IS 'Org-level isolation (UPDATE).';

-- senders
CREATE POLICY senders_select ON public.senders
    FOR SELECT
    TO authenticated
    USING (
        client_id IN (
            SELECT id FROM public.clients WHERE organization_id = current_user_org_id()
        )
    );

CREATE POLICY senders_delete ON public.senders
    FOR DELETE
    TO authenticated
    USING (
        client_id IN (
            SELECT id FROM public.clients WHERE organization_id = current_user_org_id()
        )
    );

CREATE POLICY senders_insert ON public.senders
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.clients c
            WHERE c.id = senders.client_id
              AND c.organization_id = current_user_org_id()
        )
    );

CREATE POLICY senders_update ON public.senders
    FOR UPDATE
    TO authenticated
    USING (
        client_id IN (
            SELECT id FROM public.clients WHERE organization_id = current_user_org_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.clients c
            WHERE c.id = senders.client_id
              AND c.organization_id = current_user_org_id()
        )
    );

COMMENT ON POLICY senders_select ON public.senders IS 'Client-level isolation (SELECT).';
COMMENT ON POLICY senders_delete ON public.senders IS 'Client-level isolation (DELETE).';
COMMENT ON POLICY senders_insert ON public.senders IS 'Client-level isolation (INSERT).';
COMMENT ON POLICY senders_update ON public.senders IS 'Client-level isolation (UPDATE).';

-- providers
CREATE POLICY providers_select ON public.providers
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY providers_delete ON public.providers
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY providers_insert ON public.providers
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY providers_update ON public.providers
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY providers_select ON public.providers IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY providers_delete ON public.providers IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY providers_insert ON public.providers IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY providers_update ON public.providers IS 'Org-level isolation (UPDATE).';

-- webhook_sources
CREATE POLICY webhook_sources_select ON public.webhook_sources
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY webhook_sources_delete ON public.webhook_sources
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY webhook_sources_insert ON public.webhook_sources
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY webhook_sources_update ON public.webhook_sources
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY webhook_sources_select ON public.webhook_sources IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY webhook_sources_delete ON public.webhook_sources IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY webhook_sources_insert ON public.webhook_sources IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY webhook_sources_update ON public.webhook_sources IS 'Org-level isolation (UPDATE).';

-- shipments
CREATE POLICY shipments_select ON public.shipments
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY shipments_delete ON public.shipments
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY shipments_insert ON public.shipments
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY shipments_update ON public.shipments
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY shipments_select ON public.shipments IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY shipments_delete ON public.shipments IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY shipments_insert ON public.shipments IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY shipments_update ON public.shipments IS 'Org-level isolation (UPDATE).';

-- recipients
CREATE POLICY recipients_select ON public.recipients
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY recipients_delete ON public.recipients
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY recipients_insert ON public.recipients
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY recipients_update ON public.recipients
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY recipients_select ON public.recipients IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY recipients_delete ON public.recipients IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY recipients_insert ON public.recipients IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY recipients_update ON public.recipients IS 'Org-level isolation (UPDATE).';

-- addresses
CREATE POLICY addresses_select ON public.addresses
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY addresses_delete ON public.addresses
    FOR DELETE
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY addresses_insert ON public.addresses
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

CREATE POLICY addresses_update ON public.addresses
    FOR UPDATE
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY addresses_select ON public.addresses IS 'Org-level isolation (SELECT).';
COMMENT ON POLICY addresses_delete ON public.addresses IS 'Org-level isolation (DELETE).';
COMMENT ON POLICY addresses_insert ON public.addresses IS 'Org-level isolation (INSERT).';
COMMENT ON POLICY addresses_update ON public.addresses IS 'Org-level isolation (UPDATE).';

COMMIT;
