-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S04
-- Migration: Generic workflow binding policy substrate v1
-- Date: 2026-03-09
--
-- Purpose:
-- - Add a dynamic ladder-resolved workflow binding policy category.
-- - Add workflow binding registries, dispatch ledger, and audit inventory SSOT.
-- - Add generic binding dispatch/runtime helpers, template clone helpers, and onboarding defaults.
-- - Add generic workflow handlers for dynamic task enqueue and recipient notification.
-- - Seed baseline binding templates and the global workflow binding policy.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091331_workflow_binding_policy_substrate_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Workflow template lineage metadata
-------------------------------------------------------------------------------

ALTER TABLE public.workflow_templates
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.workflow_templates.metadata IS
  'Row-driven template lineage metadata (binding_key/stage_key/source_template_id/source_scope/source_version).';

-------------------------------------------------------------------------------
-- 2) Settings category + schema: workflow_binding_policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'workflow_binding_policy',
  'Dynamic workflow bindings for business-affecting actions; resolves through the scope ladder and binds binding_key/stage_key pairs to workflow templates.',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'workflow_binding_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('version', 'bindings'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'const', 1),
      'bindings', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object(
          'type', 'object',
          'additionalProperties', FALSE,
          'required', jsonb_build_array('stages'),
          'properties', jsonb_build_object(
            'label', jsonb_build_object('type', jsonb_build_array('string', 'null')),
            'description', jsonb_build_object('type', jsonb_build_array('string', 'null')),
            'stages', jsonb_build_object(
              'type', 'object',
              'additionalProperties', jsonb_build_object(
                'type', 'object',
                'additionalProperties', FALSE,
                'required', jsonb_build_array('enabled', 'workflow_template_id'),
                'properties', jsonb_build_object(
                  'enabled', jsonb_build_object('type', 'boolean'),
                  'workflow_template_id', jsonb_build_object(
                    'type', 'string',
                    'pattern', '^[0-9a-fA-F-]{36}$'
                  ),
                  'inline_progress_steps', jsonb_build_object('type', 'integer', 'minimum', 0, 'maximum', 25),
                  'notes', jsonb_build_object('type', jsonb_build_array('string', 'null'))
                )
              )
            )
          )
        )
      )
    )
  ),
  'Dynamic workflow-binding policy. Rows bind business action binding_key/stage_key pairs to workflow templates by scope.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'bindings', jsonb_build_object(
        'customer_shipment_change', jsonb_build_object(
          'label', 'Customer shipment change',
          'stages', jsonb_build_object(
            'request_received', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a101',
              'inline_progress_steps', 1
            ),
            'review_requested', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a102',
              'inline_progress_steps', 1
            ),
            'post_apply', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a103',
              'inline_progress_steps', 1
            ),
            'post_reject', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a104',
              'inline_progress_steps', 1
            )
          )
        ),
        'tenant_signup', jsonb_build_object(
          'label', 'Tenant signup',
          'stages', jsonb_build_object(
            'review_requested', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a105',
              'inline_progress_steps', 1
            )
          )
        ),
        'marketing_lead', jsonb_build_object(
          'label', 'Marketing lead',
          'stages', jsonb_build_object(
            'review_requested', jsonb_build_object(
              'enabled', TRUE,
              'workflow_template_id', '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a106',
              'inline_progress_steps', 1
            )
          )
        )
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

-------------------------------------------------------------------------------
-- 3) Generic registries + dispatch ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_binding_registry (
  binding_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NULL,
  resource_type TEXT NULL,
  actor_surface TEXT NOT NULL,
  entrypoint_type TEXT NOT NULL,
  current_execution_kind TEXT NOT NULL,
  configurability_status TEXT NOT NULL,
  owner TEXT NOT NULL,
  migration_phase TEXT NOT NULL,
  is_business_affecting BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_binding_registry_binding_key_ck CHECK (btrim(binding_key) <> ''),
  CONSTRAINT workflow_binding_registry_entrypoint_type_ck CHECK (
    entrypoint_type IN ('edge', 'rpc', 'ui_command', 'workflow_handler', 'domain_event', 'field_ops')
  ),
  CONSTRAINT workflow_binding_registry_execution_kind_ck CHECK (
    current_execution_kind IN ('workflow_native', 'hybrid_task_backed', 'direct_rpc', 'direct_edge', 'direct_resource_mutation')
  ),
  CONSTRAINT workflow_binding_registry_configurability_ck CHECK (
    configurability_status IN ('workflow_configurable', 'policy_only', 'not_configurable')
  )
);

DROP TRIGGER IF EXISTS trg_workflow_binding_registry_set_updated_at ON public.workflow_binding_registry;
CREATE TRIGGER trg_workflow_binding_registry_set_updated_at
BEFORE UPDATE ON public.workflow_binding_registry
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.workflow_binding_stage_registry (
  binding_key TEXT NOT NULL REFERENCES public.workflow_binding_registry(binding_key) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NULL,
  sequence_order INT NOT NULL DEFAULT 10,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_key, stage_key),
  CONSTRAINT workflow_binding_stage_registry_stage_key_ck CHECK (btrim(stage_key) <> '')
);

