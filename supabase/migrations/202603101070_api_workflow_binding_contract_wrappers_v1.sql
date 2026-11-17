-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S07
-- Migration: Expose workflow binding UI contracts through the api schema
-- Date: 2026-03-10
--
-- Purpose:
-- - Keep console/portal server clients on the standard api schema contract.
-- - Expose workflow binding UI RPCs and inventory view through api.* wrappers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101070_api_workflow_binding_contract_wrappers_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION api.ui_list_workflow_bindings_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_list_workflow_bindings_v1(p_scope_type, p_scope_id);
$function$;

CREATE OR REPLACE FUNCTION api.ui_workflow_binding_clone_override_v1(
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_workflow_binding_clone_override_v1(
    p_binding_key,
    p_stage_key,
    p_scope_type,
    p_scope_id
  );
$function$;

CREATE OR REPLACE FUNCTION api.ui_workflow_binding_reset_override_v1(
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_workflow_binding_reset_override_v1(
    p_binding_key,
    p_stage_key,
    p_scope_type,
    p_scope_id
  );
$function$;

REVOKE ALL ON FUNCTION api.ui_list_workflow_bindings_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_workflow_bindings_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_list_workflow_bindings_v1(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_list_workflow_bindings_v1(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE VIEW api.workflow_business_action_inventory_v1
WITH (security_invoker = true)
AS
SELECT *
FROM public.workflow_business_action_inventory_v1;

REVOKE ALL ON api.workflow_business_action_inventory_v1 FROM PUBLIC;
REVOKE ALL ON api.workflow_business_action_inventory_v1 FROM anon;
REVOKE ALL ON api.workflow_business_action_inventory_v1 FROM authenticated;
GRANT SELECT ON api.workflow_business_action_inventory_v1 TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603101070_api_workflow_binding_contract_wrappers_v1'));
COMMIT;
