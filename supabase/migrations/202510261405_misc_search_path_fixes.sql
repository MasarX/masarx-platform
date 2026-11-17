-- Migration: Pin search_path for various runtime functions to public

BEGIN;

DO $bootstrap$
BEGIN
    IF to_regprocedure('public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text)') IS NULL THEN
        EXECUTE $func$
            CREATE OR REPLACE FUNCTION public.auto_learn_geography(
                p_organization_id UUID,
                p_client_id UUID,
                p_sender_id UUID,
                p_address_id UUID,
                p_geocode JSONB,
                p_policy JSONB,
                p_confidence NUMERIC,
                p_action TEXT
            )
            RETURNS JSONB
            LANGUAGE sql
            AS $$SELECT NULL::jsonb$$
        $func$;
    END IF;
END;
$bootstrap$;

DO $$
BEGIN
    IF to_regprocedure('public.store_response(uuid,jsonb,int)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION public.store_response(UUID, JSONB, INT) SET search_path TO public, pg_temp';
    END IF;

    IF to_regprocedure('public.resolve_webhook_ingest_policy(uuid)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION public.resolve_webhook_ingest_policy(UUID) SET search_path TO public, pg_temp';
    END IF;

    IF to_regprocedure('public.auto_learn_geography(uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION public.auto_learn_geography(UUID, UUID, UUID, UUID, JSONB, JSONB, NUMERIC, TEXT) SET search_path TO public, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_geo_decision_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_geocode_cache_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geocode_cache_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_geo_normalize_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_normalize_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;

    IF to_regprocedure('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps, workflow_runs, JSONB) SET search_path TO public, workflow_handlers, pg_temp';
    END IF;
END;
$$;

COMMIT;
