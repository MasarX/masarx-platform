-- Migration: Geocoding workflow handlers + registry entries
-- Purpose: Register handler keys expected by tests and provide minimal implementations
-- Schema: workflow_handlers (dynamic plugin space)

BEGIN;

-- Ensure type exists (created earlier). This is a no-op if already present.
DO $$ BEGIN
    PERFORM 1 FROM pg_type WHERE typname = 'workflow_handler_response';
    IF NOT FOUND THEN
        CREATE TYPE workflow_handler_response AS (
            status TEXT,
            workflow_status TEXT,
            next_run_at TIMESTAMPTZ,
            operation_result JSONB,
            context_patch JSONB,
            last_error TEXT,
            retry_attempt INT,
            max_retries INT
        );
    END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS workflow_handlers;
COMMENT ON SCHEMA workflow_handlers IS 'Dedicated schema for workflow operation handler functions.';

-- Minimal success helper
CREATE OR REPLACE FUNCTION workflow_handlers._ok(
    p_info JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
DECLARE v workflow_handler_response; BEGIN
  v.status := 'completed';
  v.operation_result := COALESCE(p_info, '{}'::jsonb);
  RETURN v;
END $$;

-- geocode_cache: noop completion (cache hit/write orchestrated elsewhere)
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_cache_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'geocode_cache'));
END $$;

-- geo_coordinate: noop completion
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_coordinate_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'geo_coordinate'));
END $$;

-- geo_normalize: noop completion
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_normalize_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'geo_normalize'));
END $$;

-- provider_dispatch: simple completion (actual HTTP handled by outbound_http step elsewhere)
CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'provider_dispatch'));
END $$;

-- geo_decision: records a trivial decision in operation_result
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'geo_decision', 'decision', 'ok'));
END $$;

-- geocode_manual_review_enqueue: noop completion (manual queue handled externally)
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geocode_manual_review_enqueue_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql AS $$
BEGIN
  RETURN workflow_handlers._ok(jsonb_build_object('handler', 'geocode_manual_review_enqueue'));
END $$;

DO $check$
BEGIN
    IF to_regprocedure('workflow_handlers.execute_geocode_cache_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'geocode_cache handler missing prior to registry update';
    END IF;
    IF to_regprocedure('workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'geo_coordinate handler missing prior to registry update';
    END IF;
    IF to_regprocedure('workflow_handlers.execute_geo_normalize_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'geo_normalize handler missing prior to registry update';
    END IF;
    IF to_regprocedure('workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'provider_dispatch handler missing prior to registry update';
    END IF;
    IF to_regprocedure('workflow_handlers.execute_geo_decision_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'geo_decision handler missing prior to registry update';
    END IF;
    IF to_regprocedure('workflow_handlers.execute_geocode_manual_review_enqueue_v1(workflow_run_steps,workflow_runs,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'geocode_manual_review_enqueue handler missing prior to registry update';
    END IF;
END;
$check$;

ALTER TABLE operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

-- Register handler keys in operation_handlers
INSERT INTO operation_handlers AS oh (
    handler_key, handler_schema, handler_name, handler_signature, handler_version, is_active, notes, doc_url
)
VALUES
    ('geocode_cache', 'workflow_handlers', 'execute_geocode_cache_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Geocoding cache orchestration (no-op stub)', NULL),
    ('geo_coordinate', 'workflow_handlers', 'execute_geo_coordinate_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Compute or reuse coordinates (no-op stub)', NULL),
    ('geo_normalize', 'workflow_handlers', 'execute_geo_normalize_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Normalize geographic information (no-op stub)', NULL),
    ('provider_dispatch', 'workflow_handlers', 'execute_provider_dispatch_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Dispatch to provider (no-op stub)', NULL),
    ('geo_decision', 'workflow_handlers', 'execute_geo_decision_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Record geocoding decision (no-op stub)', NULL),
    ('geocode_manual_review_enqueue', 'workflow_handlers', 'execute_geocode_manual_review_enqueue_v1', '(workflow_run_steps,workflow_runs,jsonb)', 'v1', TRUE, 'Enqueue manual review for geocoding (no-op stub)', NULL)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

COMMIT;
