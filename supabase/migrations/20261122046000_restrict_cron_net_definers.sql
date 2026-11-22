BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.ops_sweeper_ensure_cron_jobs(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_async_response(bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_async_response(bigint) TO service_role;
REVOKE EXECUTE ON FUNCTION public.ops_sweeper_label_renderer_cron_guard(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_cron_config(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.run_ops_sweeper_worker()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.run_edge_api_caller_worker()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
