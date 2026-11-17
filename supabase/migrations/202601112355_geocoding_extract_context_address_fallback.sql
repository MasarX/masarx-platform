-- Migration: Geocoding extract context address fallback
-- Purpose:
--   - Resolve shipment_id from destination_address_id when missing in context.
--   - Keep zone assignment workflow-driven and avoid bypassing core flow.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | RLS
-- Date: 2026-01-11

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.geocoding_extract_context(p_run workflow_runs)
RETURNS TABLE (
    organization_id UUID,
    client_id UUID,
    sender_id UUID,
    shipment_id UUID,
    address_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_shipment_id UUID;
    v_address_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_addr UUID;
    v_context_org UUID;
    v_context_client UUID;
    v_context_sender UUID;
BEGIN
    v_shipment_id := COALESCE(
        NULLIF(v_context->>'shipment_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->>'shipment_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'id', '')::UUID
    );

    v_address_id := COALESCE(
        NULLIF(v_context->>'address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'address_id', '')::UUID
    );

    v_context_org := NULLIF(v_context->>'organization_id', '')::UUID;
    v_context_client := NULLIF(v_context->>'client_id', '')::UUID;
    v_context_sender := NULLIF(v_context->>'sender_id', '')::UUID;

    IF v_shipment_id IS NOT NULL THEN
        SELECT
            s.organization_id,
            s.client_id,
            s.sender_id,
            s.destination_address_id
        INTO v_org, v_client, v_sender, v_addr
        FROM public.shipments s
        WHERE s.id = v_shipment_id;
    ELSIF v_address_id IS NOT NULL THEN
        SELECT
            s.id,
            s.organization_id,
            s.client_id,
            s.sender_id,
            s.destination_address_id
        INTO v_shipment_id, v_org, v_client, v_sender, v_addr
        FROM public.shipments s
        WHERE s.destination_address_id = v_address_id
          AND (v_context_client IS NULL OR s.client_id = v_context_client)
        ORDER BY s.created_at DESC NULLS LAST
        LIMIT 1;
    END IF;

    v_org := COALESCE(v_org, v_context_org);
    v_client := COALESCE(v_client, v_context_client);
    v_sender := COALESCE(v_sender, v_context_sender);
    v_addr := COALESCE(v_addr, v_address_id);

    RETURN QUERY
    SELECT
        v_org,
        v_client,
        v_sender,
        v_shipment_id,
        v_addr;
END;
$$;

COMMENT ON FUNCTION public.geocoding_extract_context(workflow_runs)
    IS 'Derives organization, client, sender, shipment, and address identifiers from a workflow run context (with address->shipment fallback).';

COMMIT;
