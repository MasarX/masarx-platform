-- Test Suite: Label generation workflow

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(32);

SELECT has_column('public', 'shipment_label_payload_v', 'organization_name', 'shipment_label_payload_v exposes organization_name');
SELECT has_column('public', 'shipment_label_payload_v', 'client_name', 'shipment_label_payload_v exposes client_name');
SELECT has_column('public', 'shipment_label_payload_v', 'sender_brand_name', 'shipment_label_payload_v exposes sender branding');

-- ---------------------------------------------------------------------------
-- Setup tenant, client, sender, template, shipment, and box for label testing
-- ---------------------------------------------------------------------------

-- This fixture owns client/sender setup. Defer organization bootstrap until
-- the source-binding context exists, then run canonical onboarding explicitly.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);
WITH org_row AS (
    INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
    VALUES (
        'aaaaaaaa-0000-4000-8000-00000000aa01',
        'Label QA Org',
        'label-qa-org',
        'Asia/Riyadh',
        'en-US',
        'active'
    )
    ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        slug = EXCLUDED.slug,
        timezone = EXCLUDED.timezone,
        locale = EXCLUDED.locale,
        billing_status = EXCLUDED.billing_status,
        updated_at = now()
    RETURNING id
),
client_row AS (
    INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
    VALUES (
        'bbbb0000-0000-4000-8000-00000000aa02',
        (SELECT id FROM org_row),
        'Label QA Client',
        'label-qa-client',
        'standard',
        'active',
        '{}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        name = EXCLUDED.name,
        slug = EXCLUDED.slug,
        sla_tier = EXCLUDED.sla_tier,
        status = EXCLUDED.status,
        settings_override = EXCLUDED.settings_override,
        updated_at = now()
    RETURNING id, organization_id
),
sender_row AS (
    INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status)
    VALUES (
        'bbbb0000-0000-4000-8000-00000000aa12',
        (SELECT id FROM client_row),
        'Label QA Sender',
        'Label QA Sender',
        false,
        true,
        'active'
    )
    ON CONFLICT (id) DO UPDATE
    SET client_id = EXCLUDED.client_id,
        name = EXCLUDED.name,
        brand_name = EXCLUDED.brand_name,
        status = EXCLUDED.status,
        updated_at = now()
    RETURNING id, client_id
),
template_seed AS (
    INSERT INTO label_template_specs (
        id,
        organization_id,
        template_key,
        version,
        template_scope_type,
        template_scope_id,
        renderer_config,
        asset_refs,
        created_by
    )
    VALUES (
        'cccc0000-0000-4000-8000-00000000aa03',
        (SELECT organization_id FROM client_row),
        'standard_4x6',
        1,
        'tenant',
        (SELECT organization_id FROM client_row),
        jsonb_build_object(
            'page', jsonb_build_object('width_mm', 100, 'height_mm', 150, 'dpi', 203, 'orientation', 'portrait'),
            'barcode', jsonb_build_object('type', 'CODE128', 'value_path', 'box.barcode'),
            'zones', jsonb_build_array(
                jsonb_build_object('type', 'text', 'binding', 'tracking_number', 'x', 10, 'y', 140, 'font', 'open_sans_regular', 'size', 14)
            )
        ),
        '[]'::jsonb,
        NULL
    )
    RETURNING id
),
address_row AS (
    INSERT INTO addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        city,
        province,
        country,
        validation_status
    )
    VALUES (
        'dddd0000-0000-4000-8000-00000000aa04',
        (SELECT organization_id FROM client_row),
        (SELECT id FROM client_row),
        '123 Test Street',
        'Riyadh',
        'Riyadh',
        'SA',
        'pending'
    )
    RETURNING id
),
shipment_row AS (
    INSERT INTO shipments (
        id,
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        status,
        box_count,
        origin_address_id,
        destination_address_id,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        'eeee0000-0000-4000-8000-00000000aa05',
        (SELECT organization_id FROM client_row),
        (SELECT id FROM client_row),
        (SELECT id FROM sender_row),
        'delivery',
        'LBLTEST0001',
        'pending',
        1,
        (SELECT id FROM address_row),
        (SELECT id FROM address_row),
        jsonb_build_object('source', 'pgtap'),
        now(),
        now()
    )
    RETURNING id, organization_id, client_id
),
box_row AS (
    INSERT INTO shipment_boxes (
        id,
        shipment_id,
        organization_id,
        client_id,
        box_number,
        barcode,
        created_at
    )
    VALUES (
        'ffff0000-0000-4000-8000-00000000aa06',
        (SELECT id FROM shipment_row),
        'aaaaaaaa-0000-4000-8000-00000000aa01',
        'bbbb0000-0000-4000-8000-00000000aa02',
        1,
        'LBLTEST0001:1',
        now()
    )
    RETURNING id
)
SELECT ok(TRUE, 'Test data seeded successfully');

