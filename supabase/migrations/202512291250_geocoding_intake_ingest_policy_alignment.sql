-- Migration: Align geocoding-intake-test webhook ingest policy to live source id
--
-- Some environments may already have a geocoding-intake-test webhook source with a
-- non-deterministic UUID. The webhook_ingest_policy seed must be scoped to the
-- actual webhook_sources.id so integration tests and webhook intake resolve the
-- correct policy row.

BEGIN;

SELECT pg_advisory_lock(hashtext('202512291250_geocoding_intake_ingest_policy_alignment'));

SET search_path TO public;

DO $$
DECLARE
    v_source_id uuid;
    v_mapping_config_id uuid;
    v_workflow_template_id uuid;
    v_schema_version integer;
    v_next_version integer;
    v_settings_version_id uuid;
    v_payload jsonb;
BEGIN
    SELECT ws.id
      INTO v_source_id
      FROM public.webhook_sources ws
     WHERE ws.source_identifier = 'geocoding-intake-test'
     ORDER BY ws.updated_at DESC NULLS LAST
     LIMIT 1;

    IF v_source_id IS NULL THEN
        RAISE NOTICE 'geocoding-intake-test webhook source not found; skipping webhook_ingest_policy alignment';
        RETURN;
    END IF;

    SELECT mc.id
      INTO v_mapping_config_id
      FROM public.mapping_configs mc
     WHERE mc.mapping_key = 'geocoding-intake-test::address.intake_v1'
     ORDER BY mc.mapping_version DESC NULLS LAST
     LIMIT 1;

    IF v_mapping_config_id IS NULL THEN
        RAISE NOTICE 'mapping_config geocoding-intake-test::address.intake_v1 not found; skipping webhook_ingest_policy alignment';
        RETURN;
    END IF;

    SELECT wt.id
      INTO v_workflow_template_id
      FROM public.workflow_templates wt
     WHERE wt.name = 'workflow_geocoding_standard'
     ORDER BY wt.version DESC NULLS LAST
     LIMIT 1;

    IF v_workflow_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard template not found; skipping webhook_ingest_policy alignment';
        RETURN;
    END IF;

    SELECT sr.version
      INTO v_schema_version
      FROM public.schema_registry sr
     WHERE sr.category = 'webhook_ingest_policy'
       AND sr.is_active = TRUE
     ORDER BY sr.version DESC
     LIMIT 1;

    IF v_schema_version IS NULL THEN
        RAISE NOTICE 'schema_registry has no active webhook_ingest_policy schema; skipping webhook_ingest_policy alignment';
        RETURN;
    END IF;

    v_payload := jsonb_build_object(
        'version', 1,
        'ack', jsonb_build_object(
            'mode', 'accepted_async',
            'status_code', 202,
            'default_headers', jsonb_build_object('content-type', 'application/json')
        ),
        'validation', jsonb_build_object(
            'idempotency', jsonb_build_object('body_path', 'event.id')
        ),
        'workflow', jsonb_build_object(
            'template_id', v_workflow_template_id,
            'intent', 'geocoding',
            'context_patch', jsonb_build_object(
                'mapping_config_id', v_mapping_config_id,
                'source_identifier', 'geocoding-intake-test'
            )
        ),
        'logging', jsonb_build_object(
            'decision_point', 'workflow_intake_ack',
            'tags', jsonb_build_array('geocoding', 'webhook')
        )
    );

    IF EXISTS (
        SELECT 1
          FROM public.settings s
         WHERE s.category = 'webhook_ingest_policy'
           AND s.scope_type = 'source'
           AND s.scope_hash = v_source_id
           AND s.cached_value = v_payload
    ) THEN
        RAISE NOTICE 'webhook_ingest_policy already aligned for geocoding-intake-test; skipping';
        RETURN;
    END IF;

    SELECT COALESCE(MAX(sv.version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions sv
     WHERE sv.category = 'webhook_ingest_policy'
       AND sv.scope_type = 'source'
       AND sv.scope_hash = v_source_id;

    UPDATE public.settings_versions
       SET effective_until = clock_timestamp()
     WHERE category = 'webhook_ingest_policy'
       AND scope_type = 'source'
       AND scope_hash = v_source_id
       AND effective_until IS NULL;

    v_settings_version_id := gen_random_uuid();

    INSERT INTO public.settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
    )
    VALUES (
        v_settings_version_id,
        'webhook_ingest_policy',
        'source',
        v_source_id,
        v_source_id,
        v_next_version,
        v_payload,
        v_schema_version,
        'seed: align geocoding webhook ingest policy',
        clock_timestamp(),
        clock_timestamp()
    );

    INSERT INTO public.settings (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        settings_version_id,
        cached_value,
        last_updated
    )
    VALUES (
        gen_random_uuid(),
        'webhook_ingest_policy',
        'source',
        v_source_id,
        v_source_id,
        v_settings_version_id,
        v_payload,
        clock_timestamp()
    )
    ON CONFLICT (category, scope_type, scope_hash)
    DO UPDATE SET
        scope_id = EXCLUDED.scope_id,
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;
END $$;

SELECT pg_advisory_unlock(hashtext('202512291250_geocoding_intake_ingest_policy_alignment'));

COMMIT;
