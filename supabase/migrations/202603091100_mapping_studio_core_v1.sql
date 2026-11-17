-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Shared mapping studio persistence core (runtime save + operation reports)

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061200_mapping_studio_core_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Extend mapping_configs.mapping_type for reusable tabular import profiles
-------------------------------------------------------------------------------

ALTER TABLE public.mapping_configs
  DROP CONSTRAINT IF EXISTS mapping_configs_type_check;

ALTER TABLE public.mapping_configs
  ADD CONSTRAINT mapping_configs_type_check
  CHECK (
    mapping_type IN (
      'provider_response',
      'webhook_inbound',
      'webhook_outbound',
      'event_extraction',
      'webhook_response',
      'tabular_import'
    )
  );

COMMENT ON COLUMN public.mapping_configs.mapping_type IS
  'Type of mapping: provider_response, webhook_inbound, webhook_outbound, event_extraction, webhook_response, tabular_import';

-------------------------------------------------------------------------------
-- 2) SSOT table: mapping operation reports
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mapping_operation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  save_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  primary_resource_type TEXT,
  primary_resource_id UUID,
  workflow_template_id UUID REFERENCES public.workflow_templates(id) ON DELETE SET NULL,
  correlation_id TEXT,
  request_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  conversion_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostics_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mapping_operation_reports_artifact_type_ck CHECK (
    artifact_type IN ('tabular_import', 'webhook_inbound', 'api_outbound', 'integration_plugin')
  ),
  CONSTRAINT mapping_operation_reports_save_mode_ck CHECK (
    save_mode IN ('direct', 'draft')
  ),
  CONSTRAINT mapping_operation_reports_status_ck CHECK (
    status IN ('succeeded', 'failed')
  ),
  CONSTRAINT mapping_operation_reports_next_steps_is_array_ck CHECK (
    jsonb_typeof(next_steps) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_org_created
  ON public.mapping_operation_reports (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_artifact_status
  ON public.mapping_operation_reports (artifact_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mapping_operation_reports_primary_resource
  ON public.mapping_operation_reports (primary_resource_type, primary_resource_id)
  WHERE primary_resource_type IS NOT NULL AND primary_resource_id IS NOT NULL;

COMMENT ON TABLE public.mapping_operation_reports IS
  'SSOT operation reports for mapping studio submissions, including direct runtime saves and governed draft saves.';

COMMENT ON COLUMN public.mapping_operation_reports.request_summary IS
  'Sanitized request summary that captures source type, artifact context, and save intent.';

COMMENT ON COLUMN public.mapping_operation_reports.conversion_summary IS
  'Automatic conversion/coercion summary surfaced to the user before submit.';

COMMENT ON COLUMN public.mapping_operation_reports.diagnostics_summary IS
  'Blocking/warning diagnostics that explain policy, schema, and security findings.';

COMMENT ON COLUMN public.mapping_operation_reports.result_payload IS
  'Final outcome payload including created/updated resource identifiers and workflow binding outcome.';

COMMENT ON COLUMN public.mapping_operation_reports.decision_refs IS
  'Correlation ids, settings resolution ids, and related decision/audit references.';

DROP TRIGGER IF EXISTS trg_mapping_operation_reports_set_updated_at
  ON public.mapping_operation_reports;

CREATE TRIGGER trg_mapping_operation_reports_set_updated_at
BEFORE UPDATE ON public.mapping_operation_reports
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.mapping_operation_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mapping_operation_reports FROM PUBLIC;
REVOKE ALL ON TABLE public.mapping_operation_reports FROM anon;
REVOKE ALL ON TABLE public.mapping_operation_reports FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.mapping_operation_reports TO authenticated;
GRANT ALL ON TABLE public.mapping_operation_reports TO service_role;

DROP POLICY IF EXISTS mapping_operation_reports_service_policy
  ON public.mapping_operation_reports;
CREATE POLICY mapping_operation_reports_service_policy
ON public.mapping_operation_reports
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

DROP POLICY IF EXISTS mapping_operation_reports_select
  ON public.mapping_operation_reports;
CREATE POLICY mapping_operation_reports_select
ON public.mapping_operation_reports
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND (
    public.user_has_capability_v1('mappings.read')
    OR public.user_has_capability_v1('integration_plugins.read')
    OR public.user_has_capability_v1('webhooks.read')
    OR public.user_has_capability_v1('api_routes.read')
    OR public.user_has_capability_v1('system.write')
  )
);

DROP POLICY IF EXISTS mapping_operation_reports_insert
  ON public.mapping_operation_reports;
CREATE POLICY mapping_operation_reports_insert
ON public.mapping_operation_reports
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND (
    public.user_has_capability_v1('mappings.write')
    OR public.user_has_capability_v1('integration_plugins.write')
    OR public.user_has_capability_v1('webhooks.write')
    OR public.user_has_capability_v1('system.write')
  )
);

DROP POLICY IF EXISTS mapping_operation_reports_update
  ON public.mapping_operation_reports;
CREATE POLICY mapping_operation_reports_update
ON public.mapping_operation_reports
FOR UPDATE
TO authenticated
USING (
  organization_id = public.current_user_org_id()
  AND (
    public.user_has_capability_v1('mappings.write')
    OR public.user_has_capability_v1('integration_plugins.write')
    OR public.user_has_capability_v1('webhooks.write')
    OR public.user_has_capability_v1('system.write')
  )
)
WITH CHECK (
  organization_id = public.current_user_org_id()
  AND (
    public.user_has_capability_v1('mappings.write')
    OR public.user_has_capability_v1('integration_plugins.write')
    OR public.user_has_capability_v1('webhooks.write')
    OR public.user_has_capability_v1('system.write')
  )
);

-------------------------------------------------------------------------------
-- 3) Helper functions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mapping_studio_try_uuid_v1(p_value TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN btrim(p_value)::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mapping_studio_normalize_key_v1(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_key TEXT := lower(COALESCE(p_value, ''));
BEGIN
  v_key := regexp_replace(v_key, '[^a-z0-9:_-]+', '-', 'g');
  v_key := regexp_replace(v_key, '(^-+|-+$)', '', 'g');
  IF v_key = '' THEN
    RETURN 'mapping';
  END IF;
  RETURN left(v_key, 160);
END;
$function$;

CREATE OR REPLACE FUNCTION public.mapping_studio_maybe_create_workflow_template_v1(
  p_binding JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_binding JSONB := COALESCE(p_binding, '{}'::jsonb);
  v_mode TEXT := lower(COALESCE(v_binding->>'mode', ''));
  v_workflow_template_id UUID := public.mapping_studio_try_uuid_v1(v_binding->>'workflow_template_id');
  v_name TEXT;
  v_description TEXT;
  v_create_result JSONB;
BEGIN
  IF v_workflow_template_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'workflow_template_id', v_workflow_template_id,
      'created', FALSE
    );
  END IF;

  IF v_mode NOT IN ('create_new', 'create', 'new') THEN
    RETURN '{}'::jsonb;
  END IF;

  v_name := NULLIF(btrim(COALESCE(v_binding->>'template_name', '')), '');
  IF v_name IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_description := NULLIF(btrim(COALESCE(v_binding->>'template_description', '')), '');
  v_create_result := public.ui_create_workflow_template_v1(v_name, v_description, NULL);
  v_workflow_template_id := public.mapping_studio_try_uuid_v1(v_create_result->>'workflow_template_id');

  RETURN jsonb_build_object(
    'workflow_template_id', v_workflow_template_id,
    'created', TRUE,
    'result', COALESCE(v_create_result, '{}'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) RPC: persist a mapping operation report
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_create_mapping_operation_report_v1(
  p_report JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_report->>'organization_id'),
    public.current_user_org_id()
  );
  v_id UUID;
BEGIN
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 requires report object';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 requires organization context';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT public.is_platform_user()
     AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 cannot create reports for another organization';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT (
       public.user_has_capability_v1('mappings.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('integration_plugins.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('webhooks.write', 'tenant', v_org_id)
       OR public.user_has_capability_v1('system.write', 'tenant', v_org_id)
     ) THEN
    RAISE EXCEPTION 'ui_create_mapping_operation_report_v1 missing write capability';
  END IF;

  INSERT INTO public.mapping_operation_reports (
    organization_id,
    artifact_type,
    save_mode,
    status,
    primary_resource_type,
    primary_resource_id,
    workflow_template_id,
    correlation_id,
    request_summary,
    conversion_summary,
    diagnostics_summary,
    result_payload,
    decision_refs,
    next_steps,
    created_by,
    updated_by
  )
  VALUES (
    v_org_id,
    lower(COALESCE(NULLIF(btrim(p_report->>'artifact_type'), ''), 'tabular_import')),
    lower(COALESCE(NULLIF(btrim(p_report->>'save_mode'), ''), 'direct')),
    lower(COALESCE(NULLIF(btrim(p_report->>'status'), ''), 'succeeded')),
    NULLIF(btrim(COALESCE(p_report->>'primary_resource_type', '')), ''),
    public.mapping_studio_try_uuid_v1(p_report->>'primary_resource_id'),
    public.mapping_studio_try_uuid_v1(p_report->>'workflow_template_id'),
    NULLIF(btrim(COALESCE(p_report->>'correlation_id', '')), ''),
    COALESCE(p_report->'request_summary', '{}'::jsonb),
    COALESCE(p_report->'conversion_summary', '{}'::jsonb),
    COALESCE(p_report->'diagnostics_summary', '{}'::jsonb),
    COALESCE(p_report->'result_payload', '{}'::jsonb),
    COALESCE(p_report->'decision_refs', '{}'::jsonb),
    COALESCE(p_report->'next_steps', '[]'::jsonb),
    COALESCE(public.mapping_studio_try_uuid_v1(p_report->>'created_by'), v_user_id),
    COALESCE(public.mapping_studio_try_uuid_v1(p_report->>'updated_by'), v_user_id)
  )
  RETURNING id INTO v_id;

  RETURN (
    SELECT to_jsonb(r.*)
    FROM public.mapping_operation_reports r
    WHERE r.id = v_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_create_mapping_operation_report_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_mapping_operation_report_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) RPC: direct-save runtime mapping artifacts
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_artifact_v1(
  p_artifact JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := COALESCE(
    public.mapping_studio_try_uuid_v1(p_artifact->>'organization_id'),
    public.current_user_org_id()
  );
  v_artifact TEXT := lower(COALESCE(NULLIF(btrim(p_artifact->>'artifact'), ''), ''));
  v_requested_mapping_key TEXT := NULLIF(btrim(COALESCE(p_artifact->>'mapping_key', '')), '');
  v_mapping_type TEXT;
  v_mapping_key TEXT;
  v_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'mapping_config_id');
  v_mapping_config JSONB := COALESCE(p_artifact->'mapping_config', '{}'::jsonb);
  v_mapping_notes TEXT := NULLIF(btrim(COALESCE(p_artifact->>'notes', '')), '');
  v_mapping_row public.mapping_configs%ROWTYPE;
  v_webhook_source_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'webhook_source_id');
  v_operation_template_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'operation_template_id');
  v_api_route_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'api_route_id');
  v_workflow_binding JSONB := COALESCE(p_artifact->'workflow_binding', '{}'::jsonb);
  v_workflow_outcome JSONB := '{}'::jsonb;
  v_workflow_template_id UUID;
  v_webhook_event_type TEXT;
  v_webhook_rule_id UUID;
  v_webhook_rule_name TEXT;
  v_webhook_priority INTEGER;
  v_webhook_domain_category TEXT;
  v_webhook_enabled BOOLEAN;
  v_webhook_sql TEXT;
  v_response_mapping_id UUID := public.mapping_studio_try_uuid_v1(p_artifact->>'response_mapping_config_id');
  v_response_mapping_config JSONB := COALESCE(p_artifact->'response_mapping_config', '{}'::jsonb);
  v_request_config JSONB := COALESCE(p_artifact->'request_config', '{}'::jsonb);
  v_operation_row public.operation_templates%ROWTYPE;
  v_route_row public.api_routes%ROWTYPE;
  v_resource_ids JSONB := '[]'::jsonb;
  v_result JSONB := '{}'::jsonb;
