-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Fix workflow_binding_stage_set_v1 so it can materialize nested stages on
--   binding objects that do not already have a stages key.
-- - Replay tenant workflow-binding bootstrap after the helper fix so existing
--   tenant rows gain the cloned stage/template mappings they were missing.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101010_workflow_binding_stage_set_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.workflow_binding_stage_set_v1(
  p_policy JSONB,
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_stage_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, public.workflow_binding_policy_default_v1());
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_binding_key, '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(p_stage_key, '')), ''));
BEGIN
  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RAISE EXCEPTION 'workflow_binding_stage_set_v1 requires binding_key and stage_key';
  END IF;

  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := public.workflow_binding_policy_default_v1();
  END IF;

  IF NOT (v_policy ? 'version') THEN
    v_policy := public.deep_merge_jsonb(public.workflow_binding_policy_default_v1(), v_policy);
  END IF;

  RETURN public.jsonb_deep_merge(
    v_policy,
    jsonb_build_object(
      'bindings',
      jsonb_build_object(
        v_binding_key,
        jsonb_build_object(
          'stages',
          jsonb_build_object(
            v_stage_key,
            COALESCE(p_stage_value, '{}'::jsonb)
          )
        )
      )
    )
  );
END;
$function$;

DO $do$
DECLARE
  v_scope RECORD;
BEGIN
  FOR v_scope IN
    SELECT DISTINCT s.scope_id
    FROM public.settings s
    WHERE s.category = 'workflow_binding_policy'
      AND s.scope_type = 'tenant'
      AND s.scope_id IS NOT NULL
  LOOP
    PERFORM public.bootstrap_workflow_binding_defaults_v1(
      'tenant',
      v_scope.scope_id,
      'repair:workflow_binding_stage_set_fix'
    );
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603101010_workflow_binding_stage_set_fix_v1'));
COMMIT;
