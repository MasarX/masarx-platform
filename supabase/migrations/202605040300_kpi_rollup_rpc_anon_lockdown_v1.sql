BEGIN;

-- KPI rollup reads are authenticated Console V2 projections gated by
-- insights.read inside the RPC body. Remove explicit anon ACL entries left by
-- older grant replay while preserving authenticated/service execution.
REVOKE EXECUTE ON FUNCTION public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.compute_kpi_rollup_v2(JSONB) FROM anon;

GRANT EXECUTE ON FUNCTION public.compute_kpi_rollup_v1(TEXT, DATE, INT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_kpi_rollup_v2(JSONB) TO authenticated, service_role;

COMMIT;
