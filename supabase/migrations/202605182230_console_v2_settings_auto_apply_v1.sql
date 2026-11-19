-- Console V2 settings auto-apply contract.
-- Safe categories may be activated directly from the operator UI; side-effecting
-- categories stay on the request/approval path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605182230_console_v2_settings_auto_apply_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_apply_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_change_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_category TEXT := NULLIF(BTRIM(p_category), '');
  v_scope RECORD;
  v_category_row RECORD;
  v_schema_version INT;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_settings_version_number INT;
  v_domain_event_id UUID;
  v_reason TEXT := COALESCE(NULLIF(BTRIM(p_change_reason), ''), 'applied via Console V2');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_category IS NULL THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 requires category'
      USING ERRCODE = '22023';
  END IF;

  IF p_value IS NULL THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 requires value'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  SELECT *
    INTO v_category_row
    FROM public.settings_category_registry scr
   WHERE scr.category = v_category
   LIMIT 1;

  IF v_category_row.category IS NULL THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 category % is not registered', v_category
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(v_category_row.side_effecting, FALSE) IS TRUE THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 category % requires request approval', v_category
      USING ERRCODE = '42501';
  END IF;

  IF NULLIF(BTRIM(COALESCE(v_category_row.request_capability, '')), '') IS NOT NULL THEN
    IF NOT public.user_has_capability_v1(v_category_row.request_capability, v_scope.scope_type, v_scope.scope_id) THEN
      RAISE EXCEPTION 'ui_apply_settings_value_v1 requires capability %', v_category_row.request_capability
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT (
    public.user_has_capability_v1('settings.write', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('system.write', v_scope.scope_type, v_scope.scope_id)
    OR public.user_can_write()
  ) THEN
    RAISE EXCEPTION 'ui_apply_settings_value_v1 requires settings.write capability'
      USING ERRCODE = '42501';
  END IF;

  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = v_category
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active entry for category=%', v_category
      USING ERRCODE = '23514';
  END IF;

  SELECT u.settings_id, u.settings_version_id, u.settings_version_number
    INTO v_settings_id, v_settings_version_id, v_settings_version_number
    FROM public.upsert_settings_value_v1(
      v_category,
      v_scope.scope_type,
      v_scope.scope_id,
      p_value,
      v_schema_version,
      v_reason
    ) u;

  v_domain_event_id := public.enqueue_domain_event(
    p_organization_id := v_scope.organization_id,
    p_event_type := 'settings_change.applied',
    p_resource_type := 'settings_version',
    p_resource_id := v_settings_version_id,
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_scope.organization_id,
      'client_id', v_scope.client_id,
      'sender_id', v_scope.sender_id,
      'settings_id', v_settings_id,
      'settings_version_id', v_settings_version_id,
      'settings_version_number', v_settings_version_number,
      'category', v_category,
      'scope_type', v_scope.scope_type,
      'scope_id', v_scope.scope_id,
      'reason', v_reason,
      'applied_by_user_id', v_user_id
    )),
    p_correlation_id := NULL
  );

  PERFORM public.log_decision(
    p_organization_id := v_scope.organization_id,
    p_decision_category := 'settings',
    p_resource_type := 'settings_version',
    p_resource_id := v_settings_version_id,
    p_decision_point := 'apply',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'ui_apply_settings_value_v1',
    p_correlation_id := v_domain_event_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'category', v_category,
      'scope_type', v_scope.scope_type,
      'scope_id', v_scope.scope_id,
      'settings_id', v_settings_id,
      'settings_version_number', v_settings_version_number,
      'workflow_event_type', 'settings_change.applied',
      'applied_by_user_id', v_user_id
    )),
    p_decision_reason := v_reason
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'applied', TRUE,
    'category', v_category,
    'scope_type', v_scope.scope_type,
    'scope_id', v_scope.scope_id,
    'settings_id', v_settings_id,
    'settings_version_id', v_settings_version_id,
    'settings_version_number', v_settings_version_number,
    'settings_resolution_id', v_settings_version_id,
    'domain_event_id', v_domain_event_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_apply_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_change_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_apply_settings_value_v1($1, $2, $3, $4, $5);
$function$;

REVOKE ALL ON FUNCTION public.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT)
  IS 'Browser-safe settings activation RPC for non-side-effecting categories. Applies through upsert_settings_value_v1 and emits decision/domain event lineage.';
COMMENT ON FUNCTION api.ui_apply_settings_value_v1(TEXT, TEXT, UUID, JSONB, TEXT)
  IS 'API-schema wrapper for Console V2 safe settings activation.';

SELECT pg_advisory_unlock(hashtext('202605182230_console_v2_settings_auto_apply_v1'));

COMMIT;
