-- Console V2 workflow binding registration visibility.
-- register_workflow_binding_v1 is the canonical write path for binding policy,
-- but Console operators also need the newly registered binding to appear in the
-- same browser-facing registry projection without a page reload.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605231805_workflow_binding_registration_visibility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.workflow_binding_stage_registry
  ADD COLUMN IF NOT EXISTS workflow_template_id UUID NULL REFERENCES public.workflow_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_binding_stage_registry_template
  ON public.workflow_binding_stage_registry (workflow_template_id)
  WHERE workflow_template_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.register_workflow_binding_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := gen_random_uuid()::text;
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'binding_key', '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'stage_key', '')), ''));
  v_workflow_template_id UUID := NULLIF(p_args->>'workflow_template_id', '')::uuid;
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant'));
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_inline_steps INTEGER := NULLIF(p_args->>'inline_progress_steps', '')::int;
  v_sequence_order INTEGER := NULLIF(p_args->>'priority', '')::int;
  v_notes TEXT := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_current JSONB;
  v_next JSONB;
  v_next_version INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 requires binding_key and stage_key'
      USING ERRCODE = '23502';
  END IF;
  IF v_scope_type NOT IN ('global', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;
  IF v_scope_type = 'global' AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 scope=global requires platform user'
      USING ERRCODE = '42501';
  END IF;
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := v_org_id;
  END IF;
  IF v_scope_type = 'tenant'
     AND v_org_id IS NOT NULL
     AND v_scope_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 scope_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT value INTO v_current
    FROM public.settings_versions
   WHERE category = 'workflow_binding_policy'
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
   ORDER BY version DESC
   LIMIT 1;

  v_current := COALESCE(v_current, jsonb_build_object('version', 1, 'bindings', '{}'::jsonb));

  v_next := jsonb_set(
    v_current,
    ARRAY['bindings', v_binding_key, 'stages', v_stage_key],
    jsonb_strip_nulls(jsonb_build_object(
      'enabled', v_enabled,
      'workflow_template_id', COALESCE(v_workflow_template_id::text, NULL),
      'inline_progress_steps', v_inline_steps,
      'notes', v_notes
    )),
    TRUE
  );

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'workflow_binding_policy'
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id;

  UPDATE public.settings_versions
     SET effective_until = GREATEST(now(), effective_from + interval '1 millisecond')
   WHERE category = 'workflow_binding_policy'
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
     AND approved_at IS NOT NULL
     AND effective_until IS NULL;

  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at, effective_from
  ) VALUES (
    'workflow_binding_policy', v_scope_type, v_scope_id, v_next_version, v_next, 1,
    COALESCE('register_workflow_binding_v1: ' || v_binding_key || '/' || v_stage_key, 'register_workflow_binding_v1'),
    now(), now()
  );

  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
    FROM public.settings_versions sv
   WHERE sv.category = 'workflow_binding_policy'
     AND sv.scope_type = v_scope_type
     AND sv.scope_id IS NOT DISTINCT FROM v_scope_id
     AND sv.version = v_next_version
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

  INSERT INTO public.workflow_binding_registry (
    binding_key,
    label,
    description,
    resource_type,
    actor_surface,
    entrypoint_type,
    current_execution_kind,
    configurability_status,
    owner,
    migration_phase,
    is_business_affecting
  ) VALUES (
    v_binding_key,
    COALESCE(NULLIF(p_args->>'label', ''), replace(v_binding_key, '.', ' ')),
    COALESCE(v_notes, 'Console-registered workflow binding'),
    NULLIF(p_args->>'resource_type', ''),
    'console',
    'rpc',
    'workflow_native',
    'workflow_configurable',
    COALESCE(NULLIF(p_args->>'owner', ''), 'ops'),
    'console_registered',
    COALESCE((p_args->>'is_business_affecting')::boolean, TRUE)
  )
  ON CONFLICT (binding_key) DO UPDATE
  SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    resource_type = COALESCE(EXCLUDED.resource_type, public.workflow_binding_registry.resource_type),
    actor_surface = EXCLUDED.actor_surface,
    entrypoint_type = EXCLUDED.entrypoint_type,
    current_execution_kind = EXCLUDED.current_execution_kind,
    configurability_status = EXCLUDED.configurability_status,
    owner = EXCLUDED.owner,
    migration_phase = EXCLUDED.migration_phase,
    is_business_affecting = EXCLUDED.is_business_affecting,
    updated_at = now();

  INSERT INTO public.workflow_binding_stage_registry (
    binding_key,
    stage_key,
    label,
    description,
    sequence_order,
    is_enabled,
    workflow_template_id
  ) VALUES (
    v_binding_key,
    v_stage_key,
    COALESCE(NULLIF(p_args->>'stage_label', ''), v_stage_key),
    COALESCE(v_notes, 'Console-registered workflow binding stage'),
    COALESCE(v_sequence_order, 10),
    v_enabled,
    v_workflow_template_id
  )
  ON CONFLICT (binding_key, stage_key) DO UPDATE
  SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    sequence_order = EXCLUDED.sequence_order,
    is_enabled = EXCLUDED.is_enabled,
    workflow_template_id = EXCLUDED.workflow_template_id,
    updated_at = now();

  INSERT INTO public.workflow_binding_registrations (
    organization_id, binding_key, stage_key, workflow_template_id,
    scope_type, scope_id, binding_payload, changed_by,
    correlation_id, decision_log_id
  ) VALUES (
    v_org_id, v_binding_key, v_stage_key, v_workflow_template_id,
    v_scope_type, v_scope_id, p_args, v_user_id,
    v_correlation_id, v_decision_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.binding_register', 'workflow_binding', v_resource_id,
    'register_workflow_binding_v1', 'registered',
    jsonb_strip_nulls(jsonb_build_object(
      'binding_key', v_binding_key, 'stage_key', v_stage_key,
      'scope_type', v_scope_type, 'scope_id', v_scope_id
    )),
    'register_workflow_binding_v1', v_correlation_id::uuid
  );

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_org_id, 'workflow_binding.registered', 'workflow_binding', v_resource_id,
      jsonb_build_object('binding_key', v_binding_key, 'stage_key', v_stage_key, 'scope_type', v_scope_type),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_binding_registration_id', v_resource_id,
    'binding_key', v_binding_key,
    'stage_key', v_stage_key,
    'workflow_template_id', v_workflow_template_id,
    'settings_version', v_next_version,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE VIEW public.workflow_bindings_console_v1
