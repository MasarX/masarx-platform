-- Resolve inline label templates when a tenant already has the requested
-- template_key/version with different renderer config. The resolver now
-- materializes the same inline config at the next version and reuses that
-- version on subsequent calls instead of failing live label requests.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230315_resolve_label_template_inline_bump_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_label_template(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_label_type TEXT
)
RETURNS TABLE (
    template_id UUID,
    template_version INTEGER,
    template_snapshot JSONB,
    resolved_scope TEXT,
    max_attempts INTEGER,
    retry_backoff JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_config JSONB;
    v_template JSONB;
    v_scope TEXT;
    v_template_key TEXT;
    v_template_version INTEGER;
    v_template_id UUID;
    v_renderer_config JSONB;
    v_max_attempts INTEGER;
    v_retry_backoff JSONB;
    v_assets JSONB;
    v_label_type TEXT := lower(p_label_type);
    v_page JSONB;
    v_barcode JSONB;
    v_blocks JSONB;
    v_template_record label_template_specs%ROWTYPE;
    v_inline_errors JSONB;
    v_context JSONB;
BEGIN
    IF p_label_type IS NULL OR trim(p_label_type) = '' THEN
        RAISE EXCEPTION 'label_type must be provided.';
    END IF;

    v_context := jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', p_organization_id,
        'client_id', p_client_id,
        'sender_id', p_sender_id
      )
    );

    SELECT r.value, r.scope_type
      INTO v_config, v_scope
      FROM public.resolve_settings_row_from_context('label_design', v_context) r
     LIMIT 1;

    IF v_config IS NULL THEN
        RAISE EXCEPTION 'Label design configuration missing for organization %', p_organization_id;
    END IF;

    IF (v_config ? 'templates') THEN
        v_template := v_config -> 'templates' -> v_label_type;
        IF v_template IS NULL THEN
            v_template := v_config -> 'templates' -> 'default';
        END IF;
    END IF;

    IF v_template IS NULL THEN
        IF v_config ? 'templates' THEN
            v_template := v_config -> 'templates' -> p_label_type;
            IF v_template IS NULL THEN
                v_template := v_config -> 'templates' -> 'default';
            END IF;
        END IF;
    END IF;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'Template configuration missing for label_type=% within scope=%', p_label_type, v_scope;
    END IF;

    IF (v_template ? 'page') AND (v_template ? 'blocks') THEN
        v_template_key := COALESCE(NULLIF(v_template ->> 'template_key', ''), v_label_type);
        v_page := COALESCE(v_template -> 'page', '{}'::jsonb);
        v_blocks := COALESCE(v_template -> 'blocks', '[]'::jsonb);
        v_assets := COALESCE(v_template -> 'assets', '[]'::jsonb);
        v_barcode := COALESCE(v_template -> 'barcode', '{}'::jsonb);

        IF (v_barcode = '{}'::jsonb) THEN
            SELECT jsonb_build_object(
                'type', COALESCE(block ->> 'barcode_type', 'CODE128'),
                'value_path', COALESCE(block ->> 'value_path', 'shipment.tracking_number')
            )
            INTO v_barcode
            FROM jsonb_array_elements(v_blocks) AS block
            WHERE block ->> 'type' = 'barcode'
            LIMIT 1;

            IF v_barcode IS NULL THEN
                v_barcode := jsonb_build_object(
                    'type', 'CODE128',
                    'value_path', 'shipment.tracking_number'
                );
            END IF;
        END IF;

        v_renderer_config := jsonb_strip_nulls(
            jsonb_build_object(
                'page', v_page,
                'blocks', v_blocks,
                'assets', v_assets,
                'barcode', v_barcode
            )
        );

        v_inline_errors := public.validate_label_renderer_config(v_renderer_config);
        IF v_inline_errors IS NOT NULL AND v_inline_errors <> '[]'::jsonb THEN
          RAISE EXCEPTION 'Inline renderer_config invalid: %', v_inline_errors
            USING ERRCODE = 'P0001';
        END IF;

        v_template_version := 1;
        IF (v_template ->> 'version') IS NOT NULL THEN
            BEGIN
                v_template_version := NULLIF(regexp_replace(v_template ->> 'version', '[^0-9]', '', 'g'), '')::INTEGER;
            EXCEPTION WHEN OTHERS THEN
                v_template_version := 1;
            END;
        END IF;

        v_template_id := uuid_from_hash(format(
            '%s:%s:%s:%s',
            COALESCE(p_organization_id::text, 'global'),
            v_scope,
            v_template_key,
            v_template_version
        ));

        INSERT INTO public.label_template_specs (
            id,
            organization_id,
            template_key,
            version,
            template_scope_type,
            template_scope_id,
            renderer_config,
            asset_refs
        )
        VALUES (
            v_template_id,
            p_organization_id,
            v_template_key,
            v_template_version,
            v_scope,
            CASE
                WHEN v_scope = 'global' THEN NULL
                WHEN v_scope = 'tenant' THEN p_organization_id
                WHEN v_scope = 'client' THEN p_client_id
                WHEN v_scope = 'sender' THEN p_sender_id
                ELSE p_organization_id
            END,
            v_renderer_config,
            v_assets
        )
        ON CONFLICT (organization_id, template_key, version) DO NOTHING;

        SELECT *
          INTO v_template_record
          FROM public.label_template_specs
         WHERE organization_id = p_organization_id
           AND template_key = v_template_key
           AND version = v_template_version
         ORDER BY created_at DESC
         LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Failed to materialize inline label template % version % for organization %',
              v_template_key, v_template_version, p_organization_id;
        END IF;

        IF v_template_record.renderer_config IS DISTINCT FROM v_renderer_config
           OR v_template_record.asset_refs IS DISTINCT FROM v_assets THEN
            SELECT *
              INTO v_template_record
              FROM public.label_template_specs
             WHERE organization_id = p_organization_id
               AND template_key = v_template_key
               AND renderer_config IS NOT DISTINCT FROM v_renderer_config
               AND asset_refs IS NOT DISTINCT FROM v_assets
             ORDER BY version DESC
             LIMIT 1;

            IF NOT FOUND THEN
                SELECT COALESCE(MAX(version), 0) + 1
                  INTO v_template_version
                  FROM public.label_template_specs
                 WHERE organization_id = p_organization_id
                   AND template_key = v_template_key;

                v_template_id := uuid_from_hash(format(
                    '%s:%s:%s:%s',
                    COALESCE(p_organization_id::text, 'global'),
                    v_scope,
                    v_template_key,
                    v_template_version
                ));

                INSERT INTO public.label_template_specs (
                    id,
                    organization_id,
                    template_key,
                    version,
                    template_scope_type,
                    template_scope_id,
                    renderer_config,
                    asset_refs
                )
                VALUES (
                    v_template_id,
                    p_organization_id,
                    v_template_key,
                    v_template_version,
                    v_scope,
                    CASE
                        WHEN v_scope = 'global' THEN NULL
                        WHEN v_scope = 'tenant' THEN p_organization_id
                        WHEN v_scope = 'client' THEN p_client_id
                        WHEN v_scope = 'sender' THEN p_sender_id
                        ELSE p_organization_id
                    END,
                    v_renderer_config,
                    v_assets
                )
                ON CONFLICT (organization_id, template_key, version) DO NOTHING;

                SELECT *
                  INTO v_template_record
                  FROM public.label_template_specs
                 WHERE organization_id = p_organization_id
                   AND template_key = v_template_key
                   AND version = v_template_version
                   AND renderer_config IS NOT DISTINCT FROM v_renderer_config
                   AND asset_refs IS NOT DISTINCT FROM v_assets
                 LIMIT 1;

                IF NOT FOUND THEN
                    RAISE EXCEPTION 'Failed to materialize inline label template % bumped version % for organization %',
                      v_template_key, v_template_version, p_organization_id;
                END IF;
            END IF;
        END IF;

        v_template_id := v_template_record.id;
        v_template_version := v_template_record.version;
        v_max_attempts := COALESCE(NULLIF(v_template ->> 'max_attempts', '')::INTEGER, 5);
        v_retry_backoff := COALESCE(v_template -> 'retry_backoff_seconds', '[]'::jsonb);

        RETURN QUERY
        SELECT
            v_template_id,
            v_template_version,
            jsonb_build_object(
                'template_id', v_template_id,
                'template_key', v_template_key,
                'template_version', v_template_version,
                'renderer_config', v_renderer_config,
                'asset_refs', v_assets,
                'resolved_scope', v_scope,
                'label_config', jsonb_strip_nulls(
                    jsonb_build_object(
                        'version', v_template_version,
                        'provider_hint', v_template ->> 'provider_hint',
                        'max_attempts', v_max_attempts,
                        'retry_backoff_seconds', v_retry_backoff,
                        'barcode_format', v_barcode ->> 'type'
                    )
                ),
                'schema_version', 2,
                'label_type', v_label_type
            ),
            v_scope,
            v_max_attempts,
            v_retry_backoff;

        RETURN;
    END IF;

    v_template_key := v_template ->> 'template_key';
    IF v_template_key IS NULL OR trim(v_template_key) = '' THEN
        RAISE EXCEPTION 'Template configuration for label_type=% is missing template_key', p_label_type;
    END IF;

    v_template_version := NULLIF(v_template ->> 'template_version', '')::INTEGER;

    IF v_template_version IS NOT NULL THEN
        SELECT *
        INTO v_template_record
        FROM label_template_specs
        WHERE organization_id = p_organization_id
          AND template_key = v_template_key
          AND version = v_template_version
        ORDER BY version DESC
        LIMIT 1;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Template % (version %s) not found for organization %',
              v_template_key,
              COALESCE(v_template_version::TEXT, 'latest'),
              p_organization_id;
        END IF;

        PERFORM public.assert_label_template_published(v_template_record.id, v_template_record.organization_id);
    ELSE
        SELECT t.*
        INTO v_template_record
        FROM label_template_specs t
        JOIN label_template_validation v
          ON v.template_id = t.id
         AND v.organization_id = t.organization_id
         AND v.validation_status = 'passed'
        WHERE t.organization_id = p_organization_id
          AND t.template_key = v_template_key
        ORDER BY t.version DESC
        LIMIT 1;

        IF NOT FOUND THEN
          SELECT *
          INTO v_template_record
          FROM label_template_specs
          WHERE organization_id = p_organization_id
            AND template_key = v_template_key
          ORDER BY version DESC
          LIMIT 1;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'Template % (version %s) not found for organization %',
              v_template_key,
              'latest',
              p_organization_id;
          END IF;

          PERFORM public.assert_label_template_published(v_template_record.id, v_template_record.organization_id);
        END IF;
    END IF;

    RETURN QUERY
    SELECT
        v_template_record.id,
        v_template_record.version,
        jsonb_build_object(
            'template_key', v_template_key,
            'template_version', v_template_record.version,
            'renderer_config', v_template_record.renderer_config,
            'asset_refs', v_template_record.asset_refs,
            'resolved_scope', v_scope,
            'label_config', v_template
        ),
        v_scope,
        COALESCE(NULLIF(v_template ->> 'max_attempts', '')::INTEGER, 5),
        COALESCE(v_template -> 'retry_backoff_seconds', '[]'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.resolve_label_template(UUID, UUID, UUID, TEXT)
    IS 'Resolve template metadata for a label request, enforcing publish gate for catalog templates and materializing inline template config at a new version when an older version key already exists with different renderer config.';

SELECT pg_advisory_unlock(hashtext('202605230315_resolve_label_template_inline_bump_v1'));
COMMIT;