DROP TRIGGER IF EXISTS trg_workflow_binding_stage_registry_set_updated_at ON public.workflow_binding_stage_registry;
CREATE TRIGGER trg_workflow_binding_stage_registry_set_updated_at
BEFORE UPDATE ON public.workflow_binding_stage_registry
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.workflow_binding_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  binding_key TEXT NOT NULL REFERENCES public.workflow_binding_registry(binding_key) ON DELETE RESTRICT,
  stage_key TEXT NOT NULL,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  client_id UUID NULL REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID NULL REFERENCES public.senders(id) ON DELETE SET NULL,
  resolved_scope_type TEXT NOT NULL,
  resolved_scope_id UUID NULL,
  resolved_scope_hash UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  settings_id UUID NULL REFERENCES public.settings(id) ON DELETE SET NULL,
  settings_version_id UUID NULL,
  settings_resolution_id UUID NULL,
  workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE RESTRICT,
  workflow_run_id UUID NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  resource_type TEXT NULL,
  resource_id UUID NULL,
  actor_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT NULL,
  source_function TEXT NULL,
  idempotency_key TEXT NULL,
  outcome TEXT NOT NULL DEFAULT 'started',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  inline_progress_result JSONB NULL,
  step_operation_result JSONB NULL,
  CONSTRAINT workflow_binding_dispatches_stage_fk
    FOREIGN KEY (binding_key, stage_key)
    REFERENCES public.workflow_binding_stage_registry(binding_key, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_binding_dispatches_settings_version_fk
    FOREIGN KEY (settings_version_id, resolved_scope_hash)
    REFERENCES public.settings_versions(id, scope_hash),
  CONSTRAINT workflow_binding_dispatches_scope_hash_check CHECK (
    resolved_scope_hash = COALESCE(resolved_scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  CONSTRAINT workflow_binding_dispatches_outcome_ck CHECK (
    outcome IN ('started', 'completed', 'waiting', 'failed')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_idempotency
  ON public.workflow_binding_dispatches (binding_key, stage_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_org_created
  ON public.workflow_binding_dispatches (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_template
  ON public.workflow_binding_dispatches (workflow_template_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_dispatches_run
  ON public.workflow_binding_dispatches (workflow_run_id);

DROP TRIGGER IF EXISTS trg_workflow_binding_dispatches_set_updated_at ON public.workflow_binding_dispatches;
CREATE TRIGGER trg_workflow_binding_dispatches_set_updated_at
BEFORE UPDATE ON public.workflow_binding_dispatches
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.workflow_binding_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_binding_stage_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_binding_dispatches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workflow_binding_registry FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_binding_stage_registry FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_binding_dispatches FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_binding_registry FROM anon;
REVOKE ALL ON TABLE public.workflow_binding_stage_registry FROM anon;
REVOKE ALL ON TABLE public.workflow_binding_dispatches FROM anon;
REVOKE ALL ON TABLE public.workflow_binding_registry FROM authenticated;
REVOKE ALL ON TABLE public.workflow_binding_stage_registry FROM authenticated;
REVOKE ALL ON TABLE public.workflow_binding_dispatches FROM authenticated;

DROP POLICY IF EXISTS workflow_binding_registry_service_policy ON public.workflow_binding_registry;
CREATE POLICY workflow_binding_registry_service_policy
  ON public.workflow_binding_registry
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_binding_stage_registry_service_policy ON public.workflow_binding_stage_registry;
CREATE POLICY workflow_binding_stage_registry_service_policy
  ON public.workflow_binding_stage_registry
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_binding_dispatches_service_policy ON public.workflow_binding_dispatches;
CREATE POLICY workflow_binding_dispatches_service_policy
  ON public.workflow_binding_dispatches
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_binding_registry_authenticated_select ON public.workflow_binding_registry;
CREATE POLICY workflow_binding_registry_authenticated_select
  ON public.workflow_binding_registry
  FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS workflow_binding_stage_registry_authenticated_select ON public.workflow_binding_stage_registry;
CREATE POLICY workflow_binding_stage_registry_authenticated_select
  ON public.workflow_binding_stage_registry
  FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS workflow_binding_dispatches_authenticated_select ON public.workflow_binding_dispatches;
CREATE POLICY workflow_binding_dispatches_authenticated_select
  ON public.workflow_binding_dispatches
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (organization_id IS NOT NULL AND organization_id = public.current_user_org_id())
  );

GRANT SELECT ON public.workflow_binding_registry TO authenticated, service_role;
GRANT SELECT ON public.workflow_binding_stage_registry TO authenticated, service_role;
GRANT SELECT ON public.workflow_binding_dispatches TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_binding_policy_default_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_build_object('version', 1, 'bindings', jsonb_build_object());
$function$;

CREATE OR REPLACE FUNCTION public.workflow_binding_stage_value_v1(
  p_policy JSONB,
  p_binding_key TEXT,
  p_stage_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(
    p_policy #> ARRAY['bindings', lower(NULLIF(btrim(p_binding_key), '')), 'stages', lower(NULLIF(btrim(p_stage_key), ''))],
    NULL
  );
$function$;

CREATE OR REPLACE FUNCTION public.workflow_binding_stage_set_v1(
  p_policy JSONB,
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_stage_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
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

  RETURN jsonb_set(
    v_policy,
    ARRAY['bindings', v_binding_key, 'stages', v_stage_key],
    COALESCE(p_stage_value, '{}'::jsonb),
    TRUE
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.workflow_binding_stage_template_id_v1(
  p_stage JSONB
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_template_id UUID := NULL;
BEGIN
  BEGIN
    v_template_id := NULLIF(COALESCE(p_stage->>'workflow_template_id', ''), '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;
  RETURN v_template_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clone_workflow_template_service_v1(
  p_source_template_id UUID,
  p_target_scope_type TEXT,
  p_target_scope_id UUID,
  p_name TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_target_scope_type, FALSE);
  v_source public.workflow_templates%ROWTYPE;
  v_target_id UUID := NULL;
  v_name TEXT;
  v_existing_steps INT := 0;
BEGIN
  IF p_source_template_id IS NULL THEN
    RAISE EXCEPTION 'clone_workflow_template_service_v1 requires source template id';
  END IF;

  SELECT *
    INTO v_source
    FROM public.workflow_templates wt
   WHERE wt.id = p_source_template_id
   LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'clone_workflow_template_service_v1 source template not found: %', p_source_template_id;
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_name, '')), '');
  IF v_name IS NULL THEN
    v_name := format(
      '%s__%s__%s',
      v_source.name,
      v_scope_type,
      COALESCE(replace(p_target_scope_id::text, '-', ''), 'global')
    );
  END IF;

  INSERT INTO public.workflow_templates (
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    created_by,
    published_at,
    retired_at,
    notes,
    metadata
  )
  VALUES (
    v_name,
    v_source.description,
    v_source.version,
    v_source.status,
    v_scope_type,
    p_target_scope_id,
    NULL,
    v_source.published_at,
    NULL,
    COALESCE(v_source.notes, 'Cloned by workflow binding bootstrap'),
    public.jsonb_deep_merge(
      COALESCE(v_source.metadata, '{}'::jsonb),
      jsonb_strip_nulls(
        jsonb_build_object(
          'source_template_id', v_source.id,
          'source_template_name', v_source.name,
          'source_scope_type', v_source.scope_type,
          'source_scope_id', v_source.scope_id,
          'source_version', v_source.version
        )
      ) || COALESCE(p_metadata, '{}'::jsonb)
    )
  )
  ON CONFLICT (name) DO UPDATE
  SET
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    metadata = EXCLUDED.metadata
  RETURNING id INTO v_target_id;

  SELECT COUNT(*)
    INTO v_existing_steps
    FROM public.workflow_template_steps step
   WHERE step.workflow_template_id = v_target_id;

  IF v_existing_steps = 0 THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      condition_jsonlogic,
      next_operation_name,
      next_operation_priority,
      next_operation_delay_seconds,
      manual_action_required,
      metadata,
      enabled,
      handler_key,
      handler_version
    )
    SELECT
      v_target_id,
      step.sequence_order,
      step.operation_name,
      step.operation_settings_category,
      step.transition_condition,
      step.condition_jsonlogic,
      step.next_operation_name,
      step.next_operation_priority,
      step.next_operation_delay_seconds,
      step.manual_action_required,
      step.metadata,
      step.enabled,
      step.handler_key,
      step.handler_version
    FROM public.workflow_template_steps step
    WHERE step.workflow_template_id = v_source.id
    ORDER BY step.sequence_order ASC;
  END IF;

  RETURN v_target_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_workflow_binding_v1(
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_context JSONB
)
RETURNS TABLE (
  binding_key TEXT,
  stage_key TEXT,
  requested_scope_type TEXT,
  requested_scope_id UUID,
  resolved_scope_type TEXT,
  resolved_scope_id UUID,
  settings_id UUID,
  settings_version_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB,
  stage_value JSONB,
  enabled BOOLEAN,
  inline_progress_steps INT,
  workflow_template_id UUID,
  workflow_template_name TEXT,
  workflow_template_scope_type TEXT,
  workflow_template_scope_id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_binding_key, '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(p_stage_key, '')), ''));
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_requested_scope_type TEXT := NULL;
  v_requested_scope_id UUID := NULL;
  v_row RECORD;
  v_stage JSONB := NULL;
  v_template RECORD;
  v_org_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
BEGIN
  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_binding_stage_registry s
    WHERE s.binding_key = v_binding_key
      AND s.stage_key = v_stage_key
      AND s.is_enabled = TRUE
  ) THEN
    RETURN;
  END IF;

  SELECT scope_type, scope_id
    INTO v_requested_scope_type, v_requested_scope_id
    FROM public.resolve_scope_from_context('workflow_binding_policy', v_context)
   LIMIT 1;

  SELECT *
    INTO v_row
    FROM public.resolve_settings_row('workflow_binding_policy', v_requested_scope_type, v_requested_scope_id)
   LIMIT 1;

  IF v_row.settings_id IS NULL THEN
    RETURN;
  END IF;

  v_stage := public.workflow_binding_stage_value_v1(v_row.value, v_binding_key, v_stage_key);

  BEGIN v_org_id := NULLIF(v_context->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_context->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_context->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  IF v_org_id IS NULL THEN
    v_org_id := public.resolve_organization_id_for_scope_v1(v_requested_scope_type, v_requested_scope_id);
  END IF;

  SELECT
    wt.id,
    wt.name,
    wt.scope_type,
    wt.scope_id
  INTO v_template
  FROM public.workflow_templates wt
  WHERE wt.id = public.workflow_binding_stage_template_id_v1(v_stage)
  LIMIT 1;

  binding_key := v_binding_key;
  stage_key := v_stage_key;
  requested_scope_type := v_requested_scope_type;
  requested_scope_id := v_requested_scope_id;
  resolved_scope_type := v_row.scope_type;
  resolved_scope_id := v_row.scope_id;
  settings_id := v_row.settings_id;
  settings_version_id := v_row.settings_version_id;
  value := v_row.value;
  version := v_row.version;
  scope_path := v_row.scope_path;
  stage_value := v_stage;
  enabled := COALESCE((v_stage->>'enabled')::BOOLEAN, FALSE);
  inline_progress_steps := COALESCE(NULLIF(v_stage->>'inline_progress_steps', '')::INT, 0);
  workflow_template_id := v_template.id;
  workflow_template_name := v_template.name;
  workflow_template_scope_type := v_template.scope_type;
  workflow_template_scope_id := v_template.scope_id;
  organization_id := v_org_id;
  client_id := v_client_id;
  sender_id := v_sender_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_workflow_binding_stage_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'binding_key', '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'stage_key', '')), ''));
  v_context JSONB := COALESCE(v_input->'context', '{}'::jsonb);
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');
  v_source_function TEXT := NULLIF(btrim(COALESCE(v_input->>'source_function', '')), '');
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_resolution RECORD;
  v_settings_resolution_id UUID := NULL;
  v_run_context JSONB;
  v_run_id UUID := NULL;
  v_inline_steps INT := 0;
  v_progress JSONB := '{}'::jsonb;
  v_step_result JSONB := NULL;
  v_existing RECORD;
  v_dispatch_id UUID := NULL;
  v_resource_type TEXT := NULLIF(btrim(COALESCE(v_context->>'resource_type', v_input->>'resource_type', '')), '');
  v_resource_id UUID := NULL;
  v_outcome TEXT := 'started';
  v_decision_id UUID := NULL;
  v_loop INT := 0;
BEGIN
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  BEGIN v_resource_id := NULLIF(COALESCE(v_context->>'resource_id', v_input->>'resource_id', ''), '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;

  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_key_stage_key_required'));
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT *
      INTO v_existing
      FROM public.workflow_binding_dispatches d
     WHERE d.binding_key = v_binding_key
       AND d.stage_key = v_stage_key
       AND d.idempotency_key = v_idempotency_key
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_strip_nulls(
        jsonb_build_object(
          'ok', TRUE,
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'dispatch_id', v_existing.id,
          'workflow_run_id', v_existing.workflow_run_id,
          'workflow_template_id', v_existing.workflow_template_id,
          'outcome', v_existing.outcome,
          'step_operation_result', v_existing.step_operation_result,
          'settings_resolution_id', v_existing.settings_resolution_id,
          'idempotent', TRUE
        )
      );
    END IF;
  END IF;

  SELECT *
    INTO v_resolution
    FROM public.resolve_workflow_binding_v1(v_binding_key, v_stage_key, v_context)
   LIMIT 1;

  IF v_resolution.binding_key IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_not_found'));
  END IF;

  IF COALESCE(v_resolution.enabled, FALSE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_disabled'));
  END IF;

  IF v_resolution.workflow_template_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'workflow_template_missing'));
  END IF;

  IF v_resolution.organization_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_resolution.organization_id,
      p_category := 'workflow_binding_policy',
      p_winning_scope_type := v_resolution.resolved_scope_type,
      p_winning_scope_id := v_resolution.resolved_scope_id,
      p_winning_settings_id := v_resolution.settings_id,
      p_winning_settings_version_id := v_resolution.settings_version_id,
      p_winning_version := v_resolution.version,
      p_scope_path := v_resolution.scope_path,
      p_inputs := jsonb_strip_nulls(
        jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'requested_scope_type', v_resolution.requested_scope_type,
          'requested_scope_id', v_resolution.requested_scope_id,
          'context', v_context
        )
      ),
      p_merge_notes := NULL
    );
  END IF;

  v_inline_steps := GREATEST(COALESCE(v_resolution.inline_progress_steps, 0), 0);

  v_run_context := public.jsonb_deep_merge(
    COALESCE(v_context, '{}'::jsonb),
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_resolution.organization_id,
        'client_id', v_resolution.client_id,
        'sender_id', v_resolution.sender_id,
        'idempotency_key', v_idempotency_key,
        'binding', jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'requested_scope_type', v_resolution.requested_scope_type,
          'requested_scope_id', v_resolution.requested_scope_id,
          'resolved_scope_type', v_resolution.resolved_scope_type,
          'resolved_scope_id', v_resolution.resolved_scope_id,
          'settings_id', v_resolution.settings_id,
          'settings_version_id', v_resolution.settings_version_id,
          'settings_resolution_id', v_settings_resolution_id,
          'stage_config', COALESCE(v_resolution.stage_value, '{}'::jsonb)
        ),
        'trigger_source', COALESCE(v_source_function, format('workflow_binding:%s:%s', v_binding_key, v_stage_key)),
        'actor', jsonb_strip_nulls(
          jsonb_build_object(
            'user_id', v_actor_user_id,
            'system', v_actor_system
          )
        )
      )
    )
  );

  v_run_id := public.start_workflow_run(v_resolution.workflow_template_id, v_run_context);

  IF v_inline_steps > 0 THEN
    v_loop := 0;
    WHILE v_loop < v_inline_steps LOOP
      v_loop := v_loop + 1;
      v_progress := public.progress_workflow_run(v_run_id);
      EXIT WHEN COALESCE(v_progress->>'status', '') IN ('waiting', 'failed', 'completed');
    END LOOP;

    SELECT wrs.operation_result
      INTO v_step_result
      FROM public.workflow_run_steps wrs
     WHERE wrs.workflow_run_id = v_run_id
     ORDER BY wrs.sequence_order DESC, wrs.updated_at DESC
     LIMIT 1;

    IF COALESCE(v_progress->>'status', '') IN ('waiting', 'failed', 'completed', 'in_progress') THEN
      v_outcome := COALESCE(v_progress->>'status', v_outcome, 'started');
    END IF;
  END IF;

  INSERT INTO public.workflow_binding_dispatches (
    binding_key,
    stage_key,
    organization_id,
    client_id,
    sender_id,
    resolved_scope_type,
    resolved_scope_id,
    resolved_scope_hash,
    settings_id,
    settings_version_id,
    settings_resolution_id,
    workflow_template_id,
    workflow_run_id,
    resource_type,
    resource_id,
    actor_user_id,
    actor_system,
    source_function,
    idempotency_key,
    outcome,
    context,
    inline_progress_result,
    step_operation_result
  )
  VALUES (
    v_binding_key,
    v_stage_key,
    v_resolution.organization_id,
    v_resolution.client_id,
    v_resolution.sender_id,
    v_resolution.resolved_scope_type,
    v_resolution.resolved_scope_id,
    COALESCE(v_resolution.resolved_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    v_resolution.settings_id,
    v_resolution.settings_version_id,
    v_settings_resolution_id,
    v_resolution.workflow_template_id,
    v_run_id,
    v_resource_type,
    v_resource_id,
    v_actor_user_id,
    v_actor_system,
    v_source_function,
    v_idempotency_key,
    COALESCE(v_outcome, 'started'),
    v_run_context,
    NULLIF(v_progress, '{}'::jsonb),
    v_step_result
  )
  ON CONFLICT (binding_key, stage_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL
  DO UPDATE
  SET
    updated_at = now(),
    workflow_run_id = EXCLUDED.workflow_run_id,
    workflow_template_id = EXCLUDED.workflow_template_id,
    outcome = EXCLUDED.outcome,
    inline_progress_result = EXCLUDED.inline_progress_result,
    step_operation_result = EXCLUDED.step_operation_result
  RETURNING id INTO v_dispatch_id;

  IF v_resolution.organization_id IS NOT NULL THEN
    v_decision_id := public.log_decision(
      p_organization_id := v_resolution.organization_id,
      p_decision_category := 'workflow_binding',
      p_resource_type := COALESCE(v_resource_type, 'workflow_binding_dispatch'),
      p_resource_id := COALESCE(v_resource_id, v_dispatch_id),
      p_decision_point := 'run_workflow_binding_stage_v1',
      p_decision_outcome := COALESCE(v_outcome, 'started'),
      p_performed_by_system := COALESCE(v_actor_system, 'workflow_binding'),
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(
        jsonb_build_object(
          'binding_key', v_binding_key,
          'stage_key', v_stage_key,
          'dispatch_id', v_dispatch_id,
          'workflow_run_id', v_run_id,
          'workflow_template_id', v_resolution.workflow_template_id
        )
      ),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_settings_resolution_id
    );
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'binding_key', v_binding_key,
      'stage_key', v_stage_key,
      'dispatch_id', v_dispatch_id,
      'workflow_run_id', v_run_id,
      'workflow_template_id', v_resolution.workflow_template_id,
      'settings_resolution_id', v_settings_resolution_id,
      'decision_id', v_decision_id,
      'outcome', COALESCE(v_outcome, 'started'),
      'inline_progress_result', NULLIF(v_progress, '{}'::jsonb),
      'step_operation_result', v_step_result
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Authenticated UI helpers for bindings page
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_list_workflow_bindings_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_effective RECORD;
  v_requested_scope_type TEXT;
  v_requested_scope_id UUID;
  v_effective_policy JSONB;
  v_target_policy JSONB;
  v_rows JSONB := '[]'::jsonb;
  v_row JSONB;
  v_stage JSONB;
  v_item RECORD;
  v_template RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_list_workflow_bindings_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  v_requested_scope_type := v_scope.scope_type;
  v_requested_scope_id := v_scope.scope_id;

  PERFORM public.assert_capability_v1('workflow_runs.read', v_requested_scope_type, v_requested_scope_id);

  SELECT *
    INTO v_effective
    FROM public.resolve_settings_row('workflow_binding_policy', v_requested_scope_type, v_requested_scope_id)
   LIMIT 1;

  v_effective_policy := COALESCE(v_effective.value, public.workflow_binding_policy_default_v1());

  SELECT s.cached_value
    INTO v_target_policy
    FROM public.settings s
   WHERE s.category = 'workflow_binding_policy'
     AND s.scope_type = v_requested_scope_type
     AND s.scope_id IS NOT DISTINCT FROM v_requested_scope_id
   LIMIT 1;

  FOR v_item IN
    SELECT
      r.binding_key,
      r.label AS binding_label,
      r.description AS binding_description,
      s.stage_key,
      s.label AS stage_label,
      s.description AS stage_description,
      s.sequence_order
    FROM public.workflow_binding_registry r
    JOIN public.workflow_binding_stage_registry s
      ON s.binding_key = r.binding_key
    WHERE r.is_business_affecting = TRUE
      AND s.is_enabled = TRUE
    ORDER BY r.binding_key, s.sequence_order, s.stage_key
  LOOP
    v_stage := public.workflow_binding_stage_value_v1(v_effective_policy, v_item.binding_key, v_item.stage_key);
    v_row := jsonb_strip_nulls(
      jsonb_build_object(
        'binding_key', v_item.binding_key,
        'binding_label', v_item.binding_label,
        'binding_description', v_item.binding_description,
        'stage_key', v_item.stage_key,
        'stage_label', v_item.stage_label,
        'stage_description', v_item.stage_description,
        'requested_scope_type', v_requested_scope_type,
        'requested_scope_id', v_requested_scope_id,
        'resolved_scope_type', v_effective.scope_type,
        'resolved_scope_id', v_effective.scope_id,
        'settings_id', v_effective.settings_id,
        'settings_version_id', v_effective.settings_version_id,
        'scope_path', v_effective.scope_path,
        'is_overridden_at_requested_scope',
          CASE
            WHEN v_target_policy IS NULL THEN FALSE
            ELSE public.workflow_binding_stage_value_v1(v_target_policy, v_item.binding_key, v_item.stage_key) IS NOT NULL
          END,
        'stage_value', v_stage
      )
    );

    IF public.workflow_binding_stage_template_id_v1(v_stage) IS NOT NULL THEN
      SELECT
        wt.id,
        wt.name,
        wt.scope_type,
        wt.scope_id,
        wt.status
      INTO v_template
      FROM public.workflow_templates wt
      WHERE wt.id = public.workflow_binding_stage_template_id_v1(v_stage)
      LIMIT 1;

      v_row := v_row || jsonb_strip_nulls(
        jsonb_build_object(
          'workflow_template_id', v_template.id,
          'workflow_template_name', v_template.name,
          'workflow_template_scope_type', v_template.scope_type,
          'workflow_template_scope_id', v_template.scope_id,
          'workflow_template_status', v_template.status
        )
      );
    END IF;

    v_rows := v_rows || jsonb_build_array(v_row);
  END LOOP;

  RETURN jsonb_build_object(
    'scope_type', v_requested_scope_type,
    'scope_id', v_requested_scope_id,
    'items', v_rows
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_workflow_binding_clone_override_v1(
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_effective RECORD;
  v_policy JSONB;
  v_stage JSONB;
  v_target_template_id UUID := NULL;
  v_row RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_workflow_binding_clone_override_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope.scope_type, v_scope.scope_id);

  SELECT *
    INTO v_effective
    FROM public.resolve_workflow_binding_v1(p_binding_key, p_stage_key, jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_scope.organization_id,
        'client_id', v_scope.client_id,
        'sender_id', v_scope.sender_id
      )
    ))
   LIMIT 1;

  IF v_effective.binding_key IS NULL OR v_effective.workflow_template_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'binding_not_found'));
  END IF;

  v_target_template_id := public.clone_workflow_template_service_v1(
    v_effective.workflow_template_id,
    v_scope.scope_type,
    v_scope.scope_id,
    NULL,
    jsonb_build_object(
      'binding_key', lower(btrim(p_binding_key)),
      'stage_key', lower(btrim(p_stage_key)),
      'cloned_for_scope_type', v_scope.scope_type,
      'cloned_for_scope_id', v_scope.scope_id
    )
  );

  v_policy := COALESCE(
    public.resolve_settings('workflow_binding_policy', v_scope.scope_type, v_scope.scope_id),
    public.workflow_binding_policy_default_v1()
  );
  v_stage := COALESCE(v_effective.stage_value, '{}'::jsonb);
  v_stage := public.jsonb_deep_merge(
    COALESCE(v_stage, '{}'::jsonb),
    jsonb_build_object(
      'enabled', TRUE,
      'workflow_template_id', v_target_template_id
    )
  );
  v_policy := public.workflow_binding_stage_set_v1(v_policy, p_binding_key, p_stage_key, v_stage);

  SELECT *
    INTO v_row
    FROM public.upsert_settings_value_v1(
      'workflow_binding_policy',
      v_scope.scope_type,
      v_scope.scope_id,
      v_policy,
      1,
      format('Workflow binding override clone for %s/%s', lower(btrim(p_binding_key)), lower(btrim(p_stage_key)))
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope.scope_type,
    'scope_id', v_scope.scope_id,
    'workflow_template_id', v_target_template_id,
    'settings_id', v_row.settings_id,
    'settings_version_id', v_row.settings_version_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_workflow_binding_reset_override_v1(
  p_binding_key TEXT,
  p_stage_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_scope_path JSONB;
  v_item JSONB;
  v_parent_scope_type TEXT := NULL;
  v_parent_scope_id UUID := NULL;
  v_parent_policy JSONB := public.workflow_binding_policy_default_v1();
  v_target_policy JSONB := public.workflow_binding_policy_default_v1();
  v_parent_stage JSONB := NULL;
  v_row RECORD;
  v_seen_target BOOLEAN := FALSE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_workflow_binding_reset_override_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope.scope_type, v_scope.scope_id);

  v_scope_path := public.resolve_scope_path_v1(v_scope.scope_type, v_scope.scope_id);

  FOR v_item IN
    SELECT elem
    FROM jsonb_array_elements(v_scope_path) AS e(elem)
  LOOP
    IF NOT v_seen_target THEN
      IF (v_item->>'scope_type') = v_scope.scope_type
         AND ((v_item->>'scope_id')::UUID IS NOT DISTINCT FROM v_scope.scope_id) THEN
        v_seen_target := TRUE;
      END IF;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'workflow_binding_policy'
        AND s.scope_type = (v_item->>'scope_type')
        AND s.scope_id IS NOT DISTINCT FROM NULLIF(v_item->>'scope_id', '')::UUID
    ) THEN
      v_parent_scope_type := v_item->>'scope_type';
      BEGIN v_parent_scope_id := NULLIF(v_item->>'scope_id', '')::UUID; EXCEPTION WHEN others THEN v_parent_scope_id := NULL; END;
      EXIT;
    END IF;
  END LOOP;

  IF v_parent_scope_type IS NOT NULL THEN
    v_parent_policy := COALESCE(
      public.resolve_settings('workflow_binding_policy', v_parent_scope_type, v_parent_scope_id),
      public.workflow_binding_policy_default_v1()
    );
  END IF;

  v_parent_stage := COALESCE(
    public.workflow_binding_stage_value_v1(v_parent_policy, p_binding_key, p_stage_key),
    '{}'::jsonb
  );

  v_target_policy := COALESCE(
    public.resolve_settings('workflow_binding_policy', v_scope.scope_type, v_scope.scope_id),
    public.workflow_binding_policy_default_v1()
  );
  v_target_policy := public.workflow_binding_stage_set_v1(v_target_policy, p_binding_key, p_stage_key, v_parent_stage);

  SELECT *
    INTO v_row
    FROM public.upsert_settings_value_v1(
      'workflow_binding_policy',
      v_scope.scope_type,
      v_scope.scope_id,
      v_target_policy,
      1,
      format('Workflow binding reset to parent for %s/%s', lower(btrim(p_binding_key)), lower(btrim(p_stage_key)))
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope.scope_type,
    'scope_id', v_scope.scope_id,
    'parent_scope_type', v_parent_scope_type,
    'parent_scope_id', v_parent_scope_id,
    'settings_id', v_row.settings_id,
    'settings_version_id', v_row.settings_version_id
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Generic handlers for bindings
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_workflow_binding_noop_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
BEGIN
  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_build_object(
    'status', 'noop',
    'workflow_run_id', p_run.id,
    'step_id', p_step.id
  );
  RETURN v_resp;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_dynamic_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload_path TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'task_path', '')), ''),
    '$.context.binding_payload.task'
  );
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'task');
  v_task_json JSONB := NULL;
  v_task_context JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_task_type_key TEXT := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := NULL;
  v_actor_system TEXT := NULL;
  v_task_metadata JSONB := '{}'::jsonb;
  v_created RECORD;
  v_resp public.workflow_handler_response;
