-- Keep preview requests on the same access and validation path as mutations.
BEGIN;
SET LOCAL lock_timeout = '30s';

DO $preview$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.shipment_amend_cancel_v1(jsonb)'::regprocedure);
  v_input TEXT := $old$  v_input JSONB := COALESCE(p_input, '{}'::jsonb);$old$;
  v_input_with_preview TEXT := $new$  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_dry_run BOOLEAN := lower(COALESCE(v_input->>'dry_run', 'false')) IN ('true', 't', '1', 'yes', 'on');$new$;
  v_replay TEXT := '  IF v_existing_action.id IS NOT NULL THEN';
  v_start TEXT := '  v_context := jsonb_strip_nulls(';
  v_preview TEXT := $branch$  IF v_dry_run THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', TRUE,
      'dry_run', TRUE,
      'shipment_id', v_shipment_id,
      'operation', v_operation,
      'workflow_template_id', v_template_id,
      'workflow_template_name', v_template_name,
      'workflow_status', 'preview',
      'workflow_step_status', 'not_started',
      'lock_state', v_guard,
      'current_values', v_options->'current_values',
      'policy_source', 'shipment_operation_policy',
      'operation_result', jsonb_build_object(
        'dry_run', TRUE,
        'would_start_workflow', TRUE,
        'would_mutate', FALSE,
        'mutation_suppressed', TRUE,
        'workflow_template_id', v_template_id,
        'workflow_template_name', v_template_name,
        'idempotency_key', v_idempotency_key,
        'audit_actor', v_audit_actor,
        'policy_source', 'shipment_operation_policy'
      )
    ));
  END IF;

$branch$;
  v_marker TEXT;
BEGIN
  FOREACH v_marker IN ARRAY ARRAY[v_input, v_replay, v_start] LOOP
    IF (length(v_definition) - length(replace(v_definition, v_marker, ''))) <> length(v_marker) THEN
      RAISE EXCEPTION 'Shipment preview requires the canonical amendment boundary';
    END IF;
  END LOOP;
  EXECUTE replace(
    replace(replace(v_definition, v_input, v_input_with_preview),
      v_replay, '  IF v_existing_action.id IS NOT NULL AND NOT v_dry_run THEN'),
    v_start, v_preview || v_start
  );
END;
$preview$;

COMMIT;
