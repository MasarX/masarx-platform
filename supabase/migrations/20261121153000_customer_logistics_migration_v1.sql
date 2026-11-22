-- Row-driven customer/logistics migration plugin readiness.
-- Adds a dedicated client/customer migration path. It does not reuse shipment
-- create intake, webhook inbox success, or provider shipment artifacts.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261119050000_customer_logistics_migration_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('logistics_migration_source_status', 'Customer migration source lifecycle', 'engineering', 'tier_1', FALSE),
  ('logistics_migration_item_target_type', 'Customer migration item target type', 'engineering', 'tier_1', FALSE),
  ('logistics_migration_item_status', 'Customer migration item result status', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (VALUES
  ('decision_category', 'imports.validate', 'Import validation', 1910, FALSE),
  ('decision_category', 'imports.execute', 'Import execution', 1920, FALSE),
  ('decision_category', 'imports.idempotency', 'Import identity check', 1930, FALSE),
  ('logistics_migration_source_status', 'active', 'Active', 10, TRUE),
  ('logistics_migration_source_status', 'archived', 'Archived', 20, FALSE),
  ('logistics_migration_item_target_type', 'client', 'Client', 10, FALSE),
  ('logistics_migration_item_target_type', 'recipient', 'Recipient', 20, FALSE),
  ('logistics_migration_item_status', 'would_create', 'Would create', 10, FALSE),
  ('logistics_migration_item_status', 'created', 'Created', 20, FALSE),
  ('logistics_migration_item_status', 'failed', 'Failed', 30, FALSE)
) AS v(category, value, label, sort_order, is_default) ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.logistics_migration_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  plugin_key TEXT NOT NULL DEFAULT 'customer-logistics-migration',
  plugin_id UUID NOT NULL REFERENCES public.integration_plugins(id) ON DELETE RESTRICT,
  plugin_binding_id UUID NOT NULL REFERENCES public.integration_plugin_bindings(id) ON DELETE RESTRICT,
  provider_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  auth_mode TEXT NOT NULL DEFAULT 'api_key',
  redaction_profile JSONB NOT NULL DEFAULT '{"fields":["api_key","password","token","secret","authorization"]}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_key),
  CONSTRAINT logistics_migration_sources_key_check CHECK (source_key ~ '^[a-z0-9][a-z0-9_-]*$')
);

CREATE TABLE IF NOT EXISTS public.logistics_migration_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.logistics_migration_sources(id) ON DELETE CASCADE,
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  target_entity TEXT NOT NULL DEFAULT 'client_customer',
  status TEXT NOT NULL DEFAULT 'active',
  mapping_rules JSONB NOT NULL,
  validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_id, profile_key),
  CONSTRAINT logistics_migration_profiles_target_check CHECK (target_entity = 'client_customer')
);

CREATE TABLE IF NOT EXISTS public.logistics_migration_requests (
  import_job_id UUID PRIMARY KEY REFERENCES public.import_jobs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.logistics_migration_sources(id) ON DELETE RESTRICT,
  profile_id UUID NOT NULL REFERENCES public.logistics_migration_profiles(id) ON DELETE RESTRICT,
  external_batch_id TEXT NOT NULL,
  plugin_id UUID NOT NULL REFERENCES public.integration_plugins(id) ON DELETE RESTRICT,
  plugin_version_id UUID NOT NULL REFERENCES public.integration_plugin_versions(id) ON DELETE RESTRICT,
  plugin_binding_id UUID NOT NULL REFERENCES public.integration_plugin_bindings(id) ON DELETE RESTRICT,
  profile_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  imported_client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  preview_workflow_run_id UUID REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  execution_workflow_run_id UUID REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  decision_log_id UUID,
  validation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_batch_id),
  CONSTRAINT logistics_migration_requests_batch_check CHECK (btrim(external_batch_id) <> ''),
  CONSTRAINT logistics_migration_requests_payload_hash_check CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT logistics_migration_requests_config_hash_check CHECK (profile_config_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.logistics_migration_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_job_id UUID NOT NULL REFERENCES public.logistics_migration_requests(import_job_id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  external_id TEXT,
  status TEXT NOT NULL,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_job_id, item_key),
  CONSTRAINT logistics_migration_items_key_check CHECK (btrim(item_key) <> '')
);

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'logistics_migration_sources', 'status', 'logistics_migration_source_status'),
  ('public', 'logistics_migration_items', 'target_type', 'logistics_migration_item_target_type'),
  ('public', 'logistics_migration_items', 'status', 'logistics_migration_item_status')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO NOTHING;

-- Use the canonical trigger names so later lookup reconciliation can replace them.
CREATE TRIGGER trg_lookup_contract_5f0d45dd7a94
BEFORE INSERT OR UPDATE OF status ON public.logistics_migration_sources
FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts();
CREATE TRIGGER trg_lookup_contract_ea1c5e9186d8
BEFORE INSERT OR UPDATE OF status, target_type ON public.logistics_migration_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts();

