BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

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

WITH dispatch AS (
    SELECT pg_get_functiondef(
        'workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
    ) AS definition
)
SELECT ok(
    split_part(split_part(definition, 'ELSIF v_reverse_enabled AND (', 2), 'v_is_reverse := TRUE', 1)
        LIKE '%{geocoding,selected_geocode,coordinates,latitude}%{geocoding,selected_geocode,coordinates,longitude}%'
        AND definition LIKE '%pr.organization_id = v_ctx.organization_id%'
        AND definition LIKE '%eligible_template.provider_id = pr.id%'
        AND split_part(split_part(definition, '''coordinates_text'',', 2), 'THEN concat_ws', 1)
          LIKE '%COALESCE(%provided_coordinates'',%selected_geocode''->''coordinates'',%shipment''->''coordinates''%) IS NOT NULL%',
    'reverse dispatch serializes a selected coordinate pair and retains scoped provider selection'
)
FROM dispatch;

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

SELECT ok(
    pg_get_functiondef('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
        LIKE '%geocoding_attempts%'
        AND pg_get_functiondef('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
            LIKE '%manual_review_gate%'
        AND pg_get_functiondef('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
            LIKE '%manual_review_required%'
        AND pg_get_functiondef('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
            LIKE '%deferred%',
    'execute_geocode_manual_review_enqueue_v1 records deferred manual-review geocoding attempt ledger evidence'
);

WITH registry AS (
    SELECT resource
    FROM jsonb_array_elements(
        public.resolve_settings_merged('ui_read_registry', 'global', NULL::uuid)->'resources'
    ) AS resource
    WHERE resource->>'key' = 'manual_review_tasks'
)
SELECT ok(
    EXISTS (
        SELECT 1
        FROM registry,
             jsonb_array_elements_text(resource->'select') AS selected(column_name)
        WHERE selected.column_name IN ('address_id', 'shipment_id')
        GROUP BY resource
        HAVING COUNT(DISTINCT selected.column_name) = 2
    )
    AND EXISTS (
        SELECT 1
        FROM registry,
             jsonb_array_elements(resource->'filters') AS filter
        WHERE filter->>'key' IN ('address_id', 'shipment_id')
        GROUP BY resource
        HAVING COUNT(DISTINCT filter->>'key') = 2
    ),
    'manual_review_tasks registry exposes address/shipment filters for geocoding review readback'
);

SELECT finish();

ROLLBACK;
