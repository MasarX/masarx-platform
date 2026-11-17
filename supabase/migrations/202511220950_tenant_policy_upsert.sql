-- Migration: Tenant Domain Event Policy Upsert Helper

BEGIN;

SET search_path TO public;

CREATE OR REPLACE FUNCTION upsert_tenant_domain_event_policy(
    p_organization_id UUID,
    p_events JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_events JSONB;
    v_value JSONB;
    v_existing settings%ROWTYPE;
    v_sv_id UUID := gen_random_uuid();
    v_s_id UUID;
    v_next_version INT;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_id required';
    END IF;

    v_events := CASE WHEN p_events ? 'events' THEN p_events->'events' ELSE COALESCE(p_events, '{}'::jsonb) END;
    v_value := jsonb_build_object('events', v_events);

    SELECT * INTO v_existing
      FROM settings
     WHERE category = 'domain_event_policy'
       AND scope_type = 'tenant'
       AND scope_id = p_organization_id
     LIMIT 1;

    SELECT COALESCE(MAX(version)+1, 1) INTO v_next_version
      FROM settings_versions
     WHERE category = 'domain_event_policy'
       AND scope_type = 'tenant'
       AND scope_id = p_organization_id;

    INSERT INTO settings_versions (
        id, category, scope_type, scope_id, scope_hash, version, value, schema_version, change_reason, approved_at, effective_from
    ) VALUES (
        v_sv_id, 'domain_event_policy', 'tenant', p_organization_id, p_organization_id, v_next_version, v_value, 1,
        'upsert tenant domain_event_policy', now(), now()
    );

    IF v_existing.id IS NULL THEN
        v_s_id := gen_random_uuid();
        INSERT INTO settings (
            id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
        ) VALUES (
            v_s_id, 'domain_event_policy', 'tenant', p_organization_id, p_organization_id, v_sv_id, v_value, now()
        );
    ELSE
        UPDATE settings
           SET settings_version_id = v_sv_id,
               cached_value = v_value,
               last_updated = now()
         WHERE id = v_existing.id;
        v_s_id := v_existing.id;
    END IF;

    RETURN v_s_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_tenant_domain_event_policy(UUID, JSONB) TO authenticated, service_role;

COMMIT;

