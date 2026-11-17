-- Migration: resolve_organization_id_strict hardening
-- Purpose: Qualify table names to avoid search_path ambiguities observed in cloud

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_organization_id_strict(
    p_resource_type TEXT,
    p_resource_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_org UUID;
BEGIN
    CASE p_resource_type
        WHEN 'provider' THEN
            SELECT organization_id INTO v_org FROM public.providers WHERE id = p_resource_id;
        WHEN 'client' THEN
            SELECT organization_id INTO v_org FROM public.clients WHERE id = p_resource_id;
        WHEN 'sender' THEN
            SELECT c.organization_id INTO v_org
            FROM public.senders s
            JOIN public.clients c ON c.id = s.client_id
            WHERE s.id = p_resource_id;
        WHEN 'shipment' THEN
            SELECT c.organization_id INTO v_org
            FROM public.shipments s
            JOIN public.clients c ON c.id = s.client_id
            WHERE s.id = p_resource_id;
        WHEN 'webhook_inbox' THEN
            SELECT ws.organization_id INTO v_org
            FROM public.webhook_inbox wi
            JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
            WHERE wi.id = p_resource_id;
        WHEN 'outbound_call' THEN
            SELECT organization_id INTO v_org
            FROM public.providers
            WHERE id = (
                SELECT target_id
                FROM public.outbound_calls
                WHERE id = p_resource_id
                  AND target_type = 'provider'
            );
            IF v_org IS NULL THEN
                SELECT c.organization_id
                INTO v_org
                FROM public.outbound_calls oc
                JOIN public.clients c ON c.id = oc.target_id
                WHERE oc.id = p_resource_id
                  AND oc.target_type = 'client';
            END IF;
        WHEN 'alert_rule' THEN
            SELECT organization_id INTO v_org FROM public.alert_rules WHERE id = p_resource_id;
        WHEN 'circuit_breaker_state' THEN
            SELECT p.organization_id INTO v_org
            FROM public.circuit_breaker_state cbs
            JOIN public.providers p ON p.id = cbs.provider_id
            WHERE cbs.id = p_resource_id;
        ELSE
            RAISE EXCEPTION 'resolve_organization_id_strict: unsupported resource_type=%', p_resource_type;
    END CASE;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve organization_id for resource_type=% resource_id=%', p_resource_type, p_resource_id;
    END IF;

    RETURN v_org;
END;
$$;

COMMIT;