CREATE INDEX IF NOT EXISTS idx_lms_org_status ON public.logistics_migration_sources(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_lms_plugin ON public.logistics_migration_sources(plugin_id);
CREATE INDEX IF NOT EXISTS idx_lms_plugin_binding ON public.logistics_migration_sources(plugin_binding_id);
CREATE INDEX IF NOT EXISTS idx_lmp_org_source_status ON public.logistics_migration_profiles(organization_id, source_id, status);
CREATE INDEX IF NOT EXISTS idx_lmp_source ON public.logistics_migration_profiles(source_id);
CREATE INDEX IF NOT EXISTS idx_lmr_org_updated ON public.logistics_migration_requests(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lmr_source ON public.logistics_migration_requests(source_id);
CREATE INDEX IF NOT EXISTS idx_lmr_profile ON public.logistics_migration_requests(profile_id);
CREATE INDEX IF NOT EXISTS idx_lmr_plugin ON public.logistics_migration_requests(plugin_id);
CREATE INDEX IF NOT EXISTS idx_lmr_plugin_version ON public.logistics_migration_requests(plugin_version_id);
CREATE INDEX IF NOT EXISTS idx_lmr_plugin_binding ON public.logistics_migration_requests(plugin_binding_id);
CREATE INDEX IF NOT EXISTS idx_lmr_imported_client ON public.logistics_migration_requests(imported_client_id);
CREATE INDEX IF NOT EXISTS idx_lmr_preview_workflow_run ON public.logistics_migration_requests(preview_workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_lmr_execution_workflow_run ON public.logistics_migration_requests(execution_workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_lmi_import_job ON public.logistics_migration_items(import_job_id);
CREATE INDEX IF NOT EXISTS idx_lmi_org ON public.logistics_migration_items(organization_id);

ALTER TABLE public.logistics_migration_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logistics_migration_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logistics_migration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logistics_migration_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS logistics_migration_sources_read ON public.logistics_migration_sources;
CREATE POLICY logistics_migration_sources_read ON public.logistics_migration_sources
FOR SELECT TO authenticated, ui_rpc_executor USING (
  public.is_platform_user()
  OR (public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_scope_id()
      AND organization_id = public.current_user_org_id()
      AND public.user_has_capability_v1('integration_plugins.read', 'tenant', organization_id))
);

DROP POLICY IF EXISTS logistics_migration_profiles_read ON public.logistics_migration_profiles;
CREATE POLICY logistics_migration_profiles_read ON public.logistics_migration_profiles
FOR SELECT TO authenticated, ui_rpc_executor USING (
  public.is_platform_user()
  OR (public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_scope_id()
      AND organization_id = public.current_user_org_id()
      AND public.user_has_capability_v1('integration_plugins.read', 'tenant', organization_id))
);

DROP POLICY IF EXISTS logistics_migration_requests_read ON public.logistics_migration_requests;
CREATE POLICY logistics_migration_requests_read ON public.logistics_migration_requests
FOR SELECT TO authenticated, ui_rpc_executor USING (
  public.is_platform_user()
  OR (public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_scope_id()
      AND organization_id = public.current_user_org_id()
      AND public.user_has_capability_v1('imports.read', 'tenant', organization_id)
      AND public.user_has_capability_v1('clients.read', 'tenant', organization_id)
      AND public.user_has_capability_v1('recipients.read', 'tenant', organization_id))
);

DROP POLICY IF EXISTS logistics_migration_items_read ON public.logistics_migration_items;
CREATE POLICY logistics_migration_items_read ON public.logistics_migration_items
FOR SELECT TO authenticated, ui_rpc_executor USING (
  public.is_platform_user()
  OR (public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_scope_id()
      AND organization_id = public.current_user_org_id()
      AND public.user_has_capability_v1('imports.read', 'tenant', organization_id)
      AND public.user_has_capability_v1('clients.read', 'tenant', organization_id)
      AND public.user_has_capability_v1('recipients.read', 'tenant', organization_id))
);

REVOKE ALL ON public.logistics_migration_sources FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.logistics_migration_sources TO authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON public.logistics_migration_profiles FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.logistics_migration_profiles TO authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON public.logistics_migration_requests FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.logistics_migration_requests TO authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON public.logistics_migration_items FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.logistics_migration_items TO authenticated, service_role, ui_rpc_executor;

CREATE POLICY ui_rpc_executor_trusted ON public.logistics_migration_sources FOR ALL TO ui_rpc_executor
USING (public.is_platform_user() OR public.ui_rpc_request_is_service_v1())
WITH CHECK (public.is_platform_user() OR public.ui_rpc_request_is_service_v1());
CREATE POLICY ui_rpc_executor_trusted ON public.logistics_migration_profiles FOR ALL TO ui_rpc_executor
USING (public.is_platform_user() OR public.ui_rpc_request_is_service_v1())
WITH CHECK (public.is_platform_user() OR public.ui_rpc_request_is_service_v1());
CREATE POLICY ui_rpc_executor_trusted ON public.logistics_migration_requests FOR ALL TO ui_rpc_executor
USING (public.is_platform_user() OR public.ui_rpc_request_is_service_v1())
WITH CHECK (public.is_platform_user() OR public.ui_rpc_request_is_service_v1());
CREATE POLICY ui_rpc_executor_trusted ON public.logistics_migration_items FOR ALL TO ui_rpc_executor
USING (public.is_platform_user() OR public.ui_rpc_request_is_service_v1())
WITH CHECK (public.is_platform_user() OR public.ui_rpc_request_is_service_v1());

DO $contracts$
BEGIN
  IF to_regclass('public.table_contracts') IS NOT NULL THEN
    INSERT INTO public.table_contracts (
      table_schema,
      table_name,
      created_at_required,
      created_at_source_column,
      updated_at_required,
      updated_at_source_column,
      audit_enabled,
      notes
    )
    VALUES
      ('public', 'logistics_migration_sources', TRUE, 'created_at', TRUE, 'updated_at', TRUE, 'logistics customer migration source audit'),
      ('public', 'logistics_migration_profiles', TRUE, 'created_at', TRUE, 'updated_at', TRUE, 'logistics customer migration profile audit'),
      ('public', 'logistics_migration_requests', TRUE, 'created_at', TRUE, 'updated_at', TRUE, 'logistics customer migration request audit'),
      ('public', 'logistics_migration_items', TRUE, 'created_at', TRUE, 'updated_at', TRUE, 'logistics customer migration item audit')
    ON CONFLICT (table_schema, table_name) DO UPDATE
    SET
      created_at_required = EXCLUDED.created_at_required,
      created_at_source_column = EXCLUDED.created_at_source_column,
      updated_at_required = EXCLUDED.updated_at_required,
      updated_at_source_column = EXCLUDED.updated_at_source_column,
      audit_enabled = EXCLUDED.audit_enabled,
      notes = EXCLUDED.notes,
      updated_at = now();
  END IF;

  IF to_regprocedure('public.apply_table_contracts(text)') IS NOT NULL THEN
    PERFORM * FROM public.apply_table_contracts('public');
  END IF;

  IF to_regprocedure('public.ensure_audit_triggers()') IS NOT NULL THEN
    PERFORM * FROM public.ensure_audit_triggers();
  END IF;
END;
$contracts$;

CREATE OR REPLACE VIEW public.v_logistics_migration_source_directory
WITH (security_invoker = true) AS
SELECT s.id, s.organization_id, s.source_key, s.display_name, s.plugin_key,
       s.provider_name, s.status, s.auth_mode, s.plugin_id,
       ip.active_version_id AS plugin_version_id, s.plugin_binding_id,
       ipv.version_no AS plugin_version_no, ip.status AS plugin_status,
       ipv.status AS plugin_version_status, b.enabled AS plugin_binding_enabled,
       s.redaction_profile, s.metadata, s.created_at, s.updated_at
  FROM public.logistics_migration_sources s
  JOIN public.integration_plugins ip ON ip.id = s.plugin_id
  JOIN public.integration_plugin_versions ipv ON ipv.id = ip.active_version_id
  JOIN public.integration_plugin_bindings b ON b.id = s.plugin_binding_id;

CREATE OR REPLACE VIEW public.v_logistics_migration_profile_directory
WITH (security_invoker = true) AS
SELECT p.id, p.organization_id, p.source_id, s.display_name AS source_name, p.profile_key,
       p.display_name, p.target_entity, p.status, p.mapping_rules, p.validation_rules,
       p.metadata, p.created_at, p.updated_at
  FROM public.logistics_migration_profiles p
  JOIN public.logistics_migration_sources s ON s.id = p.source_id;

CREATE OR REPLACE VIEW public.v_logistics_migration_request_directory
WITH (security_invoker = true) AS
SELECT r.import_job_id AS id, r.import_job_id, r.organization_id, r.source_id,
       s.display_name AS source_name, r.profile_id, p.display_name AS profile_name,
       s.source_key || ':' || r.external_batch_id AS request_key,
       CASE WHEN r.execution_workflow_run_id IS NOT NULL THEN 'execute' ELSE 'dry_run' END AS mode,
       ij.status, r.external_batch_id, r.profile_config_sha256, r.payload_sha256,
       r.plugin_id, r.plugin_version_id, r.plugin_binding_id,
       r.imported_client_id, c.name AS imported_client_name,
       recipients.imported_recipient_ids,
       COALESCE(r.execution_workflow_run_id, r.preview_workflow_run_id) AS workflow_run_id,
       r.preview_workflow_run_id, r.execution_workflow_run_id, r.decision_log_id,
       r.validation_summary, r.result_summary, r.redaction_summary, ij.error_summary,
       r.organization_id::text || ':' || r.external_batch_id AS idempotency_key,
       ij.submitted_at AS created_at, GREATEST(ij.updated_at, r.updated_at) AS updated_at
  FROM public.logistics_migration_requests r
  JOIN public.import_jobs ij ON ij.id = r.import_job_id
  JOIN public.logistics_migration_sources s ON s.id = r.source_id
  JOIN public.logistics_migration_profiles p ON p.id = r.profile_id
  LEFT JOIN public.clients c ON c.id = r.imported_client_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             jsonb_agg(i.target_id ORDER BY i.item_key) FILTER (WHERE i.target_id IS NOT NULL),
             '[]'::jsonb
           ) AS imported_recipient_ids
      FROM public.logistics_migration_items i
     WHERE i.import_job_id = r.import_job_id
       AND i.target_type = 'recipient'
  ) recipients ON TRUE;

REVOKE ALL ON public.v_logistics_migration_source_directory FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.v_logistics_migration_source_directory TO authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON public.v_logistics_migration_profile_directory FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.v_logistics_migration_profile_directory TO authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON public.v_logistics_migration_request_directory FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON public.v_logistics_migration_request_directory TO authenticated, service_role, ui_rpc_executor;

CREATE OR REPLACE FUNCTION public.safe_jsonpath_query_array_v1(
  p_document JSONB,
  p_expression TEXT,
  p_max_items INT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_path JSONPATH;
  v_match JSONB;
  v_nested_item JSONB;
  v_result JSONB := '[]'::jsonb;
BEGIN
  IF p_document IS NULL
     OR jsonb_typeof(p_document) NOT IN ('object', 'array')
  THEN
    RAISE EXCEPTION 'safe_jsonpath_query_array_v1 requires an object or array document'
      USING ERRCODE = '22023';
  END IF;

  IF NULLIF(btrim(COALESCE(p_expression, '')), '') IS NULL THEN
    RAISE EXCEPTION 'safe_jsonpath_query_array_v1 invalid JSONPath'
      USING ERRCODE = '22023';
  END IF;

  IF p_max_items IS NULL OR p_max_items < 1 OR p_max_items > 100 THEN
    RAISE EXCEPTION 'safe_jsonpath_query_array_v1 invalid maximum'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_path := p_expression::JSONPATH;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'safe_jsonpath_query_array_v1 invalid JSONPath'
      USING ERRCODE = '22023';
  END;

  BEGIN
    FOR v_match IN
      SELECT value
        FROM jsonb_path_query(p_document, v_path) AS matched(value)
       LIMIT (p_max_items + 1)
    LOOP
      IF jsonb_typeof(v_match) = 'array' THEN
        FOR v_nested_item IN SELECT value FROM jsonb_array_elements(v_match)
        LOOP
          IF jsonb_typeof(v_nested_item) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'safe_jsonpath_query_array_v1 collection items must be objects'
              USING ERRCODE = '22023';
          END IF;
          v_result := v_result || jsonb_build_array(v_nested_item);
          IF jsonb_array_length(v_result) > p_max_items THEN
            RETURN v_result;
          END IF;
        END LOOP;
      ELSIF jsonb_typeof(v_match) = 'object' THEN
        v_result := v_result || jsonb_build_array(v_match);
        IF jsonb_array_length(v_result) > p_max_items THEN
          RETURN v_result;
        END IF;
      ELSE
        RAISE EXCEPTION 'safe_jsonpath_query_array_v1 collection items must be objects'
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'safe_jsonpath_query_array_v1 JSONPath evaluation failed'
        USING ERRCODE = '22023';
  END;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.safe_jsonpath_query_array_v1(JSONB, TEXT, INT)
  IS 'Deterministically extracts object collections through validated JSONPath, returning at most the configured maximum plus one sentinel item for fail-closed limit validation.';

CREATE OR REPLACE FUNCTION public.validate_logistics_customer_migration_profile_v1(
  p_mapping_rules JSONB,
  p_validation_rules JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_group_name TEXT;
  v_group JSONB;
  v_spec_name TEXT;
  v_spec JSONB;
  v_field_name TEXT;
  v_field_spec JSONB;
  v_path TEXT;
  v_required_collection JSONB;
  v_policy_name TEXT;
  v_policy_value JSONB;
  v_max_recipients INT;
  v_max_payload_bytes INT;
BEGIN
  IF jsonb_typeof(p_mapping_rules) IS DISTINCT FROM 'object'
     OR COALESCE((p_mapping_rules->>'version')::INT, 0) <> 1
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'mapping_rules_version_invalid');
  END IF;

  IF jsonb_typeof(p_mapping_rules->'objects') IS DISTINCT FROM 'object'
     OR NOT (p_mapping_rules->'objects' ? 'client')
     OR jsonb_typeof(p_mapping_rules->'collections') IS DISTINCT FROM 'object'
     OR NOT (p_mapping_rules->'collections' ? 'recipients')
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'mapping_rules_target_contract_invalid');
  END IF;

  FOR v_group_name, v_group IN
    SELECT key, value
      FROM jsonb_each(jsonb_build_object(
        'objects', p_mapping_rules->'objects',
        'collections', p_mapping_rules->'collections'
      ))
  LOOP
    FOR v_spec_name, v_spec IN SELECT key, value FROM jsonb_each(v_group)
    LOOP
      IF jsonb_typeof(v_spec) IS DISTINCT FROM 'object'
         OR NULLIF(btrim(COALESCE(v_spec->>'source_path', '')), '') IS NULL
         OR jsonb_typeof(v_spec->'field_mappings') IS DISTINCT FROM 'object'
         OR v_spec->'field_mappings' = '{}'::jsonb
      THEN
        RETURN jsonb_build_object(
          'ok', FALSE,
          'code', 'mapping_spec_invalid',
          'target', v_group_name || '.' || v_spec_name
        );
      END IF;

      BEGIN
        PERFORM (v_spec->>'source_path')::jsonpath;
      EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object(
          'ok', FALSE,
          'code', 'mapping_source_path_invalid',
          'target', v_group_name || '.' || v_spec_name
        );
      END;

      FOR v_field_name, v_field_spec IN SELECT key, value FROM jsonb_each(v_spec->'field_mappings')
      LOOP
        IF jsonb_typeof(v_field_spec) NOT IN ('string', 'array') THEN
          RETURN jsonb_build_object(
            'ok', FALSE,
            'code', 'mapping_field_path_invalid',
            'target', v_group_name || '.' || v_spec_name || '.' || v_field_name
          );
        END IF;

        BEGIN
          FOR v_path IN
            SELECT value
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(v_field_spec) = 'string' THEN jsonb_build_array(v_field_spec)
                  ELSE v_field_spec
                END
              ) AS candidate(value)
          LOOP
            IF NULLIF(btrim(v_path), '') IS NULL THEN
              RAISE EXCEPTION 'empty JSONPath';
            END IF;
            PERFORM v_path::jsonpath;
          END LOOP;
        EXCEPTION WHEN OTHERS THEN
          RETURN jsonb_build_object(
            'ok', FALSE,
            'code', 'mapping_field_path_invalid',
            'target', v_group_name || '.' || v_spec_name || '.' || v_field_name
          );
        END;
      END LOOP;
    END LOOP;
  END LOOP;

  IF jsonb_typeof(p_validation_rules) IS DISTINCT FROM 'object'
     OR COALESCE((p_validation_rules->>'version')::INT, 0) <> 1
     OR jsonb_typeof(p_validation_rules->'required_paths') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_validation_rules->'required_collections') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_validation_rules->'conflict_policy') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_validation_rules->'limits') IS DISTINCT FROM 'object'
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'validation_rules_contract_invalid');
  END IF;

  IF jsonb_typeof(p_validation_rules#>'{limits,max_recipients}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_validation_rules#>'{limits,max_payload_bytes}') IS DISTINCT FROM 'number'
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'validation_limits_invalid');
  END IF;

  BEGIN
    v_max_recipients := (p_validation_rules#>>'{limits,max_recipients}')::INT;
    v_max_payload_bytes := (p_validation_rules#>>'{limits,max_payload_bytes}')::INT;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'validation_limits_invalid');
  END;

  IF v_max_recipients < 1
     OR v_max_recipients > 100
     OR v_max_payload_bytes < 1
     OR v_max_payload_bytes > 262144
  THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'validation_limits_invalid',
      'limits', p_validation_rules->'limits'
    );
  END IF;

  BEGIN
    FOR v_path IN SELECT value FROM jsonb_array_elements_text(p_validation_rules->'required_paths') AS required(value)
    LOOP
      PERFORM v_path::jsonpath;
    END LOOP;

    FOR v_required_collection IN SELECT value FROM jsonb_array_elements(p_validation_rules->'required_collections')
    LOOP
      IF jsonb_typeof(v_required_collection) IS DISTINCT FROM 'object'
         OR NULLIF(btrim(COALESCE(v_required_collection->>'path', '')), '') IS NULL
         OR jsonb_typeof(v_required_collection->'required_fields') IS DISTINCT FROM 'array'
         OR COALESCE((v_required_collection->>'min_items')::INT, 0) < 0
         OR COALESCE((v_required_collection->>'min_items')::INT, 0) > v_max_recipients
      THEN
        RAISE EXCEPTION 'required collection contract invalid';
      END IF;
      PERFORM (v_required_collection->>'path')::jsonpath;
      PERFORM value FROM jsonb_array_elements_text(v_required_collection->'required_fields');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'validation_jsonpath_invalid');
  END;

  FOR v_policy_name, v_policy_value IN SELECT key, value FROM jsonb_each(p_validation_rules->'conflict_policy')
  LOOP
    IF jsonb_typeof(v_policy_value) IS DISTINCT FROM 'string'
       OR lower(v_policy_value #>> '{}') <> 'fail'
    THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'conflict_policy_must_fail_closed', 'policy', v_policy_name);
    END IF;
  END LOOP;

  IF lower(COALESCE(p_validation_rules #>> '{conflict_policy,client_slug}', '')) <> 'fail'
     OR lower(COALESCE(p_validation_rules #>> '{conflict_policy,recipient_external_id}', '')) <> 'fail'
     OR lower(COALESCE(p_validation_rules #>> '{conflict_policy,recipient_phone_number}', '')) <> 'fail'
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'required_conflict_policy_missing');
  END IF;

  RETURN jsonb_build_object('ok', TRUE);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', FALSE, 'code', 'profile_contract_invalid');
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_logistics_customer_migration_profile_v1(
  p_payload JSONB,
  p_mapping_rules JSONB,
  p_max_items INT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_target TEXT;
  v_spec JSONB;
  v_source JSONB;
  v_item JSONB;
  v_items JSONB;
BEGIN
  FOR v_target, v_spec IN SELECT key, value FROM jsonb_each(p_mapping_rules->'objects')
  LOOP
    v_source := public.safe_jsonpath_query_first(p_payload, v_spec->>'source_path');
    v_result := jsonb_set(
      v_result,
      ARRAY[v_target],
      public.jsonb_extract_fields(
        CASE WHEN jsonb_typeof(v_source) = 'object' THEN v_source ELSE '{}'::jsonb END,
        v_spec->'field_mappings'
      ),
      TRUE
    );
  END LOOP;

  FOR v_target, v_spec IN SELECT key, value FROM jsonb_each(p_mapping_rules->'collections')
  LOOP
    v_items := '[]'::jsonb;
    v_source := public.safe_jsonpath_query_array_v1(
      p_payload,
      v_spec->>'source_path',
      p_max_items
    );
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_source)
    LOOP
      v_items := v_items || jsonb_build_array(
        public.jsonb_extract_fields(v_item, v_spec->'field_mappings')
      );
    END LOOP;
    v_result := jsonb_set(v_result, ARRAY[v_target], v_items, TRUE);
  END LOOP;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_logistics_customer_migration_mapped_v1(
  p_mapped JSONB,
  p_validation_rules JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_errors JSONB := '[]'::jsonb;
  v_path TEXT;
  v_value JSONB;
  v_collection_rule JSONB;
  v_collection JSONB;
  v_item JSONB;
  v_field TEXT;
  v_index INT;
  v_min_items INT;
  v_max_items INT;
BEGIN
  v_max_items := COALESCE(NULLIF(p_validation_rules#>>'{limits,max_recipients}', '')::INT, 0);

  FOR v_path IN SELECT value FROM jsonb_array_elements_text(p_validation_rules->'required_paths') AS required(value)
  LOOP
    v_value := public.safe_jsonpath_query_first(p_mapped, v_path);
    IF v_value IS NULL
       OR v_value = 'null'::jsonb
       OR (jsonb_typeof(v_value) = 'string' AND NULLIF(btrim(v_value #>> '{}'), '') IS NULL)
    THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('path', v_path, 'code', 'required'));
    END IF;
  END LOOP;

  FOR v_collection_rule IN SELECT value FROM jsonb_array_elements(p_validation_rules->'required_collections')
  LOOP
    v_path := v_collection_rule->>'path';
    v_min_items := COALESCE((v_collection_rule->>'min_items')::INT, 0);
    v_collection := public.safe_jsonpath_query_first(p_mapped, v_path);

    IF jsonb_typeof(v_collection) IS DISTINCT FROM 'array' THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('path', v_path, 'code', 'collection_required'));
      CONTINUE;
    END IF;

    IF jsonb_array_length(v_collection) < v_min_items THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'path', v_path,
        'code', 'min_items',
        'required', v_min_items,
        'actual', jsonb_array_length(v_collection)
      ));
    END IF;

    IF jsonb_array_length(v_collection) > v_max_items THEN
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'path', v_path,
        'code', 'max_items',
        'maximum', v_max_items,
        'actual', jsonb_array_length(v_collection)
      ));
      CONTINUE;
    END IF;

    FOR v_item, v_index IN
      SELECT value, ordinality::INT
        FROM jsonb_array_elements(v_collection) WITH ORDINALITY
    LOOP
      FOR v_field IN SELECT value FROM jsonb_array_elements_text(v_collection_rule->'required_fields') AS required(value)
      LOOP
        v_value := v_item->v_field;
        IF v_value IS NULL
           OR v_value = 'null'::jsonb
           OR (jsonb_typeof(v_value) = 'string' AND NULLIF(btrim(v_value #>> '{}'), '') IS NULL)
        THEN
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'path', format('%s[%s].%s', v_path, v_index - 1, v_field),
            'code', 'required'
          ));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_errors) = 0,
    'errors', v_errors,
    'clients', CASE WHEN jsonb_typeof(p_mapped->'client') = 'object' THEN 1 ELSE 0 END,
    'recipients', CASE WHEN jsonb_typeof(p_mapped->'recipients') = 'array' THEN jsonb_array_length(p_mapped->'recipients') ELSE 0 END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_logistics_customer_migration_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_import_job_id UUID;
  v_runtime_run public.workflow_runs%ROWTYPE;
  v_runtime_step public.workflow_run_steps%ROWTYPE;
  v_engine_lineage_ok BOOLEAN := FALSE;
  v_request public.logistics_migration_requests%ROWTYPE;
  v_job public.import_jobs%ROWTYPE;
  v_source public.logistics_migration_sources%ROWTYPE;
  v_profile public.logistics_migration_profiles%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_binding public.integration_plugin_bindings%ROWTYPE;
  v_readiness JSONB;
  v_payload JSONB := COALESCE(p_operation_result->'payload', '{}'::jsonb);
  v_dry_run BOOLEAN := COALESCE((p_operation_result->>'dry_run')::BOOLEAN, FALSE);
  v_mode TEXT := CASE WHEN COALESCE((p_operation_result->>'dry_run')::BOOLEAN, FALSE) THEN 'dry_run' ELSE 'execute' END;
  v_max_recipients INT;
  v_max_payload_bytes INT;
  v_payload_bytes INT;
  v_expected_run_id UUID;
  v_profile_contract JSONB;
  v_config_hash TEXT;
  v_payload_hash TEXT;
  v_mapped JSONB;
  v_validation JSONB;
  v_validation_errors JSONB := '[]'::jsonb;
  v_client JSONB;
  v_recipients JSONB;
  v_recipient JSONB;
  v_recipient_index INT;
  v_recipient_count INT := 0;
  v_client_result JSONB;
  v_recipient_result JSONB;
  v_imported_client_id UUID;
  v_imported_recipient_id UUID;
  v_imported_recipient_ids JSONB := '[]'::jsonb;
  v_item_id UUID;
  v_item_ids JSONB := '[]'::jsonb;
  v_seen_external_ids TEXT[] := ARRAY[]::TEXT[];
  v_seen_phone_numbers TEXT[] := ARRAY[]::TEXT[];
  v_external_id TEXT;
  v_phone_number TEXT;
  v_redaction_summary JSONB;
  v_result_summary JSONB;
  v_decision_id UUID := gen_random_uuid();
  v_response workflow_handler_response;
  v_error_state TEXT;
BEGIN
  IF p_run.id IS NULL
     OR p_step.id IS NULL
     OR COALESCE(NULLIF(current_setting('masarx.workflow_engine', TRUE), ''), '0') <> '1'
     OR COALESCE(NULLIF(current_setting('app.workflow_run_id', TRUE), ''), '') <> p_run.id::TEXT
     OR COALESCE(NULLIF(current_setting('app.workflow_run_step_id', TRUE), ''), '') <> p_step.id::TEXT
     OR COALESCE(NULLIF(current_setting('masarx.workflow_run_step_id', TRUE), ''), '') <> p_step.id::TEXT
  THEN
    v_response.status := 'failed';
    v_response.operation_result := jsonb_build_object(
      'error', jsonb_build_object('code', 'workflow_engine_context_required')
    );
    v_response.context_patch := '{}'::jsonb;
    v_response.last_error := 'workflow_engine_context_required';
    RETURN v_response;
  END IF;

  SELECT *
    INTO v_runtime_run
    FROM public.workflow_runs
   WHERE id = p_run.id;

  SELECT *
    INTO v_runtime_step
    FROM public.workflow_run_steps
   WHERE id = p_step.id
     AND workflow_run_id = p_run.id;

  SELECT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts
        ON wts.workflow_template_id = wt.id
     WHERE wt.id = v_runtime_run.workflow_template_id
       AND wt.name = 'customer_logistics_migration_v1'
       AND wt.status = 'active'
       AND wts.id = v_runtime_step.workflow_template_step_id
       AND wts.sequence_order = 1
       AND wts.handler_key = 'logistics_customer_migration'
       AND wts.enabled IS TRUE
       AND v_runtime_run.workflow_status = 'in_progress'
       AND v_runtime_run.current_step_id = v_runtime_step.workflow_template_step_id
       AND v_runtime_step.step_status = 'in_progress'
       AND v_runtime_step.handler_key = 'logistics_customer_migration'
       AND v_runtime_step.operation_started_at IS NOT NULL
  )
    INTO v_engine_lineage_ok;

  IF v_runtime_run.id IS NULL
     OR v_runtime_step.id IS NULL
     OR v_engine_lineage_ok IS NOT TRUE
     OR NULLIF(v_runtime_run.context->>'import_job_id', '') IS NULL
  THEN
    v_response.status := 'failed';
    v_response.operation_result := jsonb_build_object(
      'error', jsonb_build_object('code', 'workflow_engine_lineage_mismatch')
    );
    v_response.context_patch := '{}'::jsonb;
    v_response.last_error := 'workflow_engine_lineage_mismatch';
    RETURN v_response;
  END IF;

  v_import_job_id := NULLIF(v_runtime_run.context->>'import_job_id', '')::UUID;

  IF v_import_job_id IS NULL THEN
    RAISE EXCEPTION 'execute_logistics_customer_migration_v1 requires import_job_id';
  END IF;

  SELECT * INTO v_request
    FROM public.logistics_migration_requests
   WHERE import_job_id = v_import_job_id
   FOR UPDATE;
  SELECT * INTO v_job FROM public.import_jobs WHERE id = v_import_job_id FOR UPDATE;

  IF v_request.import_job_id IS NULL OR v_job.id IS NULL THEN
    RAISE EXCEPTION 'customer migration import job % not found', v_import_job_id;
  END IF;

  SELECT * INTO v_source FROM public.logistics_migration_sources WHERE id = v_request.source_id;
  SELECT * INTO v_profile FROM public.logistics_migration_profiles WHERE id = v_request.profile_id;
  SELECT * INTO v_plugin FROM public.integration_plugins WHERE id = v_request.plugin_id;
  SELECT * INTO v_version FROM public.integration_plugin_versions WHERE id = v_request.plugin_version_id;
  SELECT * INTO v_binding FROM public.integration_plugin_bindings WHERE id = v_request.plugin_binding_id;

  v_expected_run_id := CASE
    WHEN v_dry_run THEN v_request.preview_workflow_run_id
    ELSE v_request.execution_workflow_run_id
  END;

  IF v_source.id IS NULL
     OR v_profile.id IS NULL
     OR v_plugin.id IS NULL
     OR v_version.id IS NULL
     OR v_binding.id IS NULL
     OR v_job.organization_id IS DISTINCT FROM v_request.organization_id
     OR v_job.kind IS DISTINCT FROM 'client_customer_migration'
     OR v_job.source IS DISTINCT FROM 'manual'
     OR v_job.status IS DISTINCT FROM 'queued'
     OR v_source.organization_id IS DISTINCT FROM v_request.organization_id
     OR v_source.status IS DISTINCT FROM 'active'
     OR v_source.plugin_key IS DISTINCT FROM 'customer-logistics-migration'
     OR v_profile.organization_id IS DISTINCT FROM v_request.organization_id
     OR v_profile.source_id IS DISTINCT FROM v_source.id
     OR v_profile.status IS DISTINCT FROM 'active'
     OR v_profile.target_entity IS DISTINCT FROM 'client_customer'
     OR v_source.plugin_id IS DISTINCT FROM v_plugin.id
     OR v_source.plugin_binding_id IS DISTINCT FROM v_binding.id
     OR v_plugin.organization_id IS DISTINCT FROM v_request.organization_id
     OR v_plugin.plugin_key IS DISTINCT FROM 'customer-logistics-migration'
     OR v_plugin.plugin_kind IS DISTINCT FROM 'api'
     OR v_plugin.status IS DISTINCT FROM 'active'
     OR v_plugin.active_version_id IS DISTINCT FROM v_version.id
     OR v_version.plugin_id IS DISTINCT FROM v_plugin.id
     OR v_version.status IS DISTINCT FROM 'active'
     OR COALESCE((v_version.validation_summary->>'ok')::BOOLEAN, FALSE) IS NOT TRUE
     OR v_binding.plugin_version_id IS DISTINCT FROM v_version.id
     OR v_binding.organization_id IS DISTINCT FROM v_request.organization_id
     OR lower(v_binding.scope_type) IS DISTINCT FROM 'tenant'
     OR v_binding.scope_id IS DISTINCT FROM v_request.organization_id
     OR v_binding.binding_type IS DISTINCT FROM 'api_route'
     OR v_binding.enabled IS NOT TRUE
     OR v_runtime_run.entry_point IS DISTINCT FROM 'manual'
     OR COALESCE(v_runtime_run.context->>'trigger_source', '') <> 'manual'
     OR COALESCE(v_runtime_run.context->>'source_id', '') <> v_request.source_id::TEXT
     OR COALESCE(v_runtime_run.context->>'profile_id', '') <> v_request.profile_id::TEXT
     OR COALESCE(v_runtime_run.context->>'plugin_id', '') <> v_request.plugin_id::TEXT
     OR COALESCE(v_runtime_run.context->>'plugin_version_id', '') <> v_request.plugin_version_id::TEXT
     OR COALESCE(v_runtime_run.context->>'plugin_binding_id', '') <> v_request.plugin_binding_id::TEXT
     OR COALESCE(v_runtime_run.context->>'profile_config_sha256', '') <> v_request.profile_config_sha256
     OR COALESCE(v_runtime_run.context->>'payload_sha256', '') <> v_request.payload_sha256
     OR COALESCE(v_runtime_run.context->>'external_batch_id', '') <> v_request.external_batch_id
     OR COALESCE(v_runtime_run.context->>'mode', '') <> v_mode
     OR COALESCE(v_runtime_run.context->>'contract', '') <> 'customer_logistics_migration_v1'
     OR v_expected_run_id IS DISTINCT FROM v_runtime_run.id
  THEN
    RAISE EXCEPTION 'customer migration canonical lineage mismatch';
  END IF;

  v_readiness := public.onboarding_integration_plugin_readiness_v1(
    'tenant',
    v_request.organization_id
  );
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(v_readiness->'items', '[]'::jsonb)
      ) AS readiness_item(value)
     WHERE readiness_item.value->>'plugin_key' = 'customer-logistics-migration'
       AND readiness_item.value->>'status' = 'healthy'
       AND readiness_item.value->>'plugin_id' = v_plugin.id::TEXT
       AND readiness_item.value->>'effective_version_id' = v_version.id::TEXT
       AND readiness_item.value->>'active_version_id' = v_version.id::TEXT
  ) THEN
    RAISE EXCEPTION 'customer migration canonical onboarding readiness blocked';
  END IF;

  v_profile_contract := public.validate_logistics_customer_migration_profile_v1(
    v_profile.mapping_rules,
    v_profile.validation_rules
  );
  IF COALESCE((v_profile_contract->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'customer migration profile contract invalid';
  END IF;

  v_max_recipients := (v_profile.validation_rules#>>'{limits,max_recipients}')::INT;
  v_max_payload_bytes := (v_profile.validation_rules#>>'{limits,max_payload_bytes}')::INT;
  v_payload_bytes := octet_length(v_payload::TEXT);

  v_config_hash := public.integration_plugin_hash_payload_v1(jsonb_build_object(
    'source_id', v_source.id,
    'profile_id', v_profile.id,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'mapping_rules', v_profile.mapping_rules,
    'validation_rules', v_profile.validation_rules
  ));
  v_payload_hash := public.integration_plugin_hash_payload_v1(v_payload);

  IF v_config_hash <> v_request.profile_config_sha256
     OR v_payload_hash <> v_request.payload_sha256
  THEN
    RAISE EXCEPTION 'customer migration execution identity mismatch';
  END IF;

  v_validation_errors := '[]'::jsonb;
  IF v_payload_bytes > v_max_payload_bytes THEN
    v_mapped := '{}'::jsonb;
    v_validation_errors := jsonb_build_array(jsonb_build_object(
      'path', '$',
      'code', 'max_payload_bytes',
      'maximum', v_max_payload_bytes,
      'actual', v_payload_bytes
    ));
  ELSE
    v_mapped := public.apply_logistics_customer_migration_profile_v1(
      v_payload,
      v_profile.mapping_rules,
      v_max_recipients
    );
  END IF;

  v_client := COALESCE(v_mapped->'client', '{}'::jsonb);
  v_recipients := COALESCE(v_mapped->'recipients', '[]'::jsonb);
  v_recipient_count := CASE WHEN jsonb_typeof(v_recipients) = 'array' THEN jsonb_array_length(v_recipients) ELSE 0 END;

  IF jsonb_array_length(v_validation_errors) = 0
     AND v_recipient_count > v_max_recipients
  THEN
    v_validation_errors := v_validation_errors || jsonb_build_array(jsonb_build_object(
      'path', '$.recipients',
      'code', 'max_items',
      'maximum', v_max_recipients,
      'actual', v_recipient_count
    ));
  END IF;

  IF jsonb_array_length(v_validation_errors) = 0 THEN
    v_validation := public.validate_logistics_customer_migration_mapped_v1(v_mapped, v_profile.validation_rules);
    v_validation_errors := COALESCE(v_validation->'errors', '[]'::jsonb);
  ELSE
    v_validation := jsonb_build_object('ok', FALSE, 'errors', v_validation_errors);
  END IF;

  IF lower(v_profile.validation_rules #>> '{conflict_policy,client_slug}') = 'fail'
     AND NULLIF(btrim(COALESCE(v_client->>'slug', '')), '') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.clients c
        WHERE c.organization_id = v_request.organization_id
          AND lower(c.slug) = lower(v_client->>'slug')
     )
  THEN
    v_validation_errors := v_validation_errors || jsonb_build_array(
      jsonb_build_object('path', '$.client.slug', 'code', 'target_conflict')
    );
  END IF;

  FOR v_recipient, v_recipient_index IN
    SELECT value, ordinality::INT FROM jsonb_array_elements(v_recipients) WITH ORDINALITY
  LOOP
    v_external_id := NULLIF(btrim(COALESCE(v_recipient->>'external_id', '')), '');
    v_phone_number := NULLIF(btrim(COALESCE(v_recipient->>'phone_number', '')), '');

    IF lower(v_profile.validation_rules #>> '{conflict_policy,recipient_external_id}') = 'fail'
       AND v_external_id IS NOT NULL
    THEN
      IF v_external_id = ANY(v_seen_external_ids)
         OR EXISTS (
           SELECT 1 FROM public.recipients r
            WHERE r.organization_id = v_request.organization_id
              AND r.external_id = v_external_id
         )
      THEN
        v_validation_errors := v_validation_errors || jsonb_build_array(
          jsonb_build_object('path', format('$.recipients[%s].external_id', v_recipient_index - 1), 'code', 'target_conflict')
        );
      ELSE
        v_seen_external_ids := array_append(v_seen_external_ids, v_external_id);
      END IF;
    END IF;

    IF lower(v_profile.validation_rules #>> '{conflict_policy,recipient_phone_number}') = 'fail'
       AND v_phone_number IS NOT NULL
    THEN
      IF v_phone_number = ANY(v_seen_phone_numbers)
         OR EXISTS (
           SELECT 1 FROM public.recipients r
            WHERE r.organization_id = v_request.organization_id
              AND r.phone_number = v_phone_number
         )
      THEN
        v_validation_errors := v_validation_errors || jsonb_build_array(
          jsonb_build_object('path', format('$.recipients[%s].phone_number', v_recipient_index - 1), 'code', 'target_conflict')
        );
      ELSE
        v_seen_phone_numbers := array_append(v_seen_phone_numbers, v_phone_number);
      END IF;
    END IF;
  END LOOP;

  v_validation := v_validation || jsonb_build_object(
    'ok', jsonb_array_length(v_validation_errors) = 0,
    'errors', v_validation_errors,
    'limits', jsonb_build_object(
      'max_recipients', v_max_recipients,
      'max_payload_bytes', v_max_payload_bytes,
      'payload_bytes', v_payload_bytes
    )
  );
  v_redaction_summary := jsonb_build_object(
    'secret_fields_redacted', CASE WHEN public.redact_sensitive_json(v_payload) IS DISTINCT FROM v_payload THEN 1 ELSE 0 END,
    'payload_sample', 'not_stored'
  );

  IF jsonb_array_length(v_validation_errors) > 0 THEN
    UPDATE public.import_jobs
       SET status = 'failed',
           started_at = COALESCE(started_at, now()),
           completed_at = now(),
           row_count = 1 + v_recipient_count,
           error_count = jsonb_array_length(v_validation_errors),
           error_summary = jsonb_build_object('code', 'validation_failed', 'errors', v_validation_errors),
           updated_at = now()
     WHERE id = v_import_job_id;

    UPDATE public.logistics_migration_requests
       SET decision_log_id = v_decision_id,
           validation_summary = v_validation,
           result_summary = jsonb_build_object('preview', v_dry_run, 'imported_clients', 0, 'imported_recipients', 0),
           redaction_summary = v_redaction_summary,
           updated_at = now()
     WHERE import_job_id = v_import_job_id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, decision_reason,
      performed_by_system, correlation_id, timestamp
    ) VALUES (
      v_decision_id, v_request.organization_id, 'imports.validate', 'import_job', v_import_job_id,
      'execute_logistics_customer_migration_v1', 'failed',
      jsonb_build_object('mode', v_mode, 'error_count', jsonb_array_length(v_validation_errors)),
      'Stored migration validation rules failed closed.', 'workflow_engine', p_run.id, now()
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_request.organization_id, 'import_job.failed', 'import_job', v_import_job_id,
      jsonb_build_object('mode', v_mode, 'code', 'validation_failed'), p_run.id, 'pending'
    );

    v_response.status := 'failed';
    v_response.operation_result := jsonb_build_object(
      'import_job_id', v_import_job_id,
      'mode', v_mode,
      'validation_summary', v_validation,
      'redaction_summary', v_redaction_summary,
      'error', jsonb_build_object('code', 'validation_failed')
    );
    v_response.context_patch := jsonb_build_object('import_job_id', v_import_job_id, 'mode', v_mode);
    v_response.last_error := 'validation_failed';
    RETURN v_response;
  END IF;

  INSERT INTO public.logistics_migration_items (
    import_job_id, organization_id, item_key, target_type, target_id,
    external_id, status, result_summary, raw_sha256
  ) VALUES (
    v_import_job_id, v_request.organization_id, 'client', 'client', NULL,
    NULLIF(v_client->>'slug', ''), CASE WHEN v_dry_run THEN 'would_create' ELSE 'created' END,
    jsonb_build_object('mapped', TRUE), public.integration_plugin_hash_payload_v1(v_client)
  )
  ON CONFLICT (import_job_id, item_key) DO UPDATE
     SET target_id = EXCLUDED.target_id,
         external_id = EXCLUDED.external_id,
         status = EXCLUDED.status,
         result_summary = EXCLUDED.result_summary,
         raw_sha256 = EXCLUDED.raw_sha256,
         updated_at = now()
  RETURNING id INTO v_item_id;
  v_item_ids := v_item_ids || jsonb_build_array(v_item_id);

  IF v_dry_run THEN
    FOR v_recipient, v_recipient_index IN
      SELECT value, ordinality::INT FROM jsonb_array_elements(v_recipients) WITH ORDINALITY
    LOOP
      INSERT INTO public.logistics_migration_items (
        import_job_id, organization_id, item_key, target_type, target_id,
        external_id, status, result_summary, raw_sha256
      ) VALUES (
        v_import_job_id, v_request.organization_id, format('recipient:%s', v_recipient_index),
        'recipient', NULL, NULLIF(v_recipient->>'external_id', ''), 'would_create',
        jsonb_build_object('mapped', TRUE), public.integration_plugin_hash_payload_v1(v_recipient)
      )
      ON CONFLICT (import_job_id, item_key) DO UPDATE
         SET target_id = NULL,
             external_id = EXCLUDED.external_id,
             status = 'would_create',
             result_summary = EXCLUDED.result_summary,
             raw_sha256 = EXCLUDED.raw_sha256,
             updated_at = now()
      RETURNING id INTO v_item_id;
      v_item_ids := v_item_ids || jsonb_build_array(v_item_id);
    END LOOP;

    v_result_summary := jsonb_build_object(
      'preview', TRUE,
      'would_create_clients', 1,
      'would_import_recipients', v_recipient_count
    );

    UPDATE public.import_jobs
       SET status = 'queued',
           row_count = 1 + v_recipient_count,
           error_count = 0,
           error_summary = '{}'::jsonb,
           updated_at = now()
     WHERE id = v_import_job_id;
  ELSE
    UPDATE public.import_jobs
       SET status = 'running',
           started_at = COALESCE(started_at, now()),
           completed_at = NULL,
           row_count = 1 + v_recipient_count,
           error_count = 0,
           error_summary = '{}'::jsonb,
           updated_at = now()
     WHERE id = v_import_job_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_request.organization_id, 'import_job.running', 'import_job', v_import_job_id,
      jsonb_build_object('kind', v_job.kind, 'source', v_job.source), p_run.id, 'pending'
    );

    v_client_result := public.client_create_v1(jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_request.organization_id,
      'name', v_client->>'name',
      'slug', v_client->>'slug',
      'sla_tier', NULLIF(v_client->>'sla_tier', ''),
      'settings_override', jsonb_build_object(
        'import_job_id', v_import_job_id,
        'migration_source_id', v_source.id,
        'migration_profile_id', v_profile.id
      )
    )));
    v_imported_client_id := NULLIF(v_client_result->>'client_id', '')::UUID;

    UPDATE public.logistics_migration_items
       SET target_id = v_imported_client_id,
           status = 'created',
           result_summary = jsonb_build_object('client_id', v_imported_client_id),
           updated_at = now()
     WHERE import_job_id = v_import_job_id
       AND item_key = 'client';

    FOR v_recipient, v_recipient_index IN
      SELECT value, ordinality::INT FROM jsonb_array_elements(v_recipients) WITH ORDINALITY
    LOOP
      v_recipient_result := public.recipient_create_v1(jsonb_strip_nulls(jsonb_build_object(
        'client_id', v_imported_client_id,
        'external_id', NULLIF(v_recipient->>'external_id', ''),
        'name', v_recipient->>'name',
        'phone_number', v_recipient->>'phone_number',
        'email', NULLIF(v_recipient->>'email', ''),
        'preferred_language', NULLIF(v_recipient->>'preferred_language', '')
      )));
      v_imported_recipient_id := NULLIF(v_recipient_result->>'recipient_id', '')::UUID;
      v_imported_recipient_ids := v_imported_recipient_ids || jsonb_build_array(v_imported_recipient_id);

      INSERT INTO public.logistics_migration_items (
        import_job_id, organization_id, item_key, target_type, target_id,
        external_id, status, result_summary, raw_sha256
      ) VALUES (
        v_import_job_id, v_request.organization_id, format('recipient:%s', v_recipient_index),
        'recipient', v_imported_recipient_id, NULLIF(v_recipient->>'external_id', ''), 'created',
        jsonb_build_object('recipient_id', v_imported_recipient_id),
        public.integration_plugin_hash_payload_v1(v_recipient)
      )
      ON CONFLICT (import_job_id, item_key) DO UPDATE
         SET target_id = EXCLUDED.target_id,
             external_id = EXCLUDED.external_id,
             status = 'created',
             result_summary = EXCLUDED.result_summary,
             raw_sha256 = EXCLUDED.raw_sha256,
             updated_at = now()
      RETURNING id INTO v_item_id;
      v_item_ids := v_item_ids || jsonb_build_array(v_item_id);
    END LOOP;

    v_result_summary := jsonb_build_object(
      'preview', FALSE,
      'imported_clients', 1,
      'imported_recipients', jsonb_array_length(v_imported_recipient_ids)
    );

    UPDATE public.import_jobs
       SET status = 'completed',
           completed_at = now(),
           row_count = 1 + v_recipient_count,
           error_count = 0,
           error_summary = '{}'::jsonb,
           updated_at = now()
     WHERE id = v_import_job_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id, timestamp
  ) VALUES (
    v_decision_id, v_request.organization_id, 'imports.execute', 'import_job', v_import_job_id,
    'execute_logistics_customer_migration_v1', CASE WHEN v_dry_run THEN 'validated' ELSE 'completed' END,
    jsonb_build_object('mode', v_mode, 'source_id', v_source.id, 'profile_id', v_profile.id),
    'Workflow-engine customer logistics migration.', 'workflow_engine', p_run.id, now()
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_request.organization_id,
    CASE WHEN v_dry_run THEN 'import_job.preview_validated' ELSE 'import_job.completed' END,
    'import_job', v_import_job_id,
    jsonb_build_object('mode', v_mode, 'row_count', 1 + v_recipient_count), p_run.id, 'pending'
  );

  UPDATE public.logistics_migration_requests
     SET imported_client_id = v_imported_client_id,
         decision_log_id = v_decision_id,
         validation_summary = v_validation,
         result_summary = v_result_summary,
         redaction_summary = v_redaction_summary,
         updated_at = now()
   WHERE import_job_id = v_import_job_id;

  v_response.status := 'completed';
  v_response.workflow_status := 'completed';
  v_response.operation_result := jsonb_build_object(
    'import_job_id', v_import_job_id,
    'mode', v_mode,
    'imported_client_id', v_imported_client_id,
    'imported_recipient_ids', v_imported_recipient_ids,
    'migration_item_ids', v_item_ids,
    'decision_log_id', v_decision_id,
    'validation_summary', v_validation,
    'result_summary', v_result_summary,
    'redaction_summary', v_redaction_summary
  );
  v_response.context_patch := jsonb_build_object(
    'import_job_id', v_import_job_id,
    'mode', v_mode,
    'result_summary', v_result_summary
  );
  RETURN v_response;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_error_state = RETURNED_SQLSTATE;
  v_decision_id := gen_random_uuid();

  IF v_import_job_id IS NOT NULL THEN
    UPDATE public.import_jobs
       SET status = 'failed',
           started_at = COALESCE(started_at, now()),
           completed_at = now(),
           error_count = GREATEST(COALESCE(error_count, 0), 1),
           error_summary = jsonb_build_object('code', 'migration_execution_failed', 'sqlstate', v_error_state),
           updated_at = now()
     WHERE id = v_import_job_id;

    UPDATE public.logistics_migration_requests
       SET decision_log_id = v_decision_id,
           result_summary = jsonb_build_object('preview', v_dry_run, 'failed', TRUE),
           updated_at = now()
     WHERE import_job_id = v_import_job_id;

    IF v_request.organization_id IS NOT NULL THEN
      INSERT INTO public.decision_log (
        id, organization_id, decision_category, resource_type, resource_id,
        decision_point, decision_outcome, decision_inputs, decision_reason,
        performed_by_system, correlation_id, timestamp
      ) VALUES (
        v_decision_id, v_request.organization_id, 'imports.execute', 'import_job', v_import_job_id,
        'execute_logistics_customer_migration_v1', 'failed',
        jsonb_build_object('mode', v_mode, 'sqlstate', v_error_state),
        'Migration execution failed closed.', 'workflow_engine', p_run.id, now()
      );

      INSERT INTO public.domain_events (
        organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
      ) VALUES (
        v_request.organization_id, 'import_job.failed', 'import_job', v_import_job_id,
        jsonb_build_object('mode', v_mode, 'code', 'migration_execution_failed'), p_run.id, 'pending'
      );
    END IF;
  END IF;

  v_response.status := 'failed';
  v_response.operation_result := jsonb_build_object(
    'import_job_id', v_import_job_id,
    'mode', v_mode,
    'decision_log_id', v_decision_id,
    'error', jsonb_build_object('code', 'migration_execution_failed')
  );
  v_response.context_patch := jsonb_build_object('import_job_id', v_import_job_id, 'mode', v_mode);
  v_response.last_error := 'migration_execution_failed';
  RETURN v_response;
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
VALUES (
  'logistics_customer_migration',
  'workflow_handlers',
  'execute_logistics_customer_migration_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Execute config-driven client and recipient migration through import_jobs SSOT.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
   SET handler_schema = EXCLUDED.handler_schema,
       handler_name = EXCLUDED.handler_name,
       handler_signature = EXCLUDED.handler_signature,
       handler_version = EXCLUDED.handler_version,
       is_active = EXCLUDED.is_active,
       notes = EXCLUDED.notes,
       doc_url = EXCLUDED.doc_url,
       updated_at = now();

DO $workflow$
DECLARE
  v_template_id UUID;
BEGIN
  INSERT INTO public.workflow_templates AS wt (
    name, description, version, status, scope_type, scope_id,
    published_at, notes, steps_checksum, created_at, updated_at
  ) VALUES (
    'customer_logistics_migration_v1',
    'Config-driven client and recipient migration through canonical import and product lifecycles.',
    1,
    'active',
    'global',
    NULL,
    now(),
    'workflow-engine customer logistics migration.',
    public.integration_plugin_hash_payload_v1(jsonb_build_object(
      'operation_name', 'customer_logistics_migration_v1',
      'handler_key', 'logistics_customer_migration',
      'handler_version', 'v1'
    )),
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
     SET description = EXCLUDED.description,
         version = EXCLUDED.version,
         status = EXCLUDED.status,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         published_at = COALESCE(wt.published_at, EXCLUDED.published_at),
         notes = EXCLUDED.notes,
         steps_checksum = EXCLUDED.steps_checksum,
         updated_at = now()
  RETURNING id INTO v_template_id;

  DELETE FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled,
    created_at,
    updated_at
  ) VALUES (
    v_template_id,
    1,
    'customer_logistics_migration_v1',
    'integration_plugin',
    'always',
    'logistics_customer_migration',
    'v1',
    jsonb_build_object(
      'lifecycle_ssot', 'import_jobs',
      'mapping_source', 'logistics_migration_profiles',
      'decision_event', 'import_job.customer_logistics_migration'
    ),
    TRUE,
    now(),
    now()
  );
END;
$workflow$;

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
  'customer-logistics-migration',
  'Customer Logistics Migration',
  'Required tenant operator plugin for config-driven client and recipient migration.',
  'api',
  TRUE,
  'auto_activate',
  jsonb_build_object('allow_external_side_effects', FALSE),
  'manual',
  jsonb_build_object(
    'contract', 'customer_logistics_migration_v1',
    'managed_by', 'onboarding_default'
  ),
  jsonb_build_object(
    'route', jsonb_build_object(
      'method', 'POST',
      'path_template', '/internal/customer-logistics-migration',
      'upstream_method', 'POST',
      'upstream_path_template', '/internal/customer-logistics-migration',
      'policy', jsonb_build_object(
        'auth', jsonb_build_object('mode', 'operator_session'),
        'customer_migration', jsonb_build_object('entrypoint', 'rpc_only')
      )
    )
  ),
  jsonb_build_object(
    'version', 1,
    'resolver', 'logistics_migration_profiles',
    'identity_fields', jsonb_build_array('source_id', 'profile_id', 'profile_config_sha256')
  ),
  jsonb_build_object('template_name', 'customer_logistics_migration_v1'),
  '[]'::jsonb,
  jsonb_build_object(
    'baseline_profile', 'default',
    'required', TRUE,
    'activation_mode', 'auto_activate',
    'readiness_owner', 'onboarding_integration_plugin_readiness_v1',
    'contract', 'customer_logistics_migration_v1'
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

CREATE OR REPLACE FUNCTION public.ui_upsert_logistics_customer_migration_config_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor UUID := auth.uid();
  v_org UUID;
  v_source_key TEXT := lower(regexp_replace(COALESCE(NULLIF(btrim(p_args->>'source_key'), ''), p_args->>'display_name', 'logistics-migration'), '[^a-zA-Z0-9]+', '-', 'g'));
  v_profile_key TEXT := lower(regexp_replace(COALESCE(NULLIF(btrim(p_args->>'profile_key'), ''), 'clients-and-customers'), '[^a-zA-Z0-9]+', '-', 'g'));
  v_display_name TEXT := NULLIF(btrim(COALESCE(p_args->>'display_name', '')), '');
  v_provider_name TEXT := NULLIF(btrim(COALESCE(p_args->>'provider_name', '')), '');
  v_profile_name TEXT := COALESCE(NULLIF(btrim(p_args->>'profile_display_name'), ''), 'Clients and customers');
  v_mapping_rules JSONB := COALESCE(p_args->'mapping_rules', '{}'::jsonb);
  v_validation_rules JSONB := COALESCE(p_args->'validation_rules', jsonb_build_object(
    'version', 1,
    'required_paths', jsonb_build_array('$.client.name', '$.client.slug'),
    'required_collections', jsonb_build_array(jsonb_build_object(
      'path', '$.recipients',
      'min_items', 1,
      'required_fields', jsonb_build_array('name', 'phone_number')
    )),
    'limits', jsonb_build_object(
      'max_recipients', 100,
      'max_payload_bytes', 262144
    ),
    'conflict_policy', jsonb_build_object(
      'client_slug', 'fail',
      'recipient_external_id', 'fail',
      'recipient_phone_number', 'fail'
    )
  ));
  v_redaction_profile JSONB := COALESCE(p_args->'redaction_profile', '{"fields":["api_key","password","token","secret","authorization"]}'::jsonb);
  v_plugin_key TEXT := 'customer-logistics-migration';
  v_plugin_id UUID;
  v_plugin_version_id UUID;
  v_plugin_binding_id UUID;
  v_source_id UUID;
  v_profile_id UUID;
  v_decision_log_id UUID := gen_random_uuid();
  v_profile_contract JSONB;
  v_readiness JSONB;
  v_config_hash TEXT;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'config_args_must_be_object'));
  END IF;

  IF jsonb_typeof(v_validation_rules) = 'object'
     AND NOT (v_validation_rules ? 'limits')
  THEN
    v_validation_rules := jsonb_set(
      v_validation_rules,
      '{limits}',
      jsonb_build_object('max_recipients', 100, 'max_payload_bytes', 262144),
      TRUE
    );
  END IF;

  v_org := public.current_user_org_id();
  IF v_actor IS NULL OR v_org IS NULL
     OR public.current_user_scope_type() IS DISTINCT FROM 'tenant'
     OR public.current_user_scope_id() IS DISTINCT FROM v_org THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'missing_operator_org'));
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('integration_plugins.write', 'tenant', v_org);
  PERFORM public.assert_capability_v1('integration_plugins.test', 'tenant', v_org);
  PERFORM public.assert_capability_v1('integration_plugins.approve', 'tenant', v_org);
  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_org);
  PERFORM public.assert_capability_v1('audit_log.read', 'tenant', v_org);

  v_source_key := COALESCE(NULLIF(btrim(v_source_key, '-'), ''), 'logistics-migration');
  v_profile_key := COALESCE(NULLIF(btrim(v_profile_key, '-'), ''), 'clients-and-customers');

  IF v_display_name IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'source_display_name_required'));
  END IF;
  v_profile_contract := public.validate_logistics_customer_migration_profile_v1(v_mapping_rules, v_validation_rules);
  IF COALESCE((v_profile_contract->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_profile_contract);
  END IF;

  PERFORM public.bootstrap_integration_plugin_defaults_v1(
    'tenant',
    v_org,
    'customer_logistics_migration_config'
  );
  v_readiness := public.onboarding_integration_plugin_readiness_v1('tenant', v_org);

  SELECT p.id, p.active_version_id, b.id
    INTO v_plugin_id, v_plugin_version_id, v_plugin_binding_id
    FROM public.integration_plugins p
    JOIN public.integration_plugin_versions v ON v.id = p.active_version_id
    JOIN public.integration_plugin_bindings b
      ON b.plugin_version_id = v.id
     AND lower(b.scope_type) = 'tenant'
     AND b.scope_id = v_org
     AND b.binding_type = 'api_route'
     AND b.enabled = TRUE
   WHERE p.organization_id = v_org
     AND b.organization_id = v_org
     AND p.plugin_key = v_plugin_key
     AND p.plugin_kind = 'api'
     AND p.status = 'active'
     AND v.status = 'active'
     AND COALESCE((v.validation_summary->>'ok')::BOOLEAN, FALSE) IS TRUE
   ORDER BY b.created_at DESC
   LIMIT 1;

  IF v_plugin_id IS NULL OR v_plugin_version_id IS NULL OR v_plugin_binding_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'onboarding_readiness', v_readiness,
      'error', jsonb_build_object('code', 'canonical_plugin_lifecycle_incomplete')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(v_readiness->'items', '[]'::jsonb)
      ) AS readiness_item(value)
     WHERE readiness_item.value->>'plugin_key' = v_plugin_key
       AND readiness_item.value->>'status' = 'healthy'
       AND readiness_item.value->>'plugin_id' = v_plugin_id::TEXT
       AND readiness_item.value->>'effective_version_id' = v_plugin_version_id::TEXT
       AND readiness_item.value->>'active_version_id' = v_plugin_version_id::TEXT
  ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'onboarding_readiness', v_readiness,
      'error', jsonb_build_object(
        'code', 'canonical_onboarding_readiness_blocked',
        'details', v_readiness
      )
    );
  END IF;

  INSERT INTO public.logistics_migration_sources (
    organization_id, source_key, display_name, plugin_key, plugin_id, plugin_binding_id,
    provider_name, auth_mode, redaction_profile, metadata
  ) VALUES (
    v_org, v_source_key, v_display_name, v_plugin_key, v_plugin_id, v_plugin_binding_id,
    v_provider_name, COALESCE(NULLIF(p_args->>'auth_mode', ''), 'api_key'), v_redaction_profile,
    jsonb_build_object('configured_by', v_actor, 'contract', 'customer_logistics_migration_v1')
  )
  ON CONFLICT (organization_id, source_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        plugin_key = EXCLUDED.plugin_key,
        plugin_id = EXCLUDED.plugin_id,
        plugin_binding_id = EXCLUDED.plugin_binding_id,
        provider_name = EXCLUDED.provider_name,
        auth_mode = EXCLUDED.auth_mode,
        redaction_profile = EXCLUDED.redaction_profile,
        status = 'active',
        metadata = COALESCE(public.logistics_migration_sources.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
  RETURNING id INTO v_source_id;

  INSERT INTO public.logistics_migration_profiles (
    organization_id, source_id, profile_key, display_name, target_entity, status, mapping_rules, validation_rules, metadata
  ) VALUES (
    v_org, v_source_id, v_profile_key, v_profile_name, 'client_customer', 'active',
    v_mapping_rules, v_validation_rules,
    jsonb_build_object('plugin_id', v_plugin_id, 'contract', 'customer_logistics_migration_v1')
  )
  ON CONFLICT (organization_id, source_id, profile_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        mapping_rules = EXCLUDED.mapping_rules,
        validation_rules = EXCLUDED.validation_rules,
        status = 'active',
        metadata = COALESCE(public.logistics_migration_profiles.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = now()
  RETURNING id INTO v_profile_id;

  v_config_hash := public.integration_plugin_hash_payload_v1(jsonb_build_object(
    'source_id', v_source_id,
    'profile_id', v_profile_id,
    'plugin_id', v_plugin_id,
    'plugin_version_id', v_plugin_version_id,
    'mapping_rules', v_mapping_rules,
    'validation_rules', v_validation_rules
  ));

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason, performed_by_system, correlation_id, timestamp
  ) VALUES (
    v_decision_log_id, v_org, 'integration_plugin.governance', 'logistics_migration_profile', v_profile_id,
    'ui_upsert_logistics_customer_migration_config_v1', 'updated',
    jsonb_build_object(
      'source_id', v_source_id,
      'profile_id', v_profile_id,
      'plugin_id', v_plugin_id,
      'plugin_version_id', v_plugin_version_id,
      'plugin_binding_id', v_plugin_binding_id,
      'profile_config_sha256', v_config_hash
    ),
    'migration source/profile saved after canonical plugin lifecycle readiness.',
    'console-v2', v_profile_id, now()
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_id', v_source_id,
    'profile_id', v_profile_id,
    'plugin_id', v_plugin_id,
    'plugin_version_id', v_plugin_version_id,
    'plugin_binding_id', v_plugin_binding_id,
    'decision_log_id', v_decision_log_id,
    'status', 'configured',
    'profile_config_sha256', v_config_hash,
    'onboarding_readiness', v_readiness,
    'mapping_summary', jsonb_build_object(
      'target_entity', 'client_customer',
      'profile_key', v_profile_key,
      'limits', v_validation_rules->'limits'
    ),
    'redaction_summary', jsonb_build_object('profile_fields', v_redaction_profile->'fields', 'payload_sample', 'not_stored')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_execute_logistics_customer_migration_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor UUID := auth.uid();
  v_org UUID;
  v_source public.logistics_migration_sources%ROWTYPE;
  v_profile public.logistics_migration_profiles%ROWTYPE;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
  v_binding public.integration_plugin_bindings%ROWTYPE;
  v_readiness JSONB;
  v_payload JSONB := COALESCE(p_args->'payload', '{}'::jsonb);
  v_dry_run BOOLEAN := COALESCE((p_args->>'dry_run')::BOOLEAN, TRUE);
  v_mode TEXT := CASE WHEN COALESCE((p_args->>'dry_run')::BOOLEAN, TRUE) THEN 'dry_run' ELSE 'execute' END;
  v_external_batch_id TEXT := NULLIF(btrim(COALESCE(p_args->>'external_batch_id', '')), '');
  v_request_key TEXT;
  v_existing public.logistics_migration_requests%ROWTYPE;
  v_job public.import_jobs%ROWTYPE;
  v_profile_contract JSONB;
  v_profile_config_hash TEXT;
  v_payload_hash TEXT;
  v_import_result JSONB;
  v_import_job_id UUID;
  v_workflow_template_id UUID;
  v_workflow_run_id UUID;
  v_progress_result JSONB;
  v_progress_status TEXT;
  v_progress_failure_code TEXT;
  v_workflow_status TEXT;
  v_identity_decision_id UUID;
  v_item_ids JSONB := '[]'::jsonb;
  v_recipient_ids JSONB := '[]'::jsonb;
  v_domain_event_ids JSONB := '[]'::jsonb;
BEGIN
  IF p_args IS NULL OR jsonb_typeof(p_args) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'migration_args_must_be_object'));
  END IF;

  v_org := public.current_user_org_id();
  IF v_actor IS NULL OR v_org IS NULL
     OR public.current_user_scope_type() IS DISTINCT FROM 'tenant'
     OR public.current_user_scope_id() IS DISTINCT FROM v_org THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'missing_operator_org'));
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('imports.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('imports.write', 'tenant', v_org);
  PERFORM public.assert_capability_v1('clients.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('recipients.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('audit_log.read', 'tenant', v_org);
  PERFORM public.assert_capability_v1('workflows.read', 'tenant', v_org);
  IF NOT v_dry_run THEN
    PERFORM public.assert_capability_v1('clients.write', 'tenant', v_org);
    PERFORM public.assert_capability_v1('recipients.write', 'tenant', v_org);
  END IF;

  IF v_external_batch_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'external_batch_id_required'));
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' OR v_payload = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'payload_object_required'));
  END IF;

  SELECT * INTO v_source
    FROM public.logistics_migration_sources
   WHERE id = NULLIF(p_args->>'source_id', '')::UUID
     AND organization_id = v_org
     AND status = 'active';
  IF v_source.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'source_not_found_or_inactive'));
  END IF;

  SELECT * INTO v_profile
    FROM public.logistics_migration_profiles
   WHERE id = NULLIF(p_args->>'profile_id', '')::UUID
     AND source_id = v_source.id
     AND organization_id = v_org
     AND status = 'active'
     AND target_entity = 'client_customer';
  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'profile_not_found_or_inactive'));
  END IF;

  SELECT * INTO v_plugin FROM public.integration_plugins WHERE id = v_source.plugin_id;
  SELECT * INTO v_version FROM public.integration_plugin_versions WHERE id = v_plugin.active_version_id;
  SELECT * INTO v_binding FROM public.integration_plugin_bindings WHERE id = v_source.plugin_binding_id;

  IF v_plugin.id IS NULL
     OR v_plugin.organization_id <> v_org
     OR v_plugin.plugin_key <> 'customer-logistics-migration'
     OR v_plugin.plugin_kind <> 'api'
     OR v_plugin.status <> 'active'
     OR v_version.id IS NULL
     OR v_version.status <> 'active'
     OR COALESCE((v_version.validation_summary->>'ok')::BOOLEAN, FALSE) IS NOT TRUE
     OR v_binding.id IS NULL
     OR v_binding.plugin_version_id <> v_version.id
     OR v_binding.organization_id <> v_org
     OR lower(v_binding.scope_type) <> 'tenant'
     OR v_binding.scope_id <> v_org
     OR v_binding.binding_type <> 'api_route'
     OR v_binding.enabled IS NOT TRUE
  THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'canonical_plugin_binding_not_ready'));
  END IF;

  v_readiness := public.onboarding_integration_plugin_readiness_v1('tenant', v_org);
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        COALESCE(v_readiness->'items', '[]'::jsonb)
      ) AS readiness_item(value)
     WHERE readiness_item.value->>'plugin_key' = 'customer-logistics-migration'
       AND readiness_item.value->>'status' = 'healthy'
       AND readiness_item.value->>'plugin_id' = v_plugin.id::TEXT
       AND readiness_item.value->>'effective_version_id' = v_version.id::TEXT
       AND readiness_item.value->>'active_version_id' = v_version.id::TEXT
  ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'onboarding_readiness', v_readiness,
      'error', jsonb_build_object(
        'code', 'canonical_onboarding_readiness_blocked',
        'details', v_readiness
      )
    );
  END IF;

  v_profile_contract := public.validate_logistics_customer_migration_profile_v1(
    v_profile.mapping_rules,
    v_profile.validation_rules
  );
  IF COALESCE((v_profile_contract->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_profile_contract);
  END IF;

  v_profile_config_hash := public.integration_plugin_hash_payload_v1(jsonb_build_object(
    'source_id', v_source.id,
    'profile_id', v_profile.id,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version.id,
    'mapping_rules', v_profile.mapping_rules,
    'validation_rules', v_profile.validation_rules
  ));
  v_payload_hash := public.integration_plugin_hash_payload_v1(v_payload);
  v_request_key := v_source.source_key || ':' || v_external_batch_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_external_batch_id, 0));

  SELECT * INTO v_existing
    FROM public.logistics_migration_requests
   WHERE organization_id = v_org
     AND external_batch_id = v_external_batch_id
   FOR UPDATE;

  IF v_existing.import_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM public.import_jobs WHERE id = v_existing.import_job_id FOR UPDATE;
    v_import_job_id := v_existing.import_job_id;

    IF v_existing.source_id <> v_source.id
       OR v_existing.profile_id <> v_profile.id
       OR v_existing.plugin_id <> v_plugin.id
       OR v_existing.plugin_version_id <> v_version.id
       OR v_existing.plugin_binding_id <> v_binding.id
       OR v_existing.profile_config_sha256 <> v_profile_config_hash
       OR v_existing.payload_sha256 <> v_payload_hash
    THEN
      v_identity_decision_id := gen_random_uuid();
      INSERT INTO public.decision_log (
        id, organization_id, decision_category, resource_type, resource_id,
        decision_point, decision_outcome, decision_inputs, decision_reason,
        performed_by_system, correlation_id, timestamp
      ) VALUES (
        v_identity_decision_id, v_org, 'imports.idempotency', 'import_job', v_import_job_id,
        'ui_execute_logistics_customer_migration_v1', 'rejected',
        jsonb_build_object(
          'requested_source_id', v_source.id,
          'existing_source_id', v_existing.source_id,
          'requested_profile_id', v_profile.id,
          'existing_profile_id', v_existing.profile_id,
          'requested_plugin_version_id', v_version.id,
          'existing_plugin_version_id', v_existing.plugin_version_id,
          'requested_profile_config_sha256', v_profile_config_hash,
          'existing_profile_config_sha256', v_existing.profile_config_sha256,
          'requested_payload_sha256', v_payload_hash,
          'existing_payload_sha256', v_existing.payload_sha256
        ),
        'External batch identity changed and was rejected fail closed.',
        'console-v2', v_import_job_id, now()
      );

      INSERT INTO public.domain_events (
        organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
      ) VALUES (
        v_org, 'import_job.idempotency_rejected', 'import_job', v_import_job_id,
        jsonb_build_object('external_batch_id', v_external_batch_id), v_import_job_id, 'pending'
      );

      SELECT COALESCE(jsonb_agg(id ORDER BY item_key), '[]'::jsonb),
             COALESCE(jsonb_agg(target_id ORDER BY item_key) FILTER (WHERE target_type = 'recipient' AND target_id IS NOT NULL), '[]'::jsonb)
        INTO v_item_ids, v_recipient_ids
        FROM public.logistics_migration_items
       WHERE import_job_id = v_import_job_id;

      SELECT COALESCE(jsonb_agg(id ORDER BY created_at), '[]'::jsonb)
        INTO v_domain_event_ids
        FROM public.domain_events
       WHERE resource_type = 'import_job'
         AND resource_id = v_import_job_id;

      RETURN jsonb_strip_nulls(jsonb_build_object(
        'ok', FALSE,
        'request_id', v_import_job_id,
        'import_job_id', v_import_job_id,
        'request_key', v_request_key,
        'status', v_job.status,
        'mode', v_mode,
        'plugin_id', v_existing.plugin_id,
        'plugin_version_id', v_existing.plugin_version_id,
        'plugin_binding_id', v_existing.plugin_binding_id,
        'imported_client_id', v_existing.imported_client_id,
        'imported_recipient_ids', v_recipient_ids,
        'workflow_run_id', COALESCE(
          CASE WHEN v_dry_run THEN v_existing.preview_workflow_run_id ELSE v_existing.execution_workflow_run_id END,
          v_existing.execution_workflow_run_id,
          v_existing.preview_workflow_run_id
        ),
        'decision_log_id', v_identity_decision_id,
        'domain_event_ids', v_domain_event_ids,
        'migration_item_ids', v_item_ids,
        'validation_summary', v_existing.validation_summary,
        'result_summary', v_existing.result_summary,
        'redaction_summary', v_existing.redaction_summary,
        'idempotency_reused', FALSE,
        'error', jsonb_build_object('code', 'idempotency_identity_mismatch')
      ));
    END IF;

    IF v_job.status IN ('completed', 'failed', 'cancelled')
       OR (v_dry_run AND v_existing.preview_workflow_run_id IS NOT NULL)
       OR (NOT v_dry_run AND v_existing.execution_workflow_run_id IS NOT NULL)
    THEN
      SELECT COALESCE(jsonb_agg(id ORDER BY item_key), '[]'::jsonb),
             COALESCE(jsonb_agg(target_id ORDER BY item_key) FILTER (WHERE target_type = 'recipient' AND target_id IS NOT NULL), '[]'::jsonb)
        INTO v_item_ids, v_recipient_ids
        FROM public.logistics_migration_items
       WHERE import_job_id = v_import_job_id;

      SELECT COALESCE(jsonb_agg(id ORDER BY created_at), '[]'::jsonb)
        INTO v_domain_event_ids
        FROM public.domain_events
       WHERE resource_type = 'import_job'
         AND resource_id = v_import_job_id;

      RETURN jsonb_strip_nulls(jsonb_build_object(
        'ok', CASE
          WHEN v_job.status IN ('failed', 'cancelled') THEN FALSE
          WHEN v_dry_run THEN COALESCE(v_job.status IN ('queued', 'completed'), FALSE)
          ELSE COALESCE(v_job.status = 'completed', FALSE)
        END,
        'request_id', v_import_job_id,
        'import_job_id', v_import_job_id,
        'request_key', v_request_key,
        'status', v_job.status,
        'mode', v_mode,
        'plugin_id', v_existing.plugin_id,
        'plugin_version_id', v_existing.plugin_version_id,
        'plugin_binding_id', v_existing.plugin_binding_id,
        'imported_client_id', v_existing.imported_client_id,
        'imported_recipient_ids', v_recipient_ids,
        'workflow_run_id', COALESCE(
          CASE WHEN v_dry_run THEN v_existing.preview_workflow_run_id ELSE v_existing.execution_workflow_run_id END,
          v_existing.execution_workflow_run_id,
          v_existing.preview_workflow_run_id
        ),
        'decision_log_id', v_existing.decision_log_id,
        'domain_event_ids', v_domain_event_ids,
        'migration_item_ids', v_item_ids,
        'validation_summary', v_existing.validation_summary,
        'result_summary', v_existing.result_summary,
        'redaction_summary', v_existing.redaction_summary,
        'idempotency_reused', TRUE,
        'error', CASE
          WHEN v_job.status = 'failed' THEN v_job.error_summary
          WHEN v_job.status = 'cancelled' THEN
            jsonb_build_object('code', 'import_job_cancelled')
          WHEN v_dry_run
               AND v_job.status IS DISTINCT FROM 'queued'
               AND v_job.status IS DISTINCT FROM 'completed'
            THEN jsonb_build_object('code', 'workflow_progress_not_terminal')
          WHEN NOT v_dry_run
               AND v_job.status IS DISTINCT FROM 'completed'
            THEN jsonb_build_object('code', 'workflow_progress_not_terminal')
          ELSE NULL
        END
      ));
    END IF;
  ELSE
    v_import_result := public.import_job_create_v1(jsonb_build_object(
      'kind', 'client_customer_migration',
      'source', 'manual'
    ));
    v_import_job_id := NULLIF(v_import_result->>'import_job_id', '')::UUID;

    INSERT INTO public.logistics_migration_requests (
      import_job_id, organization_id, source_id, profile_id, external_batch_id,
      plugin_id, plugin_version_id, plugin_binding_id, profile_config_sha256,
      payload_sha256, decision_log_id
    ) VALUES (
      v_import_job_id, v_org, v_source.id, v_profile.id, v_external_batch_id,
      v_plugin.id, v_version.id, v_binding.id, v_profile_config_hash,
      v_payload_hash, NULLIF(v_import_result->>'settings_resolution_id', '')::UUID
    );
  END IF;

  SELECT id INTO v_workflow_template_id
    FROM public.workflow_templates
   WHERE name = 'customer_logistics_migration_v1'
     AND status = 'active'
   ORDER BY version DESC, updated_at DESC
   LIMIT 1;
  IF v_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'customer_logistics_migration_v1 workflow template missing or inactive';
  END IF;

  v_workflow_run_id := public.start_workflow_run(
    v_workflow_template_id,
    jsonb_build_object(
      'trigger_source', 'manual',
      'organization_id', v_org,
      'import_job_id', v_import_job_id,
      'source_id', v_source.id,
      'profile_id', v_profile.id,
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version.id,
      'plugin_binding_id', v_binding.id,
      'profile_config_sha256', v_profile_config_hash,
      'payload_sha256', v_payload_hash,
      'external_batch_id', v_external_batch_id,
      'mode', v_mode,
      'contract', 'customer_logistics_migration_v1'
    )
  );

  IF v_dry_run THEN
    UPDATE public.logistics_migration_requests
       SET preview_workflow_run_id = v_workflow_run_id,
           updated_at = now()
     WHERE import_job_id = v_import_job_id;
  ELSE
    UPDATE public.logistics_migration_requests
       SET execution_workflow_run_id = v_workflow_run_id,
           updated_at = now()
     WHERE import_job_id = v_import_job_id;
  END IF;

  v_progress_result := public.progress_workflow_run(
    v_workflow_run_id,
    jsonb_build_object('payload', v_payload, 'dry_run', v_dry_run)
  );

  v_progress_status := lower(COALESCE(NULLIF(v_progress_result->>'status', ''), 'unknown'));
  SELECT workflow_status
    INTO v_workflow_status
    FROM public.workflow_runs
   WHERE id = v_workflow_run_id;
  SELECT *
    INTO v_job
    FROM public.import_jobs
   WHERE id = v_import_job_id
   FOR UPDATE;

  IF v_progress_status IS DISTINCT FROM 'completed'
     OR v_workflow_status IS DISTINCT FROM 'completed'
     OR (
       v_dry_run
       AND v_job.status IS DISTINCT FROM 'queued'
       AND v_job.status IS DISTINCT FROM 'failed'
       AND v_job.status IS DISTINCT FROM 'cancelled'
     )
     OR (
       NOT v_dry_run
       AND v_job.status IS DISTINCT FROM 'completed'
       AND v_job.status IS DISTINCT FROM 'failed'
       AND v_job.status IS DISTINCT FROM 'cancelled'
     )
  THEN
    v_progress_failure_code := CASE
      WHEN v_progress_status = 'failed' OR v_workflow_status = 'failed'
        THEN 'workflow_progress_failed'
      ELSE 'workflow_progress_not_terminal'
    END;

    IF v_job.status IS NULL
       OR (
         v_job.status IS DISTINCT FROM 'failed'
         AND v_job.status IS DISTINCT FROM 'cancelled'
       )
    THEN
      v_identity_decision_id := gen_random_uuid();

      UPDATE public.import_jobs
         SET status = 'failed',
             started_at = COALESCE(started_at, now()),
             completed_at = now(),
             error_count = GREATEST(COALESCE(error_count, 0), 1),
             error_summary = jsonb_build_object(
               'code', v_progress_failure_code,
               'workflow_progress_status', v_progress_status,
               'workflow_status', v_workflow_status
             ),
             updated_at = now()
       WHERE id = v_import_job_id;

      UPDATE public.logistics_migration_requests
         SET decision_log_id = v_identity_decision_id,
             result_summary = COALESCE(result_summary, '{}'::jsonb)
               || jsonb_build_object(
                 'failed', TRUE,
                 'mode', v_mode,
                 'workflow_progress_status', v_progress_status,
                 'workflow_status', v_workflow_status
               ),
             updated_at = now()
       WHERE import_job_id = v_import_job_id;

      INSERT INTO public.decision_log (
        id, organization_id, decision_category, resource_type, resource_id,
        decision_point, decision_outcome, decision_inputs, decision_reason,
        performed_by_system, correlation_id, timestamp
      ) VALUES (
        v_identity_decision_id,
        v_org,
        'imports.execute',
        'import_job',
        v_import_job_id,
        'ui_execute_logistics_customer_migration_v1',
        'failed',
        jsonb_build_object(
          'mode', v_mode,
          'workflow_run_id', v_workflow_run_id,
          'workflow_progress', v_progress_result,
          'workflow_status', v_workflow_status,
          'code', v_progress_failure_code
        ),
        'Canonical workflow progress did not complete the migration.',
        'workflow_engine',
        v_workflow_run_id,
        now()
      );

      INSERT INTO public.domain_events (
        organization_id, event_type, resource_type, resource_id, payload,
        workflow_run_id, correlation_id, status
      ) VALUES (
        v_org,
        'import_job.failed',
        'import_job',
        v_import_job_id,
        jsonb_build_object(
          'mode', v_mode,
          'code', v_progress_failure_code,
          'workflow_progress_status', v_progress_status,
          'workflow_status', v_workflow_status
        ),
        v_workflow_run_id,
        v_workflow_run_id,
        'pending'
      );
    END IF;
  END IF;

  SELECT * INTO v_existing
    FROM public.logistics_migration_requests
   WHERE import_job_id = v_import_job_id;
  SELECT * INTO v_job FROM public.import_jobs WHERE id = v_import_job_id;

  SELECT COALESCE(jsonb_agg(id ORDER BY item_key), '[]'::jsonb),
         COALESCE(jsonb_agg(target_id ORDER BY item_key) FILTER (WHERE target_type = 'recipient' AND target_id IS NOT NULL), '[]'::jsonb)
    INTO v_item_ids, v_recipient_ids
    FROM public.logistics_migration_items
   WHERE import_job_id = v_import_job_id;

  SELECT COALESCE(jsonb_agg(id ORDER BY created_at), '[]'::jsonb)
    INTO v_domain_event_ids
    FROM public.domain_events
   WHERE resource_type = 'import_job'
     AND resource_id = v_import_job_id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok',
      v_progress_status IS NOT DISTINCT FROM 'completed'
      AND v_workflow_status IS NOT DISTINCT FROM 'completed'
      AND CASE
        WHEN v_dry_run THEN v_job.status IS NOT DISTINCT FROM 'queued'
        ELSE v_job.status IS NOT DISTINCT FROM 'completed'
      END,
    'request_id', v_import_job_id,
    'import_job_id', v_import_job_id,
    'request_key', v_request_key,
    'status', v_job.status,
    'mode', v_mode,
    'plugin_id', v_existing.plugin_id,
    'plugin_version_id', v_existing.plugin_version_id,
    'plugin_binding_id', v_existing.plugin_binding_id,
    'imported_client_id', v_existing.imported_client_id,
    'imported_recipient_ids', v_recipient_ids,
    'workflow_run_id', v_workflow_run_id,
    'workflow_progress', v_progress_result,
    'workflow_status', v_workflow_status,
    'decision_log_id', v_existing.decision_log_id,
    'domain_event_ids', v_domain_event_ids,
    'migration_item_ids', v_item_ids,
    'validation_summary', v_existing.validation_summary,
    'result_summary', v_existing.result_summary,
    'redaction_summary', v_existing.redaction_summary,
    'idempotency_reused', FALSE,
    'error', CASE
      WHEN v_job.status = 'failed' THEN v_job.error_summary
      WHEN v_job.status = 'cancelled' THEN
        jsonb_build_object('code', 'import_job_cancelled')
      WHEN v_progress_failure_code IS NOT NULL THEN
        jsonb_build_object(
          'code', v_progress_failure_code,
          'workflow_progress_status', v_progress_status,
          'workflow_status', v_workflow_status
        )
      ELSE NULL
    END
  ));
