-- Purpose: resolve recipient-targeted outbound communication jobs to tenant scope.
-- Live Console V2 shipment timelines showed SMS outbound_calls failing before
-- provider attempts because resolve_organization_id_strict only handled
-- provider/client outbound targets.

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
            SELECT COALESCE(s.organization_id, c.organization_id) INTO v_org
            FROM public.shipments s
            JOIN public.clients c ON c.id = s.client_id
            WHERE s.id = p_resource_id;
        WHEN 'webhook_inbox' THEN
            SELECT ws.organization_id INTO v_org
            FROM public.webhook_inbox wi
            JOIN public.webhook_sources ws ON ws.id = wi.webhook_source_id
            WHERE wi.id = p_resource_id;
        WHEN 'outbound_call' THEN
            SELECT p.organization_id
            INTO v_org
            FROM public.outbound_calls oc
            JOIN public.providers p ON p.id = oc.target_id
            WHERE oc.id = p_resource_id
              AND oc.target_type = 'provider';

            IF v_org IS NULL THEN
                SELECT c.organization_id
                INTO v_org
                FROM public.outbound_calls oc
                JOIN public.clients c ON c.id = oc.target_id
                WHERE oc.id = p_resource_id
                  AND oc.target_type = 'client';
            END IF;

            IF v_org IS NULL THEN
                SELECT r.organization_id
                INTO v_org
                FROM public.outbound_calls oc
                JOIN public.recipients r ON r.id = oc.target_id
                WHERE oc.id = p_resource_id
                  AND oc.target_type = 'recipient';
            END IF;

            IF v_org IS NULL THEN
                SELECT COALESCE(s.organization_id, c.organization_id)
                INTO v_org
                FROM public.outbound_calls oc
                JOIN public.shipments s ON s.id = oc.shipment_id
                JOIN public.clients c ON c.id = s.client_id
                WHERE oc.id = p_resource_id;
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

COMMENT ON FUNCTION public.resolve_organization_id_strict(TEXT, UUID)
    IS 'Resolve organization_id for known resource types, including recipient/shipment-scoped outbound calls. Raises if the organisation cannot be determined.';

COMMIT;
