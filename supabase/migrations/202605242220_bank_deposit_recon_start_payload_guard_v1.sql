-- Migration: bank deposit reconciliation start payload guard
-- Purpose:
--   Keep browser-started workflow runs row-driven and fail closed before a
--   late workflow step when a template requires domain context.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605242220_bank_deposit_recon_start_payload_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assert_workflow_start_payload_policy_v1(
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
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_policy RECORD;
  v_req JSONB;
  v_path TEXT;
  v_label TEXT;
  v_expected TEXT;
  v_actual JSONB;
  v_actual_text TEXT;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'workflow_start_payload_policy requires JSON object payload'
      USING ERRCODE = '23514';
  END IF;

  FOR v_policy IN
    SELECT required_capability, metadata
      FROM public.workflow_template_start_policy
     WHERE workflow_template_id = p_workflow_template_id
       AND is_active IS TRUE
     ORDER BY required_capability
  LOOP
    FOR v_req IN
      SELECT value
        FROM jsonb_array_elements(COALESCE(v_policy.metadata->'required_payload_paths', '[]'::jsonb))
    LOOP
      IF jsonb_typeof(v_req) = 'object' THEN
        v_path := NULLIF(btrim(COALESCE(v_req->>'path', '')), '');
        v_label := COALESCE(NULLIF(btrim(COALESCE(v_req->>'label', '')), ''), v_path);
      ELSE
        v_path := NULLIF(btrim(COALESCE(v_req #>> '{}', '')), '');
        v_label := v_path;
      END IF;

      IF v_path IS NULL THEN
        CONTINUE;
      END IF;

      v_actual := public.safe_jsonpath_query_first(v_payload, v_path);
      v_actual_text := NULLIF(btrim(COALESCE(v_actual #>> '{}', '')), '');
      IF v_actual IS NULL OR v_actual_text IS NULL THEN
        RAISE EXCEPTION 'workflow_start_payload_policy missing required payload field %', v_label
          USING ERRCODE = '23514';
      END IF;
    END LOOP;

    FOR v_req IN
      SELECT value
        FROM jsonb_array_elements(COALESCE(v_policy.metadata->'required_payload_values', '[]'::jsonb))
    LOOP
      v_path := NULLIF(btrim(COALESCE(v_req->>'path', '')), '');
      v_label := COALESCE(NULLIF(btrim(COALESCE(v_req->>'label', '')), ''), v_path);
      v_expected := COALESCE(v_req->>'value', v_req->>'equals');
      IF v_path IS NULL THEN
        CONTINUE;
      END IF;

      v_actual := public.safe_jsonpath_query_first(v_payload, v_path);
      v_actual_text := NULLIF(btrim(COALESCE(v_actual #>> '{}', '')), '');
      IF v_expected IS NOT NULL AND v_actual_text IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'workflow_start_payload_policy expected % to equal %', v_label, v_expected
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.assert_workflow_start_payload_policy_v1(UUID, JSONB) IS
  'Row-driven Console workflow start payload guard. Reads workflow_template_start_policy.metadata required_payload_paths/required_payload_values and fails closed before start_workflow_run.';

REVOKE ALL ON FUNCTION public.assert_workflow_start_payload_policy_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_workflow_start_payload_policy_v1(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_workflow_start_payload_policy_v1(UUID, JSONB) TO authenticated, service_role;

UPDATE public.workflow_template_start_policy
   SET metadata = COALESCE(metadata, '{}'::jsonb)
     || jsonb_build_object(
       'template_key', 'bank_deposit_reconciliation_v2',
       'reason', 'Bank reconciliation start mutates finance workflow state and requires branch-day settlement anchors',
       'required_payload_values', jsonb_build_array(
         jsonb_build_object('path', '$.kind', 'value', 'deposit', 'label', 'settlement kind'),
         jsonb_build_object('path', '$.scope_type', 'value', 'branch_day', 'label', 'settlement scope')
       ),
       'required_payload_paths', jsonb_build_array(
         jsonb_build_object('path', '$.bank_account_id', 'label', 'bank account'),
         jsonb_build_object('path', '$.bank_account_key', 'label', 'bank account key'),
         jsonb_build_object('path', '$.branch_id', 'label', 'branch'),
         jsonb_build_object('path', '$.subject_type', 'label', 'settlement subject type'),
         jsonb_build_object('path', '$.subject_id', 'label', 'settlement subject')
       )
     ),
       updated_at = now()
 WHERE workflow_template_id = '99990000-0000-0000-0000-000000570004'::uuid
   AND required_capability = 'finance.write';

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

  PERFORM public.assert_workflow_start_payload_policy_v1(p_workflow_template_id, COALESCE(p_payload, '{}'::jsonb));
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
  'Browser-safe workflow start wrapper. Requires workflow_runs.write plus active row-driven workflow_template_start_policy capabilities and payload policy guards, then applies domain guards such as COD settlement duplicate prevention before starting the workflow.';

REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605242220_bank_deposit_recon_start_payload_guard_v1'));
COMMIT;