END;
$function$;

CREATE SCHEMA IF NOT EXISTS api;

CREATE VIEW api.logistics_migration_sources WITH (security_invoker = true) AS
SELECT * FROM public.logistics_migration_sources;
CREATE VIEW api.logistics_migration_profiles WITH (security_invoker = true) AS
SELECT * FROM public.logistics_migration_profiles;
CREATE VIEW api.logistics_migration_requests WITH (security_invoker = true) AS
SELECT * FROM public.logistics_migration_requests;
CREATE VIEW api.logistics_migration_items WITH (security_invoker = true) AS
SELECT * FROM public.logistics_migration_items;
REVOKE ALL ON api.logistics_migration_sources, api.logistics_migration_profiles,
  api.logistics_migration_requests, api.logistics_migration_items FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
GRANT SELECT ON api.logistics_migration_sources, api.logistics_migration_profiles,
  api.logistics_migration_requests, api.logistics_migration_items TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_upsert_logistics_customer_migration_config_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_upsert_logistics_customer_migration_config_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_execute_logistics_customer_migration_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_execute_logistics_customer_migration_v1(p_args);
$$;

REVOKE EXECUTE ON FUNCTION public.safe_jsonpath_query_array_v1(JSONB, TEXT, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.validate_logistics_customer_migration_profile_v1(JSONB, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.apply_logistics_customer_migration_profile_v1(JSONB, JSONB, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.validate_logistics_customer_migration_mapped_v1(JSONB, JSONB) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps, workflow_runs, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps, workflow_runs, JSONB) FROM anon;
REVOKE ALL ON FUNCTION workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps, workflow_runs, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps, workflow_runs, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.ui_upsert_logistics_customer_migration_config_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ui_execute_logistics_customer_migration_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_upsert_logistics_customer_migration_config_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_execute_logistics_customer_migration_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_logistics_customer_migration_config_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_execute_logistics_customer_migration_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_upsert_logistics_customer_migration_config_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_execute_logistics_customer_migration_v1(JSONB) TO authenticated, service_role;

DO $registry$
DECLARE
  v_setting RECORD;
  v_resource JSONB;
  v_resources JSONB;
  v_payload JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'logistics_migration_sources',
      'label', 'Customer migration sources',
      'id_column', 'id',
      'read_scope_types', jsonb_build_array('tenant', 'platform'),
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'default_sort', jsonb_build_object('column','id','direction','asc'),
      'relation', 'public.v_logistics_migration_source_directory',
      'capability_read', 'integration_plugins.read',
      'capability_write', 'integration_plugins.write',
      'select', jsonb_build_array('id','organization_id','source_key','display_name','plugin_key','plugin_id','plugin_version_id','plugin_binding_id','plugin_version_no','plugin_status','plugin_version_status','plugin_binding_enabled','provider_name','status','auth_mode','redaction_profile','metadata','created_at','updated_at'),
      'filters', jsonb_build_array(jsonb_build_object('key','organization_id','column','organization_id','op','eq'), jsonb_build_object('key','status','column','status','op','eq'))
    ),
    jsonb_build_object(
      'key', 'logistics_migration_profiles',
      'label', 'Customer migration profiles',
      'id_column', 'id',
      'read_scope_types', jsonb_build_array('tenant', 'platform'),
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'default_sort', jsonb_build_object('column','id','direction','asc'),
      'relation', 'public.v_logistics_migration_profile_directory',
      'capability_read', 'integration_plugins.read',
      'capability_write', 'integration_plugins.write',
      'select', jsonb_build_array('id','organization_id','source_id','source_name','profile_key','display_name','target_entity','status','mapping_rules','validation_rules','metadata','created_at','updated_at'),
      'filters', jsonb_build_array(jsonb_build_object('key','organization_id','column','organization_id','op','eq'), jsonb_build_object('key','source_id','column','source_id','op','eq'), jsonb_build_object('key','status','column','status','op','eq'))
    ),
    jsonb_build_object(
      'key', 'logistics_migration_requests',
      'label', 'Customer migration requests',
      'id_column', 'id',
      'read_scope_types', jsonb_build_array('tenant', 'platform'),
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'default_sort', jsonb_build_object('column','id','direction','asc'),
      'relation', 'public.v_logistics_migration_request_directory',
      'capability_read', 'imports.read',
      'capability_write', 'imports.write',
      'select', jsonb_build_array('id','import_job_id','organization_id','source_id','source_name','profile_id','profile_name','request_key','mode','status','external_batch_id','profile_config_sha256','payload_sha256','plugin_id','plugin_version_id','plugin_binding_id','imported_client_id','imported_client_name','imported_recipient_ids','workflow_run_id','preview_workflow_run_id','execution_workflow_run_id','decision_log_id','validation_summary','result_summary','redaction_summary','error_summary','idempotency_key','created_at','updated_at'),
      'filters', jsonb_build_array(jsonb_build_object('key','organization_id','column','organization_id','op','eq'), jsonb_build_object('key','status','column','status','op','eq'), jsonb_build_object('key','mode','column','mode','op','eq'))
    ),
    jsonb_build_object(
      'key', 'logistics_migration_items',
      'label', 'Customer migration items',
      'id_column', 'id',
      'read_scope_types', jsonb_build_array('tenant', 'platform'),
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'default_sort', jsonb_build_object('column','id','direction','asc'),
      'relation', 'public.logistics_migration_items',
      'capability_read', 'imports.read',
      'capability_write', 'imports.write',
      'select', jsonb_build_array('id','import_job_id','item_key','organization_id','target_type','target_id','external_id','status','validation_errors','result_summary','raw_sha256','created_at','updated_at'),
      'filters', jsonb_build_array(jsonb_build_object('key','import_job_id','column','import_job_id','op','eq'), jsonb_build_object('key','target_type','column','target_type','op','eq'), jsonb_build_object('key','status','column','status','op','eq'))
    )
  );