BEGIN
  v_task_json := public.safe_jsonpath_query_first(
    jsonb_build_object(
      'context', v_ctx,
      'operation_result', COALESCE(p_operation_result, '{}'::jsonb)
    ),
    v_payload_path
  );

  IF v_task_json IS NULL OR jsonb_typeof(v_task_json) <> 'object' THEN
    RAISE EXCEPTION 'task_enqueue_dynamic: missing object at % (workflow_run_id=% step_id=%)', v_payload_path, p_run.id, p_step.id;
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_task_json->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_dynamic: task_type_key missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  BEGIN v_org_id := NULLIF(COALESCE(v_task_json->>'organization_id', v_ctx->>'organization_id'), '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_dynamic: organization_id missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_task_context := COALESCE(v_task_json->'context', '{}'::jsonb);
  IF jsonb_typeof(v_task_context) <> 'object' THEN
    v_task_context := '{}'::jsonb;
  END IF;
  v_task_context := public.jsonb_deep_merge(
    jsonb_build_object('organization_id', v_org_id),
    v_task_context
  );

  v_resource_type := NULLIF(lower(btrim(COALESCE(v_task_json->>'resource_type', ''))), '');
  BEGIN v_resource_id := NULLIF(btrim(COALESCE(v_task_json->>'resource_id', '')), '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  v_queue_key := NULLIF(btrim(COALESCE(v_task_json->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(btrim(COALESCE(v_task_json->>'priority', '')), '')::INT; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(btrim(COALESCE(v_task_json->>'sla_minutes', '')), '')::INT; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_task_json->>'idempotency_key', '')), ''),
    format('workflow_binding:%s:%s', p_run.id, p_step.id)
  );
  v_actor_system := COALESCE(
    NULLIF(btrim(COALESCE(v_task_json->>'actor_system', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx #>> ARRAY['actor', 'system'], '')), ''),
    'workflow_binding'
  );
  v_task_metadata := COALESCE(v_task_json->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_task_metadata) <> 'object' THEN
    v_task_metadata := '{}'::jsonb;
  END IF;
  v_task_metadata := public.jsonb_deep_merge(
    v_task_metadata,
    jsonb_strip_nulls(
      jsonb_build_object(
        'parent_workflow_run_id', p_run.id,
        'parent_workflow_step_id', p_step.id,
        'binding', v_ctx->'binding'
      )
    )
  );

  SELECT *
    INTO v_created
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', v_task_context,
          'resource_type', v_resource_type,
          'resource_id', v_resource_id,
          'queue_key', v_queue_key,
          'priority', v_priority,
          'sla_minutes', v_sla_minutes,
          'idempotency_key', v_idempotency_key,
          'metadata', v_task_metadata,
          'actor_system', v_actor_system
        )
      )
    )
   LIMIT 1;

  IF v_created.task_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_dynamic: create_task_system_v1 returned NULL task_id (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'task_id', v_created.task_id,
      'task_event_id', v_created.task_event_id,
      'workflow_run_id', v_created.workflow_run_id,
      'task_type_key', v_task_type_key,
      'resource_type', v_resource_type,
      'resource_id', v_resource_id
    )
  );
  v_resp.context_patch := jsonb_build_object(v_context_key, v_resp.operation_result);
  RETURN v_resp;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_recipient_notification_dynamic_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload_path TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'notification_path', '')), ''),
    '$.context.binding_payload.notification'
  );
  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'notification');
  v_notification JSONB := NULL;
  v_recipient_id UUID := NULL;
  v_org_id UUID := NULL;
  v_support_case_id UUID := NULL;
  v_channel_mode TEXT := NULL;
  v_channel TEXT := NULL;
  v_call_type TEXT := NULL;
  v_priority INT := 100;
  v_max_retries INT := 3;
  v_message TEXT := NULL;
  v_stage TEXT := NULL;
  v_payload JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_recipient RECORD;
  v_outbound_id UUID := NULL;
  v_resp public.workflow_handler_response;
