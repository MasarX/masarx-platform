-- Plan: PLAN-202604-onboarding-readiness-plugin-baseline-closure / Step: S04
-- Migration: Onboarding readiness + plugin baseline automation v1
-- Date: 2026-04-16
--
-- Purpose:
-- - Extend SaaS onboarding policy with baseline workflow/plugin profiles.
-- - Auto-install baseline integration plugins through the canonical lifecycle.
-- - Expose a readiness snapshot for Console/Portal without SQL inspection.
-- - Keep onboarding fail-closed on required baseline drift while allowing
--   pending-credential plugins to stay operator-assisted and visible.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604161915_onboarding_readiness_plugin_baseline_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Shared helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_role_is_service_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_role_setting TEXT := lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), ''));
  v_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
  v_claims JSONB := NULL;
  v_claim_role TEXT := NULL;
BEGIN
  IF v_role_setting = 'service_role' THEN
    RETURN TRUE;
  END IF;

  IF v_role = 'service_role' THEN
    RETURN TRUE;
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_claim_role := lower(NULLIF(btrim(COALESCE(v_claims->>'role', '')), ''));

  IF v_claim_role = 'service_role' THEN
    RETURN TRUE;
  END IF;

  IF (v_role_setting IS NOT NULL AND v_role_setting <> 'none')
     OR v_role IS NOT NULL
     OR v_claim_role IS NOT NULL THEN
    RETURN FALSE;
  END IF;

  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.onboarding_integration_plugin_task_idempotency_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_plugin_key TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT format(
    'integration_plugin_credentials:%s:%s:%s',
    public.normalize_scope_type_v1(p_scope_type, FALSE),
    COALESCE(p_scope_id::text, 'global'),
    lower(NULLIF(btrim(COALESCE(p_plugin_key, '')), ''))
  );
$function$;