BEGIN
  SELECT s.scope_type, s.scope_id, sv.value, sv.schema_version
    INTO STRICT v_setting
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      AND sv.category = s.category AND sv.scope_hash = s.scope_hash
      AND sv.value = s.cached_value
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL AND sv.approved_at IS NOT NULL AND sv.effective_until IS NULL
   FOR UPDATE OF s, sv;

  v_resources := v_setting.value->'resources';
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Customer migration requires an approved read registry';
  END IF;

  FOR v_resource IN SELECT value FROM jsonb_array_elements(v_payload) LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_resources) item WHERE item->>'key' = v_resource->>'key') THEN
      RAISE EXCEPTION 'Customer migration read resource already registered: %', v_resource->>'key';
    END IF;
  END LOOP;

  PERFORM public.upsert_settings_value_v1(
    'ui_read_registry', v_setting.scope_type, v_setting.scope_id,
    jsonb_set(v_setting.value, '{resources}', v_resources || v_payload),
    v_setting.schema_version, 'Register tenant-scoped customer migration readback'
  );

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%logistics_migration%';
END;
$registry$;

-- Extend the sealed executor receipt with only the new migration relations.
DO $receipt$
DECLARE
  prior_seal TEXT;
  prior_before JSONB;
  prior_after JSONB;
  added JSONB;
  current_plan JSONB;
  expected_after JSONB;
  digest TEXT;