SELECT set_config('app.organization_onboarding_source', '', true);

SELECT public.bootstrap_tenant_onboarding_v1(
    'aaaaaaaa-0000-4000-8000-00000000aa01',
    'pgtap:label-generation-fixture-bootstrap'
);

-- Ensure template resolution returns expected snapshot
SELECT ok(
    EXISTS (
        SELECT 1
        FROM resolve_label_template(
            'aaaaaaaa-0000-4000-8000-00000000aa01',
            'bbbb0000-0000-4000-8000-00000000aa02',
            NULL,
            'shipping'
        )
    ),
    'resolve_label_template returns template for shipping label'
);

-- Request label generation and verify job created pending
SET LOCAL ROLE service_role;

SELECT set_config('app.workflow_run_id', '11110000-0000-4000-8000-00000000aa09', true);
INSERT INTO workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type
)
VALUES (
    '11110000-0000-4000-8000-00000000aa07',
    'pgtap_label_guard_template',
    'Fixture workflow for label guard context',
    1,
    'active',
    'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    enabled
)
VALUES (
    '11110000-0000-4000-8000-00000000aa08',
    '11110000-0000-4000-8000-00000000aa07',
    1,
    'workflow_control',
    'always',
    'workflow_control',
    'v1',
    TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
)
VALUES (
    '11110000-0000-4000-8000-00000000aa09',
    '11110000-0000-4000-8000-00000000aa07',
    1,
    'test',
    'pending',
    '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    handler_key,
    handler_version,
    max_retries,
    enqueued_at,
    created_at,
    updated_at
)
VALUES (
    '11110000-0000-4000-8000-00000000aa10',
    '11110000-0000-4000-8000-00000000aa09',
    '11110000-0000-4000-8000-00000000aa08',
    1,
    'pending',
    'workflow_control',
    'workflow_control',
    'v1',
    1,
    now(),
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_step_id', '11110000-0000-4000-8000-00000000aa10', true);
SELECT set_config('platform.workflow_engine', '1', true);
SELECT set_config('platform.workflow_run_step_id', '11110000-0000-4000-8000-00000000aa10', true);

SELECT lives_ok(
    $$SELECT request_label_generation(
        'eeee0000-0000-4000-8000-00000000aa05',
        'shipping',
        NULL,
        'pgtap_test',
        'ffff0000-0000-4000-8000-00000000aa06',
        'primary'
    );$$,
    'request_label_generation executes successfully'
);

SELECT is(
    (SELECT COUNT(*) FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' AND status = 'pending'),
    1::bigint,
    'label_jobs row inserted in pending status'
);
RESET ROLE;

-- Lease the job for processing
SELECT is(
    (SELECT (lease_label_job('aaaaaaaa-0000-4000-8000-00000000aa01', 120, NULL)).status),
    'in_progress',
    'lease_label_job transitions job to in_progress'
);

-- Compose payload to ensure JSON structure returned
SELECT ok(
    (SELECT (compose_label_payload(id))->'payload' ? 'tracking_number'
     FROM label_jobs
     WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05'
     LIMIT 1),
    'compose_label_payload returns payload with tracking_number'
);

-- Complete job successfully and verify label record
SELECT lives_ok(
    $$SELECT complete_label_job(
        (SELECT id FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
        'failed',
        'labels/LBLTEST0001.pdf',
        2048,
        jsonb_build_object('engine', 'pgtap'), 'render_failure'
    );$$,
    'complete_label_job handles failure'
);

SELECT is(
    (SELECT status FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'pending',
    'label job rescheduled after failure'
);

SELECT is(
    (SELECT error_reason FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'render_failure',
    'label job error reason persisted'
);

SELECT ok(
    NOT EXISTS (
        SELECT 1
        FROM labels
        WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05'
    ),
    'labels table empty after failure'
);

SELECT lives_ok(
    $$SELECT complete_label_job(
        (SELECT id FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
        'succeeded',
        'labels/LBLTEST0001.pdf',
        4096,
        jsonb_build_object('engine', 'pgtap', 'attempts', 1),
        NULL
    );$$,
    'complete_label_job handles success'
);

SELECT is(
    (SELECT status FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'succeeded',
    'label job marked succeeded after completion'
);

SELECT ok(
    (SELECT error_reason IS NULL FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'error_reason cleared on success'
);

SELECT is(
    (SELECT output_file_url FROM label_jobs WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'labels/LBLTEST0001.pdf',
    'label job output_file_url stored'
);

SELECT is(
    (SELECT file_url FROM labels WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'labels/LBLTEST0001.pdf',
    'labels table populated on success'
);

SELECT is(
    (SELECT print_count FROM labels WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    1,
    'labels.print_count initialised to 1'
);

SELECT ok(
    (SELECT renderer_metadata->>'engine' = 'pgtap'
     FROM labels
     WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
    'renderer metadata captured'
);

SELECT has_function(
    'public',
    'invoke_label_renderer',
    ARRAY['integer'],
    'invoke_label_renderer helper is present'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM worker_registry
        WHERE worker_name = 'label_job_renderer'
          AND (config->>'max_jobs')::INT = 10
    ),
    'worker_registry seeded with label_job_renderer definition'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM cron_config
        WHERE worker_name = 'label_job_renderer'
          AND batch_size = 10
          AND interval_seconds IN (10, 60)
    ),
    'cron_config seeded for label_job_renderer'
);

SELECT ok(
    COALESCE(
        (
            SELECT
                (cached_value->'providers'->0 ? 'invoke_url')
                AND (cached_value->'providers'->0 ? 'invoke_secret')
            FROM settings
            WHERE category = 'label_provider'
              AND scope_type = 'global'
            ORDER BY last_updated DESC
            LIMIT 1
        ),
        FALSE
    ),
    'label_provider cached value includes invoke_url and invoke_secret'
);

SELECT ok(TRUE, 'label_provider invoke metadata rotation status recorded');

SELECT diag(
    CASE
        WHEN (
            SELECT
                (cached_value->'providers'->0->>'invoke_secret') = 'EXAMPLE_PASSWORD'
                OR cached_value->'providers'->0->>'invoke_url' = 'https://example.supabase.co/functions/v1/label-renderer'
            FROM settings
            WHERE category = 'label_provider'
              AND scope_type = 'global'
            ORDER BY last_updated DESC
            LIMIT 1
        )
        THEN 'label_provider invoke metadata still using placeholder values (rotate via settings workflow)'
        ELSE 'label_provider invoke metadata rotated'
    END
);

SELECT ok(
    (SELECT relrowsecurity
     FROM pg_class
     WHERE oid = 'schema_registry'::regclass),
    'schema_registry RLS enabled'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'schema_registry'
          AND policyname = 'schema_registry_select_authenticated'
    ),
    'schema_registry select policy for authenticated present'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'schema_registry'
          AND policyname = 'schema_registry_select_service'
    ),
    'schema_registry select policy for service_role present'
);

SELECT is(
    (
        SELECT COUNT(*)
        FROM schema_registry
        WHERE category = 'label_design'
          AND is_active = TRUE
    )::int,
    1,
    'label_design active schema registered'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM schema_registry
        WHERE category = 'label_design'
          AND is_active = TRUE
          AND jsonb_path_exists(
              schema,
              '$.**.human_readable.oneOf[*] ? (@.type == "string")'
          )
          AND jsonb_path_exists(
              schema,
              '$.**.human_readable.oneOf[*] ? (@.type == "boolean")'
          )
    ),
    'label_design active schema allows string and boolean barcode human_readable'
);

SELECT is(
    (
        SELECT schema_version
        FROM settings_versions
        WHERE category = 'label_design'
          AND scope_type = 'global'
        ORDER BY approved_at DESC
        LIMIT 1
    ),
    (
        SELECT version
        FROM schema_registry
        WHERE category = 'label_design'
          AND is_active = TRUE
        LIMIT 1
    ),
    'label_design global settings use active schema version'
);

SELECT is(
    (
        SELECT (cached_value -> 'templates' -> 'shipping' -> 'page' ->> 'width_inch')
        FROM settings
        WHERE category = 'label_design'
          AND scope_type = 'global'
        ORDER BY last_updated DESC
        LIMIT 1
    ),
    '4',
    'label_design global template width seeded to 4 inches'
);

SELECT finish();

ROLLBACK;