-------------------------------------------------------------------------------
-- 2) Canonical baseline table
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.onboarding_integration_plugin_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  plugin_key TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  description TEXT NULL,
  plugin_kind TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  activation_mode TEXT NOT NULL,
  validation_pack JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_template_key TEXT NULL,
  task_queue_key TEXT NULL,
  task_priority INT NULL,
  task_sla_minutes INT NULL,
  source_type TEXT NOT NULL DEFAULT 'onboarding_baseline',
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  inbound_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapping_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_binding JSONB NOT NULL DEFAULT '{}'::jsonb,
  outbound_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_integration_plugin_defaults_profile_ck
    CHECK (btrim(profile_key) <> ''),
  CONSTRAINT onboarding_integration_plugin_defaults_scope_ck
    CHECK (btrim(scope_type) <> '' AND scope_type = lower(scope_type)),
  CONSTRAINT onboarding_integration_plugin_defaults_plugin_key_ck
    CHECK (btrim(plugin_key) <> ''),
  CONSTRAINT onboarding_integration_plugin_defaults_plugin_name_ck
    CHECK (btrim(plugin_name) <> ''),
  CONSTRAINT onboarding_integration_plugin_defaults_plugin_kind_ck
    CHECK (btrim(plugin_kind) <> '' AND plugin_kind = lower(plugin_kind)),
  CONSTRAINT onboarding_integration_plugin_defaults_task_template_ck
    CHECK (
      (activation_mode = 'auto_activate' AND task_template_key IS NULL)
      OR (
        activation_mode = 'auto_install_pending_credentials'
        AND NULLIF(btrim(COALESCE(task_template_key, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT onboarding_integration_plugin_defaults_priority_ck
    CHECK (task_priority IS NULL OR task_priority >= 0),
  CONSTRAINT onboarding_integration_plugin_defaults_sla_ck
    CHECK (task_sla_minutes IS NULL OR task_sla_minutes > 0),
  CONSTRAINT onboarding_integration_plugin_defaults_unique
    UNIQUE (profile_key, scope_type, plugin_key)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_integration_plugin_defaults_profile_scope
  ON public.onboarding_integration_plugin_defaults(profile_key, scope_type, enabled);

DROP TRIGGER IF EXISTS trg_onboarding_integration_plugin_defaults_set_updated_at
  ON public.onboarding_integration_plugin_defaults;
CREATE TRIGGER trg_onboarding_integration_plugin_defaults_set_updated_at
BEFORE UPDATE ON public.onboarding_integration_plugin_defaults
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.onboarding_integration_plugin_defaults ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.onboarding_integration_plugin_defaults FROM PUBLIC;
REVOKE ALL ON TABLE public.onboarding_integration_plugin_defaults FROM anon;
REVOKE ALL ON TABLE public.onboarding_integration_plugin_defaults FROM authenticated;

DROP POLICY IF EXISTS onboarding_integration_plugin_defaults_service_policy
  ON public.onboarding_integration_plugin_defaults;
CREATE POLICY onboarding_integration_plugin_defaults_service_policy
  ON public.onboarding_integration_plugin_defaults
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.onboarding_integration_plugin_defaults
  TO service_role;

COMMENT ON TABLE public.onboarding_integration_plugin_defaults IS
  'Canonical baseline plugin defaults applied during onboarding by profile/scope.';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'onboarding_integration_plugin_activation_mode',
  'Activation mode for onboarding baseline integration plugins.',
  'operations',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
JOIN (
  VALUES
    (
      'auto_activate',
      'Auto Activate',
      'Install automatically and require healthy activation before day-1 operations.',
      10,
      TRUE,
      '{"requires_credentials_task":false}'
    ),
    (
      'auto_install_pending_credentials',
      'Pending Credentials',
      'Install automatically but surface as pending until credentials are supplied.',
      20,
      FALSE,
      '{"requires_credentials_task":true}'
    )
) AS v(value, label, description, sort_order, is_default, metadata)
  ON TRUE
WHERE ld.category = 'onboarding_integration_plugin_activation_mode'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category
)
VALUES (
  'public',
  'onboarding_integration_plugin_defaults',
  'activation_mode',
  'onboarding_integration_plugin_activation_mode'
)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

SELECT public.apply_lookup_column_contracts('public');

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'onboarding_integration_plugin_defaults',
  TRUE,
  TRUE,
  TRUE,
  'Row-driven onboarding baseline plugin defaults applied automatically by onboarding policy.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT *
FROM public.apply_table_contracts('public');

SELECT *
FROM public.ensure_audit_triggers();

INSERT INTO public.onboarding_integration_plugin_defaults (
  profile_key,
  scope_type,
  plugin_key,
  plugin_name,
  description,
  plugin_kind,
  required,
  activation_mode,
  validation_pack,
  source_type,
  source_payload,
  inbound_config,
  mapping_config,
  workflow_binding,
  outbound_operations,
  metadata,
  enabled
)
VALUES (
  'default',
  'tenant',
  'default-shipment-webhook-intake',
  'Default Shipment Webhook Intake',
  'Baseline webhook intake plugin for onboarding; activates the canonical webhook intake workflow without manual Plugin Studio setup.',
  'webhook',
  TRUE,
  'auto_activate',
  jsonb_build_object('allow_external_side_effects', FALSE),
  'manual',
  jsonb_build_object(
    'baseline_profile', 'default',
    'managed_by', 'onboarding_default'
  ),
  jsonb_build_object(
    'webhook', jsonb_build_object(
      'name', 'Default Shipment Webhook Intake'
    )
  ),
  '{}'::jsonb,
  jsonb_build_object('template_name', 'webhook_intake_v1'),
  '[]'::jsonb,
  jsonb_build_object(
    'baseline_profile', 'default',
    'required', TRUE,
    'activation_mode', 'auto_activate'
  ),
  TRUE
)
ON CONFLICT (profile_key, scope_type, plugin_key) DO UPDATE
SET
  plugin_name = EXCLUDED.plugin_name,
  description = EXCLUDED.description,
  plugin_kind = EXCLUDED.plugin_kind,
  required = EXCLUDED.required,
  activation_mode = EXCLUDED.activation_mode,
  validation_pack = EXCLUDED.validation_pack,
  source_type = EXCLUDED.source_type,
  source_payload = EXCLUDED.source_payload,
  inbound_config = EXCLUDED.inbound_config,
  mapping_config = EXCLUDED.mapping_config,
  workflow_binding = EXCLUDED.workflow_binding,
  outbound_operations = EXCLUDED.outbound_operations,
  metadata = EXCLUDED.metadata,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-------------------------------------------------------------------------------
-- 3) Extend task_type_catalog with pending-credentials follow-up
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
  v_task_types JSONB;
  v_item JSONB := jsonb_build_object(
    'key', 'integration_plugin_credentials',
    'name', 'Integration Plugin Credentials',
    'description', 'Complete credential handoff for onboarding-installed integration plugins that cannot auto-activate yet.',
    'default_priority', 45,
    'default_queue_key', 'integration_plugin_credentials',
    'enabled', TRUE
  );
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'task_type_catalog global settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_task_types) AS item(value)
     WHERE lower(NULLIF(btrim(COALESCE(item.value->>'key', '')), '')) = 'integration_plugin_credentials'
  ) THEN
    v_task_types := v_task_types || jsonb_build_array(v_item);
  END IF;

  v_value := jsonb_set(COALESCE(v_value, '{}'::jsonb), '{task_types}', v_task_types, TRUE);
  IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{version}', to_jsonb(1), TRUE);
  END IF;

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = now()
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = now()
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash;
END;
$do$;

-------------------------------------------------------------------------------
-- 4) Extend onboarding policy schema + defaults
-------------------------------------------------------------------------------

UPDATE public.schema_registry
   SET schema = jsonb_set(
         jsonb_set(
           COALESCE(schema, '{}'::jsonb),
           '{properties,workflow_bindings}',
           jsonb_build_object(
             'type', 'object',
             'additionalProperties', TRUE,
             'properties', jsonb_build_object(
               'clone_defaults_for_tenant', jsonb_build_object('type', 'boolean'),
               'baseline_profile', jsonb_build_object('type', 'string')
             )
           ),
           TRUE
         ),
         '{properties,integration_plugins}',
         jsonb_build_object(
           'type', 'object',
           'additionalProperties', TRUE,
           'properties', jsonb_build_object(
             'baseline_profile', jsonb_build_object('type', 'string')
           )
         ),
         TRUE
       ),
       examples = (
         SELECT jsonb_agg(
           CASE
             WHEN ordinality = 1 THEN
               public.jsonb_deep_merge(
                 example,
                 jsonb_build_object(
                   'workflow_bindings', jsonb_build_object(
                     'clone_defaults_for_tenant', TRUE,
                     'baseline_profile', 'default'
                   ),
                   'integration_plugins', jsonb_build_object(
                     'baseline_profile', 'default'
                   )
                 )
               )
             ELSE example
           END
           ORDER BY ordinality
         )
         FROM jsonb_array_elements(COALESCE(examples, '[]'::jsonb)) WITH ORDINALITY AS t(example, ordinality)
       ),
       updated_at = now()
 WHERE category = 'saas_onboarding_policy'
   AND version = 1
   AND is_active = TRUE;

DO $do$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_patch JSONB := jsonb_build_object(
    'workflow_bindings', jsonb_build_object(
      'clone_defaults_for_tenant', TRUE,
      'baseline_profile', 'default'
    ),
    'integration_plugins', jsonb_build_object(
      'baseline_profile', 'default'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  v_next := public.jsonb_deep_merge(COALESCE(v_current, '{}'::jsonb), v_patch);

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    public.get_root_scope_type_key_v1(),
    NULL,
    v_next,
    1,
    'Extend onboarding policy with workflow/plugin baseline profiles'
  );
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
        'strict_required_coverage', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('saas_onboarding_policy', 'workflow_binding_policy')
      ),
      'client', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'strict_required_coverage', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('workflow_binding_policy')
      ),
      'sender', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'strict_required_coverage', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('workflow_binding_policy')
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
      'clone_defaults_for_tenant', TRUE,
      'baseline_profile', 'default'
    ),
    'integration_plugins', jsonb_build_object(
      'baseline_profile', 'default'
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

-------------------------------------------------------------------------------
-- 5) Service-role capability seam + plugin draft support
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_capability_v1(
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_eval JSONB;
BEGIN
  IF public.request_role_is_service_v1() THEN
    RETURN;
  END IF;

  v_eval := public.user_capability_eval_v1(p_capability_key, p_scope_type, p_scope_id);
  IF COALESCE((v_eval->>'allowed')::BOOLEAN, FALSE) = FALSE THEN
    RAISE EXCEPTION 'Capability denied: %', p_capability_key
      USING ERRCODE = '42501',
            DETAIL = v_eval::text;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_generate_draft_v1(
  p_plugin_name TEXT,
  p_plugin_kind TEXT,
  p_source_type TEXT DEFAULT 'manual',
  p_source_payload JSONB DEFAULT '{}'::jsonb,
  p_inbound_config JSONB DEFAULT '{}'::jsonb,
  p_mapping_config JSONB DEFAULT '{}'::jsonb,
  p_workflow_binding JSONB DEFAULT '{}'::jsonb,
  p_outbound_operations JSONB DEFAULT '[]'::jsonb,
  p_plugin_id UUID DEFAULT NULL,
  p_plugin_key TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_organization_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_org_id UUID;
  v_plugin public.integration_plugins%ROWTYPE;
  v_plugin_id UUID;
  v_plugin_key TEXT;
  v_version_no INTEGER;
  v_version_id UUID;
  v_counter INT := 1;
BEGIN
  v_org_id := COALESCE(p_organization_id, public.current_user_org_id());

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires tenant organization context';
  END IF;

  IF NOT v_is_service
     AND NOT public.is_platform_user()
     AND p_organization_id IS NOT NULL
     AND p_organization_id <> public.current_user_org_id()
  THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 cannot create drafts for another organization';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_org_id);

  IF p_plugin_kind IS NULL OR btrim(p_plugin_kind) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_kind';
  END IF;

  IF p_plugin_name IS NULL OR btrim(p_plugin_name) = '' THEN
    RAISE EXCEPTION 'integration_plugin_generate_draft_v1 requires plugin_name';
  END IF;

  IF p_plugin_id IS NOT NULL THEN
    SELECT *
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.id = p_plugin_id
     LIMIT 1;

    IF v_plugin.id IS NULL THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 plugin % not found', p_plugin_id;
    END IF;

    IF v_plugin.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'integration_plugin_generate_draft_v1 organization mismatch for plugin %', p_plugin_id;
    END IF;

    v_plugin_id := v_plugin.id;
  ELSE
    v_plugin_key := public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name));

    WHILE EXISTS (
      SELECT 1
      FROM public.integration_plugins p
      WHERE p.organization_id = v_org_id
        AND p.plugin_key = v_plugin_key
    ) LOOP
      v_counter := v_counter + 1;
      v_plugin_key := left(
        format('%s-%s', public.integration_plugin_normalize_key_v1(COALESCE(NULLIF(btrim(p_plugin_key), ''), p_plugin_name)), v_counter),
        80
      );
    END LOOP;

    INSERT INTO public.integration_plugins (
      organization_id,
      plugin_key,
      name,
      description,
      plugin_kind,
      status,
      managed_by,
      metadata,
      created_by,
      updated_by
    )
    VALUES (
      v_org_id,
      v_plugin_key,
      btrim(p_plugin_name),
      NULLIF(btrim(COALESCE(p_description, '')), ''),
      lower(btrim(p_plugin_kind)),
      'draft',
      'integration_plugin',
      COALESCE(p_metadata, '{}'::jsonb),
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_plugin_id;
  END IF;

  v_version_no := public.integration_plugin_next_version_no_v1(v_plugin_id);

  INSERT INTO public.integration_plugin_versions (
    plugin_id,
    organization_id,
    version_no,
    status,
    source_type,
    source_payload,
    normalized_contract,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    auth_bindings,
    metadata,
    created_by,
    updated_by
  )
  VALUES (
    v_plugin_id,
    v_org_id,
    v_version_no,
    'draft',
    lower(COALESCE(NULLIF(btrim(p_source_type), ''), 'manual')),
    COALESCE(p_source_payload, '{}'::jsonb),
    COALESCE(p_source_payload, '{}'::jsonb),
    COALESCE(p_inbound_config, '{}'::jsonb),
    COALESCE(p_mapping_config, '{}'::jsonb),
    COALESCE(p_workflow_binding, '{}'::jsonb),
    COALESCE(p_outbound_operations, '[]'::jsonb),
    '{}'::jsonb,
    COALESCE(p_metadata, '{}'::jsonb),
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_version_id;

  UPDATE public.integration_plugins
     SET status = 'draft',
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = v_plugin_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin_id,
    'version_id', v_version_id,
    'version_no', v_version_no,
    'organization_id', v_org_id
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Workflow bootstrap patch: report baseline profile
-------------------------------------------------------------------------------

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
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['workflow_bindings', 'baseline_profile']), ''),
    'default'
  );