BEGIN
  LOCK TABLE public.marketplace_review_readback_state_v1 IN EXCLUSIVE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.marketplace_review_readback_state_v1'::regclass)
      IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Customer migration receipt requires the existing receipt owner' USING ERRCODE = '42501';
  END IF;
  prior_seal := obj_description('public.marketplace_review_readback_state_v1'::regclass, 'pg_class');
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  IF prior_seal IS DISTINCT FROM 'marketplace_review_readback_state_v1:sha256:' || digest THEN
    RAISE EXCEPTION 'Marketplace predecessor receipt integrity mismatch';
  END IF;

  SELECT value INTO STRICT prior_before FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_before';
  SELECT value INTO STRICT prior_after FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_after';
  SELECT jsonb_agg(jsonb_build_object('object_kind', 'relation', 'object_id', oid,
    'privilege', 'SELECT', 'column_name', NULL) ORDER BY oid) INTO added
  FROM unnest(ARRAY[
    'public.logistics_migration_sources'::regclass::oid,
    'public.logistics_migration_profiles'::regclass::oid,
    'public.logistics_migration_requests'::regclass::oid,
    'public.logistics_migration_items'::regclass::oid,
    'public.v_logistics_migration_source_directory'::regclass::oid,
    'public.v_logistics_migration_profile_directory'::regclass::oid,
    'public.v_logistics_migration_request_directory'::regclass::oid
  ]) AS relations(oid);
  SELECT jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name) INTO current_plan
  FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
    entry->>'privilege', entry->>'column_name') INTO expected_after
  FROM jsonb_array_elements(prior_after || added) entry;
  IF current_plan IS DISTINCT FROM expected_after THEN
    RAISE EXCEPTION 'Unexpected executor plan delta for customer migration';
  END IF;

  INSERT INTO public.marketplace_review_readback_state_v1(key, value) VALUES ('customer_migration_extension_v1',
    jsonb_build_object('predecessor_seal', prior_seal, 'plan_before', prior_before, 'plan_after', prior_after, 'added', added));
  -- Both sides gain the shared relations while the marketplace-only delta stays intact.
  UPDATE public.marketplace_review_readback_state_v1 SET value = (
    SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
      entry->>'privilege', entry->>'column_name') FROM jsonb_array_elements(value || added) entry
  ) WHERE key IN ('plan_before', 'plan_after');
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.marketplace_review_readback_state_v1 IS %L',
    'marketplace_review_readback_state_v1:sha256:' || digest);