BEGIN
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) <> 'object' THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 requires artifact object';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 requires organization context';
  END IF;

  IF v_user_id IS NOT NULL
     AND NOT public.is_platform_user()
     AND public.current_user_org_id() IS DISTINCT FROM v_org_id THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 cannot write another organization';
  END IF;

  IF v_artifact NOT IN ('tabular_import', 'webhook_inbound', 'api_outbound') THEN
    RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 unsupported artifact %', v_artifact;
  END IF;

  IF v_artifact = 'tabular_import' THEN
    PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
    v_mapping_type := 'tabular_import';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'tabular_import::%s::%s',
        public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'target_resource_key', 'resource')),
        v_org_id
      )
    );
  ELSIF v_artifact = 'webhook_inbound' THEN
    PERFORM public.assert_capability_v1('mappings.write', 'tenant', v_org_id);
    IF v_webhook_source_id IS NOT NULL THEN
      PERFORM public.assert_capability_v1('webhooks.write', 'tenant', v_org_id);
    END IF;
    v_mapping_type := 'webhook_inbound';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'webhook_inbound::%s::%s',
        COALESCE(p_artifact->>'webhook_source_id', public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'source_identifier', 'default'))),
        v_org_id
      )
    );
  ELSE
    PERFORM public.assert_capability_v1('system.write', 'tenant', v_org_id);
    v_mapping_type := 'provider_response';
    v_mapping_key := COALESCE(
      v_requested_mapping_key,
      format(
        'api_outbound::%s::%s',
        COALESCE(
          p_artifact->>'operation_template_id',
          p_artifact->>'api_route_id',
          public.mapping_studio_normalize_key_v1(COALESCE(p_artifact->>'target_resource_key', 'default'))
        ),
        v_org_id
      )
    );
  END IF;

  IF v_mapping_id IS NOT NULL THEN
    UPDATE public.mapping_configs
       SET mapping_config = v_mapping_config,
           mapping_version = mapping_version + 1,
           notes = COALESCE(v_mapping_notes, notes),
           organization_id = COALESCE(organization_id, v_org_id),
           updated_at = now()
     WHERE id = v_mapping_id
       AND (organization_id IS NULL OR organization_id = v_org_id)
     RETURNING * INTO v_mapping_row;
  END IF;

  IF v_mapping_row.id IS NULL THEN
    INSERT INTO public.mapping_configs (
      organization_id,
      mapping_type,
      mapping_key,
      mapping_config,
      mapping_version,
      notes
    )
    VALUES (
      v_org_id,
      v_mapping_type,
      v_mapping_key,
      v_mapping_config,
      1,
      COALESCE(v_mapping_notes, format('Mapping studio %s artifact', v_artifact))
    )
    ON CONFLICT (mapping_type, mapping_key) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        mapping_config = EXCLUDED.mapping_config,
        mapping_version = public.mapping_configs.mapping_version + 1,
        notes = EXCLUDED.notes,
        updated_at = now()
    RETURNING * INTO v_mapping_row;
  END IF;

  v_mapping_id := v_mapping_row.id;
  v_resource_ids := v_resource_ids || jsonb_build_array(
    jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_mapping_id)
  );

  v_workflow_outcome := public.mapping_studio_maybe_create_workflow_template_v1(v_workflow_binding);
  v_workflow_template_id := public.mapping_studio_try_uuid_v1(v_workflow_outcome->>'workflow_template_id');

  IF v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN
    UPDATE public.webhook_sources
       SET mapping_config_id = v_mapping_id,
           updated_at = now()
     WHERE id = v_webhook_source_id
       AND organization_id = v_org_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 webhook source % not found for organization %', v_webhook_source_id, v_org_id;
    END IF;

    v_resource_ids := v_resource_ids || jsonb_build_array(
      jsonb_build_object('resource_type', 'webhook_sources', 'resource_id', v_webhook_source_id)
    );

    IF v_workflow_template_id IS NOT NULL THEN
      v_webhook_event_type := COALESCE(
        NULLIF(btrim(COALESCE(v_workflow_binding->>'event_type', '')), ''),
        NULLIF(btrim(COALESCE(p_artifact->>'event_type', '')), ''),
        'default'
      );
      v_webhook_rule_name := COALESCE(
        NULLIF(btrim(COALESCE(v_workflow_binding->>'rule_name', '')), ''),
        format('mapping-studio-%s', v_webhook_event_type)
      );
      v_webhook_priority := COALESCE((v_workflow_binding->>'priority')::int, 100);
      v_webhook_domain_category := COALESCE(
        NULLIF(btrim(COALESCE(v_workflow_binding->>'domain_category', '')), ''),
        'shipment'
      );
      v_webhook_enabled := COALESCE((v_workflow_binding->>'enabled')::boolean, TRUE);

      v_webhook_sql := 'SELECT id
                          FROM public.webhook_rules
                         WHERE webhook_source_id = $1
                           AND event_type = $2
                         ORDER BY created_at DESC
                         LIMIT 1';
      EXECUTE v_webhook_sql
         INTO v_webhook_rule_id
        USING v_webhook_source_id, v_webhook_event_type;

      IF v_webhook_rule_id IS NULL THEN
        v_webhook_sql := 'INSERT INTO public.webhook_rules (
                            webhook_source_id,
                            event_type,
                            name,
                            priority,
                            mapping_config_id,
                            workflow_template_id,
                            domain_category,
                            enabled
                          )
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                          RETURNING id';
        EXECUTE v_webhook_sql
           INTO v_webhook_rule_id
          USING
            v_webhook_source_id,
            v_webhook_event_type,
            v_webhook_rule_name,
            v_webhook_priority,
            v_mapping_id,
            v_workflow_template_id,
            v_webhook_domain_category,
            v_webhook_enabled;
      ELSE
        v_webhook_sql := 'UPDATE public.webhook_rules
                             SET mapping_config_id = $1,
                                 workflow_template_id = $2,
                                 name = $3,
                                 priority = $4,
                                 domain_category = $5,
                                 enabled = $6
                           WHERE id = $7';
        EXECUTE v_webhook_sql
          USING
            v_mapping_id,
            v_workflow_template_id,
            v_webhook_rule_name,
            v_webhook_priority,
            v_webhook_domain_category,
            v_webhook_enabled,
            v_webhook_rule_id;
      END IF;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'webhook_rules', 'resource_id', v_webhook_rule_id)
      );
    END IF;

    v_result := jsonb_build_object(
      'primary_resource_type', 'mapping_configs',
      'primary_resource_id', v_mapping_id,
      'mapping_config_id', v_mapping_id,
      'webhook_source_id', v_webhook_source_id,
      'workflow_template_id', v_workflow_template_id,
      'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
      'resource_ids', v_resource_ids
    );
    RETURN v_result;
  END IF;

  IF v_artifact = 'api_outbound' THEN
    IF v_response_mapping_id IS NOT NULL THEN
      UPDATE public.mapping_configs
         SET mapping_config = v_response_mapping_config,
             mapping_version = mapping_version + 1,
             organization_id = COALESCE(organization_id, v_org_id),
             notes = COALESCE(v_mapping_notes, notes),
             updated_at = now()
       WHERE id = v_response_mapping_id
         AND (organization_id IS NULL OR organization_id = v_org_id);
    ELSIF v_response_mapping_config <> '{}'::jsonb THEN
      INSERT INTO public.mapping_configs (
        organization_id,
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes
      )
      VALUES (
        v_org_id,
        'provider_response',
        format('provider_response::%s::%s', v_mapping_key, v_org_id),
        v_response_mapping_config,
        1,
        COALESCE(v_mapping_notes, 'Mapping studio provider response mapping')
      )
      ON CONFLICT (mapping_type, mapping_key) DO UPDATE
      SET organization_id = EXCLUDED.organization_id,
          mapping_config = EXCLUDED.mapping_config,
          mapping_version = public.mapping_configs.mapping_version + 1,
          notes = EXCLUDED.notes,
          updated_at = now()
      RETURNING id INTO v_response_mapping_id;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'mapping_configs', 'resource_id', v_response_mapping_id)
      );
    END IF;

    IF v_operation_template_id IS NOT NULL THEN
      SELECT *
        INTO v_operation_row
        FROM public.operation_templates
       WHERE id = v_operation_template_id
         AND (
           provider_id IN (
             SELECT id
             FROM public.providers
             WHERE organization_id = v_org_id
           )
           OR public.user_has_capability_v1('system.write', 'tenant', v_org_id)
         )
       LIMIT 1;

      IF v_operation_row.id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 operation template % not found', v_operation_template_id;
      END IF;

      UPDATE public.operation_templates
         SET method = COALESCE(NULLIF(btrim(COALESCE(v_request_config->>'method', '')), ''), method),
             url_template = COALESCE(NULLIF(btrim(COALESCE(v_request_config->>'url_template', '')), ''), url_template),
             headers_template = COALESCE(v_request_config->'headers_template', headers_template),
             body_template = COALESCE(v_request_config->'body_template', body_template),
             request_mappings = COALESCE(v_request_config->'request_mappings', request_mappings),
             timeout_seconds = COALESCE(NULLIF(v_request_config->>'timeout_seconds', '')::int, timeout_seconds),
             mapping_config_id = COALESCE(v_response_mapping_id, mapping_config_id),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'mapping_studio', jsonb_build_object(
                 'saved_at', now(),
                 'saved_by', v_user_id,
                 'artifact', v_artifact
               )
             )
       WHERE id = v_operation_template_id;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'operation_templates', 'resource_id', v_operation_template_id)
      );
    END IF;

    IF v_api_route_id IS NOT NULL THEN
      SELECT *
        INTO v_route_row
        FROM public.api_routes
       WHERE id = v_api_route_id
         AND (
           scope_id IS NULL
           OR scope_id = v_org_id
           OR public.user_has_capability_v1('system.write', 'tenant', v_org_id)
         )
       LIMIT 1;

      IF v_route_row.id IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_mapping_artifact_v1 api route % not found', v_api_route_id;
      END IF;

      UPDATE public.api_routes
         SET policy = COALESCE(policy, '{}'::jsonb) || jsonb_build_object(
           'mapping_studio', jsonb_strip_nulls(jsonb_build_object(
             'mapping_config_id', v_mapping_id,
             'response_mapping_config_id', v_response_mapping_id,
             'request_config', NULLIF(v_request_config, '{}'::jsonb),
             'workflow_template_id', v_workflow_template_id
           ))
         ),
             updated_at = now()
       WHERE id = v_api_route_id;

      v_resource_ids := v_resource_ids || jsonb_build_array(
        jsonb_build_object('resource_type', 'api_routes', 'resource_id', v_api_route_id)
      );
    END IF;

    v_result := jsonb_build_object(
      'primary_resource_type',
      CASE
        WHEN v_operation_template_id IS NOT NULL THEN 'operation_templates'
        WHEN v_api_route_id IS NOT NULL THEN 'api_routes'
        ELSE 'mapping_configs'
      END,
      'primary_resource_id',
      COALESCE(v_operation_template_id, v_api_route_id, v_mapping_id),
      'mapping_config_id', v_mapping_id,
      'response_mapping_config_id', v_response_mapping_id,
      'operation_template_id', v_operation_template_id,
      'api_route_id', v_api_route_id,
      'workflow_template_id', v_workflow_template_id,
      'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
      'resource_ids', v_resource_ids
    );
    RETURN v_result;
  END IF;

  v_result := jsonb_build_object(
    'primary_resource_type', 'mapping_configs',
    'primary_resource_id', v_mapping_id,
    'mapping_config_id', v_mapping_id,
    'workflow_template_id', v_workflow_template_id,
    'workflow_binding_outcome', COALESCE(v_workflow_outcome, '{}'::jsonb),
    'resource_ids', v_resource_ids
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_mapping_artifact_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_mapping_artifact_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603061200_mapping_studio_core_v1'));
COMMIT;
