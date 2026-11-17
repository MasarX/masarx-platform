-- Keep label_print.counts.ready aligned with the canonical ready projection.
-- Patch the effective bundle handler narrowly so all existing completeness,
-- pending, failure, scope, and asynchronous-settlement behavior is preserved.

BEGIN;
SELECT pg_advisory_lock(hashtext('20260920006000_label_bundle_ready_count_projection_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_target regprocedure := 'workflow_handlers.execute_label_bundle_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure;
  v_definition text;
  v_initial_old text := $fragment$
    v_pending_count := COALESCE(
        NULLIF(v_counts->>'pending', '')::INT,
        GREATEST(v_expected_count - COALESCE(jsonb_array_length(v_ready), 0), 0)
    );

    IF v_fresh_scope_only THEN
$fragment$;
  v_initial_new text := $fragment$
    v_pending_count := COALESCE(
        NULLIF(v_counts->>'pending', '')::INT,
        GREATEST(v_expected_count - COALESCE(jsonb_array_length(v_ready), 0), 0)
    );
    v_counts := jsonb_set(
        COALESCE(v_counts, '{}'::jsonb),
        '{ready}',
        to_jsonb(COALESCE(jsonb_array_length(v_ready), 0)),
        true
    );

    IF v_fresh_scope_only THEN
$fragment$;
  v_refreshed_old text := $fragment$
    v_ready_count_actual := COALESCE(jsonb_array_length(v_ready), 0);

    IF v_fresh_scope_only AND v_expected_count > 0
$fragment$;
  v_refreshed_new text := $fragment$
    v_ready_count_actual := COALESCE(jsonb_array_length(v_ready), 0);
    v_counts := jsonb_set(
        COALESCE(v_counts, '{}'::jsonb),
        '{ready}',
        to_jsonb(v_ready_count_actual),
        true
    );

    IF v_fresh_scope_only AND v_expected_count > 0
$fragment$;
BEGIN
  SELECT pg_get_functiondef(v_target) INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'label bundle ready-count repair target is missing';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_initial_old, '')))
       / NULLIF(length(v_initial_old), 0) <> 1 THEN
    RAISE EXCEPTION 'label bundle ready-count initial anchor drifted';
  END IF;
  IF (length(v_definition) - length(replace(v_definition, v_refreshed_old, '')))
       / NULLIF(length(v_refreshed_old), 0) <> 1 THEN
    RAISE EXCEPTION 'label bundle ready-count refreshed anchor drifted';
  END IF;

  v_definition := replace(v_definition, v_initial_old, v_initial_new);
  v_definition := replace(v_definition, v_refreshed_old, v_refreshed_new);
  EXECUTE v_definition;

  SELECT pg_get_functiondef(v_target) INTO v_definition;
  IF position(v_initial_new IN v_definition) = 0
     OR position(v_refreshed_new IN v_definition) = 0 THEN
    RAISE EXCEPTION 'label bundle ready-count repair did not persist';
  END IF;
END;
$migration$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v1(
  public.workflow_run_steps,
  public.workflow_runs,
  jsonb
) IS 'Invoke label renderer bundle mode with fresh-only completeness guards and keep counts.ready aligned with the canonical ready projection.';

SELECT pg_advisory_unlock(hashtext('20260920006000_label_bundle_ready_count_projection_v1'));
COMMIT;
