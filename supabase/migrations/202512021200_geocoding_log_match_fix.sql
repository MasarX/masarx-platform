-- Migration: Geocoding log match fix
-- Purpose: Log geocoding_match into decision_log without relying on external helper.

BEGIN;

SET search_path TO workflow_handlers, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_run workflow_runs%ROWTYPE;
  v_ctx RECORD;
BEGIN
  IF NOT v_can_log THEN
    RETURN;
  END IF;

  SELECT * INTO v_run FROM workflow_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_ctx FROM geocoding_extract_context(v_run);
  IF v_ctx.organization_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO decision_log (
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    settings_resolution_id
  )
  VALUES (
    v_ctx.organization_id,
    'geocoding',
    'workflow_run_step',
    p_step_id,
    COALESCE(p_match->>'plugin', 'geocoding'),
    COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(p_match),
    p_match->>'routing_reason',
    'workflow_handlers',
    NULL,
    NULL
  );
END;
$$;

DO $$
BEGIN
  PERFORM 1;
  EXECUTE 'ALTER FUNCTION workflow_handlers.geocoding_log_match(UUID, UUID, JSONB, JSONB) SET search_path TO workflow_handlers, public, extensions, pg_temp';
END;
$$;

COMMIT;