BEGIN
  v_notification := public.safe_jsonpath_query_first(
    jsonb_build_object(
      'context', v_ctx,
      'operation_result', COALESCE(p_operation_result, '{}'::jsonb)
    ),
    v_payload_path
  );

  IF v_notification IS NULL OR jsonb_typeof(v_notification) <> 'object' THEN
    RAISE EXCEPTION 'recipient_notification_dynamic: missing object at % (workflow_run_id=% step_id=%)', v_payload_path, p_run.id, p_step.id;
  END IF;

  BEGIN v_recipient_id := NULLIF(v_notification->>'recipient_id', '')::UUID; EXCEPTION WHEN others THEN v_recipient_id := NULL; END;
  BEGIN v_org_id := NULLIF(COALESCE(v_notification->>'organization_id', v_ctx->>'organization_id'), '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_notification->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  v_stage := NULLIF(lower(btrim(COALESCE(v_notification->>'stage', ''))), '');
  v_message := NULLIF(btrim(COALESCE(v_notification->>'message', '')), '');
  v_channel_mode := lower(COALESCE(NULLIF(btrim(COALESCE(v_notification->>'channel', '')), ''), 'best_available'));
  BEGIN v_priority := NULLIF(btrim(COALESCE(v_notification->>'priority', '')), '')::INT; EXCEPTION WHEN others THEN v_priority := 100; END;
  BEGIN v_max_retries := NULLIF(btrim(COALESCE(v_notification->>'max_retries', '')), '')::INT; EXCEPTION WHEN others THEN v_max_retries := 3; END;
  v_payload := COALESCE(v_notification->'payload', '{}'::jsonb);
  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  IF v_recipient_id IS NULL OR v_message IS NULL THEN
    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_or_message_missing');
    RETURN v_resp;
  END IF;

  SELECT r.id, NULLIF(btrim(r.email), '') AS email, NULLIF(btrim(r.phone_number), '') AS phone_number
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = v_recipient_id
   LIMIT 1;

  IF v_recipient.id IS NULL THEN
    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_not_found');
    RETURN v_resp;
  END IF;

  IF v_channel_mode = 'sms' THEN
    IF v_recipient.phone_number IS NULL THEN
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_phone_missing');
      RETURN v_resp;
    END IF;
    v_channel := 'sms';
    v_call_type := 'comms_sms';
  ELSIF v_channel_mode = 'email' THEN
    IF v_recipient.email IS NULL THEN
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_email_missing');
      RETURN v_resp;
    END IF;
    v_channel := 'email';
    v_call_type := 'comms_email';
  ELSE
    IF v_recipient.email IS NOT NULL THEN
      v_channel := 'email';
      v_call_type := 'comms_email';
    ELSIF v_recipient.phone_number IS NOT NULL THEN
      v_channel := 'sms';
      v_call_type := 'comms_sms';
    ELSE
      v_resp.status := 'completed';
      v_resp.operation_result := jsonb_build_object('queued', FALSE, 'reason', 'recipient_contact_missing');
      RETURN v_resp;
    END IF;
  END IF;

  v_context := jsonb_strip_nulls(
    jsonb_build_object(
      'source', 'workflow_binding',
      'binding', v_ctx->'binding',
      'support_case_id', v_support_case_id,
      'organization_id', v_org_id,
      'stage', v_stage
    )
  );

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id
  )
  VALUES (
    v_call_type,
    'recipient',
    v_recipient_id,
    'POST',
    format('comms://%s', v_channel),
    '{}'::jsonb,
    jsonb_strip_nulls(
      jsonb_build_object(
        'stage', v_stage,
        'message', v_message,
        'support_case_id', v_support_case_id,
        'payload', v_payload
      )
    ),
    GREATEST(COALESCE(v_priority, 100), 0),
    GREATEST(COALESCE(v_max_retries, 3), 0),
    v_context,
    NULL
  )
  RETURNING id INTO v_outbound_id;

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(
    jsonb_build_object(
      'queued', TRUE,
      'channel', v_channel,
      'outbound_call_id', v_outbound_id
    )
  );
  v_resp.context_patch := jsonb_build_object(v_context_key, v_resp.operation_result);
  RETURN v_resp;
