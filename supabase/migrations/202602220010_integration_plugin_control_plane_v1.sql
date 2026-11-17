-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S02
-- Migration: Integration plugin control-plane foundation v1
-- Purpose:
--   - Add plugin lifecycle control-plane SSOT tables.
--   - Register lookup-driven lifecycle domains (no hardcoded enums).
--   - Register row-driven settings categories/policies for plugin governance and security.
--   - Enforce strict RLS + org isolation + table/lookup contracts.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220010_integration_plugin_control_plane_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup categories and values (row-driven domains)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('integration_plugin_kind', 'Integration plugin inbound kind.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_status', 'Integration plugin lifecycle status.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_version_status', 'Integration plugin version lifecycle status.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_source_type', 'Integration plugin source contract input type.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_binding_type', 'Integration plugin runtime binding type.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_validation_type', 'Integration plugin validation run type.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_run_status', 'Integration plugin validation run status.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_approval_action', 'Integration plugin approval event action.', 'operations', 'tier_1', FALSE),
  ('integration_plugin_auth_mode', 'Integration plugin supported auth modes.', 'operations', 'tier_1', FALSE),
  ('integration_managed_by', 'Managed-by marker for runtime artifacts.', 'operations', 'tier_1', FALSE)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata::jsonb
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('integration_plugin_kind', 'webhook', 'Webhook', 'Inbound webhook plugin', 10, TRUE, '{}'),
    ('integration_plugin_kind', 'api', 'API', 'Inbound API route plugin', 20, FALSE, '{}'),

    ('integration_plugin_status', 'draft', 'Draft', 'Plugin exists with draft versions', 10, TRUE, '{}'),
    ('integration_plugin_status', 'submitted', 'Submitted', 'Plugin waiting approval', 20, FALSE, '{}'),
    ('integration_plugin_status', 'approved', 'Approved', 'Plugin approved for activation', 30, FALSE, '{}'),
    ('integration_plugin_status', 'active', 'Active', 'Plugin has active runtime artifacts', 40, FALSE, '{}'),
    ('integration_plugin_status', 'archived', 'Archived', 'Plugin archived', 50, FALSE, '{}'),

    ('integration_plugin_version_status', 'draft', 'Draft', 'Version draft', 10, TRUE, '{}'),
    ('integration_plugin_version_status', 'submitted', 'Submitted', 'Version submitted for approval', 20, FALSE, '{}'),
    ('integration_plugin_version_status', 'approved', 'Approved', 'Version approved', 30, FALSE, '{}'),
    ('integration_plugin_version_status', 'rejected', 'Rejected', 'Version rejected', 40, FALSE, '{}'),
    ('integration_plugin_version_status', 'active', 'Active', 'Version active in runtime', 50, FALSE, '{}'),
    ('integration_plugin_version_status', 'archived', 'Archived', 'Version archived', 60, FALSE, '{}'),

    ('integration_plugin_source_type', 'manual', 'Manual', 'Manual studio configuration', 10, TRUE, '{}'),
    ('integration_plugin_source_type', 'webhook_sample', 'Webhook Sample', 'Generated from webhook payload sample', 20, FALSE, '{}'),
    ('integration_plugin_source_type', 'curl', 'cURL', 'Generated from cURL input', 30, FALSE, '{}'),
    ('integration_plugin_source_type', 'openapi', 'OpenAPI', 'Generated from OpenAPI contract', 40, FALSE, '{}'),

    ('integration_plugin_binding_type', 'webhook_source', 'Webhook Source', 'Runtime webhook source binding', 10, FALSE, '{}'),
    ('integration_plugin_binding_type', 'api_route', 'API Route', 'Runtime API route binding', 20, FALSE, '{}'),
    ('integration_plugin_binding_type', 'provider', 'Provider', 'Runtime provider binding', 30, FALSE, '{}'),
    ('integration_plugin_binding_type', 'operation_template', 'Operation Template', 'Runtime operation template binding', 40, FALSE, '{}'),

    ('integration_plugin_validation_type', 'parse', 'Parse', 'Contract parsing run', 10, FALSE, '{}'),
    ('integration_plugin_validation_type', 'infer', 'Infer', 'Mapping inference run', 20, FALSE, '{}'),
    ('integration_plugin_validation_type', 'preview', 'Preview', 'Preview/sandbox run', 30, FALSE, '{}'),
    ('integration_plugin_validation_type', 'validate', 'Validate', 'Deterministic validation run', 40, TRUE, '{}'),

    ('integration_plugin_run_status', 'pending', 'Pending', 'Run queued/in progress', 10, TRUE, '{}'),
    ('integration_plugin_run_status', 'succeeded', 'Succeeded', 'Run succeeded', 20, FALSE, '{}'),
    ('integration_plugin_run_status', 'failed', 'Failed', 'Run failed', 30, FALSE, '{}'),

    ('integration_plugin_approval_action', 'submitted', 'Submitted', 'Version submitted', 10, FALSE, '{}'),
    ('integration_plugin_approval_action', 'approved', 'Approved', 'Version approved', 20, FALSE, '{}'),
    ('integration_plugin_approval_action', 'rejected', 'Rejected', 'Version rejected', 30, FALSE, '{}'),
    ('integration_plugin_approval_action', 'activated', 'Activated', 'Version activated', 40, FALSE, '{}'),
    ('integration_plugin_approval_action', 'rolled_back', 'Rolled Back', 'Version rolled back', 50, FALSE, '{}'),
    ('integration_plugin_approval_action', 'rotated_credentials', 'Rotated Credentials', 'Credentials rotated', 60, FALSE, '{}'),

    ('integration_plugin_auth_mode', 'api_key_header', 'API Key Header', 'Inject API key in header', 10, TRUE, '{}'),
    ('integration_plugin_auth_mode', 'bearer_token_header', 'Bearer Header', 'Inject bearer token in authorization header', 20, FALSE, '{}'),
    ('integration_plugin_auth_mode', 'basic_auth_header', 'Basic Header', 'Inject basic auth header', 30, FALSE, '{}'),

    ('integration_managed_by', 'platform', 'Platform', 'Runtime artifact managed by platform setup', 10, TRUE, '{}'),
    ('integration_managed_by', 'integration_plugin', 'Integration Plugin', 'Runtime artifact materialized by integration plugin activation', 20, FALSE, '{}')
) AS v(category, value, label, description, sort_order, is_default, metadata)
  ON ld.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  metadata = EXCLUDED.metadata,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Settings categories + schema registry + global defaults
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
VALUES
  (
    'integration_plugin_policy',
    'Row-driven governance policy for integration plugin lifecycle (draft/approval/activation/workflow enforcement).',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant"]'::jsonb
  ),
  (
    'integration_plugin_ai_policy',
    'Row-driven AI assist policy for parse/infer mapping suggestion behavior.',
    TRUE,
    TRUE,
    FALSE,
    'soft_fail',
    '["global","tenant"]'::jsonb
  ),
  (
    'integration_plugin_security_policy',
    'Row-driven integration plugin security policy (redaction, preview side-effects, envelope).',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant"]'::jsonb
  ),
  (
    'integration_plugin_egress_policy',
    'Row-driven outbound egress policy for integration plugin generated HTTP traffic.',
    TRUE,
    TRUE,
    TRUE,
    'hard_fail',
    '["global","tenant"]'::jsonb
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
VALUES
  (
    'integration_plugin_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'governance', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'rollout', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'workflow_enforcement', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'reuse', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'auth', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
      )
    ),
    'Integration plugin lifecycle governance policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'governance', jsonb_build_object(
          'approval_required', TRUE,
          'approver_capability', 'integration_plugins.approve',
          'allow_platform_override', TRUE
        ),
        'rollout', jsonb_build_object(
          'mode', 'tiered',
          'allowed_tiers', jsonb_build_array('enterprise', 'pro', 'starter')
        ),
        'workflow_enforcement', jsonb_build_object(
          'studio_managed_routes_only', TRUE,
          'require_binding_for_webhook_activation', TRUE,
          'require_workflow_mode_for_api_activation', TRUE,
          'block_proxy_for_studio_managed_routes', TRUE
        ),
        'reuse', jsonb_build_object(
          'tenant_library_enabled', TRUE,
          'client_override_enabled', TRUE
        ),
        'auth', jsonb_build_object(
          'allowed_modes', jsonb_build_array('api_key_header', 'bearer_token_header', 'basic_auth_header')
        )
      )
    ),
    TRUE
  ),
  (
    'integration_plugin_ai_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enabled', jsonb_build_object('type', 'boolean'),
        'assist_mapping', jsonb_build_object('type', 'boolean'),
        'require_human_approval', jsonb_build_object('type', 'boolean')
      )
    ),
    'Integration plugin AI mapping assist policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enabled', FALSE,
        'assist_mapping', FALSE,
        'require_human_approval', TRUE
      )
    ),
    TRUE
  ),
  (
    'integration_plugin_security_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'preview', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'redaction', jsonb_build_object('type', 'object', 'additionalProperties', TRUE),
        'request_envelope', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
      )
    ),
    'Integration plugin security policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'preview', jsonb_build_object(
          'allow_external_side_effects', FALSE
        ),
        'redaction', jsonb_build_object(
          'headers', jsonb_build_array('authorization', 'proxy-authorization', 'x-api-key', 'api-key'),
          'body_fields', jsonb_build_array('password', 'secret', 'token', 'api_key', 'access_token', 'refresh_token')
        ),
        'request_envelope', jsonb_build_object(
          'max_payload_bytes', 262144,
          'max_timeout_seconds', 60
        )
      )
    ),
    TRUE
  ),
  (
    'integration_plugin_egress_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'enforce_https_only', jsonb_build_object('type', 'boolean'),
        'block_private_networks', jsonb_build_object('type', 'boolean'),
        'domain_allowlist', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'domain_denylist', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'allowed_methods', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'max_payload_bytes', jsonb_build_object('type', 'integer', 'minimum', 1),
        'max_timeout_seconds', jsonb_build_object('type', 'integer', 'minimum', 1),
        'follow_redirects', jsonb_build_object('type', 'boolean'),
        'header_allowlist', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
      )
    ),
    'Integration plugin outbound egress and envelope policy.',
    jsonb_build_array(
      jsonb_build_object(
        'version', 1,
        'enforce_https_only', TRUE,
        'block_private_networks', TRUE,
        'domain_allowlist', jsonb_build_array(),
        'domain_denylist', jsonb_build_array(),
        'allowed_methods', jsonb_build_array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
        'max_payload_bytes', 262144,
        'max_timeout_seconds', 60,
        'follow_redirects', FALSE,
        'header_allowlist', jsonb_build_array('accept', 'content-type', 'authorization', 'x-api-key', 'api-key', 'user-agent')
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

DO $seed$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT category, examples
    FROM public.schema_registry
    WHERE category IN (
      'integration_plugin_policy',
      'integration_plugin_ai_policy',
      'integration_plugin_security_policy',
      'integration_plugin_egress_policy'
    )
      AND version = 1
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = v_row.category
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
    ) THEN
      PERFORM public.upsert_settings_value_v1(
        v_row.category,
        'global',
        NULL,
        COALESCE(v_row.examples->0, '{}'::jsonb),
        1,
        format('seed %s global default', v_row.category)
      );
    END IF;
  END LOOP;
END;
$seed$;

-------------------------------------------------------------------------------
-- 3) Helper predicates
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_user_can_access_org_v1(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  RETURN p_organization_id = public.current_user_org_id();
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_scope_belongs_org_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_organization_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'tenant'));
BEGIN
  IF p_organization_id IS NULL OR p_scope_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type = 'tenant' THEN
    RETURN p_scope_id = p_organization_id;
  ELSIF v_scope_type = 'client' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = p_scope_id
        AND c.organization_id = p_organization_id
    );
  ELSIF v_scope_type = 'sender' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
      WHERE s.id = p_scope_id
        AND c.organization_id = p_organization_id
    );
  ELSIF v_scope_type = 'source' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.webhook_sources ws
      WHERE ws.id = p_scope_id
        AND ws.organization_id = p_organization_id
    );
  END IF;

  RETURN FALSE;
