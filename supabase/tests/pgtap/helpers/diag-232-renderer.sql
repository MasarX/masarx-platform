-- Temporary probes for the two hosted pgTAP reproductions.
SET LOCAL client_min_messages TO NOTICE;

CREATE FUNCTION pg_temp.d232_field(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_value ~ '^[1-5][0-9]{2}$' OR p_value IN (
      'ready', 'placeholder_url', 'missing_or_invalid_url', 'missing_secret_ref', 'pin_mismatch',
      'label_renderer_unavailable', 'label_renderer_configuration_changed', 'outbound_url_invalid',
      'spec_resolution_failed', 'renderer_gateway_rejected', 'enabled', 'disabled', 'skipped',
      'pg_cron_not_installed', 'invoke_label_renderer_missing', 'label_provider_invoke_configuration_placeholder'
    ) THEN p_value
    ELSE '[redacted]'
  END;
$$;

CREATE FUNCTION pg_temp.d232_return(p_name text, p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'D232 %=%', p_name, jsonb_build_object(
    'keys', ARRAY(SELECT k FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_value) = 'object'
      THEN p_value ELSE '{}'::jsonb END) AS keys(k) ORDER BY k),
    'status', pg_temp.d232_field(p_value->>'status'),
    'state', pg_temp.d232_field(p_value->>'state'),
    'reason', pg_temp.d232_field(COALESCE(p_value->>'reason', p_value#>>'{body,reason}')),
    'code', pg_temp.d232_field(COALESCE(p_value->>'code', p_value#>>'{body,code}',
      p_value#>>'{body,error,code}', p_value#>>'{body,error}')));
  RETURN p_value;
END;
$$;

CREATE FUNCTION pg_temp.d232_error(p_name text, p_state text, p_context text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'D232 lookup_error=%', p_state;
  RAISE NOTICE 'D232 lookup_site=%', jsonb_build_object('probe', p_name, 'frame',
    substring(p_context FROM 'PL/pgSQL function ((?:public\.)?[a-z_][a-z_0-9]*\([a-z_0-9, ]*\) line [0-9]+)'));
END;
$$;

CREATE FUNCTION pg_temp.d232_counts(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY lane, status), '[]'::jsonb)
  FROM (
    SELECT CASE
      WHEN renderer_request_id IS NOT NULL THEN 'renderer_edge'
      WHEN status IN ('pending_edge', 'in_progress_edge') OR context ? 'edge_dispatch' THEN 'edge'
      WHEN status = 'pending' THEN 'sql'
      ELSE 'unmarked'
    END AS lane, status, count(*)
    FROM public.outbound_calls
    WHERE context->>'organization_id' IS NOT DISTINCT FROM p_org::text
    GROUP BY 1, 2
  ) grouped;
$$;

CREATE FUNCTION pg_temp.d232_config(p_name text, p_org uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  settings jsonb;
  provider jsonb;
  endpoint text;
  config jsonb;
  error_context text;
BEGIN
  IF p_org IS NOT NULL THEN
    settings := public.resolve_settings('label_provider', 'tenant', p_org);
    endpoint := NULLIF(settings#>>'{providers,0,invoke_url}', '');
  END IF;
  IF settings IS NULL OR endpoint LIKE ('https://' || 'example' || '.%') THEN
    settings := public.resolve_settings('label_provider', 'global', NULL);
  END IF;
  provider := settings#>'{providers,0}';
  endpoint := NULLIF(provider->>'invoke_url', '');
  config := pg_temp.d232_return(p_name || '.resolve_label_renderer_edge_config_v1',
    public.resolve_label_renderer_edge_config_v1(p_org));
  RAISE NOTICE 'D232 %.config=%', p_name, jsonb_build_object(
    'endpoint_present', endpoint IS NOT NULL,
    'placeholder', COALESCE(endpoint LIKE ('https://' || 'example' || '.%'), false),
    'credential_ref_present', COALESCE(provider#>>'{invoke_secret_ref,type}' = 'SecretRef'
      AND pg_input_is_valid(provider#>>'{invoke_secret_ref,id}', 'uuid'), false),
    'pin_match', CASE config->>'state' WHEN 'ready' THEN true WHEN 'pin_mismatch' THEN false END);
  RETURN config;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
  PERFORM pg_temp.d232_error(p_name || '.config', SQLSTATE, error_context);
  RETURN NULL;
END;
$$;

CREATE FUNCTION pg_temp.d232_probe(p_name text, p_org uuid, p_call text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
  setting_value text;
  wrapper jsonb;
  edge_policy jsonb;
  before_decisions uuid[];
  before_errors uuid[];
  error_context text;
BEGIN
  RAISE NOTICE 'D232 %.outbound_before=%', p_name, pg_temp.d232_counts(p_org);
  SELECT ARRAY(SELECT id FROM public.decision_log WHERE organization_id = p_org) INTO before_decisions;
  SELECT ARRAY(SELECT id FROM public.outbound_calls WHERE error_message IS NOT NULL
    AND context->>'organization_id' IS NOT DISTINCT FROM p_org::text) INTO before_errors;

  PERFORM pg_temp.d232_config(p_name, p_org);

  BEGIN
    SELECT NULLIF(d.value->>'legacy_outbound_template_id', '') INTO setting_value
    FROM public.resolve_settings_row_from_context('workflow_defaults',
      jsonb_strip_nulls(jsonb_build_object('organization_id', p_org))) d;
    WITH configured AS (
      SELECT id FROM public.workflow_templates WHERE status = 'active'
        AND id = CASE WHEN pg_input_is_valid(setting_value, 'uuid') THEN setting_value::uuid END
    ), fallback AS (
      SELECT id FROM public.workflow_templates WHERE name = 'outbound_wrapper_v1' AND status = 'active'
        AND scope_type = public.get_root_scope_type_key_v1() AND scope_id IS NULL
      ORDER BY version DESC, id LIMIT 1
    )
    SELECT jsonb_build_object('setting_present', setting_value IS NOT NULL,
      'configured_active', EXISTS (SELECT FROM configured), 'fallback_active', EXISTS (SELECT FROM fallback),
      'selected_enabled_steps', (SELECT count(*) FROM public.workflow_template_steps s WHERE s.enabled
        AND s.workflow_template_id = COALESCE((SELECT id FROM configured), (SELECT id FROM fallback))))
    INTO wrapper;
    RAISE NOTICE 'D232 %.wrapper=%', p_name, wrapper;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
    PERFORM pg_temp.d232_error(p_name || '.wrapper', SQLSTATE, error_context);
  END;

  BEGIN
    SELECT jsonb_build_object('row_present', count(*) > 0,
      'row_enabled', bool_or(cached_value->'enabled' = 'true'::jsonb),
      'effective_enabled', public.resolve_edge_dispatch_enabled_v1())
    INTO edge_policy FROM public.settings
    WHERE category = 'edge_dispatch_policy' AND scope_type = 'global' AND scope_id IS NULL;
    RAISE NOTICE 'D232 %.edge_policy=%', p_name, edge_policy;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
    PERFORM pg_temp.d232_error(p_name || '.edge_policy', SQLSTATE, error_context);
  END;

  BEGIN
    -- Each call is a fixed expression supplied by the fixture, executed exactly once.
    EXECUTE 'SELECT ' || p_call INTO result USING p_org;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
    PERFORM pg_temp.d232_error(p_name, SQLSTATE, error_context);
  END;
  PERFORM pg_temp.d232_return(p_name, result);

  RAISE NOTICE 'D232 %.outbound_after=%', p_name, pg_temp.d232_counts(p_org);
  RAISE NOTICE 'D232 %.decisions=%', p_name, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'code', pg_temp.d232_field(COALESCE(decision_inputs->>'code', decision_inputs->>'error_code')),
      'reason', pg_temp.d232_field(COALESCE(decision_inputs->>'reason', decision_reason))))
    FROM public.decision_log WHERE organization_id = p_org AND id <> ALL(before_decisions)), '[]'::jsonb);
  RAISE NOTICE 'D232 %.outbound_errors=%', p_name, COALESCE((
    SELECT jsonb_agg(jsonb_build_object('code', response_status_code, 'reason', pg_temp.d232_field(error_message)))
    FROM public.outbound_calls WHERE error_message IS NOT NULL AND id <> ALL(before_errors)
      AND context->>'organization_id' IS NOT DISTINCT FROM p_org::text), '[]'::jsonb);
  RETURN result;
END;
$$;

CREATE FUNCTION pg_temp.d232_job(p_name text, p_receipt jsonb) RETURNS public.outbound_calls
LANGUAGE plpgsql AS $$
DECLARE
  outbound public.outbound_calls;
  error_context text;
BEGIN
  SELECT * INTO STRICT outbound FROM public.outbound_calls WHERE id = (p_receipt->>'edge_job_id')::uuid;
  RETURN outbound;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
  PERFORM pg_temp.d232_error(p_name || '.outbound_lookup', SQLSTATE, error_context);
  RETURN NULL;
END;
$$;

CREATE FUNCTION pg_temp.d232_claim(p_name text, p_receipt jsonb) RETURNS TABLE (job_id uuid, lease_token uuid)
LANGUAGE plpgsql AS $$
DECLARE
  error_context text;
BEGIN
  RETURN QUERY SELECT c.job_id, c.lease_token
  FROM public.claim_edge_job_by_id_v1((p_receipt->>'edge_job_id')::uuid) c;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS error_context = PG_EXCEPTION_CONTEXT;
  PERFORM pg_temp.d232_error(p_name || '.lease_lookup', SQLSTATE, error_context);
END;
$$;