BEGIN
  IF v_scope_type <> 'tenant' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'baseline_profile', v_baseline_profile,
      'seeded', FALSE,
      'reason', 'clone_defaults_for_tenant_only'
    );
  END IF;

  IF p_scope_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_workflow_binding_defaults_v1 requires non-NULL scope_id for %', v_scope_type;
  END IF;

  v_enabled := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['workflow_bindings', 'clone_defaults_for_tenant'],
    TRUE
  );

  IF NOT v_enabled THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'baseline_profile', v_baseline_profile,
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
            'bootstrap_scope_id', p_scope_id,
            'baseline_profile', v_baseline_profile
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
    'baseline_profile', v_baseline_profile,
    'settings_id', v_upserted.settings_id,
    'settings_version_id', v_upserted.settings_version_id,
    'seeded_bindings', v_seeded
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 7) Plugin baseline bootstrap
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bootstrap_integration_plugin_defaults_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_actor_context TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_scope_id UUID := p_scope_id;
  v_org_id UUID := public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id);
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
    'default'
  );
  v_actor_context TEXT := COALESCE(NULLIF(btrim(COALESCE(p_actor_context, '')), ''), 'manual');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_claims JSONB := NULL;
  v_service_claims JSONB := '{}'::jsonb;
  v_default RECORD;
  v_plugin public.integration_plugins%ROWTYPE;
  v_effective_version public.integration_plugin_versions%ROWTYPE;
  v_result JSONB;
  v_items JSONB := '[]'::jsonb;
  v_findings JSONB := '[]'::jsonb;
  v_plugin_id UUID;
  v_version_id UUID;
  v_binding_count INT := 0;
  v_task_exists BOOLEAN := FALSE;
  v_task_idempotency_key TEXT;
  v_drift BOOLEAN;
  v_item_status TEXT;
  v_blocking_count INT := 0;
  v_pending_count INT := 0;