END;
$function$;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES
  (
    'workflow_binding_noop',
    'workflow_handlers',
    'execute_workflow_binding_noop_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'No-op helper for workflow binding stages.',
    'docs/ops/runbooks/workflow-binding-policy.md'
  ),
  (
    'task_enqueue_dynamic',
    'workflow_handlers',
    'execute_task_enqueue_dynamic_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Binding-driven task enqueue handler; reads task routing from workflow context.',
    'docs/ops/runbooks/workflow-binding-policy.md'
  ),
  (
    'recipient_notification_dynamic',
    'workflow_handlers',
    'execute_recipient_notification_dynamic_v1',
    '(workflow_run_steps,workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Binding-driven requester notification handler; chooses email or SMS from workflow context.',
    'docs/ops/runbooks/workflow-binding-policy.md'
  )
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

-------------------------------------------------------------------------------
-- 7) Seed registry rows, baseline templates, and global policy defaults
-------------------------------------------------------------------------------

INSERT INTO public.workflow_binding_registry AS r (
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
)
VALUES
  (
    'customer_shipment_change',
    'Customer shipment change',
    'Public tracking shipment changes with review/apply lifecycle.',
    'shipment',
    'landing|console|portal',
    'rpc',
    'hybrid_task_backed',
    'workflow_configurable',
    'ops',
    'wave_1',
    TRUE
  ),
  (
    'tenant_signup',
    'Tenant signup review',
    'Landing tenant-signup intake with review task routing.',
    'tenant_signup_request',
    'landing|console',
    'edge',
    'hybrid_task_backed',
    'workflow_configurable',
    'growth_ops',
    'wave_2',
    TRUE
  ),
  (
    'marketing_lead',
    'Marketing lead review',
    'Landing marketing lead intake with follow-up task routing.',
    'marketing_lead_request',
    'landing|console',
    'edge',
    'hybrid_task_backed',
    'workflow_configurable',
    'growth_ops',
    'wave_2',
    TRUE
  ),
  (
    'settings_approval',
    'Settings approval',
    'Manual review and approval of scoped settings changes.',
    'settings_version',
    'console|portal',
    'workflow_handler',
    'workflow_native',
    'workflow_configurable',
    'platform',
    'baseline',
    TRUE
  ),
  (
    'domain_event_workflow_launch',
    'Domain event workflow launch',
    'Domain-event driven workflow orchestration and follow-up.',
    'domain_event',
    'worker',
    'domain_event',
    'workflow_native',
    'workflow_configurable',
    'platform',
    'baseline',
    TRUE
  ),
  (
    'geocoding_enrichment',
    'Geocoding enrichment',
    'Address enrichment and geocoding flows executed by workflow handlers.',
    'address',
    'worker',
    'workflow_handler',
    'workflow_native',
    'workflow_configurable',
    'platform',
    'baseline',
    TRUE
  ),
  (
    'managed_integration_plugin_route',
    'Managed integration plugin route',
    'Studio-managed inbound routes that must start workflow-safe execution.',
    'api_route',
    'console|worker',
    'edge',
    'workflow_native',
    'workflow_configurable',
    'integrations',
    'baseline',
    TRUE
  ),
  (
    'shipment_mutation_handler',
    'Shipment mutation handler',
    'Canonical shipment mutation handlers invoked by workflows and reviewed actions.',
    'shipment',
    'worker|console|portal',
    'workflow_handler',
    'workflow_native',
    'workflow_configurable',
    'ops',
    'baseline',
    TRUE
  )
