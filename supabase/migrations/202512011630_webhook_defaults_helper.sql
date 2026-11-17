-- Migration: Provide resolve_webhook_defaults helper for webhook intake defaults ladder
-- Date: 2025-12-01

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_webhook_defaults(p_webhook_source_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_settings JSONB;
    v_org_id UUID;
BEGIN
    IF p_webhook_source_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;

    SELECT organization_id
    INTO v_org_id
    FROM webhook_sources
    WHERE id = p_webhook_source_id;

    -- Resource-level defaults win.
    v_settings := resolve_settings('webhook_intake', 'resource', p_webhook_source_id);

    -- Then tenant-level defaults (organization)
    IF v_settings IS NULL AND v_org_id IS NOT NULL THEN
        v_settings := resolve_settings('webhook_intake', 'tenant', v_org_id);
    END IF;

    -- Finally, global defaults
    IF v_settings IS NULL THEN
        v_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;

    RETURN COALESCE(v_settings->'defaults', '{}'::jsonb);
END;
$$;

COMMIT;