BEGIN
  IF v_scope_type <> public.get_root_scope_type_key_v1() AND v_scope_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_integration_plugin_defaults_v1 requires non-NULL scope_id for %', v_scope_type;
  END IF;

  IF v_scope_type <> public.get_root_scope_type_key_v1() AND v_org_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_integration_plugin_defaults_v1 could not resolve organization for %/%', v_scope_type, v_scope_id;
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := v_service_claims || jsonb_build_object('role', 'service_role');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  BEGIN
    FOR v_default IN
      SELECT *
      FROM public.onboarding_integration_plugin_defaults d
      WHERE d.enabled = TRUE
        AND d.profile_key = v_baseline_profile
        AND d.scope_type = v_scope_type
      ORDER BY d.plugin_key
    LOOP
      v_plugin := NULL;
      v_effective_version := NULL;
      v_plugin_id := NULL;
      v_version_id := NULL;
      v_binding_count := 0;
      v_task_exists := FALSE;
      v_drift := FALSE;
      v_item_status := 'blocked';
      v_task_idempotency_key := public.onboarding_integration_plugin_task_idempotency_v1(
        v_scope_type,
        v_scope_id,
        v_default.plugin_key
      );

      SELECT *
        INTO v_plugin
        FROM public.integration_plugins p
       WHERE p.organization_id = v_org_id
         AND p.plugin_key = v_default.plugin_key
       LIMIT 1;

      IF v_plugin.id IS NULL THEN
        v_result := public.integration_plugin_generate_draft_v1(
          p_plugin_name => v_default.plugin_name,
          p_plugin_kind => v_default.plugin_kind,
          p_source_type => v_default.source_type,
          p_source_payload => COALESCE(v_default.source_payload, '{}'::jsonb),
          p_inbound_config => COALESCE(v_default.inbound_config, '{}'::jsonb),
          p_mapping_config => COALESCE(v_default.mapping_config, '{}'::jsonb),
          p_workflow_binding => COALESCE(v_default.workflow_binding, '{}'::jsonb),
          p_outbound_operations => COALESCE(v_default.outbound_operations, '[]'::jsonb),
          p_plugin_key => v_default.plugin_key,
          p_description => v_default.description,
          p_organization_id => v_org_id,
          p_metadata => public.jsonb_deep_merge(
            COALESCE(v_default.metadata, '{}'::jsonb),
            jsonb_build_object(
              'baseline_profile', v_baseline_profile,
              'required', v_default.required,
              'activation_mode', v_default.activation_mode,
              'managed_by', 'onboarding_default',
              'scope_type', v_scope_type,
              'scope_id', v_scope_id,
              'actor_context', v_actor_context
            )
          )
        );

        v_plugin_id := NULLIF(v_result->>'plugin_id', '')::uuid;
        v_version_id := NULLIF(v_result->>'version_id', '')::uuid;

        SELECT * INTO v_plugin
        FROM public.integration_plugins p
        WHERE p.id = v_plugin_id
        LIMIT 1;
      END IF;

      IF v_plugin.id IS NOT NULL THEN
        SELECT *
          INTO v_effective_version
          FROM public.integration_plugin_versions v
         WHERE v.id = COALESCE(v_plugin.active_version_id, (
           SELECT latest.id
           FROM public.integration_plugin_versions latest
           WHERE latest.plugin_id = v_plugin.id
           ORDER BY latest.version_no DESC, latest.created_at DESC, latest.id DESC
           LIMIT 1
         ))
         LIMIT 1;

        v_plugin_id := v_plugin.id;
        v_version_id := v_effective_version.id;

        v_drift := (
          lower(COALESCE(v_plugin.plugin_kind, '')) <> lower(COALESCE(v_default.plugin_kind, ''))
          OR lower(COALESCE(v_effective_version.source_type, '')) <> lower(COALESCE(v_default.source_type, ''))
          OR COALESCE(v_effective_version.source_payload, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.source_payload, '{}'::jsonb)
          OR COALESCE(v_effective_version.inbound_config, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.inbound_config, '{}'::jsonb)
          OR COALESCE(v_effective_version.mapping_config, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.mapping_config, '{}'::jsonb)
          OR COALESCE(v_effective_version.workflow_binding, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.workflow_binding, '{}'::jsonb)
          OR COALESCE(v_effective_version.outbound_operations, '[]'::jsonb) IS DISTINCT FROM COALESCE(v_default.outbound_operations, '[]'::jsonb)
        );

        IF NOT v_drift AND v_effective_version.id IS NOT NULL THEN
          IF v_effective_version.status IN ('draft', 'rejected') THEN
            PERFORM public.integration_plugin_submit_v1(
              v_effective_version.id,
              format('Onboarding baseline submit (%s/%s)', v_scope_type, COALESCE(v_scope_id::text, 'global'))
            );
          END IF;

          SELECT *
            INTO v_effective_version
            FROM public.integration_plugin_versions v
           WHERE v.id = v_version_id
           LIMIT 1;

          IF v_effective_version.status = 'submitted' THEN
            PERFORM public.integration_plugin_approve_v1(
              v_effective_version.id,
              'approved',
              format('Onboarding baseline approval (%s/%s)', v_scope_type, COALESCE(v_scope_id::text, 'global'))
            );
          END IF;

          SELECT * INTO v_plugin
          FROM public.integration_plugins p
          WHERE p.id = v_plugin_id
          LIMIT 1;

          SELECT *
            INTO v_effective_version
            FROM public.integration_plugin_versions v
           WHERE v.id = COALESCE(v_plugin.active_version_id, v_version_id)
           LIMIT 1;

          IF v_default.activation_mode = 'auto_activate'
             AND v_effective_version.id IS NOT NULL
             AND v_effective_version.status IN ('approved', 'active')
          THEN
            PERFORM public.integration_plugin_activate_v1(
              v_effective_version.id,
              v_scope_type,
              v_scope_id,
              format('Onboarding baseline activation (%s/%s)', v_scope_type, COALESCE(v_scope_id::text, 'global'))
            );

            SELECT * INTO v_plugin
            FROM public.integration_plugins p
            WHERE p.id = v_plugin_id
            LIMIT 1;

            SELECT *
              INTO v_effective_version
              FROM public.integration_plugin_versions v
             WHERE v.id = COALESCE(v_plugin.active_version_id, v_effective_version.id)
             LIMIT 1;
          ELSIF v_default.activation_mode = 'auto_install_pending_credentials'
                AND v_effective_version.id IS NOT NULL
                AND v_effective_version.status IN ('approved', 'active')
          THEN
            PERFORM public.create_task_system_v1(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'task_type_key', v_default.task_template_key,
                  'context', jsonb_build_object(
                    'organization_id', v_org_id,
                    'scope_type', v_scope_type,
                    'scope_id', v_scope_id,
                    'plugin_id', v_plugin.id,
                    'plugin_version_id', v_effective_version.id,
                    'plugin_key', v_default.plugin_key,
                    'baseline_profile', v_baseline_profile
                  ),
                  'resource_type', 'integration_plugins',
                  'resource_id', v_plugin.id,
                  'queue_key', NULLIF(btrim(COALESCE(v_default.task_queue_key, '')), ''),
                  'priority', v_default.task_priority,
                  'sla_minutes', v_default.task_sla_minutes,
                  'idempotency_key', v_task_idempotency_key,
                  'metadata', jsonb_strip_nulls(
                    jsonb_build_object(
                      'plugin_key', v_default.plugin_key,
                      'plugin_version_id', v_effective_version.id,
                      'baseline_profile', v_baseline_profile,
                      'activation_mode', v_default.activation_mode,
                      'task_template_key', v_default.task_template_key
                    )
                  ),
                  'actor_system', 'onboarding_defaults'
                )
              )
            );
          END IF;
        END IF;
      END IF;

      IF v_plugin.id IS NOT NULL AND v_effective_version.id IS NOT NULL THEN
        SELECT COUNT(*)
          INTO v_binding_count
          FROM public.integration_plugin_bindings b
         WHERE b.plugin_version_id = COALESCE(v_plugin.active_version_id, v_effective_version.id)
           AND lower(b.scope_type) = v_scope_type
           AND b.scope_id IS NOT DISTINCT FROM v_scope_id;

        SELECT EXISTS (
          SELECT 1
          FROM public.tasks t
          WHERE t.organization_id = v_org_id
            AND t.idempotency_key = v_task_idempotency_key
        )
          INTO v_task_exists;
      END IF;

      IF v_plugin.id IS NULL THEN
        v_item_status := 'blocked';
        v_findings := v_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'integration_plugins',
            'code', 'plugin_missing',
            'plugin_key', v_default.plugin_key,
            'message', format('Baseline plugin %s is missing.', v_default.plugin_key)
          )
        );
      ELSIF v_drift THEN
        v_item_status := 'blocked';
        v_findings := v_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'integration_plugins',
            'code', 'plugin_contract_drift',
            'plugin_key', v_default.plugin_key,
            'plugin_id', v_plugin.id,
            'message', format('Baseline plugin %s exists but its effective contract drifted from onboarding defaults.', v_default.plugin_key)
          )
        );
      ELSIF v_default.activation_mode = 'auto_activate' THEN
        IF v_plugin.active_version_id IS NOT NULL
           AND v_effective_version.status = 'active'
           AND v_binding_count > 0
           AND COALESCE((v_effective_version.validation_summary->>'ok')::boolean, FALSE)
        THEN
          v_item_status := 'healthy';
        ELSE
          v_item_status := 'blocked';
          v_findings := v_findings || jsonb_build_array(
            jsonb_build_object(
              'severity', 'blocking',
              'component', 'integration_plugins',
              'code', 'plugin_not_active',
              'plugin_key', v_default.plugin_key,
              'plugin_id', v_plugin.id,
              'message', format('Baseline plugin %s did not reach active state for %s/%s.', v_default.plugin_key, v_scope_type, COALESCE(v_scope_id::text, 'global'))
            )
          );
        END IF;
      ELSE
        IF v_effective_version.id IS NOT NULL
           AND v_effective_version.status IN ('approved', 'active')
           AND v_task_exists
        THEN
          v_item_status := 'pending_credentials';
          v_pending_count := v_pending_count + 1;
        ELSE
          v_item_status := 'blocked';
          v_findings := v_findings || jsonb_build_array(
            jsonb_build_object(
              'severity', 'blocking',
              'component', 'integration_plugins',
              'code', 'plugin_pending_credentials_not_task_backed',
              'plugin_key', v_default.plugin_key,
              'plugin_id', v_plugin.id,
              'message', format('Baseline plugin %s did not reach approved pending-credentials state with a follow-up task.', v_default.plugin_key)
            )
          );
        END IF;
      END IF;

      IF v_item_status = 'blocked' AND COALESCE(v_default.required, TRUE) THEN
        v_blocking_count := v_blocking_count + 1;
      END IF;

      v_items := v_items || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'plugin_key', v_default.plugin_key,
            'plugin_name', v_default.plugin_name,
            'scope_type', v_scope_type,
            'scope_id', v_scope_id,
            'required', v_default.required,
            'activation_mode', v_default.activation_mode,
            'baseline_profile', v_baseline_profile,
            'plugin_id', v_plugin.id,
            'plugin_status', v_plugin.status,
            'effective_version_id', v_effective_version.id,
            'effective_version_status', v_effective_version.status,
            'active_version_id', v_plugin.active_version_id,
            'binding_count', v_binding_count,
            'validation_ok', COALESCE((v_effective_version.validation_summary->>'ok')::boolean, FALSE),
            'pending_task_idempotency_key', CASE
              WHEN v_default.activation_mode = 'auto_install_pending_credentials' THEN v_task_idempotency_key
              ELSE NULL
            END,
            'pending_task_exists', CASE
              WHEN v_default.activation_mode = 'auto_install_pending_credentials' THEN v_task_exists
              ELSE NULL
            END,
            'status', v_item_status
          )
        )
      );
    END LOOP;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);

  RETURN jsonb_build_object(
    'ok', v_blocking_count = 0,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_org_id,
    'baseline_profile', v_baseline_profile,
    'items', v_items,
    'pending_credentials_count', v_pending_count,
    'blocking_count', v_blocking_count,
    'blocking_findings', v_findings
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 8) Readiness snapshot + UI/API read path
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.onboarding_integration_plugin_readiness_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_scope_id UUID := p_scope_id;
  v_org_id UUID := public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id);
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
    'default'
  );
  v_default RECORD;
  v_plugin public.integration_plugins%ROWTYPE;
  v_effective_version public.integration_plugin_versions%ROWTYPE;
  v_items JSONB := '[]'::jsonb;
  v_findings JSONB := '[]'::jsonb;
  v_binding_count INT := 0;
  v_task_exists BOOLEAN := FALSE;
  v_task_idempotency_key TEXT;
  v_drift BOOLEAN := FALSE;
  v_item_status TEXT := 'blocked';
  v_blocking_count INT := 0;
  v_pending_count INT := 0;
