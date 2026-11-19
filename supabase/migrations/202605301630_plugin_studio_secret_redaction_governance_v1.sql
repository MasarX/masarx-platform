-- Plugin Studio/runtime plugin governance: fail closed on credential-shaped
-- payloads before persisted readback, audit reports, or operator evidence.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605301630_plugin_studio_secret_redaction_governance_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $plugin_studio_redaction_lookups$
DECLARE
  v_decision_category_def UUID;
  v_decision_outcome_def UUID;
BEGIN
  SELECT id INTO v_decision_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_decision_category_def IS NOT NULL THEN
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES (
      v_decision_category_def,
      'integration_plugin.governance',
      'Integration plugin governance',
      'active',
      1840
    )
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;

  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NOT NULL THEN
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES (
      v_decision_outcome_def,
      'draft_saved',
      'Draft saved',
      'active',
      1841
    )
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;
END
$plugin_studio_redaction_lookups$;

CREATE OR REPLACE FUNCTION public.redact_sensitive_text_v1(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out text := p_value;
BEGIN
  IF v_out IS NULL THEN
    RETURN NULL;
  END IF;

  v_out := regexp_replace(
    v_out,
    '("[^"]*(authorization|x-api-key|api[_-]?key|apikey|credential|password|private[_-]?key|secret|signature|token)[^"]*"[[:space:]]*:[[:space:]]*")[^"]*(")',
    E'\\1REDACTED\\3',
    'gi'
  );
  v_out := regexp_replace(
    v_out,
    '(bearer[[:space:]]+)[^''",[[:space:]];}]+',
    E'\\1REDACTED',
    'gi'
  );
  v_out := regexp_replace(
    v_out,
    '(basic[[:space:]]+)[^''",[[:space:]];}]+',
    E'\\1REDACTED',
    'gi'
  );
  v_out := regexp_replace(
    v_out,
    '((authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|signature)[[:space:]]*[:=][[:space:]]*)[^&''",;}]+',
    E'\\1REDACTED',
    'gi'
  );
  v_out := regexp_replace(
    v_out,
    '([?&](api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|signature|password)=)[^&''"[[:space:]]]+',
    E'\\1REDACTED',
    'gi'
  );

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.redact_sensitive_text_v1(text)
  IS 'Redacts credential-shaped scalar text such as bearer/basic tokens, auth headers, and secret query parameters before Plugin Studio persistence/readback.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_json(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out JSONB;
  v_entry RECORD;
  v_key_lower TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_value) = 'string' THEN
    RETURN to_jsonb(public.redact_sensitive_text_v1(p_value #>> '{}'));
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    v_out := '{}'::jsonb;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_key_lower := lower(v_entry.key);
      IF v_key_lower IN (
        'api_key',
        'apikey',
        'authorization',
        'credential',
        'password',
        'private_key',
        'secret',
        'signature',
        'token',
        'access_token',
        'refresh_token',
        'signing_secret',
        'shared_secret',
        'x-api-key'
      )
      OR v_key_lower LIKE '%token%'
      OR v_key_lower LIKE '%secret%'
      OR v_key_lower LIKE '%password%'
      OR v_key_lower LIKE '%credential%'
      OR v_key_lower LIKE '%signature%'
      OR v_key_lower LIKE '%private%key%'
      OR v_key_lower LIKE '%api%key%'
      THEN
        v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
      ELSE
        v_out := v_out || jsonb_build_object(v_entry.key, public.redact_sensitive_json(v_entry.value));
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_entry IN
      SELECT value, ordinality
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS arr(value, ordinality)
      ORDER BY ordinality
    LOOP
      v_out := v_out || jsonb_build_array(public.redact_sensitive_json(v_entry.value));
    END LOOP;
    RETURN v_out;
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.redact_sensitive_json(JSONB)
  IS 'Recursively redacts sensitive JSON keys and credential-shaped scalar text for safe persistence/logging/readback.';

CREATE OR REPLACE FUNCTION public.integration_plugins_redact_sensitive_metadata_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  NEW.metadata := COALESCE(public.redact_sensitive_json(NEW.metadata), '{}'::jsonb);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_integration_plugins_redact_sensitive_metadata_v1
  ON public.integration_plugins;

CREATE TRIGGER trg_integration_plugins_redact_sensitive_metadata_v1
  BEFORE INSERT OR UPDATE OF metadata ON public.integration_plugins
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugins_redact_sensitive_metadata_v1();

CREATE OR REPLACE FUNCTION public.integration_plugin_versions_redact_sensitive_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  NEW.source_payload := COALESCE(public.redact_sensitive_json(NEW.source_payload), '{}'::jsonb);
  NEW.normalized_contract := COALESCE(public.redact_sensitive_json(NEW.normalized_contract), '{}'::jsonb);
  NEW.inbound_config := COALESCE(public.redact_sensitive_json(NEW.inbound_config), '{}'::jsonb);
  NEW.mapping_config := COALESCE(public.redact_sensitive_json(NEW.mapping_config), '{}'::jsonb);
  NEW.outbound_operations := COALESCE(public.redact_sensitive_json(NEW.outbound_operations), '[]'::jsonb);
  NEW.auth_bindings := COALESCE(public.redact_sensitive_json(NEW.auth_bindings), '{}'::jsonb);
  NEW.validation_summary := COALESCE(public.redact_sensitive_json(NEW.validation_summary), '{}'::jsonb);
  NEW.metadata := COALESCE(public.redact_sensitive_json(NEW.metadata), '{}'::jsonb);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_integration_plugin_versions_redact_sensitive_v1
  ON public.integration_plugin_versions;

CREATE TRIGGER trg_integration_plugin_versions_redact_sensitive_v1
  BEFORE INSERT OR UPDATE OF source_payload, normalized_contract, inbound_config, mapping_config, outbound_operations, auth_bindings, validation_summary, metadata
  ON public.integration_plugin_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_versions_redact_sensitive_v1();

CREATE OR REPLACE FUNCTION public.integration_plugin_versions_draft_governance_lineage_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_correlation_id UUID;
  v_decision_log_id UUID := gen_random_uuid();
  v_correlation_text TEXT := NULLIF(NEW.metadata->>'correlation_id', '');
  v_payload JSONB;
BEGIN
  IF NEW.status <> 'draft' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.metadata->>'managed_by', '') <> 'integration_plugin_studio_edge' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.decision_log dl
    WHERE dl.resource_type = 'integration_plugin_version'
      AND dl.resource_id = NEW.id
      AND dl.decision_point = 'plugin_studio.draft_saved'
  ) THEN
    RETURN NEW;
  END IF;

  v_correlation_id := CASE
    WHEN v_correlation_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN v_correlation_text::UUID
    ELSE NEW.id
  END;

  v_payload := public.redact_sensitive_json(jsonb_build_object(
    'plugin_id', NEW.plugin_id,
    'plugin_version_id', NEW.id,
    'version_no', NEW.version_no,
    'source_type', NEW.source_type,
    'workflow_binding', NEW.workflow_binding,
    'validation_summary', NEW.validation_summary,
    'metadata', NEW.metadata
  ));

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    timestamp
  )
  VALUES (
    v_decision_log_id,
    NEW.organization_id,
    'integration_plugin.governance',
    'integration_plugin_version',
    NEW.id,
    'plugin_studio.draft_saved',
    'draft_saved',
    v_payload,
    'Plugin Studio draft persisted with redacted runtime plugin payloads.',
    'integration_plugin_studio',
    v_correlation_id,
    now()
  );

  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload,
    status
  )
  VALUES (
    NEW.organization_id,
    'integration_plugin_version_draft_saved',
    'integration_plugin_version',
    NEW.id,
    v_correlation_id,
    public.redact_sensitive_json(v_payload || jsonb_build_object('decision_log_id', v_decision_log_id)),
    'pending'
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.integration_plugin_versions_draft_governance_lineage_v1()
  IS 'Writes redacted decision_log/domain_events lineage when Plugin Studio persists a runtime plugin draft version.';

DROP TRIGGER IF EXISTS trg_integration_plugin_versions_draft_governance_lineage_v1
  ON public.integration_plugin_versions;

CREATE TRIGGER trg_integration_plugin_versions_draft_governance_lineage_v1
  AFTER INSERT ON public.integration_plugin_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.integration_plugin_versions_draft_governance_lineage_v1();

CREATE OR REPLACE FUNCTION public.mapping_operation_reports_redact_sensitive_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  NEW.request_summary := COALESCE(public.redact_sensitive_json(NEW.request_summary), '{}'::jsonb);
  NEW.conversion_summary := COALESCE(public.redact_sensitive_json(NEW.conversion_summary), '{}'::jsonb);
  NEW.diagnostics_summary := COALESCE(public.redact_sensitive_json(NEW.diagnostics_summary), '{}'::jsonb);
  NEW.result_payload := COALESCE(public.redact_sensitive_json(NEW.result_payload), '{}'::jsonb);
  NEW.decision_refs := COALESCE(public.redact_sensitive_json(NEW.decision_refs), '{}'::jsonb);
  NEW.next_steps := COALESCE(public.redact_sensitive_json(NEW.next_steps), '[]'::jsonb);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_mapping_operation_reports_redact_sensitive_v1
  ON public.mapping_operation_reports;

CREATE TRIGGER trg_mapping_operation_reports_redact_sensitive_v1
  BEFORE INSERT OR UPDATE OF request_summary, conversion_summary, diagnostics_summary, result_payload, decision_refs, next_steps
  ON public.mapping_operation_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.mapping_operation_reports_redact_sensitive_v1();

CREATE OR REPLACE FUNCTION public.mapping_operation_reports_plugin_studio_lineage_correlation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_correlation_id UUID;
BEGIN
  IF NEW.artifact_type <> 'integration_plugin'
     OR NEW.primary_resource_id IS NULL
     OR COALESCE(NEW.operation_kind, '') <> 'mapping_save'
     OR COALESCE(NEW.correlation_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN NEW;
  END IF;

  v_correlation_id := NEW.correlation_id::UUID;

  UPDATE public.decision_log
     SET correlation_id = v_correlation_id
   WHERE resource_type = 'integration_plugin_version'
     AND resource_id = NEW.primary_resource_id
     AND decision_point = 'plugin_studio.draft_saved';

  UPDATE public.domain_events
     SET correlation_id = v_correlation_id,
         payload = public.redact_sensitive_json(
           COALESCE(payload, '{}'::jsonb)
           || jsonb_build_object('mapping_operation_report_id', NEW.id)
         )
   WHERE resource_type = 'integration_plugin_version'
     AND resource_id = NEW.primary_resource_id
     AND event_type = 'integration_plugin_version_draft_saved';

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.mapping_operation_reports_plugin_studio_lineage_correlation_v1()
  IS 'Aligns Plugin Studio draft decision/domain-event lineage to the saved mapping operation report correlation id.';

DROP TRIGGER IF EXISTS trg_mapping_operation_reports_plugin_studio_lineage_correlation_v1
  ON public.mapping_operation_reports;

CREATE TRIGGER trg_mapping_operation_reports_plugin_studio_lineage_correlation_v1
  AFTER INSERT OR UPDATE OF correlation_id, primary_resource_id, artifact_type, operation_kind
  ON public.mapping_operation_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.mapping_operation_reports_plugin_studio_lineage_correlation_v1();

UPDATE public.integration_plugins
   SET metadata = COALESCE(public.redact_sensitive_json(metadata), '{}'::jsonb);

UPDATE public.integration_plugin_versions
   SET source_payload = COALESCE(public.redact_sensitive_json(source_payload), '{}'::jsonb),
       normalized_contract = COALESCE(public.redact_sensitive_json(normalized_contract), '{}'::jsonb),
       inbound_config = COALESCE(public.redact_sensitive_json(inbound_config), '{}'::jsonb),
       mapping_config = COALESCE(public.redact_sensitive_json(mapping_config), '{}'::jsonb),
       outbound_operations = COALESCE(public.redact_sensitive_json(outbound_operations), '[]'::jsonb),
       auth_bindings = COALESCE(public.redact_sensitive_json(auth_bindings), '{}'::jsonb),
       validation_summary = COALESCE(public.redact_sensitive_json(validation_summary), '{}'::jsonb),
       metadata = COALESCE(public.redact_sensitive_json(metadata), '{}'::jsonb);

UPDATE public.mapping_operation_reports
   SET request_summary = COALESCE(public.redact_sensitive_json(request_summary), '{}'::jsonb),
       conversion_summary = COALESCE(public.redact_sensitive_json(conversion_summary), '{}'::jsonb),
       diagnostics_summary = COALESCE(public.redact_sensitive_json(diagnostics_summary), '{}'::jsonb),
       result_payload = COALESCE(public.redact_sensitive_json(result_payload), '{}'::jsonb),
       decision_refs = COALESCE(public.redact_sensitive_json(decision_refs), '{}'::jsonb),
       next_steps = COALESCE(public.redact_sensitive_json(next_steps), '[]'::jsonb);

UPDATE public.decision_log dl
   SET correlation_id = r.correlation_id::UUID
  FROM public.mapping_operation_reports r
 WHERE r.artifact_type = 'integration_plugin'
   AND r.operation_kind = 'mapping_save'
   AND r.primary_resource_id = dl.resource_id
   AND r.correlation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND dl.resource_type = 'integration_plugin_version'
   AND dl.decision_point = 'plugin_studio.draft_saved';

UPDATE public.domain_events de
   SET correlation_id = r.correlation_id::UUID,
       payload = public.redact_sensitive_json(
         COALESCE(de.payload, '{}'::jsonb)
         || jsonb_build_object('mapping_operation_report_id', r.id)
       )
  FROM public.mapping_operation_reports r
 WHERE r.artifact_type = 'integration_plugin'
   AND r.operation_kind = 'mapping_save'
   AND r.primary_resource_id = de.resource_id
   AND r.correlation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND de.resource_type = 'integration_plugin_version'
   AND de.event_type = 'integration_plugin_version_draft_saved';

COMMENT ON FUNCTION public.integration_plugin_generate_draft_v1(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid,
  text,
  text,
  uuid,
  jsonb
) IS 'Creates or versions an integration plugin draft. Plugin Studio/runtime governance redacts credential-shaped source, contract, config, outbound, auth, and metadata payloads before canonical persistence.';

SELECT pg_advisory_unlock(hashtext('202605301630_plugin_studio_secret_redaction_governance_v1'));
COMMIT;
