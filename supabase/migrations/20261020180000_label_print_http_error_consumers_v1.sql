-- HTTP completion is not renderer success; keep raw transport payloads private.
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20261020180000_label_print_http_error_consumers_v1'));

DO $repair$
DECLARE
  v_target regprocedure;
  v_definition text;
  v_direct_old text := $fragment$
      IF COALESCE((v_execute_response->>'completed')::boolean, false)
         AND jsonb_typeof(v_execute_response->'body') = 'object' THEN
        v_result := COALESCE(v_execute_response->'body', '{}'::jsonb);
$fragment$;
  v_direct_new text := $fragment$
      IF COALESCE((v_execute_response->>'completed')::boolean, false)
         AND (jsonb_typeof(v_execute_response->'body') = 'object'
              OR COALESCE((v_execute_response->>'status')::int, 0) NOT BETWEEN 200 AND 299) THEN
        v_result := CASE
          WHEN COALESCE((v_execute_response->>'status')::int, 0) NOT BETWEEN 200 AND 299
            THEN jsonb_build_object('status', 'failed', 'error', 'label_print_execute_http_error',
                                    'http_status', COALESCE((v_execute_response->>'status')::int, 0))
          ELSE COALESCE(v_execute_response->'body', '{}'::jsonb)
        END;
$fragment$;
  v_poll_old text := $fragment$
      v_result := COALESCE(v_http_body, '{}'::jsonb);
$fragment$;
  v_poll_new text := $fragment$
      v_result := CASE
        WHEN COALESCE((v_http_response->>'status')::int, 0) NOT BETWEEN 200 AND 299
          THEN jsonb_build_object('status', 'failed', 'error', 'label_print_execute_http_error',
                                  'http_status', COALESCE((v_http_response->>'status')::int, 0))
        ELSE COALESCE(v_http_body, '{}'::jsonb)
      END;
$fragment$;
  v_execute_old text := $fragment$
        IF jsonb_typeof(v_execute_async_response->'body') = 'object' THEN
          v_execute_async_body := v_execute_async_response->'body';
        END IF;
$fragment$;
  v_execute_new text := $fragment$
        IF v_execute_async_completed
           AND COALESCE((v_execute_async_response->>'status')::int, 0) NOT BETWEEN 200 AND 299 THEN
          v_execute_async_body := jsonb_build_object(
            'status', 'failed', 'error', 'label_print_execute_http_error',
            'http_status', COALESCE((v_execute_async_response->>'status')::int, 0));
          v_execute_async_response := jsonb_set(v_execute_async_response, '{body}', v_execute_async_body);
        ELSIF jsonb_typeof(v_execute_async_response->'body') = 'object' THEN
          v_execute_async_body := v_execute_async_response->'body';
        END IF;
$fragment$;
  v_bundle_old text := $fragment$
        IF jsonb_typeof(v_async_response->'body') = 'object' THEN
          v_async_body := v_async_response->'body';
        END IF;
$fragment$;
  v_bundle_new text := $fragment$
        IF v_async_completed
           AND COALESCE((v_async_response->>'status')::int, 0) NOT BETWEEN 200 AND 299 THEN
          v_async_body := jsonb_build_object(
            'status', 'failed', 'error', 'label_print_execute_http_error',
            'http_status', COALESCE((v_async_response->>'status')::int, 0));
          v_async_response := jsonb_set(v_async_response, '{body}', v_async_body);
        ELSIF jsonb_typeof(v_async_response->'body') = 'object' THEN
          v_async_body := v_async_response->'body';
        END IF;
$fragment$;
BEGIN
  v_target := 'workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure;
  SELECT pg_get_functiondef(v_target) INTO STRICT v_definition;
  IF (length(v_definition) - length(replace(v_definition, v_direct_old, ''))) / length(v_direct_old) <> 1
     OR (length(v_definition) - length(replace(v_definition, v_poll_old, ''))) / length(v_poll_old) <> 1 THEN
    RAISE EXCEPTION 'label print HTTP execute anchors drifted';
  END IF;
  EXECUTE replace(replace(v_definition, v_direct_old, v_direct_new), v_poll_old, v_poll_new);
  SELECT pg_get_functiondef(v_target) INTO STRICT v_definition;
  IF position(v_direct_new IN v_definition) = 0 OR position(v_poll_new IN v_definition) = 0 THEN
    RAISE EXCEPTION 'label print HTTP execute repair did not persist';
  END IF;

  v_target := 'public.ui_get_workflow_run_output_status_v1(uuid,text[])'::regprocedure;
  SELECT pg_get_functiondef(v_target) INTO STRICT v_definition;
  IF (length(v_definition) - length(replace(v_definition, v_execute_old, ''))) / length(v_execute_old) <> 1
     OR (length(v_definition) - length(replace(v_definition, v_bundle_old, ''))) / length(v_bundle_old) <> 1 THEN
    RAISE EXCEPTION 'label print HTTP UI reconciliation anchors drifted';
  END IF;
  EXECUTE replace(replace(v_definition, v_execute_old, v_execute_new), v_bundle_old, v_bundle_new);
  SELECT pg_get_functiondef(v_target) INTO STRICT v_definition;
  IF position(v_execute_new IN v_definition) = 0 OR position(v_bundle_new IN v_definition) = 0 THEN
    RAISE EXCEPTION 'label print HTTP UI reconciliation repair did not persist';
  END IF;
END;
$repair$;
COMMIT;
