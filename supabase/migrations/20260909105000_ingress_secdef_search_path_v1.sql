-- Pin existing ingress helpers to the canonical SECURITY DEFINER search path.
-- Bodies already schema-qualify API/Vault references; preserve bodies, ACLs and triggers.
BEGIN;

ALTER FUNCTION api.ui_upsert_api_gateway_route_mapping_v1(jsonb)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.persist_ingress_execution_url_v1(uuid, text, uuid)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.resolve_ingress_execution_url_v1(uuid)
  SET search_path TO public, extensions, pg_temp;
ALTER FUNCTION public.purge_obsolete_ingress_execution_url_v1()
  SET search_path TO public, extensions, pg_temp;

COMMIT;
