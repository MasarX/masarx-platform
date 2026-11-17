BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202608140900_security_invoker_projection_grants_v1'));
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path TO public, extensions, pg_temp;

REVOKE ALL ON public.return_to_branch_shipments_v1 FROM PUBLIC;
REVOKE ALL ON public.return_to_branch_shipments_v1 FROM anon;
REVOKE ALL ON public.return_to_branch_shipments_v1 FROM authenticated;
REVOKE ALL ON public.return_to_branch_shipments_v1 FROM service_role;
GRANT SELECT ON public.return_to_branch_shipments_v1 TO authenticated, service_role;

REVOKE ALL ON public.dispatch_exception_review_sla_breaches_v FROM PUBLIC;
REVOKE ALL ON public.dispatch_exception_review_sla_breaches_v FROM anon;
REVOKE ALL ON public.dispatch_exception_review_sla_breaches_v FROM authenticated;
REVOKE ALL ON public.dispatch_exception_review_sla_breaches_v FROM service_role;
GRANT SELECT ON public.dispatch_exception_review_sla_breaches_v TO authenticated, service_role;

COMMENT ON VIEW public.return_to_branch_shipments_v1 IS
  'Security-invoker returned-to-branch queue projection. Underlying SELECT is granted only to authenticated and service_role so api.return_to_branch_shipments_v1 can preserve caller RLS.';

COMMENT ON VIEW public.dispatch_exception_review_sla_breaches_v IS
  'Security-invoker dispatch SLA projection. Underlying SELECT is granted only to authenticated and service_role so api.dispatch_exception_review_sla_breaches_v can preserve caller RLS.';

COMMIT;
