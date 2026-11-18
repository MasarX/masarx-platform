BEGIN;

REVOKE ALL ON TABLE public.ops_alerts FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_alerts FROM anon;
REVOKE ALL ON TABLE public.ops_alerts FROM authenticated;

DROP POLICY IF EXISTS ops_alerts_authenticated_select ON public.ops_alerts;

SELECT public.enforce_partition_tree_service_only_v1('public.ops_alerts'::regclass);

GRANT SELECT ON public.ops_alerts_console_v1 TO authenticated, service_role;

COMMIT;
