-- Migration: Resolve settings function hardening
-- Purpose: Qualify table names to avoid search_path issues observed in cloud runtime
-- Date: 2025-11-13

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_settings(
    p_category TEXT,
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public, pg_temp'
AS $$
DECLARE
    v_value JSONB;
    v_client_id UUID;
    v_org_id UUID;
    v_sender_id UUID;
BEGIN
    IF p_category IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_scope_type IS NULL OR p_scope_type = '' THEN
        p_scope_type := 'global';
    ELSIF p_scope_type = 'organization' THEN
        p_scope_type := 'tenant';
    END IF;

    IF p_scope_type = 'global' THEN
        SELECT cached_value
        INTO v_value
        FROM public.settings
        WHERE category = p_category
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY last_updated DESC
        LIMIT 1;
        RETURN v_value;
    END IF;

    SELECT cached_value
    INTO v_value
    FROM public.settings
    WHERE category = p_category
      AND scope_type = p_scope_type
      AND (
            (scope_type = 'global' AND scope_id IS NULL)
            OR scope_id = p_scope_id
          )
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_value IS NOT NULL THEN
        RETURN v_value;
    END IF;

    IF p_scope_type = 'resource' THEN
        RETURN public.resolve_settings(p_category, 'global'::text, NULL);
    ELSIF p_scope_type = 'source' THEN
        SELECT sender_id, organization_id
        INTO v_sender_id, v_org_id
        FROM public.webhook_sources
        WHERE id = p_scope_id;

        IF v_sender_id IS NOT NULL THEN
            v_value := public.resolve_settings(p_category, 'sender'::text, v_sender_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;

            SELECT client_id INTO v_client_id FROM public.senders WHERE id = v_sender_id;
            IF v_client_id IS NOT NULL THEN
                v_value := public.resolve_settings(p_category, 'client'::text, v_client_id);
                IF v_value IS NOT NULL THEN
                    RETURN v_value;
                END IF;
            END IF;
        END IF;

        IF v_client_id IS NULL AND v_sender_id IS NULL AND v_org_id IS NULL THEN
            SELECT organization_id INTO v_org_id FROM public.webhook_sources WHERE id = p_scope_id;
        END IF;

        IF v_org_id IS NOT NULL THEN
            v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN public.resolve_settings(p_category, 'global'::text, NULL);
    ELSIF p_scope_type = 'sender' THEN
        SELECT client_id INTO v_client_id FROM public.senders WHERE id = p_scope_id;
        IF v_client_id IS NOT NULL THEN
            v_value := public.resolve_settings(p_category, 'client'::text, v_client_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        SELECT c.organization_id INTO v_org_id
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
        WHERE s.id = p_scope_id;

        IF v_org_id IS NOT NULL THEN
            v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN public.resolve_settings(p_category, 'global'::text, NULL);
    ELSIF p_scope_type = 'client' THEN
        SELECT organization_id INTO v_org_id FROM public.clients WHERE id = p_scope_id;
        IF v_org_id IS NOT NULL THEN
            v_value := public.resolve_settings(p_category, 'tenant'::text, v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN public.resolve_settings(p_category, 'global'::text, NULL);
    ELSIF p_scope_type = 'tenant' THEN
        RETURN public.resolve_settings(p_category, 'global', NULL);
    ELSE
        RETURN public.resolve_settings(p_category, 'global'::text, NULL);
    END IF;
END;
$$;

COMMIT;
