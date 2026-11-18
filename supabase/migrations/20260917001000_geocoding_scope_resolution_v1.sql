-- Keep geocoding policy and provider resolution inside the workflow run's owned scope.
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(
  p_run public.workflow_runs
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_policy JSONB;
BEGIN
  SELECT * INTO v_ctx
  FROM public.geocoding_extract_context(p_run);

  IF v_ctx.sender_id IS NOT NULL THEN
    v_scope_type := 'sender';
    v_scope_id := v_ctx.sender_id;
  ELSIF v_ctx.client_id IS NOT NULL THEN
    v_scope_type := 'client';
    v_scope_id := v_ctx.client_id;
  ELSIF v_ctx.organization_id IS NOT NULL THEN
    v_scope_type := 'tenant';
    v_scope_id := v_ctx.organization_id;
  ELSE
    v_scope_type := 'global';
    v_scope_id := NULL;
  END IF;

  SELECT public.resolve_settings('geocoding_policy', v_scope_type, v_scope_id)
  INTO v_policy;

  RETURN COALESCE(v_policy, '{}'::JSONB);
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(public.workflow_runs)
  IS 'Resolves geocoding_policy once from the most-specific workflow context; resolve_settings owns the fallback ladder.';

DO $repair$
DECLARE
  v_definition TEXT;
  v_old CONSTANT TEXT := $old$        SELECT pr.* INTO v_provider
        FROM public.providers pr
        WHERE pr.name = v_provider_name
        LIMIT 1;$old$;
  v_new CONSTANT TEXT := $new$        SELECT pr.* INTO v_provider
        FROM public.providers pr
        JOIN public.organizations provider_org ON provider_org.id = pr.organization_id
        WHERE pr.name = v_provider_name
          AND pr.enabled IS TRUE
          AND (
            pr.organization_id = v_ctx.organization_id
            OR provider_org.slug = 'global-root'
          )
          AND EXISTS (
            SELECT 1
            FROM public.operation_templates eligible_template
            WHERE eligible_template.provider_id = pr.id
              AND (NULLIF(v_metadata->>'operation_name', '') IS NULL
                   OR eligible_template.operation_name = v_metadata->>'operation_name')
              AND COALESCE(eligible_template.metadata->>'operation_role', '') =
                  CASE WHEN v_is_reverse THEN 'geocoding_reverse' ELSE 'geocoding_forward' END
          )
        ORDER BY (pr.organization_id = v_ctx.organization_id) DESC,
                 pr.priority_rank DESC, pr.updated_at DESC, pr.id
        LIMIT 1;$new$;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps,public.workflow_runs,jsonb)'::REGPROCEDURE
  )
  INTO v_definition;

  IF position(v_new IN v_definition) > 0 THEN
    RETURN;
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION
      'Unexpected execute_provider_dispatch_v1_base definition shape while applying provider ownership scope';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$repair$;

COMMENT ON FUNCTION workflow_handlers.execute_provider_dispatch_v1_base(
  public.workflow_run_steps,
  public.workflow_runs,
  JSONB
) IS 'Selects an enabled provider owned by the workflow organization or canonical global provider with an eligible operation template.';

COMMIT;
