-- Exact scoped selected-record readback for shipment cohort actions.
BEGIN;

CREATE OR REPLACE FUNCTION public.ui_shipment_selection_readback_v1(
  p_action_key TEXT,
  p_selection_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_selection JSONB;
  v_capability TEXT;
  v_min INT;
  v_max INT;
  v_count INT := cardinality(p_selection_ids);
  v_id UUID;
  v_record JSONB;
  v_items JSONB := '[]'::JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'shipment selection readback requires authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT value INTO v_command
  FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::JSONB))
  WHERE value->>'key' = p_action_key
    AND value#>>'{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
    AND value#>>'{execution,result_contract}' = 'batch_items_v1'
    AND value#>>'{execution,params,operation}' IN ('cancel', 'reschedule');
  IF v_command IS NULL THEN
    RAISE EXCEPTION 'shipment selection readback requires registered batch command' USING ERRCODE = '42501';
  END IF;
  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;
  v_selection := COALESCE(v_command->'selection', '{}'::JSONB);
  v_min := COALESCE(NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN lower(v_selection->>'mode') IN ('none', 'any') THEN 0 ELSE 1 END);
  v_max := COALESCE(NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN lower(v_selection->>'mode') = 'single' THEN 1 ELSE NULL END);
  IF array_ndims(p_selection_ids) IS DISTINCT FROM 1 OR v_count IS NULL OR v_count < 1 OR v_count < v_min
     OR (v_max IS NOT NULL AND v_count > v_max)
     OR array_position(p_selection_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT id) FROM unnest(p_selection_ids) id) <> v_count THEN
    RAISE EXCEPTION 'invalid shipment readback selection' USING ERRCODE = '23514';
  END IF;
  FOREACH v_id IN ARRAY p_selection_ids LOOP
    v_record := public.ui_get_resource_v1('shipments', v_id);
    IF v_record IS NULL OR v_record->>'id' IS DISTINCT FROM v_id::TEXT
       OR NULLIF(btrim(v_record->>'status'), '') IS NULL THEN
      RETURN jsonb_build_object('visible', FALSE, 'items', '[]'::JSONB);
    END IF;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'selection_id', v_id, 'status', v_record->>'status'
    ));
  END LOOP;
  RETURN jsonb_build_object('visible', TRUE, 'count', v_count, 'items', v_items);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_shipment_selection_readback_v1(TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_shipment_selection_readback_v1(TEXT, UUID[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_shipment_selection_readback_v1(p_action_key TEXT, p_selection_ids UUID[])
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
  SELECT public.ui_shipment_selection_readback_v1($1, $2);
$function$;
REVOKE ALL ON FUNCTION api.ui_shipment_selection_readback_v1(TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_shipment_selection_readback_v1(TEXT, UUID[]) TO authenticated, service_role;

DO $binding$
DECLARE
  v_setting RECORD;
  v_commands JSONB;
  v_next JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id, s.settings_version_id, sv.value
    FROM public.settings s JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry' AND sv.effective_until IS NULL
  LOOP
    IF jsonb_typeof(v_setting.value->'commands') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
    SELECT jsonb_agg(CASE
      WHEN command->>'key' IN ('shipments.delete', 'shipments.reschedule')
        AND command#>>'{execution,rpc}' = 'ui_execute_shipment_batch_operation_v1'
        AND command#>>'{execution,result_contract}' = 'batch_items_v1'
      THEN jsonb_set(command, '{execution,readback}', jsonb_build_object(
        'rpc', 'ui_shipment_selection_readback_v1',
        'params', jsonb_build_object(
          'p_action_key', jsonb_build_object('source', 'static', 'value', command->>'key'),
          'p_selection_ids', jsonb_build_object('source', 'selection', 'path', 'ids')
        ),
        'success_path', 'visible', 'max_attempts', 4, 'delay_ms', 150
      ), TRUE)
      ELSE command END ORDER BY ordinal)
    INTO v_commands FROM jsonb_array_elements(v_setting.value->'commands') WITH ORDINALITY item(command, ordinal);
    v_next := jsonb_set(v_setting.value, '{commands}', COALESCE(v_commands, '[]'::JSONB), TRUE);
    IF v_next IS DISTINCT FROM v_setting.value THEN
      UPDATE public.settings_versions SET value = v_next, version = version + 1,
        change_reason = 'Require scoped selected shipment readback for cohort actions',
        approved_at = now(), effective_from = now()
      WHERE id = v_setting.settings_version_id;
      UPDATE public.settings SET cached_value = v_next, last_updated = now() WHERE id = v_setting.id;
    END IF;
  END LOOP;
END;
$binding$;

COMMIT;