BEGIN
  FOR v_default IN
    SELECT *
    FROM public.onboarding_integration_plugin_defaults d
    WHERE d.enabled = TRUE
      AND d.profile_key = v_baseline_profile
      AND d.scope_type = v_scope_type
    ORDER BY d.plugin_key
  LOOP
    v_plugin := NULL;
    v_effective_version := NULL;
    v_binding_count := 0;
    v_task_exists := FALSE;
    v_drift := FALSE;
    v_item_status := 'blocked';
    v_task_idempotency_key := public.onboarding_integration_plugin_task_idempotency_v1(
      v_scope_type,
      v_scope_id,
      v_default.plugin_key
    );

    SELECT *
      INTO v_plugin
      FROM public.integration_plugins p
     WHERE p.organization_id = v_org_id
       AND p.plugin_key = v_default.plugin_key
     LIMIT 1;

    IF v_plugin.id IS NOT NULL THEN
      SELECT *
        INTO v_effective_version
        FROM public.integration_plugin_versions v
       WHERE v.id = COALESCE(v_plugin.active_version_id, (
         SELECT latest.id
         FROM public.integration_plugin_versions latest
         WHERE latest.plugin_id = v_plugin.id
         ORDER BY latest.version_no DESC, latest.created_at DESC, latest.id DESC
         LIMIT 1
       ))
       LIMIT 1;

      v_drift := (
        lower(COALESCE(v_plugin.plugin_kind, '')) <> lower(COALESCE(v_default.plugin_kind, ''))
        OR lower(COALESCE(v_effective_version.source_type, '')) <> lower(COALESCE(v_default.source_type, ''))
        OR COALESCE(v_effective_version.source_payload, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.source_payload, '{}'::jsonb)
        OR COALESCE(v_effective_version.inbound_config, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.inbound_config, '{}'::jsonb)
        OR COALESCE(v_effective_version.mapping_config, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.mapping_config, '{}'::jsonb)
        OR COALESCE(v_effective_version.workflow_binding, '{}'::jsonb) IS DISTINCT FROM COALESCE(v_default.workflow_binding, '{}'::jsonb)
        OR COALESCE(v_effective_version.outbound_operations, '[]'::jsonb) IS DISTINCT FROM COALESCE(v_default.outbound_operations, '[]'::jsonb)
      );

      IF v_effective_version.id IS NOT NULL THEN
        SELECT COUNT(*)
          INTO v_binding_count
          FROM public.integration_plugin_bindings b
         WHERE b.plugin_version_id = COALESCE(v_plugin.active_version_id, v_effective_version.id)
           AND lower(b.scope_type) = v_scope_type
           AND b.scope_id IS NOT DISTINCT FROM v_scope_id;

        SELECT EXISTS (
          SELECT 1
          FROM public.tasks t
          WHERE t.organization_id = v_org_id
            AND t.idempotency_key = v_task_idempotency_key
        )
          INTO v_task_exists;
      END IF;
    END IF;

    IF v_plugin.id IS NULL THEN
      v_item_status := 'blocked';
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'integration_plugins',
          'code', 'plugin_missing',
          'plugin_key', v_default.plugin_key,
          'message', format('Baseline plugin %s is missing.', v_default.plugin_key)
        )
      );
    ELSIF v_drift THEN
      v_item_status := 'blocked';
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'integration_plugins',
          'code', 'plugin_contract_drift',
          'plugin_key', v_default.plugin_key,
          'plugin_id', v_plugin.id,
          'message', format('Baseline plugin %s exists but its effective contract drifted from onboarding defaults.', v_default.plugin_key)
        )
      );
    ELSIF v_default.activation_mode = 'auto_activate' THEN
      IF v_plugin.active_version_id IS NOT NULL
         AND v_effective_version.status = 'active'
         AND v_binding_count > 0
         AND COALESCE((v_effective_version.validation_summary->>'ok')::boolean, FALSE)
      THEN
        v_item_status := 'healthy';
      ELSE
        v_item_status := 'blocked';
        v_findings := v_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'integration_plugins',
            'code', 'plugin_not_active',
            'plugin_key', v_default.plugin_key,
            'plugin_id', v_plugin.id,
            'message', format('Baseline plugin %s did not reach active state for %s/%s.', v_default.plugin_key, v_scope_type, COALESCE(v_scope_id::text, 'global'))
          )
        );
      END IF;
    ELSE
      IF v_effective_version.id IS NOT NULL
         AND v_effective_version.status IN ('approved', 'active')
         AND v_task_exists
      THEN
        v_item_status := 'pending_credentials';
        v_pending_count := v_pending_count + 1;
      ELSE
        v_item_status := 'blocked';
        v_findings := v_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'integration_plugins',
            'code', 'plugin_pending_credentials_not_task_backed',
            'plugin_key', v_default.plugin_key,
            'plugin_id', v_plugin.id,
            'message', format('Baseline plugin %s did not reach approved pending-credentials state with a follow-up task.', v_default.plugin_key)
          )
        );
      END IF;
    END IF;

    IF v_item_status = 'blocked' AND COALESCE(v_default.required, TRUE) THEN
      v_blocking_count := v_blocking_count + 1;
    END IF;

    v_items := v_items || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'plugin_key', v_default.plugin_key,
          'plugin_name', v_default.plugin_name,
          'scope_type', v_scope_type,
          'scope_id', v_scope_id,
          'required', v_default.required,
          'activation_mode', v_default.activation_mode,
          'baseline_profile', v_baseline_profile,
          'plugin_id', v_plugin.id,
          'plugin_status', v_plugin.status,
          'effective_version_id', v_effective_version.id,
          'effective_version_status', v_effective_version.status,
          'active_version_id', v_plugin.active_version_id,
          'binding_count', v_binding_count,
          'validation_ok', COALESCE((v_effective_version.validation_summary->>'ok')::boolean, FALSE),
          'pending_task_idempotency_key', CASE
            WHEN v_default.activation_mode = 'auto_install_pending_credentials' THEN v_task_idempotency_key
            ELSE NULL
          END,
          'pending_task_exists', CASE
            WHEN v_default.activation_mode = 'auto_install_pending_credentials' THEN v_task_exists
            ELSE NULL
          END,
          'status', v_item_status
        )
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_blocking_count = 0,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_org_id,
    'baseline_profile', v_baseline_profile,
    'items', v_items,
    'pending_credentials_count', v_pending_count,
    'blocking_count', v_blocking_count,
    'blocking_findings', v_findings
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.onboarding_readiness_snapshot_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_scope_id UUID := p_scope_id;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_org_id UUID := public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id);
  v_blocking_findings JSONB := '[]'::jsonb;
  v_settings_missing JSONB := '[]'::jsonb;
  v_settings_required_count INT := 0;
  v_settings_present_count INT := 0;
  v_workflow_missing JSONB := '[]'::jsonb;
  v_workflow_required_count INT := 0;
  v_workflow_present_count INT := 0;
  v_workflow_target_policy JSONB := NULL;
  v_workflow_status TEXT := 'not_applicable';
  v_plugin_status JSONB := '{}'::jsonb;
  v_plugin_items JSONB := '[]'::jsonb;
  v_plugin_findings JSONB := '[]'::jsonb;
  v_plugin_blocking_count INT := 0;
  v_plugin_pending_count INT := 0;
  v_plugin_healthy_count INT := 0;
  v_plugin_required_count INT := 0;
  v_category RECORD;
  v_binding RECORD;
  v_stage RECORD;
  v_stage_value JSONB;
  v_template_status TEXT;
  v_workflow_baseline_policy JSONB := '{}'::jsonb;
  v_workflow_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['workflow_bindings', 'baseline_profile']), ''),
    'default'
  );
  v_integration_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
    'default'
  );
  v_overall_status TEXT;
