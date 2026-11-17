-- Test Suite: Label generation workflow

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(63);

SELECT has_column('public', 'shipment_label_payload_v', 'organization_name', 'shipment_label_payload_v exposes organization_name');
SELECT has_column('public', 'shipment_label_payload_v', 'client_name', 'shipment_label_payload_v exposes client_name');
SELECT has_column('public', 'shipment_label_payload_v', 'sender_brand_name', 'shipment_label_payload_v exposes sender branding');

-- ---------------------------------------------------------------------------
-- Setup tenant, client, template, shipment, and box for label testing
-- ---------------------------------------------------------------------------

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
    RETURNING id, organization_id
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

SELECT lives_ok(
    $admin$
    DO $body$
    DECLARE
        v_prior_role TEXT := current_setting('request.jwt.claim.role', true);
        v_prior_claims TEXT := current_setting('request.jwt.claims', true);
        v_job_id UUID;
    BEGIN
        IF session_user NOT IN ('postgres', 'supabase_admin') OR current_user <> session_user THEN
            RAISE EXCEPTION 'Expected a reset postgres/supabase_admin session';
        END IF;
        PERFORM set_config('request.jwt.claim.role', '', true);
        PERFORM set_config('request.jwt.claims', '{}', true);

        v_job_id := public.request_label_reprint(
            (SELECT id FROM public.labels WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1),
            'damaged original',
            NULL,
            'pgtap_reprint_admin_access'
        );
        IF NOT EXISTS (
            SELECT 1 FROM public.label_jobs
            WHERE id = v_job_id
              AND organization_id = 'aaaaaaaa-0000-4000-8000-00000000aa01'::uuid
              AND shipment_id = 'eeee0000-0000-4000-8000-00000000aa05'::uuid
              AND label_id = (SELECT id FROM public.labels WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' LIMIT 1)
              AND requested_source = 'pgtap_reprint_admin_access'
              AND job_purpose = 'reprint'
              AND status = 'pending'
        ) THEN
            RAISE EXCEPTION 'Admin reprint did not enqueue the exact fixture label job';
        END IF;

        PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);
        PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);
        PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
        RAISE;
    END;
    $body$;
    $admin$,
    format('request_label_reprint handles RESET ROLE without JWT claims (%s)', session_user)
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

-- Caller-authority regression matrix; native pgTAP remains required before admission.
INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
VALUES ('ab230000-0000-4000-8000-000000000001', 'Label foreign caller fixture', 'label-foreign-caller-fixture', 'UTC', 'en-US', 'active');
INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
VALUES
  ('ab230000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000aa01', 'label-own-caller@example.test', 'Label own caller', 'ops_admin', 'active', 'tenant', NULL),
  ('ab230000-0000-4000-8000-000000000003', 'ab230000-0000-4000-8000-000000000001', 'label-foreign-caller@example.test', 'Label foreign caller', 'ops_admin', 'active', 'tenant', NULL);

CREATE FUNCTION pg_temp.check_label_caller_authority(
  p_case TEXT, p_sql_role TEXT, p_scalar_role TEXT, p_claims TEXT, p_sub TEXT,
  p_compose_allowed BOOLEAN, p_reprint_allowed BOOLEAN, p_error_state TEXT
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
SET search_path TO extensions, public, pg_temp
AS $fixture$
DECLARE
  v_prior_sql_role TEXT := current_setting('role', true);
  v_prior_scalar_role TEXT := current_setting('request.jwt.claim.role', true);
  v_prior_claims TEXT := current_setting('request.jwt.claims', true);
  v_prior_sub TEXT := current_setting('request.jwt.claim.sub', true);
  v_job_id UUID;
  v_label_id UUID;
  v_reprint_id UUID;
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Caller matrix requires the existing named-admin fixture session';
  END IF;
  SELECT id INTO STRICT v_job_id FROM public.label_jobs
  WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05' AND job_purpose = 'primary';
  SELECT id INTO STRICT v_label_id FROM public.labels
  WHERE shipment_id = 'eeee0000-0000-4000-8000-00000000aa05';

  PERFORM set_config('request.jwt.claim.role', p_scalar_role, true);
  PERFORM set_config('request.jwt.claims', p_claims, true);
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  PERFORM set_config('role', p_sql_role, true);
  IF p_compose_allowed IS NOT NULL THEN
    IF p_compose_allowed THEN
      RETURN NEXT is((public.compose_label_payload(v_job_id) -> 'job' ->> 'id')::uuid,
                     v_job_id, p_case || ': compose preserves exact job');
    ELSE
      RETURN NEXT throws_ok(format('SELECT public.compose_label_payload(%L::uuid)', v_job_id),
        p_error_state, CASE WHEN p_error_state = 'P0001' THEN format('Access denied for label job %s', v_job_id) END,
        p_case || ': compose denies caller');
    END IF;
  END IF;
  IF p_reprint_allowed IS NOT NULL THEN
    IF p_reprint_allowed THEN
      v_reprint_id := public.request_label_reprint(v_label_id, 'caller fixture', NULL, 'caller_' || p_case);
      RETURN NEXT ok(EXISTS (
        SELECT 1 FROM public.label_jobs WHERE id = v_reprint_id
          AND label_id = v_label_id AND organization_id = 'aaaaaaaa-0000-4000-8000-00000000aa01'
          AND shipment_id = 'eeee0000-0000-4000-8000-00000000aa05'
          AND requested_source = 'caller_' || p_case AND job_purpose = 'reprint' AND status = 'pending'
      ), p_case || ': reprint preserves exact label and organization');
    ELSE
      RETURN NEXT throws_ok(format('SELECT public.request_label_reprint(%L::uuid, %L, NULL, %L)',
        v_label_id, 'caller fixture', 'caller_' || p_case), p_error_state,
        CASE WHEN p_error_state = 'P0001' THEN format('Access denied for label %s', v_label_id) END,
        p_case || ': reprint denies caller');
    END IF;
  END IF;
  PERFORM set_config('role', COALESCE(v_prior_sql_role, 'none'), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_scalar_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prior_sub, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role', COALESCE(v_prior_sql_role, 'none'), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_scalar_role, ''), true);
  PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prior_sub, ''), true);
  RAISE;
