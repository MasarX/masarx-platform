SELECT pg_advisory_lock(hashtext('202601092011_ui_resource_metrics_revoke_anon'));

REVOKE ALL ON FUNCTION public.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_resource_metrics_v1(TEXT, JSONB, TEXT[]) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601092011_ui_resource_metrics_revoke_anon'));
