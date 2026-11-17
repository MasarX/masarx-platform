-- pgTAP: UC184 label reprint governance invariants

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

SELECT plan(10);

DO $$
DECLARE
    v_org_id UUID := gen_random_uuid();
    v_client_id UUID := gen_random_uuid();
    v_address_id UUID := gen_random_uuid();
    v_shipment_id UUID := gen_random_uuid();
    v_box_id UUID := gen_random_uuid();
    v_template_id UUID := gen_random_uuid();
    v_label_id UUID := gen_random_uuid();
    v_job_id UUID := NULL;
    v_initial_version_id UUID := NULL;
    v_active_version_id UUID := NULL;
    v_active_version_number INTEGER := NULL;
    v_version_count BIGINT := 0;
    v_superseded_count BIGINT := 0;
    v_active_count BIGINT := 0;
    v_reason TEXT := 'damaged_barcode';
BEGIN
    INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
    VALUES (v_org_id, 'pgTAP UC184 Org', 'pgtap-uc184-org', 'UTC', 'en-US', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
    VALUES (v_client_id, v_org_id, 'pgTAP UC184 Client', 'pgtap-uc184-client', 'standard', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO addresses (
        id, organization_id, client_id, raw_input, city, province, country, validation_status
    )
    VALUES (
        v_address_id, v_org_id, v_client_id, 'pgTAP UC184 Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
    )
    ON CONFLICT (id, client_id) DO NOTHING;

    INSERT INTO label_template_specs (
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
        v_org_id,
        'pgtap_uc184_shipping',
        1,
        'client',
        v_client_id,
        jsonb_build_object(
            'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203),
            'blocks', jsonb_build_array(),
            'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'shipment.tracking_number')
        ),
        '[]'::jsonb
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO shipments (
        id, organization_id, client_id, service_type, tracking_number, status,
        box_count, origin_address_id, destination_address_id, created_at, updated_at
    )
    VALUES (
        v_shipment_id,
        v_org_id,
        v_client_id,
        'delivery',
        'PG184' || upper(substring(v_shipment_id::text, 1, 8)),
        'pending',
        1,
        v_address_id,
        v_address_id,
        now(),
        now()
    )
    ON CONFLICT (id, client_id) DO NOTHING;

    INSERT INTO shipment_boxes (
        id, shipment_id, organization_id, client_id, box_number, barcode, created_at
    )
    VALUES (
        v_box_id,
        v_shipment_id,
        v_org_id,
        v_client_id,
        1,
        'PG184' || upper(substring(v_shipment_id::text, 1, 8)) || ':1',
        now()
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO labels (
        id,
        shipment_id,
        organization_id,
        client_id,
        label_type,
        barcode,
        barcode_format,
        layout_template_id,
        file_url,
        file_size_bytes,
        generated_by,
        generated_at,
        print_count,
        last_printed_at,
        metadata,
        renderer_metadata
    )
    VALUES (
        v_label_id,
        v_shipment_id,
        v_org_id,
        v_client_id,
        'shipping',
        'PG184' || upper(substring(v_shipment_id::text, 1, 8)) || ':1',
        'CODE128',
        v_template_id,
        'labels/original.pdf',
        100,
        NULL,
        now() - interval '1 day',
        1,
        now() - interval '1 day',
        jsonb_build_object(
            'template',
            jsonb_build_object(
                'template_id', v_template_id,
                'template_version', 1,
                'label_config',
                jsonb_build_object(
                    'max_attempts', 3,
                    'retry_backoff_seconds', jsonb_build_array(30),
                    'provider_hint', 'internal',
                    'barcode_format', 'CODE128'
                )
            )
        ),
        '{}'::jsonb
    )
    ON CONFLICT DO NOTHING;

    SELECT label_version_id
    INTO v_initial_version_id
    FROM ensure_label_active_version_v1(v_label_id, v_shipment_id);

    PERFORM ok(v_initial_version_id IS NOT NULL, 'initial active label version is backfilled');

    SELECT request_label_reprint(v_label_id, v_reason, NULL, 'console')
    INTO v_job_id;

    PERFORM ok(v_job_id IS NOT NULL, 'request_label_reprint returns a job id');

    PERFORM ok(
        EXISTS (
            SELECT 1
            FROM label_jobs
            WHERE id = v_job_id
              AND reprint_reason = v_reason
              AND source_label_version_id = v_initial_version_id
        ),
        'label job stores reason and source active version'
    );

    PERFORM complete_label_job(
        v_job_id,
        'succeeded',
        'labels/reprint.pdf',
        256,
        jsonb_build_object('renderer', 'pgtap'),
        NULL
    );

    SELECT active_version_id, active_version_number
    INTO v_active_version_id, v_active_version_number
    FROM labels
    WHERE id = v_label_id
      AND shipment_id = v_shipment_id;

    PERFORM is(v_active_version_number, 2, 'label row advances to version 2 after reprint');
    PERFORM ok(v_active_version_id IS DISTINCT FROM v_initial_version_id, 'active version pointer changes after reprint');

    SELECT count(*) INTO v_version_count
    FROM label_versions
    WHERE label_id = v_label_id;

    SELECT count(*) INTO v_superseded_count
    FROM label_versions
    WHERE label_id = v_label_id
      AND version_status = 'superseded';

    SELECT count(*) INTO v_active_count
    FROM label_versions
    WHERE label_id = v_label_id
      AND version_status = 'active';

    PERFORM is(v_version_count, 2::bigint, 'two label versions exist after reprint');
    PERFORM is(v_superseded_count, 1::bigint, 'prior label version is marked superseded');
    PERFORM is(v_active_count, 1::bigint, 'exactly one active label version remains');

    PERFORM ok(
        EXISTS (
            SELECT 1
            FROM label_versions lv_old
            JOIN label_versions lv_new
              ON lv_new.id = lv_old.superseded_by_version_id
            WHERE lv_old.id = v_initial_version_id
              AND lv_old.version_status = 'superseded'
              AND lv_new.id = v_active_version_id
              AND lv_new.version_status = 'active'
              AND lv_new.reprint_reason = v_reason
              AND lv_new.supersedes_version_id = v_initial_version_id
        ),
        'active and superseded versions keep linked lineage and reason'
    );

    PERFORM ok(
        EXISTS (
            SELECT 1
            FROM shipment_actions
            WHERE shipment_id = v_shipment_id
              AND action_data->>'label_job_id' = v_job_id::text
              AND action_data->>'reprint_reason' = v_reason
        ),
        'shipment action audit includes the reprint reason'
    );
END $$;

SELECT finish();

ROLLBACK;
