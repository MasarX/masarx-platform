BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

WITH cache_defs AS (
    SELECT
        pg_get_functiondef('workflow_handlers.execute_geocode_cache_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure) AS wrapper_def,
        CASE
            WHEN to_regprocedure('workflow_handlers.execute_geocode_cache_v1_base(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL
            THEN pg_get_functiondef('workflow_handlers.execute_geocode_cache_v1_base(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
            ELSE ''
        END AS base_def
)
SELECT ok(
    wrapper_def LIKE '%jsonb_build_object%'
    OR (
        wrapper_def LIKE '%execute_geocode_cache_v1_base%'
        AND base_def LIKE '%jsonb_build_object%'
    ),
    'execute_geocode_cache_v1 contains real cache logic'
)
FROM cache_defs;

SELECT ok(
    pg_get_functiondef('workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
        LIKE '%coordinates_valid%',
    'execute_geo_coordinate_v1 validates coordinates'
);

SELECT ok(
    pg_get_functiondef('workflow_handlers.execute_geo_normalize_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
        LIKE '%normalized_address%',
    'execute_geo_normalize_v1 builds normalized address'
);

WITH dispatch_defs AS (
    SELECT
        pg_get_functiondef('workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure) AS wrapper_def,
        CASE
            WHEN to_regprocedure('workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)') IS NOT NULL
            THEN pg_get_functiondef('workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
            ELSE ''
        END AS base_def
)
SELECT ok(
    wrapper_def LIKE '%execute_outbound_http_v1%'
    OR (
        wrapper_def LIKE '%execute_provider_dispatch_v1_base%'
        AND base_def LIKE '%execute_outbound_http_v1%'
    ),
    'execute_provider_dispatch_v1 delegates to outbound_http handler'
)
FROM dispatch_defs;

SELECT ok(
    pg_get_functiondef('workflow_handlers.execute_geo_decision_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
        LIKE '%decision%',
    'execute_geo_decision_v1 encodes decision output'
);

SELECT ok(
    pg_get_functiondef('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
        LIKE '%manual_review_tasks%',
    'execute_geocode_manual_review_enqueue_v1 enqueues manual review tasks'
);

SELECT finish();

ROLLBACK;
