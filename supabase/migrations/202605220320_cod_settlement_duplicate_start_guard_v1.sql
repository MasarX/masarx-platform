BEGIN;

SELECT pg_advisory_lock(hashtext('202605220320_cod_settlement_duplicate_start_guard_v1'));

UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
     || jsonb_build_object('allows_cod_restart', lv.value = 'canceled')
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'settlement_status';

UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
     || jsonb_build_object('blocks_cod_restart', lv.value IN ('pending', 'in_progress', 'running'))
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'workflow_run_status';

CREATE OR REPLACE FUNCTION public.assert_cod_settlement_start_allowed_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_template_key TEXT;
  v_cod_entry_id TEXT;
  v_org_id UUID;
  v_existing RECORD;
  v_existing_run RECORD;
BEGIN
  SELECT COALESCE(NULLIF(template_key, ''), name)
    INTO v_template_key
    FROM public.workflow_templates
   WHERE id = p_workflow_template_id;

  IF v_template_key IS DISTINCT FROM 'cod_driver_shift_settlement_v2' THEN
    RETURN;
  END IF;

  v_cod_entry_id := NULLIF(BTRIM(COALESCE(
    p_payload->>'cod_entry_id',
    p_payload#>>'{metadata,cod_entry_id}'
  )), '');

  IF v_cod_entry_id IS NULL THEN
    RETURN;
  END IF;

  v_org_id := COALESCE(
    NULLIF(p_payload->>'organization_id', '')::uuid,
    public.current_user_org_id()
  );

  PERFORM pg_advisory_xact_lock(
    hashtext('cod_settlement_start'),
    hashtext(v_org_id::text || ':' || v_cod_entry_id)
  );

  SELECT id, status
    INTO v_existing
    FROM public.settlement_batches
   WHERE organization_id = v_org_id
     AND kind = 'cod'
     AND metadata->>'cod_entry_id' = v_cod_entry_id
     AND NOT COALESCE((
       SELECT CASE
                WHEN jsonb_typeof(COALESCE(lv.metadata, '{}'::jsonb)->'allows_cod_restart') = 'boolean'
                  THEN (lv.metadata->>'allows_cod_restart')::boolean
                ELSE FALSE
              END
         FROM public.lookup_definitions ld
         JOIN public.lookup_values lv
           ON lv.lookup_definition_id = ld.id
        WHERE ld.category = 'settlement_status'
          AND lv.value = lower(COALESCE(public.settlement_batches.status, ''))
        LIMIT 1
     ), FALSE)
   ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'COD settlement already exists for COD entry %', v_cod_entry_id
      USING ERRCODE = '23505',
            DETAIL = format('Existing settlement batch %s is %s.', v_existing.id, COALESCE(v_existing.status, 'unknown')),
            HINT = 'Open the existing settlement batch instead of starting a duplicate COD settlement workflow.';
  END IF;

  SELECT wr.id, wr.workflow_status
    INTO v_existing_run
    FROM public.workflow_runs wr
   WHERE wr.workflow_template_id = p_workflow_template_id
     AND COALESCE(
       wr.context->>'organization_id',
       wr.context#>>'{payload,organization_id}'
     ) = v_org_id::text
     AND COALESCE(
       wr.context#>>'{payload,cod_entry_id}',
       wr.context#>>'{payload,metadata,cod_entry_id}',
       wr.context->>'cod_entry_id',
       wr.context#>>'{metadata,cod_entry_id}'
     ) = v_cod_entry_id
     AND COALESCE((
       SELECT CASE
                WHEN jsonb_typeof(COALESCE(lv.metadata, '{}'::jsonb)->'blocks_cod_restart') = 'boolean'
                  THEN (lv.metadata->>'blocks_cod_restart')::boolean
                ELSE TRUE
              END
         FROM public.lookup_definitions ld
         JOIN public.lookup_values lv
           ON lv.lookup_definition_id = ld.id
        WHERE ld.category = 'workflow_run_status'
          AND lv.value = lower(COALESCE(wr.workflow_status, ''))
        LIMIT 1
     ), TRUE)
   ORDER BY wr.updated_at DESC NULLS LAST, wr.created_at DESC NULLS LAST
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'COD settlement workflow already exists for COD entry %', v_cod_entry_id
      USING ERRCODE = '23505',
            DETAIL = format('Existing workflow run %s is %s.', v_existing_run.id, COALESCE(v_existing_run.workflow_status, 'unknown')),
            HINT = 'Open the existing workflow run instead of starting a duplicate COD settlement workflow.';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_cod_settlement_start_allowed_v1(UUID, JSONB) IS
  'Fail-closed duplicate guard for Console/API starts of cod_driver_shift_settlement_v2. A COD entry may not start another settlement workflow while an existing COD settlement batch or active workflow run is present unless row-driven status metadata allows restart.';

REVOKE ALL ON FUNCTION public.assert_cod_settlement_start_allowed_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_cod_settlement_start_allowed_v1(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_cod_settlement_start_allowed_v1(UUID, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_require_active BOOLEAN := COALESCE(p_require_active, TRUE);
  v_context JSONB;
  v_run_id UUID;
  v_policy RECORD;
BEGIN
  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  FOR v_policy IN
    SELECT required_capability, scope_type
      FROM public.workflow_template_start_policy
     WHERE workflow_template_id = p_workflow_template_id
       AND is_active IS TRUE
     ORDER BY required_capability
  LOOP
    PERFORM public.assert_capability_v1(
      v_policy.required_capability,
      COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type),
      CASE
        WHEN COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type) = v_scope_type
          THEN v_scope_id
        WHEN v_policy.scope_type = 'tenant'
          THEN public.current_user_org_id()
        ELSE v_scope_id
      END
    );
  END LOOP;

  PERFORM public.assert_cod_settlement_start_allowed_v1(p_workflow_template_id, COALESCE(p_payload, '{}'::jsonb));

  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  );

  v_run_id := start_workflow_run(p_workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_id', p_workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) IS
  'Browser-safe workflow start wrapper. Requires workflow_runs.write plus active row-driven workflow_template_start_policy capabilities, then applies domain guards such as COD settlement duplicate prevention before starting the workflow.';

REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605220320_cod_settlement_duplicate_start_guard_v1'));

COMMIT;