BEGIN
  FOR v_category IN
    SELECT c.category
    FROM public.onboarding_policy_categories_v1(v_policy, v_scope_type) AS c
  LOOP
    v_settings_required_count := v_settings_required_count + 1;

    IF EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = v_category.category
        AND s.scope_type = v_scope_type
        AND s.scope_id IS NOT DISTINCT FROM v_scope_id
    ) THEN
      v_settings_present_count := v_settings_present_count + 1;
    ELSE
      v_settings_missing := v_settings_missing || jsonb_build_array(v_category.category);
      v_blocking_findings := v_blocking_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'settings_defaults',
          'code', 'missing_scope_default',
          'category', v_category.category,
          'message', format('Required onboarding default %s is missing for %s/%s.', v_category.category, v_scope_type, COALESCE(v_scope_id::text, 'global'))
        )
      );
    END IF;
  END LOOP;

  IF v_scope_type = 'tenant' THEN
    v_workflow_status := 'healthy';
    v_workflow_baseline_policy := COALESCE(public.workflow_binding_policy_baseline_v1(), public.workflow_binding_policy_default_v1());

    SELECT s.cached_value
      INTO v_workflow_target_policy
      FROM public.settings s
     WHERE s.category = 'workflow_binding_policy'
       AND s.scope_type = 'tenant'
       AND s.scope_id = v_scope_id
     LIMIT 1;

    FOR v_binding IN
      SELECT key, value
      FROM jsonb_each(COALESCE(v_workflow_baseline_policy->'bindings', '{}'::jsonb))
    LOOP
      FOR v_stage IN
        SELECT key, value
        FROM jsonb_each(COALESCE(v_binding.value->'stages', '{}'::jsonb))
      LOOP
        v_workflow_required_count := v_workflow_required_count + 1;
        v_stage_value := public.workflow_binding_stage_value_v1(v_workflow_target_policy, v_binding.key, v_stage.key);

        IF v_stage_value IS NULL THEN
          v_workflow_missing := v_workflow_missing || jsonb_build_array(
            jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
          );
          v_blocking_findings := v_blocking_findings || jsonb_build_array(
            jsonb_build_object(
              'severity', 'blocking',
              'component', 'workflow_bindings',
              'code', 'missing_workflow_binding_stage',
              'binding_key', v_binding.key,
              'stage_key', v_stage.key,
              'message', format('Workflow binding %s/%s is missing from tenant onboarding defaults.', v_binding.key, v_stage.key)
            )
          );
          v_workflow_status := 'blocked';
          CONTINUE;
        END IF;

        SELECT wt.status
          INTO v_template_status
          FROM public.workflow_templates wt
         WHERE wt.id = public.workflow_binding_stage_template_id_v1(v_stage_value)
         LIMIT 1;

        IF COALESCE(v_template_status, '') <> 'active' THEN
          v_workflow_missing := v_workflow_missing || jsonb_build_array(
            jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
          );
          v_blocking_findings := v_blocking_findings || jsonb_build_array(
            jsonb_build_object(
              'severity', 'blocking',
              'component', 'workflow_bindings',
              'code', 'inactive_workflow_template',
              'binding_key', v_binding.key,
              'stage_key', v_stage.key,
              'message', format('Workflow binding %s/%s does not resolve to an active tenant template.', v_binding.key, v_stage.key)
            )
          );
          v_workflow_status := 'blocked';
        ELSE
          v_workflow_present_count := v_workflow_present_count + 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  v_plugin_status := public.onboarding_integration_plugin_readiness_v1(v_scope_type, v_scope_id);
  v_plugin_items := COALESCE(v_plugin_status->'items', '[]'::jsonb);
  v_plugin_findings := COALESCE(v_plugin_status->'blocking_findings', '[]'::jsonb);
  v_plugin_blocking_count := COALESCE((v_plugin_status->>'blocking_count')::int, 0);
  v_plugin_pending_count := COALESCE((v_plugin_status->>'pending_credentials_count')::int, 0);

  SELECT COUNT(*)
    INTO v_plugin_required_count
    FROM public.onboarding_integration_plugin_defaults d
   WHERE d.enabled = TRUE
     AND d.profile_key = v_integration_baseline_profile
     AND d.scope_type = v_scope_type;

  SELECT COUNT(*)
    INTO v_plugin_healthy_count
    FROM jsonb_array_elements(v_plugin_items) AS item(value)
   WHERE lower(COALESCE(item.value->>'status', '')) = 'healthy';

  v_blocking_findings := v_blocking_findings || v_plugin_findings;

  IF jsonb_array_length(v_blocking_findings) > 0 THEN
    v_overall_status := 'blocked';
  ELSIF v_plugin_pending_count > 0 THEN
    v_overall_status := 'pending_credentials';
  ELSE
    v_overall_status := 'healthy';
  END IF;

  RETURN jsonb_build_object(
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_org_id,
    'overall_status', v_overall_status,
    'healthy', v_overall_status = 'healthy',
    'settings_defaults', jsonb_build_object(
      'status', CASE
        WHEN v_settings_required_count = 0 OR jsonb_array_length(v_settings_missing) = 0 THEN 'healthy'
        ELSE 'blocked'
      END,
      'healthy', v_settings_required_count = 0 OR jsonb_array_length(v_settings_missing) = 0,
      'required_count', v_settings_required_count,
      'present_count', v_settings_present_count,
      'missing_categories', v_settings_missing
    ),
    'workflow_bindings', jsonb_build_object(
      'status', v_workflow_status,
      'healthy', v_workflow_status IN ('healthy', 'not_applicable'),
      'baseline_profile', v_workflow_baseline_profile,
      'required_count', v_workflow_required_count,
      'present_count', v_workflow_present_count,
      'missing_stages', v_workflow_missing
    ),
    'integration_plugins', jsonb_build_object(
      'status', CASE
        WHEN v_plugin_blocking_count > 0 THEN 'blocked'
        WHEN v_plugin_pending_count > 0 THEN 'pending_credentials'
        ELSE 'healthy'
      END,
      'healthy', v_plugin_blocking_count = 0 AND v_plugin_pending_count = 0,
      'baseline_profile', v_integration_baseline_profile,
      'required_count', v_plugin_required_count,
      'healthy_count', v_plugin_healthy_count,
      'pending_credentials_count', v_plugin_pending_count,
      'blocking_count', v_plugin_blocking_count,
      'items', v_plugin_items
    ),
    'blocking_findings', v_blocking_findings
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_onboarding_readiness_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_onboarding_readiness_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  IF NOT (
    public.user_has_capability_v1('settings.read', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('workflow_runs.read', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('integration_plugins.read', v_scope.scope_type, v_scope.scope_id)
  ) THEN
    RAISE EXCEPTION
      'ui_get_onboarding_readiness_v1 requires settings.read, workflow_runs.read, or integration_plugins.read capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.onboarding_readiness_snapshot_v1(v_scope.scope_type, v_scope.scope_id);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_get_onboarding_readiness_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_get_onboarding_readiness_v1(p_scope_type, p_scope_id);
$function$;

-------------------------------------------------------------------------------
-- 9) Patch onboarding bootstraps + reconcile
-------------------------------------------------------------------------------

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
  v_plugin_result JSONB := '{}'::jsonb;
  v_readiness JSONB := '{}'::jsonb;
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
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('tenant', p_organization_id, p_trigger_source);

  IF COALESCE((v_plugin_result->>'ok')::boolean, FALSE) IS FALSE THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1 plugin baseline blocked'
      USING DETAIL = v_plugin_result::text;
  END IF;

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

  v_readiness := public.onboarding_readiness_snapshot_v1('tenant', p_organization_id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'workflow_bindings', v_binding_result,
    'integration_plugins', v_plugin_result,
    'rbac_templates_provisioned', v_provisioned,
    'readiness', v_readiness
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_client_onboarding_v1(
  p_client_id UUID,
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
  v_scope_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
  v_readiness JSONB := '{}'::jsonb;
  v_create_default_sender BOOLEAN;
  v_default_sender_name TEXT;
  v_default_sender_brand_name TEXT;
  v_default_sender_created BOOLEAN := FALSE;
BEGIN
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.clients c WHERE c.id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client % not found', p_client_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'client_id', p_client_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('client', p_client_id, v_policy, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('client', p_client_id, p_trigger_source);

  IF COALESCE((v_plugin_result->>'ok')::boolean, FALSE) IS FALSE THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1 plugin baseline blocked'
      USING DETAIL = v_plugin_result::text;
  END IF;

  v_create_default_sender := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['client_defaults', 'create_default_sender'],
    TRUE
  );

  IF v_create_default_sender THEN
    v_default_sender_name := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['client_defaults', 'default_sender_name'], 'Default Sender')), '');
    IF v_default_sender_name IS NULL THEN
      v_default_sender_name := 'Default Sender';
    END IF;

    v_default_sender_brand_name := NULLIF(btrim(v_policy #>> ARRAY['client_defaults', 'default_sender_brand_name']), '');

    IF NOT EXISTS (
      SELECT 1
      FROM public.senders s
      WHERE s.client_id = p_client_id
    ) THEN
      INSERT INTO public.senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status
      ) VALUES (
        p_client_id,
        v_default_sender_name,
        v_default_sender_brand_name,
        FALSE,
        TRUE,
        'active'
      );

      v_default_sender_created := TRUE;
    END IF;
  END IF;

  v_readiness := public.onboarding_readiness_snapshot_v1('client', p_client_id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'client_id', p_client_id,
    'scope_defaults', v_scope_result,
    'integration_plugins', v_plugin_result,
    'default_sender_created', v_default_sender_created,
    'readiness', v_readiness
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_sender_onboarding_v1(
  p_sender_id UUID,
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
  v_scope_result JSONB := '{}'::jsonb;
  v_plugin_result JSONB := '{}'::jsonb;
  v_readiness JSONB := '{}'::jsonb;
BEGIN
  IF p_sender_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.senders s WHERE s.id = p_sender_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender % not found', p_sender_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'sender_id', p_sender_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('sender', p_sender_id, v_policy, p_trigger_source);
  v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('sender', p_sender_id, p_trigger_source);

  IF COALESCE((v_plugin_result->>'ok')::boolean, FALSE) IS FALSE THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1 plugin baseline blocked'
      USING DETAIL = v_plugin_result::text;
  END IF;

  v_readiness := public.onboarding_readiness_snapshot_v1('sender', p_sender_id);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'sender_id', p_sender_id,
    'scope_defaults', v_scope_result,
    'integration_plugins', v_plugin_result,
    'readiness', v_readiness
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_saas_onboarding_defaults_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_trigger_source TEXT DEFAULT 'manual:reconcile_saas_onboarding_defaults_v1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(btrim(COALESCE(p_scope_type, '')));
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_global_result JSONB := public.ensure_required_global_defaults_v1();
  v_scope_result JSONB := '{}'::jsonb;
  v_workflow_result JSONB := NULL;
  v_plugin_result JSONB := NULL;
  v_readiness JSONB := NULL;
  v_provision_templates BOOLEAN;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_scope_type = '' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', NULL,
      'scope_id', NULL,
      'global_defaults', v_global_result,
      'scope_defaults', NULL,
      'workflow_bindings', NULL,
      'integration_plugins', NULL,
      'readiness', NULL
    );
  END IF;

  IF v_scope_type = 'global' THEN
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=global requires NULL scope_id';
    END IF;
    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'global',
      NULL,
      v_policy,
      p_trigger_source
    );
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('global', NULL, p_trigger_source);
    v_readiness := public.onboarding_readiness_snapshot_v1('global', NULL);
  ELSIF v_scope_type = 'tenant' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=tenant requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.organizations WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 tenant % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'tenant',
      p_scope_id,
      v_policy,
      p_trigger_source
    );
    v_workflow_result := public.bootstrap_workflow_binding_defaults_v1('tenant', p_scope_id, p_trigger_source);
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('tenant', p_scope_id, p_trigger_source);

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
          p_scope_id,
          v_template_keys,
          NULL
        );
      END IF;
    END IF;

    v_readiness := public.onboarding_readiness_snapshot_v1('tenant', p_scope_id);
  ELSIF v_scope_type = 'client' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=client requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.clients WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 client % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'client',
      p_scope_id,
      v_policy,
      p_trigger_source
    );
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('client', p_scope_id, p_trigger_source);
    v_readiness := public.onboarding_readiness_snapshot_v1('client', p_scope_id);
  ELSIF v_scope_type = 'sender' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=sender requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.senders WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 sender % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'sender',
      p_scope_id,
      v_policy,
      p_trigger_source
    );
    v_plugin_result := public.bootstrap_integration_plugin_defaults_v1('sender', p_scope_id, p_trigger_source);
    v_readiness := public.onboarding_readiness_snapshot_v1('sender', p_scope_id);
  ELSE
    RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 unsupported scope_type=%', p_scope_type;
  END IF;

  RETURN jsonb_build_object(
    'ok', COALESCE((v_plugin_result->>'ok')::boolean, TRUE),
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'global_defaults', v_global_result,
    'scope_defaults', v_scope_result,
    'workflow_bindings', v_workflow_result,
    'integration_plugins', v_plugin_result,
    'readiness', v_readiness
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 10) Grants
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.request_role_is_service_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_task_idempotency_v1(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_role_is_service_v1() FROM anon;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_task_idempotency_v1(TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.request_role_is_service_v1() FROM authenticated;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_task_idempotency_v1(TEXT, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.request_role_is_service_v1()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_integration_plugin_task_idempotency_v1(TEXT, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_integration_plugin_defaults_v1(TEXT, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID)
  TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604161915_onboarding_readiness_plugin_baseline_v1'));
COMMIT;