ON CONFLICT (binding_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  resource_type = EXCLUDED.resource_type,
  actor_surface = EXCLUDED.actor_surface,
  entrypoint_type = EXCLUDED.entrypoint_type,
  current_execution_kind = EXCLUDED.current_execution_kind,
  configurability_status = EXCLUDED.configurability_status,
  owner = EXCLUDED.owner,
  migration_phase = EXCLUDED.migration_phase,
  is_business_affecting = EXCLUDED.is_business_affecting,
  updated_at = now();

INSERT INTO public.workflow_binding_stage_registry AS s (
  binding_key,
  stage_key,
  label,
  description,
  sequence_order,
  is_enabled
)
VALUES
  ('customer_shipment_change', 'request_received', 'Request received', 'Notify the requester that the shipment change request was received.', 10, TRUE),
  ('customer_shipment_change', 'review_requested', 'Review requested', 'Create an internal review task when a shipment change needs review.', 20, TRUE),
  ('customer_shipment_change', 'post_apply', 'Post apply', 'Notify the requester after a shipment change was applied.', 30, TRUE),
  ('customer_shipment_change', 'post_reject', 'Post reject', 'Notify the requester after a shipment change was rejected.', 40, TRUE),
  ('tenant_signup', 'review_requested', 'Review requested', 'Create an internal signup review task.', 10, TRUE),
  ('marketing_lead', 'review_requested', 'Review requested', 'Create an internal marketing lead follow-up task.', 10, TRUE)
ON CONFLICT (binding_key, stage_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sequence_order = EXCLUDED.sequence_order,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = now();

DO $do$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
BEGIN
  INSERT INTO public.workflow_templates AS wt (
    id,
    name,
    description,
    version,
    status,
    scope_type,
    scope_id,
    created_by,
    created_at,
    published_at,
    notes,
    metadata
  )
  VALUES
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a101',
      'workflow_binding.customer_shipment_change.request_received.global.v1',
      'Default requester received notification for customer shipment changes.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', 'request_received', 'baseline_scope_type', v_root)
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a102',
      'workflow_binding.customer_shipment_change.review_requested.global.v1',
      'Default review-task routing for customer shipment changes.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', 'review_requested', 'baseline_scope_type', v_root)
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a103',
      'workflow_binding.customer_shipment_change.post_apply.global.v1',
      'Default requester applied notification for customer shipment changes.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', 'post_apply', 'baseline_scope_type', v_root)
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a104',
      'workflow_binding.customer_shipment_change.post_reject.global.v1',
      'Default requester rejected notification for customer shipment changes.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'customer_shipment_change', 'stage_key', 'post_reject', 'baseline_scope_type', v_root)
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a105',
      'workflow_binding.tenant_signup.review_requested.global.v1',
      'Default tenant-signup review task routing.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'tenant_signup', 'stage_key', 'review_requested', 'baseline_scope_type', v_root)
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a106',
      'workflow_binding.marketing_lead.review_requested.global.v1',
      'Default marketing-lead review task routing.',
      1,
      'active',
      v_root,
      NULL,
      NULL,
      workflow_now(),
      workflow_now(),
      'Seeded global workflow binding template.',
      jsonb_build_object('binding_key', 'marketing_lead', 'stage_key', 'review_requested', 'baseline_scope_type', v_root)
    )
  ON CONFLICT (id) DO UPDATE
  SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    version = EXCLUDED.version,
    status = EXCLUDED.status,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    published_at = EXCLUDED.published_at,
    notes = EXCLUDED.notes,
    metadata = EXCLUDED.metadata,
    created_at = EXCLUDED.created_at;

  INSERT INTO public.workflow_template_steps AS wts (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  )
  VALUES
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a201',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a101',
      10,
      'binding_request_received_notify',
      'success',
      jsonb_build_object('notification_path', '$.context.binding_payload.notification', 'context_key', 'notification'),
      TRUE,
      'recipient_notification_dynamic',
      'v1'
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a202',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a102',
      10,
      'binding_review_requested_task',
      'success',
      jsonb_build_object('task_path', '$.context.binding_payload.task', 'context_key', 'task'),
      TRUE,
      'task_enqueue_dynamic',
      'v1'
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a203',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a103',
      10,
      'binding_post_apply_notify',
      'success',
      jsonb_build_object('notification_path', '$.context.binding_payload.notification', 'context_key', 'notification'),
      TRUE,
      'recipient_notification_dynamic',
      'v1'
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a204',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a104',
      10,
      'binding_post_reject_notify',
      'success',
      jsonb_build_object('notification_path', '$.context.binding_payload.notification', 'context_key', 'notification'),
      TRUE,
      'recipient_notification_dynamic',
      'v1'
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a205',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a105',
      10,
      'binding_tenant_signup_review_task',
      'success',
      jsonb_build_object('task_path', '$.context.binding_payload.task', 'context_key', 'task'),
      TRUE,
      'task_enqueue_dynamic',
      'v1'
    ),
    (
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a206',
      '8bafaa91-0f93-4a1c-9d3a-f24d0bb6a106',
      10,
      'binding_marketing_lead_review_task',
      'success',
      jsonb_build_object('task_path', '$.context.binding_payload.task', 'context_key', 'task'),
      TRUE,
      'task_enqueue_dynamic',
      'v1'
    )
  ON CONFLICT (id) DO UPDATE
  SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();
