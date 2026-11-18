-- Current-generation runtime qualification reconciliation.
-- Closes the first complete zero-state runtime wave without reviving retired schemas.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- Credential lineage: row-driven lookups, service-only RLS, and FK indexes.
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('intake_service', 'Public intake service identifier', 'engineering', 'tier_1', FALSE),
  ('credential_retired_reason', 'Credential retirement reason', 'security', 'tier_1', FALSE)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, sort_order, is_default, status
)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('intake_service', 'api_gateway', 'API Gateway', 10, TRUE),
    ('intake_service', 'webhook_receiver', 'Webhook Receiver', 20, FALSE),
    ('credential_retired_reason', 'rotated', 'Rotated', 10, TRUE),
    ('credential_retired_reason', 'archived', 'Archived', 20, FALSE),
    ('credential_retired_reason', 'revoked', 'Revoked', 30, FALSE),
    ('decision_category', 'fleet.driver_created', 'Fleet driver created', 900, FALSE),
    ('decision_category', 'fleet.vehicle_created', 'Fleet vehicle created', 910, FALSE)
) AS v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    updated_at = now();

ALTER TABLE public.intake_auth_rejections
  DROP CONSTRAINT IF EXISTS intake_auth_rejections_service_ck;
ALTER TABLE public.webhook_source_token_history
  DROP CONSTRAINT IF EXISTS webhook_source_token_history_reason_ck;

INSERT INTO public.lookup_column_contracts (
  table_schema, table_name, column_name, lookup_category
)
VALUES
  ('public', 'intake_auth_rejections', 'service', 'intake_service'),
  ('public', 'webhook_source_token_history', 'retired_reason', 'credential_retired_reason')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category,
    updated_at = now();

SELECT public.apply_lookup_column_contracts('public');

DROP POLICY IF EXISTS webhook_source_token_history_service_all
  ON public.webhook_source_token_history;
CREATE POLICY webhook_source_token_history_service_all
  ON public.webhook_source_token_history
  FOR ALL TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_client_id
  ON public.intake_auth_rejections (client_id);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_organization_id
  ON public.intake_auth_rejections (organization_id);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_provider_auth_config_id
  ON public.intake_auth_rejections (provider_auth_config_id);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_sender_id
  ON public.intake_auth_rejections (sender_id);
CREATE INDEX IF NOT EXISTS idx_intake_auth_rejections_source_id
  ON public.intake_auth_rejections (source_id);
CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_client_id
  ON public.webhook_source_token_history (client_id);
CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_retired_by_user_id
  ON public.webhook_source_token_history (retired_by_user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_source_token_history_sender_id
  ON public.webhook_source_token_history (sender_id);
CREATE INDEX IF NOT EXISTS idx_outbound_calls_execution_url_vault_id_fk
  ON public.outbound_calls (execution_url_vault_id);

-------------------------------------------------------------------------------
-- Keep the compatibility overload unambiguous.
-------------------------------------------------------------------------------

DROP FUNCTION public.redact_sensitive_url(TEXT, JSONB, BOOLEAN);

CREATE OR REPLACE FUNCTION public.redact_sensitive_url(
  p_url TEXT,
  p_policy_or_snapshot JSONB,
  p_historical BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url TEXT := p_url;
  v_base TEXT;
  v_query_and_frag TEXT;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN p_url;
  END IF;
  v_url := regexp_replace(v_url, '(/api-gateway/t/)[^/?#[:space:]]+', '\1REDACTED', 'gi');
  v_url := regexp_replace(
    v_url,
    '(/api-gateway/)([^t/?#[:space:]][^/?#[:space:]]*|t[^/?#[:space:]]+)',
    '\1REDACTED',
    'gi'
  );
  IF position('?' IN v_url) = 0 THEN
    RETURN v_url;
  END IF;
  v_base := split_part(v_url, '?', 1);
  v_query_and_frag := substring(v_url FROM position('?' IN v_url) + 1);
  RETURN v_base || '?' || public.redact_sensitive_query_string_v1(
    v_query_and_frag,
    p_policy_or_snapshot,
    p_historical
  );
END;
$$;

COMMENT ON FUNCTION public.redact_sensitive_url(TEXT, JSONB, BOOLEAN)
  IS 'Deterministically redact credential-bearing API gateway path segments and sensitive query values before persistence or logging.';

-------------------------------------------------------------------------------
-- Mapping fallback/provenance convergence.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_mapping_config(
  p_source JSONB,
  p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_config RECORD;
  v_result JSONB := '{}'::JSONB;
  v_target TEXT;
  v_spec JSONB;
  v_field_key TEXT;
  v_field_spec JSONB;
  v_path TEXT;
  v_jsonpath TEXT;
  v_field_val JSONB;
  v_object JSONB;
  v_candidate_paths TEXT[];
BEGIN
  IF p_source IS NULL OR p_mapping_config_id IS NULL THEN RETURN p_source; END IF;
  SELECT mapping_config INTO v_config FROM public.mapping_configs WHERE id = p_mapping_config_id;
  IF NOT FOUND OR v_config.mapping_config IS NULL THEN RETURN p_source; END IF;
  IF v_config.mapping_config ? 'field_mappings' THEN
    RETURN public.jsonb_extract_fields(p_source, v_config.mapping_config->'field_mappings');
  END IF;
  IF v_config.mapping_config ? 'transforms' THEN
    v_result := '{}'::jsonb;
    FOR v_target, v_spec IN SELECT key, value FROM jsonb_each(v_config.mapping_config->'transforms') LOOP
      IF jsonb_typeof(v_spec) = 'object' THEN
        v_object := '{}'::jsonb;
        FOR v_field_key, v_field_spec IN SELECT key, value FROM jsonb_each(v_spec) LOOP
          SELECT COALESCE(array_agg(btrim(elem)) FILTER (WHERE btrim(elem) <> ''), ARRAY[]::text[])
          INTO v_candidate_paths
          FROM unnest(
            CASE
              WHEN jsonb_typeof(v_field_spec) = 'string'
                THEN regexp_split_to_array(v_field_spec #>> '{}', '\s*\|\s*')
              WHEN jsonb_typeof(v_field_spec) = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(v_field_spec))
              ELSE ARRAY[]::text[]
            END
          ) AS elem;
          v_field_val := NULL;
          FOREACH v_path IN ARRAY v_candidate_paths LOOP
            v_jsonpath := public.normalize_jsonpath(v_path);
            BEGIN
              v_field_val := CASE WHEN v_jsonpath IS NULL THEN NULL
                ELSE jsonb_path_query_first(p_source, v_jsonpath::JSONPATH) END;
            EXCEPTION WHEN OTHERS THEN
              v_field_val := NULL;
            END;
            IF v_field_val IS NOT NULL AND v_field_val <> 'null'::jsonb THEN EXIT; END IF;
            v_field_val := NULL;
          END LOOP;
          v_object := jsonb_set(
            v_object,
            ARRAY[v_field_key],
            COALESCE(v_field_val, 'null'::jsonb),
            TRUE
          );
        END LOOP;
        v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
      END IF;
    END LOOP;
    RETURN v_result;
  END IF;
  RETURN p_source;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = workflow_handlers, public, extensions, pg_temp
AS $$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_run workflow_runs%ROWTYPE;
  v_ctx RECORD;
  v_policy_record RECORD;
  v_settings_id UUID := NULL;
  v_settings_version_id UUID := NULL;
  v_version INT := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_inputs JSONB;
  v_settings_resolution_id UUID := NULL;
BEGIN
  IF NOT v_can_log THEN RETURN; END IF;
  SELECT * INTO v_run FROM workflow_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_ctx FROM geocoding_extract_context(v_run);
  IF v_ctx.organization_id IS NULL THEN RETURN; END IF;
  IF v_ctx.sender_id IS NOT NULL THEN v_scope_path := v_scope_path || to_jsonb('sender'::text); END IF;
  IF v_ctx.client_id IS NOT NULL THEN v_scope_path := v_scope_path || to_jsonb('client'::text); END IF;
  v_scope_path := v_scope_path || to_jsonb('tenant'::text) || to_jsonb('global'::text);
  SELECT * INTO v_policy_record
  FROM public.geocoding_resolve_policy(v_ctx.organization_id, v_ctx.client_id, v_ctx.sender_id)
  LIMIT 1;
  IF v_policy_record.scope_type IS NULL THEN
    v_policy_record.scope_type := 'global';
    v_policy_record.scope_id := NULL;
  END IF;
  v_inputs := jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_id', p_run_id,
    'workflow_step_id', p_step_id,
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'decision_point', COALESCE(p_match->>'plugin', 'geocoding'),
    'decision_outcome', COALESCE(p_match->>'match_type', 'unknown')
  ));
  SELECT s.id, s.settings_version_id, sv.version
    INTO v_settings_id, v_settings_version_id, v_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'geocoding_policy'
    AND s.scope_type = v_policy_record.scope_type
    AND s.scope_id IS NOT DISTINCT FROM v_policy_record.scope_id
  ORDER BY s.last_updated DESC
  LIMIT 1;
  IF v_settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'geocoding_policy',
      p_winning_scope_type := v_policy_record.scope_type,
      p_winning_scope_id := v_policy_record.scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := COALESCE(v_version, 1),
      p_scope_path := v_scope_path,
      p_inputs := v_inputs,
      p_merge_notes := NULL
    );
  END IF;
  INSERT INTO decision_log (
    organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id, settings_resolution_id
  ) VALUES (
    v_ctx.organization_id, 'geocoding', 'workflow_run_step', p_step_id,
    COALESCE(p_match->>'plugin', 'geocoding'), COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(COALESCE(p_match, '{}'::jsonb) || v_inputs), p_match->>'routing_reason',
    'workflow_handlers', p_run_id, v_settings_resolution_id
  );