END;
$receipt$;

DO $navigation$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_route_item JSONB := jsonb_build_object(
    'id', 'integrations-customer-migration',
    'key', 'int-customer-migration',
    'label', 'Customer migration',
    'icon', 'upload',
    'href', '/integrations/customer-migration',
    'route', '/integrations/customer-migration',
    'resource', 'logistics_migration_requests',
    'capability', 'integration_plugins.read',
    'capabilities', jsonb_build_array('integration_plugins.read'),
    'capability_any', jsonb_build_array('integration_plugins.read')
  );
  v_found_section BOOLEAN;
  v_found_item BOOLEAN;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           s.scope_type, s.scope_id, sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
        AND sv.category = s.category AND sv.scope_hash = s.scope_hash
        AND sv.value = s.cached_value
     WHERE s.category = 'ui_navigation'
       AND sv.approved_at IS NOT NULL AND sv.effective_until IS NULL
       AND jsonb_typeof(sv.value#>'{apps,console,sections}') = 'array'
     ORDER BY s.id FOR UPDATE OF s, sv
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_new_sections := '[]'::jsonb;
    v_found_section := FALSE;

    FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      v_new_items := '[]'::jsonb;
      v_found_item := FALSE;

      FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS value LOOP
        IF COALESCE(v_item->>'route', v_item->>'href', v_item->>'path') = '/integrations/customer-migration'
           OR COALESCE(v_item->>'id', '') = 'integrations-customer-migration'
           OR COALESCE(v_item->>'key', '') = 'int-customer-migration' THEN
          IF lower(COALESCE(v_section->>'id', '')) = 'integrations' THEN
            v_new_items := v_new_items || jsonb_build_array(v_item || v_route_item);
            v_found_item := TRUE;
          END IF;
        ELSE
          v_new_items := v_new_items || jsonb_build_array(v_item);
        END IF;
      END LOOP;

      IF lower(COALESCE(v_section->>'id', '')) = 'integrations' THEN
        v_found_section := TRUE;
        IF NOT v_found_item THEN
          v_new_items := v_new_items || jsonb_build_array(v_route_item);
        END IF;
        v_section := jsonb_set(
          v_section,
          '{items}',
          v_new_items,
          TRUE
        );
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_new_items, TRUE);
      END IF;

      v_new_sections := v_new_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_found_section THEN
      v_new_sections := v_new_sections || jsonb_build_array(jsonb_build_object(
        'id', 'integrations',
        'label', 'External Intake',
        'items', jsonb_build_array(v_route_item)
      ));
    END IF;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_new_sections, TRUE);

    IF v_current IS DISTINCT FROM v_scope.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_navigation', v_scope.scope_type, v_scope.scope_id, v_current,
        v_scope.schema_version, 'Add the customer migration navigation route'
      );
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

COMMENT ON FUNCTION public.ui_execute_logistics_customer_migration_v1(JSONB)
  IS 'Console-safe client/recipient migration RPC using import_jobs lifecycle SSOT, exact identity reuse, canonical workflow progress, and backend lineage readback.';
COMMENT ON FUNCTION public.ui_upsert_logistics_customer_migration_config_v1(JSONB)
  IS 'Console-safe source/profile upsert after capability-gated canonical onboarding plugin draft, validate, submit, approve, activate, and binding readiness.';


COMMIT;