END;
$do$;

DO $do$
DECLARE
  v_root TEXT := public.get_root_scope_type_key_v1();
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'workflow_binding_policy'
       AND s.scope_type = v_root
       AND s.scope_id IS NULL
  ) THEN
    PERFORM public.upsert_settings_value_v1(
      'workflow_binding_policy',
      v_root,
      NULL,
      public.workflow_binding_policy_default_v1(),
      1,
      'seed workflow_binding_policy global defaults'
    );
  END IF;
END;
$do$;

-------------------------------------------------------------------------------
-- 8) Tenant onboarding defaults for workflow bindings
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::UUID;
  v_settings_version_id UUID;
  v_value JSONB;
  v_exclude JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RETURN;
  END IF;

  IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
    v_value := '{}'::jsonb;
  END IF;

  IF COALESCE(jsonb_typeof(v_value->'workflow_bindings'), 'null') IS DISTINCT FROM 'object' THEN
    v_value := jsonb_set(v_value, '{workflow_bindings}', '{}'::jsonb, TRUE);
  END IF;
  v_value := jsonb_set(v_value, '{workflow_bindings,clone_defaults_for_tenant}', 'true'::jsonb, TRUE);

  v_exclude := COALESCE(v_value #> ARRAY['materialize_defaults', 'tenant', 'exclude_categories'], '[]'::jsonb);
  IF jsonb_typeof(v_exclude) IS DISTINCT FROM 'array' THEN
    v_exclude := '[]'::jsonb;
  END IF;
  IF NOT (v_exclude ? 'workflow_binding_policy') THEN
    v_exclude := v_exclude || jsonb_build_array('workflow_binding_policy');
  END IF;
  v_value := jsonb_set(v_value, '{materialize_defaults,tenant,exclude_categories}', v_exclude, TRUE);

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = COALESCE(sv.approved_at, workflow_now())
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = workflow_now()
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_hash = v_scope_hash;
END;
$do$;

CREATE OR REPLACE FUNCTION public.resolve_saas_onboarding_policy_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'ensure_global_required_defaults', TRUE,
    'materialize_defaults', jsonb_build_object(
      'tenant', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('saas_onboarding_policy', 'workflow_binding_policy')
      ),
      'client', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      ),
      'sender', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      )
    ),
    'rbac', jsonb_build_object(
      'provision_templates', TRUE,
      'template_keys', jsonb_build_array(
        'ops_admin',
        'finance',
        'agreements_admin',
        'fleet_manager',
        'warehouse_operator',
        'driver'
      )
    ),
    'client_defaults', jsonb_build_object(
      'create_default_sender', TRUE,
      'default_sender_name', 'Default Sender',
      'default_sender_brand_name', NULL
    ),
    'workflow_bindings', jsonb_build_object(
      'clone_defaults_for_tenant', TRUE
    )
  );
  v_resolved JSONB;