END;
$$;

-------------------------------------------------------------------------------
-- Keep first-tenant defaults and ingress-mode boundaries aligned.
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_default JSONB := public.default_shipment_webhook_intake_mapping_config_v1();
BEGIN
  UPDATE public.onboarding_integration_plugin_defaults d
  SET mapping_config = public.jsonb_deep_merge(v_default, COALESCE(d.mapping_config, '{}'::jsonb)),
      updated_at = now()
  WHERE d.plugin_key = 'default-shipment-webhook-intake';
  UPDATE public.integration_plugin_versions v
  SET mapping_config = public.jsonb_deep_merge(v_default, COALESCE(v.mapping_config, '{}'::jsonb)),
      updated_at = now()
  FROM public.integration_plugins p
  WHERE p.id = v.plugin_id
    AND p.plugin_key = 'default-shipment-webhook-intake'
    AND (v.status IN ('active', 'approved') OR p.active_version_id = v.id);
END;
$$;

UPDATE public.lookup_values lv
SET metadata = jsonb_set(
      COALESCE(lv.metadata, '{}'::jsonb),
      '{allowed_mapping_types}',
      COALESCE((
        SELECT jsonb_agg(value ORDER BY value)
        FROM jsonb_array_elements_text(COALESCE(lv.metadata->'allowed_mapping_types', '[]'::jsonb)) value
        WHERE value <> 'api_gateway_inbound'
      ), '[]'::jsonb),
      TRUE
    ),
    updated_at = now()
FROM public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'mapping_target'
  AND lv.value IN ('shipments.cancel', 'shipments.reschedule');

-------------------------------------------------------------------------------
-- Canonical tenant-review wrapper and branch-zone ACL.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tenant_signup_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.tenant_signup_review_apply_v1_impl_202605031930(
    p_request_id, p_decision, p_reviewer_user_id, p_decision_reason,
    p_invited_auth_user_id, p_invite_email_sent, p_invite_redirect_to,
    COALESCE(p_decision_metadata, '{}'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.branch_zone_assign_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.branch_zone_unassign_v1(JSONB) FROM anon;

-------------------------------------------------------------------------------
-- Registry reference convergence without duplicating its generated source.
-------------------------------------------------------------------------------

ALTER FUNCTION public.ui_read_registry_v1()
  RENAME TO ui_read_registry_v1_base_202608161850;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1_base_202608161850()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.ui_read_registry_v1_base_202608161850()
  IS 'Internal 202608161850 base for the governed ui_read_registry_v1 wrapper; direct execution is revoked.';

CREATE OR REPLACE FUNCTION public.ui_read_registry_v1()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH registry AS (
    SELECT public.ui_read_registry_v1_base_202608161850() AS value
  ), resources AS (
    SELECT resource, ordinal
    FROM registry,
      jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb)) WITH ORDINALITY AS r(resource, ordinal)
  ), patched AS (
    SELECT ordinal,
      CASE WHEN resource->>'key' <> 'shipments' THEN resource ELSE
        jsonb_set(
          resource,
          '{columns}',
          COALESCE((
            SELECT jsonb_agg(
              CASE WHEN column_value->>'key' = 'sender_id' THEN
                jsonb_set(column_value, '{import,reference}', jsonb_build_object(
                  'label', 'Senders',
                  'relation', 'public.senders',
                  'resource', 'senders',
                  'id_column', 'id',
                  'label_column', 'name',
                  'display_columns', jsonb_build_array('name', 'status')
                ), TRUE)
              ELSE column_value END
              ORDER BY column_ordinal
            )
            FROM jsonb_array_elements(COALESCE(resource->'columns', '[]'::jsonb))
              WITH ORDINALITY AS c(column_value, column_ordinal)
          ), '[]'::jsonb),
          TRUE
        )
      END AS resource
    FROM resources
  )
  SELECT jsonb_set(
    registry.value,
    '{resources}',
    COALESCE((SELECT jsonb_agg(resource ORDER BY ordinal) FROM patched), '[]'::jsonb),
    TRUE
  )
  FROM registry
$$;

REVOKE ALL ON FUNCTION public.ui_read_registry_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_read_registry_v1() TO authenticated, service_role;

CREATE OR REPLACE VIEW api.intake_auth_rejections
WITH (security_invoker = TRUE)
AS SELECT * FROM public.intake_auth_rejections;
CREATE OR REPLACE VIEW api.workflow_templates
WITH (security_invoker = TRUE)
AS SELECT * FROM public.workflow_templates;
CREATE OR REPLACE VIEW api.workflow_template_steps
WITH (security_invoker = TRUE)
AS SELECT * FROM public.workflow_template_steps;

GRANT SELECT ON api.intake_auth_rejections TO authenticated, service_role;
GRANT SELECT ON api.workflow_templates TO authenticated, service_role;
GRANT SELECT ON api.workflow_template_steps TO authenticated, service_role;

COMMIT;