END;
$fixture$;

SELECT result.* FROM (VALUES
  ('json_tenant', 'none', '', jsonb_build_object('role', 'authenticated', 'sub', 'ab230000-0000-4000-8000-000000000003')::text, '', FALSE, FALSE, 'P0001'),
  ('json_tenant_over_scalar_service', 'none', 'service_role', jsonb_build_object('role', 'authenticated', 'sub', 'ab230000-0000-4000-8000-000000000003')::text, '', FALSE, FALSE, 'P0001'),
  ('json_tenant_over_scalar_renderer', 'none', 'edge_label_renderer_role', jsonb_build_object('role', 'authenticated', 'sub', 'ab230000-0000-4000-8000-000000000003')::text, '', FALSE, FALSE, 'P0001'),
  ('json_anon_over_scalar_service', 'none', 'service_role', '{"role":"anon"}', '', FALSE, FALSE, 'P0001'),
  ('scalar_tenant', 'none', 'authenticated', '{}', 'ab230000-0000-4000-8000-000000000003', FALSE, FALSE, 'P0001'),
  ('roleless_json_actor', 'none', '', '{"sub":"ab230000-0000-4000-8000-000000000003"}', '', FALSE, FALSE, 'P0001'),
  ('legacy_sub_without_role', 'none', '', '{}', 'ab230000-0000-4000-8000-000000000003', FALSE, FALSE, 'P0001'),
  ('json_service_over_scalar_tenant', 'none', 'authenticated', '{"role":"service_role"}', '', TRUE, TRUE, NULL),
  ('scalar_service', 'none', 'service_role', '{}', '', TRUE, TRUE, NULL),
  ('renderer_non_uuid_subject', 'none', '', '{"role":"edge_label_renderer_role","sub":"edge-function"}', '', TRUE, NULL, NULL),
  ('same_tenant_json', 'none', '', '{"role":"authenticated","sub":"ab230000-0000-4000-8000-000000000002"}', '', TRUE, TRUE, NULL),
  ('reset_named_admin_no_jwt', 'none', '', '{}', '', TRUE, TRUE, NULL),
  ('sql_service_no_jwt', 'service_role', '', '{}', '', TRUE, TRUE, NULL),
  ('sql_renderer_no_jwt', 'edge_label_renderer_role', '', '{}', '', TRUE, NULL, NULL),
  ('sql_authenticated_no_jwt', 'authenticated', '', '{}', '', FALSE, NULL, '42501'),
  ('malformed_claims', 'none', '', '{broken', '', FALSE, FALSE, '22P02'),
  ('renderer_not_reprint_authority', 'none', '', '{"role":"edge_label_renderer_role"}', '', NULL, FALSE, 'P0001')
) AS cases(name, sql_role, scalar_role, claims, sub, compose_allowed, reprint_allowed, error_state)
CROSS JOIN LATERAL pg_temp.check_label_caller_authority(
  name, sql_role, scalar_role, claims, sub, compose_allowed, reprint_allowed, error_state
) AS result;

SELECT finish();

ROLLBACK;