END;
$function$;

REVOKE ALL ON FUNCTION public.integration_plugin_user_can_access_org_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_user_can_access_org_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.integration_plugin_user_can_access_org_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.integration_plugin_scope_belongs_org_v1(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_plugin_scope_belongs_org_v1(TEXT, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.integration_plugin_scope_belongs_org_v1(TEXT, UUID, UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Control-plane tables
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.integration_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plugin_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  plugin_kind TEXT NOT NULL DEFAULT 'webhook',
  status TEXT NOT NULL DEFAULT 'draft',
  rollout_tier TEXT NOT NULL DEFAULT 'standard',
  reusable_within_tenant BOOLEAN NOT NULL DEFAULT TRUE,
  base_plugin_id UUID NULL REFERENCES public.integration_plugins(id) ON DELETE SET NULL,
  active_version_id UUID NULL,
  managed_by TEXT NOT NULL DEFAULT 'integration_plugin',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_plugins_key_nonempty_ck CHECK (btrim(plugin_key) <> ''),
  CONSTRAINT integration_plugins_name_nonempty_ck CHECK (btrim(name) <> ''),
  CONSTRAINT integration_plugins_rollout_tier_nonempty_ck CHECK (btrim(rollout_tier) <> ''),
  CONSTRAINT integration_plugins_managed_by_nonempty_ck CHECK (btrim(managed_by) <> ''),
  CONSTRAINT integration_plugins_unique_org_key UNIQUE (organization_id, plugin_key)
);

CREATE INDEX IF NOT EXISTS idx_integration_plugins_org_status
  ON public.integration_plugins(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_plugins_org_kind
  ON public.integration_plugins(organization_id, plugin_kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.integration_plugin_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES public.integration_plugins(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  inbound_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapping_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_binding JSONB NOT NULL DEFAULT '{}'::jsonb,
  outbound_operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  auth_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at TIMESTAMPTZ NULL,
  submitted_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NULL,
  approved_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NULL,
  activated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approval_reason TEXT NULL,
  artifact_hash TEXT NULL,
  diff_hash TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_plugin_versions_version_no_ck CHECK (version_no > 0),
  CONSTRAINT integration_plugin_versions_status_nonempty_ck CHECK (btrim(status) <> ''),
  CONSTRAINT integration_plugin_versions_source_type_nonempty_ck CHECK (btrim(source_type) <> ''),
  CONSTRAINT integration_plugin_versions_unique UNIQUE (plugin_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_org_status
  ON public.integration_plugin_versions(organization_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_versions_plugin_version
  ON public.integration_plugin_versions(plugin_id, version_no DESC);

ALTER TABLE public.integration_plugins
  DROP CONSTRAINT IF EXISTS integration_plugins_active_version_fkey;
ALTER TABLE public.integration_plugins
  ADD CONSTRAINT integration_plugins_active_version_fkey
  FOREIGN KEY (active_version_id) REFERENCES public.integration_plugin_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.integration_plugin_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_version_id UUID NOT NULL REFERENCES public.integration_plugin_versions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id UUID NOT NULL,
  binding_type TEXT NOT NULL,
  runtime_resource_type TEXT NULL,
  runtime_resource_id UUID NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  activation_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_plugin_bindings_scope_type_nonempty_ck CHECK (btrim(scope_type) <> ''),
  CONSTRAINT integration_plugin_bindings_binding_type_nonempty_ck CHECK (btrim(binding_type) <> ''),
  CONSTRAINT integration_plugin_bindings_runtime_resource_type_nonempty_ck CHECK (
    runtime_resource_type IS NULL OR btrim(runtime_resource_type) <> ''
  ),
  CONSTRAINT integration_plugin_bindings_unique_scope UNIQUE (plugin_version_id, scope_type, scope_id, binding_type)
);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_bindings_org_scope
  ON public.integration_plugin_bindings(organization_id, scope_type, scope_id, binding_type);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_bindings_runtime
  ON public.integration_plugin_bindings(runtime_resource_type, runtime_resource_id)
  WHERE runtime_resource_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.integration_plugin_validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_version_id UUID NOT NULL REFERENCES public.integration_plugin_versions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sandbox_mode BOOLEAN NOT NULL DEFAULT TRUE,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID NULL,
  executed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  evidence_hash TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT integration_plugin_validation_runs_type_nonempty_ck CHECK (btrim(run_type) <> ''),
  CONSTRAINT integration_plugin_validation_runs_status_nonempty_ck CHECK (btrim(status) <> '')
);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_validation_runs_org_created
  ON public.integration_plugin_validation_runs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_validation_runs_version
  ON public.integration_plugin_validation_runs(plugin_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.integration_plugin_approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_version_id UUID NOT NULL REFERENCES public.integration_plugin_versions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  reason TEXT NULL,
  diff_hash TEXT NULL,
  artifact_hash TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_plugin_approval_events_action_nonempty_ck CHECK (btrim(action) <> '')
);

CREATE INDEX IF NOT EXISTS idx_integration_plugin_approval_events_org_created
  ON public.integration_plugin_approval_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_plugin_approval_events_version
  ON public.integration_plugin_approval_events(plugin_version_id, created_at DESC);

COMMENT ON TABLE public.integration_plugins IS
  'Integration plugin lifecycle root (tenant scoped, row-driven, workflow-first).';
COMMENT ON TABLE public.integration_plugin_versions IS
  'Immutable-ish plugin version snapshots with draft/approval/activation lifecycle.';
COMMENT ON TABLE public.integration_plugin_bindings IS
  'Activation bindings between plugin versions and runtime scope/resources.';
COMMENT ON TABLE public.integration_plugin_validation_runs IS
  'Validation/test/preview runs for plugin versions (sandbox-first).';
COMMENT ON TABLE public.integration_plugin_approval_events IS
  'Immutable approval/activation ledger for plugin version governance.';

DROP TRIGGER IF EXISTS trg_integration_plugins_set_updated_at ON public.integration_plugins;
CREATE TRIGGER trg_integration_plugins_set_updated_at
  BEFORE UPDATE ON public.integration_plugins
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_integration_plugin_versions_set_updated_at ON public.integration_plugin_versions;
CREATE TRIGGER trg_integration_plugin_versions_set_updated_at
  BEFORE UPDATE ON public.integration_plugin_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_integration_plugin_bindings_set_updated_at ON public.integration_plugin_bindings;
CREATE TRIGGER trg_integration_plugin_bindings_set_updated_at
  BEFORE UPDATE ON public.integration_plugin_bindings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 5) Consistency triggers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.integration_plugin_versions_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plugin_org UUID;
BEGIN
  SELECT p.organization_id
    INTO v_plugin_org
    FROM public.integration_plugins p
   WHERE p.id = NEW.plugin_id;

  IF v_plugin_org IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_versions: plugin % not found', NEW.plugin_id USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_plugin_org THEN
    RAISE EXCEPTION
      'integration_plugin_versions: organization mismatch (plugin org %, row org %)',
      v_plugin_org,
      NEW.organization_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.integration_plugin_bindings_enforce_org_scope_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_version_org UUID;
BEGIN
  SELECT v.organization_id
    INTO v_version_org
    FROM public.integration_plugin_versions v
   WHERE v.id = NEW.plugin_version_id;

  IF v_version_org IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_bindings: plugin_version % not found', NEW.plugin_version_id USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_version_org THEN
    RAISE EXCEPTION
      'integration_plugin_bindings: organization mismatch (version org %, row org %)',
      v_version_org,
      NEW.organization_id
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.integration_plugin_scope_belongs_org_v1(NEW.scope_type, NEW.scope_id, NEW.organization_id) THEN
    RAISE EXCEPTION
      'integration_plugin_bindings: scope %/% does not belong to organization %',
      NEW.scope_type,
      NEW.scope_id,
      NEW.organization_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_integration_plugin_versions_enforce_org_match ON public.integration_plugin_versions;
CREATE TRIGGER trg_integration_plugin_versions_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.integration_plugin_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_versions_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_integration_plugin_bindings_enforce_org_scope ON public.integration_plugin_bindings;
CREATE TRIGGER trg_integration_plugin_bindings_enforce_org_scope
  BEFORE INSERT OR UPDATE ON public.integration_plugin_bindings
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_bindings_enforce_org_scope_v1();

-------------------------------------------------------------------------------
-- 6) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.integration_plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_plugin_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_plugin_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_plugin_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_plugin_approval_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.integration_plugins FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_plugins FROM anon;
REVOKE ALL ON TABLE public.integration_plugins FROM authenticated;
REVOKE ALL ON TABLE public.integration_plugin_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_plugin_versions FROM anon;
REVOKE ALL ON TABLE public.integration_plugin_versions FROM authenticated;
REVOKE ALL ON TABLE public.integration_plugin_bindings FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_plugin_bindings FROM anon;
REVOKE ALL ON TABLE public.integration_plugin_bindings FROM authenticated;
REVOKE ALL ON TABLE public.integration_plugin_validation_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_plugin_validation_runs FROM anon;
REVOKE ALL ON TABLE public.integration_plugin_validation_runs FROM authenticated;
REVOKE ALL ON TABLE public.integration_plugin_approval_events FROM PUBLIC;
REVOKE ALL ON TABLE public.integration_plugin_approval_events FROM anon;
REVOKE ALL ON TABLE public.integration_plugin_approval_events FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_plugins TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_plugin_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_plugin_bindings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_plugin_validation_runs TO authenticated;
GRANT SELECT, INSERT ON TABLE public.integration_plugin_approval_events TO authenticated;

GRANT ALL ON TABLE public.integration_plugins TO service_role;
GRANT ALL ON TABLE public.integration_plugin_versions TO service_role;
GRANT ALL ON TABLE public.integration_plugin_bindings TO service_role;
GRANT ALL ON TABLE public.integration_plugin_validation_runs TO service_role;
GRANT ALL ON TABLE public.integration_plugin_approval_events TO service_role;

DROP POLICY IF EXISTS integration_plugins_service_policy ON public.integration_plugins;
CREATE POLICY integration_plugins_service_policy
  ON public.integration_plugins
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS integration_plugins_select ON public.integration_plugins;
CREATE POLICY integration_plugins_select
  ON public.integration_plugins
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('integration_plugins', 'read')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugins_insert ON public.integration_plugins;
CREATE POLICY integration_plugins_insert
  ON public.integration_plugins
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugins_update ON public.integration_plugins;
CREATE POLICY integration_plugins_update
  ON public.integration_plugins
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugins_delete ON public.integration_plugins;
CREATE POLICY integration_plugins_delete
  ON public.integration_plugins
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_versions_service_policy ON public.integration_plugin_versions;
CREATE POLICY integration_plugin_versions_service_policy
  ON public.integration_plugin_versions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS integration_plugin_versions_select ON public.integration_plugin_versions;
CREATE POLICY integration_plugin_versions_select
  ON public.integration_plugin_versions
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('integration_plugins', 'read')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_versions_insert ON public.integration_plugin_versions;
CREATE POLICY integration_plugin_versions_insert
  ON public.integration_plugin_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_versions_update ON public.integration_plugin_versions;
CREATE POLICY integration_plugin_versions_update
  ON public.integration_plugin_versions
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_versions_delete ON public.integration_plugin_versions;
CREATE POLICY integration_plugin_versions_delete
  ON public.integration_plugin_versions
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'write')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_bindings_service_policy ON public.integration_plugin_bindings;
CREATE POLICY integration_plugin_bindings_service_policy
  ON public.integration_plugin_bindings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS integration_plugin_bindings_select ON public.integration_plugin_bindings;
CREATE POLICY integration_plugin_bindings_select
  ON public.integration_plugin_bindings
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('integration_plugins', 'read')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_bindings_insert ON public.integration_plugin_bindings;
CREATE POLICY integration_plugin_bindings_insert
  ON public.integration_plugin_bindings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.user_has_resource_capability_v1('integration_plugins', 'write')
      OR public.user_has_resource_capability_v1('integration_plugins', 'activate')
    )
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_bindings_update ON public.integration_plugin_bindings;
CREATE POLICY integration_plugin_bindings_update
  ON public.integration_plugin_bindings
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.user_has_resource_capability_v1('integration_plugins', 'write')
      OR public.user_has_resource_capability_v1('integration_plugins', 'activate')
    )
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.user_has_resource_capability_v1('integration_plugins', 'write')
      OR public.user_has_resource_capability_v1('integration_plugins', 'activate')
    )
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_bindings_delete ON public.integration_plugin_bindings;
CREATE POLICY integration_plugin_bindings_delete
  ON public.integration_plugin_bindings
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.user_has_resource_capability_v1('integration_plugins', 'write')
      OR public.user_has_resource_capability_v1('integration_plugins', 'activate')
    )
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_validation_runs_service_policy ON public.integration_plugin_validation_runs;
CREATE POLICY integration_plugin_validation_runs_service_policy
  ON public.integration_plugin_validation_runs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS integration_plugin_validation_runs_select ON public.integration_plugin_validation_runs;
