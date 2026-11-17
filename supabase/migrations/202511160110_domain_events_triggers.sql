-- Migration: Domain event triggers for internal tables
-- Purpose: Emit domain_events for shipment actions and address updates (engine-first routing).

BEGIN;

-------------------------------------------------------------------------------
-- Trigger helper: shipment_actions -> domain_events
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION domain_event_from_shipment_action()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_org UUID;
    v_payload JSONB;
    v_event_type TEXT;
    v_correlation UUID := NULL;
BEGIN
    SELECT organization_id
    INTO v_org
    FROM shipments
    WHERE id = NEW.shipment_id;

    IF v_org IS NULL THEN
        -- Shipment missing (should not happen); skip emit.
        RETURN NEW;
    END IF;

    v_event_type := format('shipment_action.%s', COALESCE(lower(NEW.action_type), 'unknown'));

    v_payload := jsonb_strip_nulls(jsonb_build_object(
        'shipment_id', NEW.shipment_id,
        'action_type', NEW.action_type,
        'action_category', NEW.action_category,
        'canonical_status', NEW.canonical_status,
        'performed_by_system', NEW.performed_by_system,
        'performed_by_user_id', NEW.performed_by_user_id,
        'timestamp', NEW.timestamp,
        'action_data', COALESCE(NEW.action_data, '{}'::jsonb)
    ));

    PERFORM enqueue_domain_event(
        p_organization_id := v_org,
        p_event_type := v_event_type,
        p_resource_type := 'shipment',
        p_resource_id := NEW.shipment_id,
        p_payload := v_payload,
        p_correlation_id := v_correlation
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shipment_actions_domain_event ON shipment_actions;
CREATE TRIGGER trg_shipment_actions_domain_event
    AFTER INSERT ON shipment_actions
    FOR EACH ROW
    EXECUTE FUNCTION domain_event_from_shipment_action();

-------------------------------------------------------------------------------
-- Trigger helper: addresses updates -> domain_events
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION domain_event_from_address_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_changed BOOLEAN := FALSE;
    v_payload JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_changed := TRUE;
    ELSIF TG_OP = 'UPDATE' AND (ROW(OLD.*) IS DISTINCT FROM ROW(NEW.*)) THEN
        v_changed := TRUE;
    END IF;

    IF NOT v_changed THEN
        RETURN NEW;
    END IF;

    v_payload := jsonb_strip_nulls(jsonb_build_object(
        'address_id', NEW.id,
        'client_id', NEW.client_id,
        'organization_id', NEW.organization_id,
        'raw_input', NEW.raw_input,
        'normalized_line1', NEW.normalized_line1,
        'normalized_line2', NEW.normalized_line2,
        'district', NEW.district,
        'city', NEW.city,
        'province', NEW.province,
        'postal_code', NEW.postal_code,
        'validation_status', NEW.validation_status,
        'updated_at', NEW.updated_at
    ));

    PERFORM enqueue_domain_event(
        p_organization_id := NEW.organization_id,
        p_event_type := 'address.updated',
        p_resource_type := 'address',
        p_resource_id := NEW.id,
        p_payload := v_payload,
        p_correlation_id := NULL
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_addresses_domain_event ON addresses;
CREATE TRIGGER trg_addresses_domain_event
    AFTER INSERT OR UPDATE ON addresses
    FOR EACH ROW
    EXECUTE FUNCTION domain_event_from_address_update();

COMMIT;
