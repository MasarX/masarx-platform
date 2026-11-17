-- Migration: Geocoding decision_log provenance (settings_resolution_id)
-- Purpose: Link geocoding decision_log entries to a settings_resolution_log row for geocoding_policy (scope ladder provenance).
-- Alignment: SSOT + resolver ladder + explicit provenance logging (no hardcoding).
-- Date: 2025-12-14

BEGIN;

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
  v_policy_record RECORD;
  v_settings_id UUID := NULL;
  v_settings_version_id UUID := NULL;
  v_version INT := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_inputs JSONB := NULL;
  v_settings_resolution_id UUID := NULL;
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

  -- Scope path (evaluated ladder): sender -> client -> tenant -> global (skip missing ids).
  v_scope_path := '[]'::jsonb;
  IF v_ctx.sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('sender'::text);
  END IF;
  IF v_ctx.client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('client'::text);
  END IF;
  v_scope_path := v_scope_path || to_jsonb('tenant'::text);
  v_scope_path := v_scope_path || to_jsonb('global'::text);

  -- Resolve winning scope (canonical ladder resolver).
  SELECT *
  INTO v_policy_record
  FROM public.geocoding_resolve_policy(
    v_ctx.organization_id,
    v_ctx.client_id,
    v_ctx.sender_id
  )
  LIMIT 1;

  IF v_policy_record.scope_type IS NULL THEN
    v_policy_record.scope_type := 'global';
    v_policy_record.scope_id := NULL;
  END IF;

  IF v_policy_record.scope_type IS NOT NULL THEN
    SELECT
      s.id AS settings_id,
      s.settings_version_id AS settings_version_id,
      sv.version AS version
    INTO v_settings_id, v_settings_version_id, v_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'geocoding_policy'
      AND s.scope_type = v_policy_record.scope_type
      AND s.scope_id IS NOT DISTINCT FROM v_policy_record.scope_id
    ORDER BY s.last_updated DESC
    LIMIT 1;
  END IF;

  -- Write provenance row when we can identify the winning settings row.
  IF v_settings_id IS NOT NULL THEN
    v_inputs := jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', p_run_id,
      'workflow_step_id', p_step_id,
      'organization_id', v_ctx.organization_id,
      'client_id', v_ctx.client_id,
      'sender_id', v_ctx.sender_id,
      'decision_point', COALESCE(p_match->>'plugin', 'geocoding'),
      'decision_outcome', COALESCE(p_match->>'match_type', 'unknown')
    ));

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'geocoding_policy',
      p_winning_scope_type := v_policy_record.scope_type,
      p_winning_scope_id := v_policy_record.scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := COALESCE(v_version, 1),
      p_scope_path := v_scope_path,
      p_inputs := v_inputs,
      p_merge_notes := NULL
    );
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
    p_run_id,
    v_settings_resolution_id
  );
END;
$$;

ALTER FUNCTION workflow_handlers.geocoding_log_match(UUID, UUID, JSONB, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMIT;