BEGIN
  v_resolved := public.resolve_settings('saas_onboarding_policy', public.get_root_scope_type_key_v1(), NULL);
  IF v_resolved IS NULL OR jsonb_typeof(v_resolved) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_resolved);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_workflow_binding_defaults_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_source_policy JSONB;
  v_target_policy JSONB := jsonb_build_object('version', 1, 'bindings', jsonb_build_object());
  v_source_row RECORD;
  v_binding RECORD;
  v_stage RECORD;
  v_stage_value JSONB;
  v_source_template_id UUID := NULL;
  v_target_template_id UUID := NULL;
  v_seeded JSONB := '[]'::jsonb;
  v_upserted RECORD;
  v_enabled BOOLEAN;
  v_trigger_source TEXT := COALESCE(NULLIF(btrim(COALESCE(p_trigger_source, '')), ''), 'manual');
BEGIN
  IF v_scope_type <> 'tenant' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'seeded', FALSE,
      'reason', 'clone_defaults_for_tenant_only'
    );
  END IF;

  IF p_scope_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_workflow_binding_defaults_v1 requires non-NULL scope_id for %', v_scope_type;
  END IF;

  v_enabled := public.onboarding_policy_bool_v1(
    public.resolve_saas_onboarding_policy_v1(),
    ARRAY['workflow_bindings', 'clone_defaults_for_tenant'],
    TRUE
  );

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'seeded', FALSE,
      'reason', 'disabled_by_policy'
    );
  END IF;

  SELECT *
    INTO v_source_row
    FROM public.resolve_settings_row('workflow_binding_policy', public.get_root_scope_type_key_v1(), NULL)
   LIMIT 1;

  v_source_policy := COALESCE(v_source_row.value, public.workflow_binding_policy_default_v1());

  FOR v_binding IN
    SELECT key, value
      FROM jsonb_each(COALESCE(v_source_policy->'bindings', '{}'::jsonb))
  LOOP
    IF jsonb_typeof(v_binding.value) <> 'object' THEN
      CONTINUE;
    END IF;

    v_target_policy := public.jsonb_deep_merge(
      v_target_policy,
      jsonb_build_object(
        'bindings',
        jsonb_build_object(
          v_binding.key,
          jsonb_strip_nulls(
            jsonb_build_object(
              'label', NULLIF(btrim(COALESCE(v_binding.value->>'label', '')), ''),
              'description', NULLIF(btrim(COALESCE(v_binding.value->>'description', '')), '')
            )
          )
        )
      )
    );

    FOR v_stage IN
      SELECT key, value
        FROM jsonb_each(COALESCE(v_binding.value->'stages', '{}'::jsonb))
    LOOP
      IF jsonb_typeof(v_stage.value) <> 'object' THEN
        CONTINUE;
      END IF;

      v_stage_value := v_stage.value;
      BEGIN
        v_source_template_id := public.workflow_binding_stage_template_id_v1(v_stage_value);
      EXCEPTION
        WHEN others THEN
          v_source_template_id := NULL;
      END;

      IF v_source_template_id IS NOT NULL THEN
        v_target_template_id := public.clone_workflow_template_service_v1(
          v_source_template_id,
          v_scope_type,
          p_scope_id,
          NULL,
          jsonb_build_object(
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'bootstrap_scope_type', v_scope_type,
            'bootstrap_scope_id', p_scope_id
          )
        );
        v_stage_value := public.jsonb_deep_merge(
          v_stage_value,
          jsonb_build_object('workflow_template_id', v_target_template_id::TEXT)
        );
      END IF;

      v_target_policy := public.workflow_binding_stage_set_v1(
        v_target_policy,
        v_binding.key,
        v_stage.key,
        v_stage_value
      );

      v_seeded := v_seeded || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'workflow_template_id', v_target_template_id
          )
        )
      );
    END LOOP;
  END LOOP;

  SELECT *
    INTO v_upserted
    FROM public.upsert_settings_value_v1(
      'workflow_binding_policy',
      v_scope_type,
      p_scope_id,
      v_target_policy,
      1,
      format('Workflow binding bootstrap (%s) for %s/%s', v_trigger_source, v_scope_type, p_scope_id)
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'settings_id', v_upserted.settings_id,
    'settings_version_id', v_upserted.settings_version_id,
    'seeded_bindings', v_seeded
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_onboarding_v1(
  p_organization_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_ensure_globals BOOLEAN;
  v_provision_templates BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_globals_result JSONB := '{}'::jsonb;
  v_binding_result JSONB := '{}'::jsonb;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
  v_template TEXT;
  v_provisioned JSONB := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_ensure_globals := public.onboarding_policy_bool_v1(v_policy, ARRAY['ensure_global_required_defaults'], TRUE);
  IF v_ensure_globals THEN
    v_globals_result := public.ensure_required_global_defaults_v1();
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('tenant', p_organization_id, v_policy, p_trigger_source);
  v_binding_result := public.bootstrap_workflow_binding_defaults_v1('tenant', p_organization_id, p_trigger_source);

  v_provision_templates := public.onboarding_policy_bool_v1(v_policy, ARRAY['rbac', 'provision_templates'], TRUE);
  IF v_provision_templates THEN
    v_template_keys_json := COALESCE(v_policy #> ARRAY['rbac', 'template_keys'], '[]'::jsonb);
    IF jsonb_typeof(v_template_keys_json) <> 'array' THEN
      v_template_keys_json := '[]'::jsonb;
    END IF;

    SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
      INTO v_template_keys
      FROM jsonb_array_elements_text(v_template_keys_json);

    IF array_length(v_template_keys, 1) IS NOT NULL THEN
      PERFORM public.provision_rbac_roles_from_templates_v1(
        p_organization_id,
        v_template_keys,
        NULL
      );

      FOREACH v_template IN ARRAY v_template_keys LOOP
        v_provisioned := v_provisioned || jsonb_build_array(v_template);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'workflow_bindings', v_binding_result,
    'rbac_templates_provisioned', v_provisioned
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 9) Business-action inventory SSOT + grants
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.workflow_business_action_inventory_v1 AS
SELECT
  r.binding_key AS id,
  r.binding_key,
  r.label,
  r.description,
  r.resource_type,
  r.actor_surface,
  r.entrypoint_type,
  r.current_execution_kind,
  r.configurability_status,
  r.owner,
  r.migration_phase,
  r.is_business_affecting,
  COUNT(s.stage_key)::INT AS registered_stage_count,
  COUNT(*) FILTER (WHERE s.is_enabled IS TRUE)::INT AS enabled_stage_count
FROM public.workflow_binding_registry r
LEFT JOIN public.workflow_binding_stage_registry s
  ON s.binding_key = r.binding_key
GROUP BY
  r.binding_key,
  r.label,
  r.description,
  r.resource_type,
  r.actor_surface,
  r.entrypoint_type,
  r.current_execution_kind,
  r.configurability_status,
  r.owner,
  r.migration_phase,
  r.is_business_affecting;

REVOKE ALL ON FUNCTION public.resolve_workflow_binding_v1(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_workflow_binding_stage_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_workflow_bindings_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_workflow_binding_defaults_v1(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_workflow_binding_v1(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_workflow_binding_stage_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_list_workflow_bindings_v1(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_workflow_binding_clone_override_v1(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_workflow_binding_reset_override_v1(TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_workflow_binding_defaults_v1(TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON TABLE public.workflow_business_action_inventory_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_business_action_inventory_v1 FROM anon;
REVOKE ALL ON TABLE public.workflow_business_action_inventory_v1 FROM authenticated;
GRANT SELECT ON public.workflow_business_action_inventory_v1 TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603091331_workflow_binding_policy_substrate_v1'));
COMMIT;