WITH (security_invoker = true) AS
WITH first_stage AS (
  SELECT DISTINCT ON (wbsr.binding_key)
    wbsr.binding_key,
    wbsr.stage_key,
    wbsr.sequence_order,
    wbsr.is_enabled,
    wbsr.workflow_template_id
  FROM public.workflow_binding_stage_registry wbsr
  ORDER BY wbsr.binding_key, wbsr.sequence_order ASC, wbsr.stage_key ASC
),
latest_dispatch AS (
  SELECT DISTINCT ON (wbd.binding_key)
    wbd.binding_key,
    wbd.workflow_template_id,
    wbd.outcome,
    wbd.created_at
  FROM public.workflow_binding_dispatches wbd
  ORDER BY wbd.binding_key, wbd.created_at DESC
)
SELECT
  wbr.binding_key AS id,
  wbr.binding_key,
  regexp_replace(wbr.binding_key, '\.[^.]+$', '') AS event,
  COALESCE(ld.workflow_template_id, fs.workflow_template_id)::text AS template_id,
  COALESCE(ld.workflow_template_id, fs.workflow_template_id) AS workflow_template_id,
  fs.stage_key,
  '{}'::jsonb AS condition,
  COALESCE(fs.sequence_order, 0)::int AS priority,
  CASE
    WHEN COALESCE(fs.is_enabled, true) THEN 'active'
    ELSE 'disabled'
  END AS status,
  COALESCE(fs.is_enabled, true) AS enabled,
  wbr.label,
  wbr.description,
  wbr.resource_type,
  wbr.actor_surface,
  wbr.entrypoint_type,
  wbr.current_execution_kind,
  wbr.configurability_status,
  wbr.owner,
  wbr.migration_phase,
  wbr.is_business_affecting,
  ld.outcome AS last_dispatch_outcome,
  ld.created_at AS last_dispatch_at,
  wbr.created_at,
  wbr.updated_at
FROM public.workflow_binding_registry wbr
LEFT JOIN first_stage fs
  ON fs.binding_key = wbr.binding_key
LEFT JOIN latest_dispatch ld
  ON ld.binding_key = wbr.binding_key;

COMMENT ON VIEW public.workflow_bindings_console_v1 IS
  'Console V2 browser-facing workflow binding projection. Console-registered bindings are mirrored into workflow_binding_registry/stage_registry by register_workflow_binding_v1 so same-context create readback appears without a browser reload.';

REVOKE ALL ON public.workflow_bindings_console_v1 FROM PUBLIC;
REVOKE ALL ON public.workflow_bindings_console_v1 FROM anon;
GRANT SELECT ON public.workflow_bindings_console_v1 TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605231805_workflow_binding_registration_visibility_v1'));
COMMIT;
