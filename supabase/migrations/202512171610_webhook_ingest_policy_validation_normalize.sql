-- Migration: webhook_ingest_policy validation normalization
-- Purpose:
--   - Normalize webhook_ingest_policy values to match the canonical JSON schema:
--     - Drop legacy top-level "response" key (ack behavior lives under "ack").
--     - Restrict validation.* to supported keys only (idempotency, hmac, json_schema_id).
--   - Repair any existing settings drift by rewriting impacted scopes through
--     upsert_webhook_ingest_policy (append-only settings_versions).

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
    v_validation JSONB;
    v_idempotency JSONB;
    v_hmac JSONB;
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

    -- Normalize incoming policy JSON:
    --  - Strip legacy top-level "response" key (ack lives under "ack").
    --  - Strip unknown validation keys to match the canonical schema.
    v_policy := jsonb_strip_nulls(COALESCE(p_policy, '{}'::jsonb) - 'response');

    IF v_policy ? 'validation' THEN
        v_validation := v_policy->'validation';
        v_idempotency := v_validation->'idempotency';
        v_hmac := v_validation->'hmac';

        v_validation := jsonb_strip_nulls(jsonb_build_object(
            'idempotency', CASE
                WHEN jsonb_typeof(v_idempotency) <> 'object' THEN NULL
                ELSE jsonb_strip_nulls(jsonb_build_object(
                    'header', v_idempotency->'header',
                    'body_path', v_idempotency->'body_path',
                    'dedupe_window_seconds', v_idempotency->'dedupe_window_seconds'
                ))
            END,
            'hmac', CASE
                WHEN jsonb_typeof(v_hmac) <> 'object' THEN NULL
                ELSE jsonb_strip_nulls(jsonb_build_object(
                    'enabled', v_hmac->'enabled',
                    'algorithm', v_hmac->'algorithm',
                    'header', v_hmac->'header',
                    'auth_config_id', v_hmac->'auth_config_id',
                    'timestamp_header', v_hmac->'timestamp_header',
                    'tolerance_seconds', v_hmac->'tolerance_seconds',
                    'signature_encoding', v_hmac->'signature_encoding'
                ))
            END,
            'json_schema_id', v_validation->'json_schema_id'
        ));

        IF v_validation IS NULL OR v_validation = '{}'::jsonb THEN
            v_policy := v_policy - 'validation';
        ELSE
            v_policy := jsonb_set(v_policy, '{validation}', v_validation, TRUE);
        END IF;
    END IF;

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

DO $$
DECLARE
    r RECORD;
    v_policy JSONB;
    v_original JSONB;
    v_validation JSONB;
    v_idempotency JSONB;
    v_hmac JSONB;
BEGIN
    FOR r IN
        SELECT scope_type, scope_id, cached_value AS policy
          FROM settings
         WHERE category = 'webhook_ingest_policy'
           AND (
               cached_value ? 'response'
               OR (
                   cached_value ? 'validation'
                   AND jsonb_typeof(cached_value->'validation') = 'object'
                   AND EXISTS (
                       SELECT 1
                         FROM jsonb_object_keys(cached_value->'validation') AS k(key)
                        WHERE k.key NOT IN ('idempotency', 'hmac', 'json_schema_id')
                   )
               )
               OR (
                   cached_value ? 'validation'
                   AND jsonb_typeof(cached_value->'validation'->'idempotency') = 'object'
                   AND EXISTS (
                       SELECT 1
                         FROM jsonb_object_keys(cached_value->'validation'->'idempotency') AS k(key)
                        WHERE k.key NOT IN ('header', 'body_path', 'dedupe_window_seconds')
                   )
               )
               OR (
                   cached_value ? 'validation'
                   AND jsonb_typeof(cached_value->'validation'->'hmac') = 'object'
                   AND EXISTS (
                       SELECT 1
                         FROM jsonb_object_keys(cached_value->'validation'->'hmac') AS k(key)
                        WHERE k.key NOT IN (
                            'enabled',
                            'algorithm',
                            'header',
                            'auth_config_id',
                            'timestamp_header',
                            'tolerance_seconds',
                            'signature_encoding'
                        )
                   )
               )
           )
    LOOP
        v_original := r.policy;
        v_policy := jsonb_strip_nulls(COALESCE(r.policy, '{}'::jsonb) - 'response');

        IF v_policy ? 'validation' THEN
            v_validation := v_policy->'validation';
            v_idempotency := v_validation->'idempotency';
            v_hmac := v_validation->'hmac';

            v_validation := jsonb_strip_nulls(jsonb_build_object(
                'idempotency', CASE
                    WHEN jsonb_typeof(v_idempotency) <> 'object' THEN NULL
                    ELSE jsonb_strip_nulls(jsonb_build_object(
                        'header', v_idempotency->'header',
                        'body_path', v_idempotency->'body_path',
                        'dedupe_window_seconds', v_idempotency->'dedupe_window_seconds'
                    ))
                END,
                'hmac', CASE
                    WHEN jsonb_typeof(v_hmac) <> 'object' THEN NULL
                    ELSE jsonb_strip_nulls(jsonb_build_object(
                        'enabled', v_hmac->'enabled',
                        'algorithm', v_hmac->'algorithm',
                        'header', v_hmac->'header',
                        'auth_config_id', v_hmac->'auth_config_id',
                        'timestamp_header', v_hmac->'timestamp_header',
                        'tolerance_seconds', v_hmac->'tolerance_seconds',
                        'signature_encoding', v_hmac->'signature_encoding'
                    ))
                END,
                'json_schema_id', v_validation->'json_schema_id'
            ));

            IF v_validation IS NULL OR v_validation = '{}'::jsonb THEN
                v_policy := v_policy - 'validation';
            ELSE
                v_policy := jsonb_set(v_policy, '{validation}', v_validation, TRUE);
            END IF;
        END IF;

        IF v_policy IS DISTINCT FROM v_original THEN
            PERFORM upsert_webhook_ingest_policy(r.scope_type, r.scope_id, v_policy);
        END IF;
    END LOOP;
END $$;

COMMIT;

