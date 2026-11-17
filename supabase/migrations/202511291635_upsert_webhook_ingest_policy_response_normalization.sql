-- Migration: upsert_webhook_ingest_policy response normalization
-- Purpose:
--   - Ensure new webhook_ingest_policy settings_versions rows are written in the
--     normalized schema expected by pgTAP and downstream tooling, without a
--     top-level "response" key. All acknowledgement behaviour should live
--     under "ack" (including any response mapping).

BEGIN;

CREATE OR REPLACE FUNCTION upsert_webhook_ingest_policy(
    p_scope_type TEXT,
    p_scope_id UUID,
    p_policy JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scope_type TEXT := lower(trim(p_scope_type));
    v_scope_id UUID := p_scope_id;
    v_scope_hash UUID;
    v_policy JSONB;
    v_existing settings%ROWTYPE;
    v_sv_id UUID := gen_random_uuid();
    v_s_id UUID;
    v_next_version INT;
    v_allowed_scope_types CONSTANT TEXT[] := ARRAY['global', 'tenant', 'client', 'sender', 'source'];
BEGIN
    IF v_scope_type NOT IN (SELECT UNNEST(v_allowed_scope_types)) THEN
        RAISE EXCEPTION 'invalid scope_type %, expected one of %', v_scope_type, v_allowed_scope_types;
    END IF;

    IF v_scope_type = 'global' THEN
        IF v_scope_id IS NOT NULL THEN
            RAISE EXCEPTION 'global scope requires NULL scope_id';
        END IF;
        v_scope_hash := '00000000-0000-0000-0000-000000000000';
    ELSE
        IF v_scope_id IS NULL THEN
            RAISE EXCEPTION 'scope_id required for scope_type %', v_scope_type;
        END IF;
        v_scope_hash := v_scope_id;
    END IF;

    -- Normalize incoming policy JSON to avoid legacy top-level "response"
    -- keys; all acknowledgement behaviour must live under "ack".
    v_policy := jsonb_strip_nulls(COALESCE(p_policy, '{}'::jsonb) - 'response');

    SELECT *
      INTO v_existing
      FROM settings
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = v_scope_type
       AND (scope_id IS NOT DISTINCT FROM v_scope_id)
     LIMIT 1;

    SELECT COALESCE(MAX(version) + 1, 1)
      INTO v_next_version
      FROM settings_versions
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = v_scope_type
       AND (scope_id IS NOT DISTINCT FROM v_scope_id);

    INSERT INTO settings_versions (
        id, category, scope_type, scope_id, scope_hash, version,
        value, schema_version, change_reason, approved_at, effective_from
    ) VALUES (
        v_sv_id,
        'webhook_ingest_policy',
        v_scope_type,
        v_scope_id,
        v_scope_hash,
        v_next_version,
        v_policy,
        1,
        format('upsert webhook_ingest_policy (%s)', v_scope_type),
        now(),
        now()
    );

    IF v_existing.id IS NULL THEN
        v_s_id := gen_random_uuid();
        INSERT INTO settings (
            id, category, scope_type, scope_id, scope_hash,
            settings_version_id, cached_value, last_updated
        ) VALUES (
            v_s_id,
            'webhook_ingest_policy',
            v_scope_type,
            v_scope_id,
            v_scope_hash,
            v_sv_id,
            v_policy,
            now()
        );
    ELSE
        v_s_id := v_existing.id;
        UPDATE settings
           SET settings_version_id = v_sv_id,
               cached_value = v_policy,
               last_updated = now()
         WHERE id = v_existing.id;
    END IF;

    RETURN v_s_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_webhook_ingest_policy(TEXT, UUID, JSONB) TO authenticated, service_role;

COMMIT;

