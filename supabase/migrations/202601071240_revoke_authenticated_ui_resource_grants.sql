-- Migration: Revoke direct authenticated access to UI resources (RPC-only)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071240_revoke_authenticated_ui_resource_grants'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

REVOKE ALL ON TABLE public.zones FROM authenticated;
REVOKE ALL ON TABLE public.zone_districts FROM authenticated;
REVOKE ALL ON TABLE public.baskets FROM authenticated;
REVOKE ALL ON TABLE public.basket_items FROM authenticated;
REVOKE ALL ON TABLE public.basket_transitions FROM authenticated;

REVOKE ALL ON TABLE public.providers FROM authenticated;
REVOKE ALL ON TABLE public.operation_templates FROM authenticated;

REVOKE ALL ON TABLE public.mapping_configs FROM authenticated;
REVOKE ALL ON TABLE public.field_mappings FROM authenticated;

REVOKE ALL ON TABLE public.webhook_sources FROM authenticated;
REVOKE ALL ON TABLE public.webhook_inbox FROM authenticated;
REVOKE ALL ON TABLE public.webhook_response_events FROM authenticated;

REVOKE ALL ON TABLE public.webhook_log FROM authenticated;
REVOKE ALL ON TABLE public.api_call_log FROM authenticated;

REVOKE ALL ON TABLE public.api_route_packs FROM authenticated;
REVOKE ALL ON TABLE public.api_routes FROM authenticated;

REVOKE ALL ON TABLE public.lookup_definitions FROM authenticated;
REVOKE ALL ON TABLE public.lookup_values FROM authenticated;

REVOKE ALL ON TABLE public.label_sections FROM authenticated;
REVOKE ALL ON TABLE public.label_sections_p0 FROM authenticated;
REVOKE ALL ON TABLE public.label_design_tokens FROM authenticated;
REVOKE ALL ON TABLE public.label_design_tokens_p0 FROM authenticated;
REVOKE ALL ON TABLE public.label_template_validation FROM authenticated;
REVOKE ALL ON TABLE public.label_template_validation_p0 FROM authenticated;

SELECT pg_advisory_unlock(hashtext('202601071240_revoke_authenticated_ui_resource_grants'));
COMMIT;
