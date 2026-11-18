BEGIN;

SELECT pg_advisory_lock(hashtext('202608161930_provider_dashboard_security_invoker_v1'));

ALTER VIEW public.provider_health_latest_v SET (security_invoker = true);
ALTER VIEW public.circuit_breaker_dashboard_v SET (security_invoker = true);

COMMENT ON VIEW public.provider_health_latest_v IS 'Latest provider health projection with caller-invoker security for registry-backed UI reads.';
COMMENT ON VIEW public.circuit_breaker_dashboard_v IS 'Circuit-breaker projection with caller-invoker security for registry-backed UI reads.';

SELECT pg_advisory_unlock(hashtext('202608161930_provider_dashboard_security_invoker_v1'));

COMMIT;
