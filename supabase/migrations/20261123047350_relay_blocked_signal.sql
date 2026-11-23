BEGIN;

DO $edge_default$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_default CONSTANT text := $old$->>'enabled', '')::BOOLEAN, TRUE)$old$;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.resolve_edge_dispatch_enabled_v1()'::regprocedure,
    'public.call_api(text,text,jsonb,jsonb,integer)'::regprocedure,
    'public.call_api_wait(text,text,jsonb,jsonb,integer,integer)'::regprocedure
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    IF cardinality(string_to_array(v_definition, v_default)) IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'Expected one implicit Edge dispatch default in %', v_signature;
    END IF;
    -- The catalog definition uses CREATE OR REPLACE, preserving owner and ACL.
    EXECUTE replace(v_definition, v_default, replace(v_default, 'TRUE', 'FALSE'));
  END LOOP;
END;
$edge_default$;

CREATE FUNCTION public.outbound_wake_relay_state_v1()
RETURNS TABLE (endpoint text, endpoint_matches boolean, dispatch_enabled boolean, blocked_with_pending_work boolean)
LANGUAGE sql
STABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  WITH configured AS MATERIALIZED (
    SELECT public.resolve_settings('edge_dispatch_policy', 'global', NULL)->>'endpoint_url' AS endpoint,
           public.resolve_edge_dispatch_enabled_v1() AS dispatch_enabled
  ), relay AS (
    SELECT endpoint, dispatch_enabled,
           COALESCE(endpoint ~ '^https?://[^/?#@[:space:]]+/functions/v1/api-caller/?$', false) AS endpoint_matches
    FROM configured
  )
  SELECT endpoint, endpoint_matches, dispatch_enabled,
         CASE WHEN endpoint_matches AND dispatch_enabled THEN false ELSE EXISTS (
           SELECT 1 FROM public.outbound_calls
           WHERE (status = 'pending_edge' AND (scheduled_at <= now() OR scheduled_at IS NULL))
              OR (status = 'failed' AND scheduled_at <= now() AND retry_count < max_retries
                  AND (lease_expires_at IS NULL OR lease_expires_at < now()))
         ) END
  FROM relay;
$function$;

REVOKE ALL ON FUNCTION public.outbound_wake_relay_state_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.run_outbound_wake_sweep_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_state record;
  v_code CONSTANT text := 'outbound_wake_relay_blocked';
  v_minute timestamptz := date_trunc('minute', statement_timestamp(), 'UTC');
BEGIN
  SELECT * INTO STRICT v_state FROM public.outbound_wake_relay_state_v1();
  IF v_state.endpoint_matches AND v_state.dispatch_enabled THEN
    PERFORM net.http_post(
      url := regexp_replace(v_state.endpoint, '/api-caller/?$', '/outbound-wake'),
      body := '{}'::jsonb,
      headers := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  ELSIF v_state.blocked_with_pending_work THEN
    -- The partition key and deterministic per-minute ID coalesce concurrent sweeps.
    INSERT INTO public.ops_alerts (organization_id, created_at, id, alert_type, severity, message)
    VALUES (public.marketplace_system_org_id_v1(), v_minute,
            md5(v_code || extract(epoch FROM v_minute)::text)::uuid, v_code, 'warning', v_code)
    ON CONFLICT (organization_id, created_at, id) DO NOTHING;
    IF FOUND THEN
      RAISE WARNING '%', v_code;
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.run_outbound_wake_sweep_v1() FROM PUBLIC, anon, authenticated, service_role;

DO $cron$
DECLARE
  v_job cron.job%ROWTYPE;
  v_command CONSTANT text := 'SELECT public.run_outbound_wake_sweep_v1();';
BEGIN
  SELECT * INTO STRICT v_job FROM cron.job
  WHERE jobname = 'outbound_wake_sweep' AND username = current_user;
  IF v_job.command IS DISTINCT FROM v_command THEN
    PERFORM cron.alter_job(v_job.jobid, command := v_command);
  END IF;
END;
$cron$;

COMMIT;
