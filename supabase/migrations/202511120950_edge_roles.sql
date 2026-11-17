-- Migration: Edge function least privilege roles
-- Purpose: Define restricted database roles for webhook receiver and API caller edge functions, and scope grants to required RPCs.
-- Date: 2025-11-12

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_webhook_role') THEN
        CREATE ROLE edge_webhook_role NOLOGIN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
        CREATE ROLE edge_api_caller_role NOLOGIN;
    END IF;
END;
$$;

-- Webhook receiver RPC grants
REVOKE EXECUTE ON FUNCTION get_webhook_source_by_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_webhook_ingest_policy(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, UUID, TEXT, UUID, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION get_webhook_source_by_token(TEXT) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION resolve_webhook_ingest_policy(UUID) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION insert_webhook_inbox_record(UUID, UUID, TEXT, JSONB, JSONB, TEXT, UUID, TEXT) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION record_webhook_ack(UUID, UUID, TEXT, INT, UUID, TEXT, UUID, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, JSONB, UUID) TO edge_webhook_role;
GRANT EXECUTE ON FUNCTION log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT) TO edge_webhook_role;

GRANT edge_webhook_role TO service_role;

-- API caller RPC grants
REVOKE EXECUTE ON FUNCTION log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_job_call_spec(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_outbound_call_in_progress(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_pending_edge_jobs(INT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION log_api_call_event(UUID, JSONB, JSONB, INT, INT, TEXT) TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION get_job_call_spec(UUID) TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION mark_outbound_call_in_progress(UUID) TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION mark_outbound_call_success(UUID, INT, JSONB, JSONB, INT) TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION mark_outbound_call_failure(UUID, INT, JSONB, JSONB, TEXT) TO edge_api_caller_role;
GRANT EXECUTE ON FUNCTION claim_pending_edge_jobs(INT) TO edge_api_caller_role;

GRANT edge_api_caller_role TO service_role;

COMMIT;
