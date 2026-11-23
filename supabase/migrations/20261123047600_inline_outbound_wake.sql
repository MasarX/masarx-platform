BEGIN;

ALTER TABLE public.cron_config
  ADD COLUMN inline_wake_not_before timestamptz,
  ADD COLUMN inline_wake_pending boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.post_outbound_wake_v1(p_endpoint text, p_inline boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_inline THEN
    -- This reservation commits with the handoff and the pg_net request.
    UPDATE public.cron_config c
    SET inline_wake_not_before = clock_timestamp() + interval '2 seconds', inline_wake_pending = true
    WHERE c.worker_name = (
      SELECT gate.worker_name FROM public.cron_config gate
      WHERE gate.worker_name = 'outbound_wake_relay' AND gate.enabled
        AND (gate.inline_wake_not_before IS NULL OR gate.inline_wake_not_before <= clock_timestamp())
      FOR UPDATE SKIP LOCKED
    );
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  PERFORM net.http_post(
    url := regexp_replace(p_endpoint, '/api-caller/?$', '/outbound-wake')
      || CASE WHEN p_inline THEN '?inline=1' ELSE '' END,
    body := '{}'::jsonb,
    headers := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.post_outbound_wake_v1(text, boolean)
  FROM PUBLIC, anon, authenticated, service_role, edge_api_caller_role, ui_rpc_executor;

CREATE FUNCTION api.try_start_inline_outbound_wake_v1()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_not_before timestamptz;
BEGIN
  -- A public signal can consume a committed producer reservation once.
  UPDATE public.cron_config c
  SET inline_wake_pending = false
  WHERE c.worker_name = (
    SELECT gate.worker_name FROM public.cron_config gate
    WHERE gate.worker_name = 'outbound_wake_relay' AND gate.enabled AND gate.inline_wake_pending
    FOR UPDATE SKIP LOCKED
  ) RETURNING c.inline_wake_not_before INTO v_not_before;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (SELECT endpoint_matches AND dispatch_enabled FROM public.outbound_wake_relay_state_v1()) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  -- Drain when the consumed reservation's coalescing window ends.
  RETURN GREATEST(0, ceil(extract(epoch FROM v_not_before - clock_timestamp()) * 1000))::integer;
END;
$function$;

REVOKE EXECUTE ON FUNCTION api.try_start_inline_outbound_wake_v1()
  FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT EXECUTE ON FUNCTION api.try_start_inline_outbound_wake_v1() TO edge_api_caller_role;

DO $patch$
DECLARE
  v_definition text := pg_get_functiondef('public.run_outbound_wake_sweep_v1()'::regprocedure);
  v_post CONSTANT text := $old$    PERFORM net.http_post(
      url := regexp_replace(v_state.endpoint, '/api-caller/?$', '/outbound-wake'),
      body := '{}'::jsonb,
      headers := '{}'::jsonb,
      timeout_milliseconds := 10000
    );$old$;
BEGIN
  IF cardinality(string_to_array(v_definition, v_post)) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Expected one sweep transport call';
  END IF;
  EXECUTE replace(v_definition, v_post, '    PERFORM public.post_outbound_wake_v1(v_state.endpoint, false);');
END;
$patch$;

REVOKE EXECUTE ON FUNCTION public.run_outbound_wake_sweep_v1()
  FROM PUBLIC, anon, authenticated, service_role, edge_api_caller_role, ui_rpc_executor;

DO $patch$
DECLARE
  v_definition text := pg_get_functiondef('public.dispatch_outbound_call_inline(uuid,jsonb)'::regprocedure);
  v_handoff CONSTANT text := $old$        PERFORM public.handoff_outbound_call_to_edge_v1(
            p_job_id, v_job.method, v_dispatch_headers, v_timeout_seconds
        );$old$;
  v_wake CONSTANT text := $new$
        BEGIN
            PERFORM public.post_outbound_wake_v1(endpoint, true)
            FROM public.outbound_wake_relay_state_v1()
            WHERE endpoint_matches AND dispatch_enabled;
        EXCEPTION WHEN others THEN
            RAISE WARNING 'outbound_inline_wake_enqueue_failed';
        END;$new$;
BEGIN
  IF cardinality(string_to_array(v_definition, v_handoff)) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Expected one inline handoff call';
  END IF;
  EXECUTE replace(v_definition, v_handoff, v_handoff || v_wake);
END;
$patch$;

REVOKE EXECUTE ON FUNCTION public.dispatch_outbound_call_inline(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_outbound_call_inline(uuid, jsonb) TO service_role;

COMMIT;