CREATE POLICY integration_plugin_validation_runs_select
  ON public.integration_plugin_validation_runs
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('integration_plugins', 'read')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_validation_runs_insert ON public.integration_plugin_validation_runs;
CREATE POLICY integration_plugin_validation_runs_insert
  ON public.integration_plugin_validation_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'test')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_validation_runs_update ON public.integration_plugin_validation_runs;
CREATE POLICY integration_plugin_validation_runs_update
  ON public.integration_plugin_validation_runs
  FOR UPDATE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'test')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  )
  WITH CHECK (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'test')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_validation_runs_delete ON public.integration_plugin_validation_runs;
CREATE POLICY integration_plugin_validation_runs_delete
  ON public.integration_plugin_validation_runs
  FOR DELETE
  TO authenticated
  USING (
    public.user_can_write()
    AND public.user_has_resource_capability_v1('integration_plugins', 'test')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_approval_events_service_policy ON public.integration_plugin_approval_events;
CREATE POLICY integration_plugin_approval_events_service_policy
  ON public.integration_plugin_approval_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS integration_plugin_approval_events_select ON public.integration_plugin_approval_events;
CREATE POLICY integration_plugin_approval_events_select
  ON public.integration_plugin_approval_events
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_resource_capability_v1('integration_plugins', 'read')
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

DROP POLICY IF EXISTS integration_plugin_approval_events_insert ON public.integration_plugin_approval_events;
CREATE POLICY integration_plugin_approval_events_insert
  ON public.integration_plugin_approval_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.user_has_resource_capability_v1('integration_plugins', 'write')
      OR public.user_has_resource_capability_v1('integration_plugins', 'approve')
      OR public.user_has_resource_capability_v1('integration_plugins', 'activate')
      OR public.user_has_resource_capability_v1('integration_plugins', 'test')
    )
    AND public.integration_plugin_user_can_access_org_v1(organization_id)
  );

