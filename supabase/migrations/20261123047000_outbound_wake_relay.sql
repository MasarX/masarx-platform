BEGIN;

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule)
VALUES ('outbound_wake_relay', 'outbound', 'Wakes the leased outbound queue.', '*/3 * * * *');

-- Match the worker tick: one bounded batch per rolling minute, up to 10 sequential leased jobs.
INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, notes)
VALUES ('outbound_wake_relay', 60, 10, 'Minimum time between queue wake attempts.');

CREATE FUNCTION api.try_start_outbound_wake_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  -- Reserve the slot even when idle, so public wake traffic cannot force repeated queue scans.
  UPDATE public.cron_config c
  SET last_run_at = clock_timestamp()
  WHERE c.worker_name = (
    SELECT gate.worker_name
    FROM public.cron_config gate
    WHERE gate.worker_name = 'outbound_wake_relay'
      AND gate.enabled
      AND (
        gate.last_run_at IS NULL
        OR gate.last_run_at <= clock_timestamp() - make_interval(secs => gate.interval_seconds)
      )
    FOR UPDATE SKIP LOCKED
  );
  IF NOT FOUND OR NOT public.resolve_edge_dispatch_enabled_v1() THEN
    RETURN FALSE;
  END IF;

  -- Match the claim RPC's due predicate. api-caller takes the lease when it is ready to execute.
  RETURN EXISTS (
    SELECT 1 FROM public.outbound_calls oc
    WHERE oc.status IN ('pending_edge', 'failed')
      AND oc.scheduled_at <= now()
      AND (oc.lease_expires_at IS NULL OR oc.lease_expires_at < now())
      AND (oc.status <> 'failed' OR oc.retry_count < oc.max_retries)
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.try_start_outbound_wake_v1() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.try_start_outbound_wake_v1() TO edge_api_caller_role;

-- Resolve the existing environment endpoint at run time. The sweep sends no job data or credential.
SELECT cron.schedule('outbound_wake_sweep', schedule, $cron$
  SELECT net.http_post(
    url := regexp_replace(endpoint, '/api-caller/?$', '/outbound-wake'),
    body := '{}'::jsonb,
    headers := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  FROM (
    SELECT public.resolve_settings('edge_dispatch_policy', 'global', NULL)->>'endpoint_url' AS endpoint
  ) configured
  WHERE endpoint ~ '^https?://[^/?#@[:space:]]+/functions/v1/api-caller/?$'
    AND public.resolve_edge_dispatch_enabled_v1();
$cron$)
FROM public.worker_registry
WHERE worker_name = 'outbound_wake_relay';

COMMIT;
