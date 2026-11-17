-- Migration: Internal view grants lockdown
-- Purpose: Prevent anon/authenticated from selecting internal observability/ops
--          views that can bypass underlying table privileges/RLS via view owner.
--
-- Strategy:
--  - Revoke PUBLIC/anon/authenticated on known internal views
--  - Grant SELECT only to service_role
--  - Prefer security_invoker when supported (Postgres 15+) as defense-in-depth

DO $$
DECLARE
  v_view TEXT;
  v_server_version INT := current_setting('server_version_num')::INT;
  v_views TEXT[] := ARRAY[
    'observability_events_v',
    'comms_reply_events_v',
    'comms_reply_failures_v',
    'comms_reply_latency_v',
    'label_job_barcode_summary_v',
    'label_job_barcode_blocks_v',
    'v_benchmark_latest_run',
    'v_benchmark_failures',
    'v_benchmark_failures_latest_run',
    'v_benchmark_plugin_metrics',
    'v_benchmark_plugin_metrics_latest_run'
  ];
BEGIN
  FOREACH v_view IN ARRAY v_views
  LOOP
    IF to_regclass(format('public.%I', v_view)) IS NULL THEN
      CONTINUE;
    END IF;

    -- Defense-in-depth: ensure view runs with invoker privileges when supported.
    IF v_server_version >= 150000 THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v_view);
    END IF;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_view);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', v_view);
  END LOOP;
END $$;