-------------------------------------------------------------------------------
-- 7) Table contracts + lookup column contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  ('public', 'integration_plugins', TRUE, TRUE, TRUE, 'Tenant-scoped plugin lifecycle root; workflow-first and row-driven.'),
  ('public', 'integration_plugin_versions', TRUE, TRUE, TRUE, 'Plugin version snapshots with governance and activation artifacts.'),
  ('public', 'integration_plugin_bindings', TRUE, TRUE, TRUE, 'Runtime activation bindings by scope/resource.'),
  ('public', 'integration_plugin_validation_runs', TRUE, FALSE, TRUE, 'Validation/test evidence store for plugin versions.'),
  ('public', 'integration_plugin_approval_events', TRUE, FALSE, TRUE, 'Immutable approval/activation event ledger.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'integration_plugins', 'plugin_kind', 'integration_plugin_kind'),
  ('public', 'integration_plugins', 'status', 'integration_plugin_status'),
  ('public', 'integration_plugins', 'managed_by', 'integration_managed_by'),

  ('public', 'integration_plugin_versions', 'status', 'integration_plugin_version_status'),
  ('public', 'integration_plugin_versions', 'source_type', 'integration_plugin_source_type'),

  ('public', 'integration_plugin_bindings', 'scope_type', 'scope_type'),
  ('public', 'integration_plugin_bindings', 'binding_type', 'integration_plugin_binding_type'),

  ('public', 'integration_plugin_validation_runs', 'run_type', 'integration_plugin_validation_type'),
  ('public', 'integration_plugin_validation_runs', 'status', 'integration_plugin_run_status'),

  ('public', 'integration_plugin_approval_events', 'action', 'integration_plugin_approval_action')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202602220010_integration_plugin_control_plane_v1'));
COMMIT;
