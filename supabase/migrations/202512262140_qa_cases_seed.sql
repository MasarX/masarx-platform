-- Migration: Seed QA smoke cases
-- Purpose: Register baseline QA cases to keep the runner row-driven.

BEGIN;

SET search_path TO qa, public, extensions, pg_temp;

INSERT INTO qa.qa_cases (
    suite_key,
    case_key,
    handler_key,
    enabled,
    input,
    expected,
    assertions,
    tags,
    metadata
)
VALUES
    (
        'qa:smoke',
        'qa_schema_exists',
        'sql_scalar',
        true,
        jsonb_build_object(
            'sql',
            'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ''qa'')'
        ),
        to_jsonb(true),
        NULL,
        ARRAY['smoke'],
        jsonb_build_object('description', 'QA schema is present')
    ),
    (
        'qa:smoke',
        'qa_views_exist',
        'sql_scalar',
        true,
        jsonb_build_object(
            'sql',
            'SELECT (to_regclass(''qa.qa_run_summary_v'') IS NOT NULL AND to_regclass(''qa.qa_latest_run_v'') IS NOT NULL)'
        ),
        to_jsonb(true),
        NULL,
        ARRAY['smoke'],
        jsonb_build_object('description', 'QA summary views are present')
    ),
    (
        'qa:smoke',
        'qa_access_roles_seeded',
        'sql_scalar',
        true,
        jsonb_build_object(
            'sql',
            'SELECT (EXISTS (SELECT 1 FROM qa.qa_access_roles WHERE user_type = ''ops_admin'' AND enabled = true) AND EXISTS (SELECT 1 FROM qa.qa_access_roles WHERE user_type = ''super_admin'' AND enabled = true))'
        ),
        to_jsonb(true),
        NULL,
        ARRAY['smoke'],
        jsonb_build_object('description', 'Default QA access roles exist and are enabled')
    ),
    (
        'qa:smoke',
        'qa_service_role_ok',
        'sql_scalar',
        true,
        jsonb_build_object('sql', 'SELECT qa.qa_is_service_role()'),
        to_jsonb(true),
        NULL,
        ARRAY['smoke'],
        jsonb_build_object('description', 'Service-role detection passes for QA runner')
    ),
    (
        'qa:smoke',
        'qa_can_read_ok',
        'sql_scalar',
        true,
        jsonb_build_object('sql', 'SELECT qa.qa_can_read()'),
        to_jsonb(true),
        NULL,
        ARRAY['smoke'],
        jsonb_build_object('description', 'QA reader eligibility resolves in runner context')
    )
ON CONFLICT (suite_key, case_key) DO UPDATE
SET
    handler_key = EXCLUDED.handler_key,
    enabled = EXCLUDED.enabled,
    input = EXCLUDED.input,
    expected = EXCLUDED.expected,
    assertions = EXCLUDED.assertions,
    tags = EXCLUDED.tags,
    metadata = EXCLUDED.metadata,
    updated_at = now();

COMMIT;
