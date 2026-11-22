-- Validate integration URLs and headers at persistence and delivery boundaries.
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.outbound_placeholder_url_v1(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p_url COLLATE "C" ~ '^(?:(?:comms|geocode)://[a-z0-9_-]+|workflow://internal/[a-z0-9_.-]+)$';
$function$;

CREATE FUNCTION public.outbound_dns_hostname_v1(p_host text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT length(p_host) <= 253
     AND p_host COLLATE "C" ~* '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
     AND p_host COLLATE "C" !~* '(^|\.)xn--'
     AND p_host COLLATE "C" !~* ('(^|\.)([0-9]+|0x[0-9a-f]*|local|internal|home[.]arpa|local' || 'host)$');
$function$;

CREATE FUNCTION public.outbound_http_allowed_hosts_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT cached_value->'http_allowed_hosts'
    FROM public.settings
   WHERE category = 'integration_plugin_egress_policy'
     AND scope_type = 'tenant'
     AND scope_id = p_organization_id;
$function$;

CREATE FUNCTION public.outbound_job_http_allowed_hosts_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN public.outbound_http_allowed_hosts_v1(public.resolve_organization_id_strict('outbound_call', p_job_id));
EXCEPTION
  WHEN raise_exception THEN
    RETURN NULL;
END;
$function$;

CREATE FUNCTION public.validate_outbound_http_hosts_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_hosts jsonb := (to_jsonb(NEW)->TG_ARGV[0])->'http_allowed_hosts';
BEGIN
  IF v_hosts IS NOT NULL AND (
    jsonb_typeof(v_hosts) <> 'array' OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_hosts) = 'array' THEN v_hosts ELSE '[]'::jsonb END) AS e(host)
       WHERE jsonb_typeof(host) <> 'string' OR NOT public.outbound_dns_hostname_v1(host #>> '{}')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_http_allowed_hosts_invalid';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.outbound_url_allowed_v1(p_url text, p_http_hosts jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_authority text[];
  v_host text;
  v_address inet;
BEGIN
  IF p_url IS NULL OR p_url ~ '[[:cntrl:][:space:]\\]' THEN
    RETURN false;
  END IF;

  -- Require a static, unescaped HTTP(S) authority. Only the path and query may be templated.
  v_authority := regexp_match(p_url COLLATE "C",
    '^https?://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#]|$)', 'i');
  IF v_authority IS NULL OR v_authority[2]::integer NOT BETWEEN 1 AND 65535 THEN
    RETURN false;
  END IF;

  v_host := lower(rtrim(v_authority[1] COLLATE "C", '.'));
  IF p_url COLLATE "C" ~* '^http://' THEN
    -- A tenant may opt an exact DNS hostname into HTTP. Peer checks require the egress proxy (#211).
    RETURN length(v_authority[1]) <= 254
       AND v_authority[1] !~ '\.\.$'
       AND public.outbound_dns_hostname_v1(v_host)
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_http_hosts) = 'array'
                                          THEN p_http_hosts ELSE '[]'::jsonb END) AS e(host)
          WHERE jsonb_typeof(host) = 'string'
            AND lower((host #>> '{}') COLLATE "C") = v_host
       );
  END IF;

  IF left(v_host, 1) = '[' THEN
    v_address := trim(both '[]' FROM v_host)::inet;
    IF family(v_address) <> 6 THEN
      RETURN false;
    END IF;
    IF v_address <<= '::ffff:0:0/96'::cidr THEN
      v_address := '0.0.0.0'::inet + (v_address - '::ffff:0:0'::inet);
    ELSE
      -- Limit IPv6 literals to global unicast, excluding address transition ranges.
      RETURN v_address <<= '2000::/3'::cidr
         AND NOT (v_address <<= ANY (ARRAY['2001::/32', '2002::/16']::cidr[]));
    END IF;
  ELSIF v_host ~ '^[0-9]+(\.[0-9]+){3}$' THEN
    v_address := v_host::inet;
    IF host(v_address) <> v_host OR v_authority[1] <> v_host THEN
      RETURN false;
    END IF;
  ELSE
    -- Reject noncanonical numeric hosts and resolver-local names.
    RETURN length(v_authority[1]) <= 254
       AND v_authority[1] !~ '\.\.$'
       AND public.outbound_dns_hostname_v1(v_host);
  END IF;

  RETURN NOT (v_address <<= ANY (ARRAY[
    '0/8', '10/8', '100.64/10', '127/8', '169.254/16', '172.16/12', '192.168/16', '224/3'
  ]::cidr[]));
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$function$;

CREATE FUNCTION public.filter_outbound_headers_v1(p_headers jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(jsonb_object_agg(header.name, header.value), '{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_headers) = 'object' THEN p_headers ELSE '{}'::jsonb END)
    AS header(name, value)
  WHERE lower(header.name COLLATE "C") = ANY (ARRAY[
    'accept', 'accept-language', 'authorization', 'content-type', 'idempotency-key',
    'user-agent', 'x-correlation-id', 'x-idempotency-key', 'x-request-id',
    'company-id', 'd360-api-key', 'traceparent', 'tracestate', 'x-api-key', 'x-client-id', 'x-provider-auth'
  ])
    AND jsonb_typeof(header.value) = 'string'
    AND (header.value #>> '{}') !~ '[[:cntrl:]]';
$function$;

CREATE FUNCTION public.validate_outbound_integration_write_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_url text;
  v_hosts jsonb;
BEGIN
  IF TG_RELID = 'public.operation_templates'::regclass THEN
    IF (TG_OP = 'INSERT' OR NEW.headers_template IS DISTINCT FROM OLD.headers_template)
       AND NEW.headers_template IS NOT NULL
       AND NEW.headers_template <> public.filter_outbound_headers_v1(NEW.headers_template) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_headers_invalid';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.url_template IS NOT DISTINCT FROM OLD.url_template
       AND NEW.provider_id IS NOT DISTINCT FROM OLD.provider_id THEN
      RETURN NEW;
    END IF;
    v_url := NEW.url_template;
    IF v_url COLLATE "C" ~* '^http://' THEN
      SELECT public.outbound_http_allowed_hosts_v1(p.organization_id)
        INTO v_hosts FROM public.providers p WHERE p.id = NEW.provider_id;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.url IS NOT DISTINCT FROM OLD.url
       AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
       AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
       AND NEW.shipment_id IS NOT DISTINCT FROM OLD.shipment_id THEN
      RETURN NEW;
    END IF;
    v_url := NEW.url;
    IF v_url COLLATE "C" ~* '^http://' THEN
      v_hosts := public.outbound_job_http_allowed_hosts_v1(NEW.id);
    END IF;
  END IF;

  IF NOT COALESCE(public.outbound_placeholder_url_v1(v_url), false)
     AND NOT public.outbound_url_allowed_v1(v_url, v_hosts) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.outbound_dispatch_headers_v1(p_url text, p_headers jsonb, p_job_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
BEGIN
  -- pg_net follows redirects and cannot validate DNS answers or the connected peer.
  -- See #211 for requiring guarded Edge proxy dispatch.
  IF NOT public.outbound_url_allowed_v1(p_url,
    CASE WHEN p_url COLLATE "C" ~* '^http://' THEN public.outbound_job_http_allowed_hosts_v1(p_job_id) END
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
  END IF;

  v_headers := public.filter_outbound_headers_v1(p_headers);
  IF p_headers IS NOT NULL AND p_headers IS DISTINCT FROM v_headers THEN
    RAISE LOG 'outbound_headers_dropped';
  END IF;
  RETURN v_headers;
END;
$function$;

CREATE FUNCTION public.mark_outbound_url_invalid_v1(p_job_id uuid, p_executor text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  UPDATE public.outbound_calls
     SET status = 'permanently_failed',
         error_message = 'outbound_url_invalid',
         completed_at = now(),
         lease_expires_at = NULL,
         edge_lease_token = NULL,
         context = context - 'edge_dispatch' - 'async_request_id'
   WHERE id = p_job_id;
  BEGIN
    PERFORM public.finalize_outbound_workflow_step_v1(p_job_id, p_executor);
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'outbound_url_invalid_workflow_finalization_failed';
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.outbound_placeholder_url_v1(text) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_dns_hostname_v1(text) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_http_allowed_hosts_v1(uuid) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_job_http_allowed_hosts_v1(uuid) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.validate_outbound_http_hosts_write_v1() FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.mark_outbound_url_invalid_v1(uuid, text) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_url_allowed_v1(text, jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.filter_outbound_headers_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.validate_outbound_integration_write_v1() FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_dispatch_headers_v1(text, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

CREATE OR REPLACE FUNCTION public.run_outbound_worker()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_job RECORD;
    v_org UUID;
    v_spec JSONB;
    v_dispatch_headers JSONB;
    v_result JSONB;
    v_status INT;
    v_completed BOOLEAN;
    v_optout JSONB;
    v_async_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_policy_row RECORD;
    v_policy_ctx JSONB;
    v_defaults JSONB;
    v_poll_seconds INT := NULL;
    v_poll_min INT := NULL;
    v_poll_max INT := NULL;
    v_settings_resolution_id UUID := NULL;
    v_policy_scope_type TEXT;
    v_policy_scope_id UUID;
    v_policy_settings_id UUID;
    v_policy_settings_version_id UUID;
    v_policy_version INT;
    v_scope_path JSONB;
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('outbound_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('outbound_worker');

    FOR v_job IN SELECT oc.workflow_run_step_id, cpj.* FROM public.claim_pending_jobs(v_throttle.batch_size) cpj JOIN public.outbound_calls oc ON oc.id = cpj.job_id
    LOOP
        BEGIN
            IF v_job.target_type = 'provider' THEN
                v_org := public.resolve_organization_id_strict('provider', v_job.target_id);
            ELSIF v_job.target_type = 'client' THEN
                v_org := public.resolve_organization_id_strict('client', v_job.target_id);
            ELSIF v_job.shipment_id IS NOT NULL THEN
                v_org := public.resolve_organization_id_strict('shipment', v_job.shipment_id);
            ELSE
                v_org := public.resolve_organization_id_strict('outbound_call', v_job.job_id);
            END IF;

            v_policy_ctx := NULL;
            v_policy_row := NULL;
            v_defaults := NULL;
            v_poll_seconds := NULL;
            v_poll_min := NULL;
            v_poll_max := NULL;
            v_settings_resolution_id := NULL;
            v_scope_path := NULL;

            IF v_job.workflow_run_step_id IS NOT NULL THEN
                SELECT r.context
                  INTO v_policy_ctx
                  FROM public.workflow_run_steps s
                  JOIN public.workflow_runs r ON r.id = s.workflow_run_id
                 WHERE s.id = v_job.workflow_run_step_id;
            END IF;

            v_policy_ctx := jsonb_strip_nulls(
              COALESCE(v_policy_ctx, v_job.context, '{}'::jsonb) || jsonb_build_object('organization_id', v_org)
            );

            SELECT *
              INTO v_policy_row
              FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
             LIMIT 1;

            IF NOT FOUND OR v_policy_row.value IS NULL THEN
                SELECT *
                  INTO v_policy_row
                  FROM public.resolve_settings_row('workflow_defaults', 'global', NULL)
                 LIMIT 1;
            END IF;

            v_defaults := v_policy_row.value;
            IF v_defaults IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults_missing';
            END IF;

            v_policy_scope_type := v_policy_row.scope_type;
            v_policy_scope_id := v_policy_row.scope_id;
            v_policy_settings_id := v_policy_row.settings_id;
            v_policy_settings_version_id := v_policy_row.settings_version_id;
            v_policy_version := v_policy_row.version;
            v_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb);

            v_settings_resolution_id := public.log_settings_resolution(
                p_organization_id := v_org,
                p_category := 'workflow_defaults',
                p_winning_scope_type := v_policy_scope_type,
                p_winning_scope_id := v_policy_scope_id,
                p_winning_settings_id := v_policy_settings_id,
                p_winning_settings_version_id := v_policy_settings_version_id,
                p_winning_version := v_policy_version,
                p_scope_path := v_scope_path,
                p_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'job_id', v_job.job_id,
                    'call_type', v_job.call_type,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id
                )),
                p_merge_notes := jsonb_build_object('source', 'run_outbound_worker')
            );

            BEGIN
                v_poll_seconds := NULLIF(v_defaults->>'outbound_poll_seconds', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_seconds := NULL;
            END;
            IF v_poll_seconds IS NULL THEN
                BEGIN
                    v_poll_seconds := NULLIF(v_defaults->>'poll_seconds', '')::INT;
                EXCEPTION
                    WHEN others THEN
                        v_poll_seconds := NULL;
                END;
            END IF;
            IF v_poll_seconds IS NULL THEN
                RAISE EXCEPTION 'workflow_defaults.poll_seconds missing';
            END IF;

            BEGIN
                v_poll_min := NULLIF(v_defaults->>'poll_seconds_min', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_min := NULL;
            END;
            BEGIN
                v_poll_max := NULLIF(v_defaults->>'poll_seconds_max', '')::INT;
            EXCEPTION
                WHEN others THEN
                    v_poll_max := NULL;
            END;

            v_poll_min := COALESCE(v_poll_min, v_poll_seconds);
            v_poll_max := COALESCE(v_poll_max, v_poll_seconds);
            v_poll_seconds := LEAST(GREATEST(v_poll_seconds, v_poll_min), v_poll_max);

            v_optout := public.should_skip_outbound_call_for_opt_out(
              v_job.call_type,
              v_job.shipment_id,
              COALESCE(v_job.context, '{}'::jsonb)
            );
            IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
                UPDATE public.outbound_calls
                   SET status = 'skipped',
                       completed_at = now(),
                       lease_expires_at = NULL,
                       error_message = COALESCE(v_optout->>'reason', 'skipped')
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'opt_out',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_optout,
                    p_decision_reason := v_optout->>'reason',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;
            v_async_request_id := NULL;
            BEGIN
                v_async_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_async_request_id := NULL;
            END;

            IF v_async_request_id IS NOT NULL THEN
                v_poll := public.check_async_response(v_async_request_id);
                v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
                v_status := COALESCE((v_poll->>'status')::INT, 0);

                IF NOT v_completed THEN
                    UPDATE public.outbound_calls
                       SET status = 'pending',
                           scheduled_at = now() + make_interval(secs => v_poll_seconds),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'async_pending',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'async_request_id', v_async_request_id,
                          'poll', v_poll,
                          'poll_seconds', v_poll_seconds
                        ),
                        p_decision_reason := 'Awaiting async HTTP response (polling pg_net).',
                        p_settings_resolution_id := v_settings_resolution_id
                    );

                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
                END IF;

                IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                    UPDATE public.outbound_calls
                       SET status = 'completed',
                           response_status_code = v_status,
                           response_body = v_poll->'body',
                           response_headers = v_poll->'headers',
                           completed_at = now(),
                           error_message = NULL,
                           lease_expires_at = NULL,
                           context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                     WHERE id = v_job.job_id;

                    -- Response processing failures should not flip delivery state or trigger resends.
                    BEGIN
                      PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                    EXCEPTION
                      WHEN OTHERS THEN
                        v_error := TRUE;
                        UPDATE public.outbound_calls
                           SET requires_investigation = TRUE,
                               root_cause = 'response_processing_exception',
                               resolution_notes = SQLERRM
                         WHERE id = v_job.job_id;

                        PERFORM public.log_decision(
                          p_organization_id := v_org,
                          p_decision_category := 'outbound_call',
                          p_resource_type := 'outbound_call',
                          p_resource_id := v_job.job_id,
                          p_decision_point := 'response_processing',
                          p_decision_outcome := 'exception',
                          p_performed_by_system := 'outbound_worker',
                          p_correlation_id := v_job.correlation_id,
                          p_decision_reason := SQLERRM
                        );
                    END;

                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, NULL
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'outbound_call',
                        p_resource_type := 'outbound_call',
                        p_resource_id := v_job.job_id,
                        p_decision_point := 'http_execution',
                        p_decision_outcome := 'success',
                        p_performed_by_system := 'outbound_worker',
                        p_correlation_id := v_job.correlation_id,
                        p_decision_inputs := jsonb_build_object(
                          'status', v_status,
                          'async_request_id', v_async_request_id
                        ),
                        p_decision_reason := 'Outbound HTTP request completed successfully.'
                    );

                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                ELSE
                    -- F267 audit begin
                    BEGIN
                        PERFORM public.log_api_call_event(
                            v_job.job_id, '{}'::jsonb,
                            jsonb_build_object('headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                                               'body', COALESCE(v_poll->'body', '{}'::jsonb)),
                            v_status, NULL, 'outbound_call_failed'
                        );
                    EXCEPTION
                        WHEN OTHERS THEN
                            -- Audit failure must not undo a delivered request or schedule a resend.
                            RAISE WARNING 'outbound_api_audit_failed';
                    END;
                    -- F267 audit end

                    PERFORM public.mark_outbound_call_failure_v2(
                      p_job_id := v_job.job_id,
                      p_status_code := v_status,
                      p_headers := COALESCE(v_poll->'headers', '{}'::jsonb),
                      p_body := COALESCE(v_poll->'body', '{}'::jsonb),
                      p_error := COALESCE(v_poll->'body'->>'error', format('HTTP %s failure', v_status)),
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id
                    );


                    BEGIN
                      PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                    EXCEPTION
                      WHEN OTHERS THEN
                        NULL;
                    END;
                END IF;

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            -- First attempt: build call spec and dispatch via call_api (pg_net).
            v_spec := public.get_job_call_spec(v_job.job_id);
            BEGIN
                v_dispatch_headers := public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers', v_job.job_id);
            EXCEPTION
                WHEN invalid_parameter_value THEN
                    IF SQLERRM <> 'outbound_url_invalid' THEN
                        RAISE;
                    END IF;
                    PERFORM public.mark_outbound_url_invalid_v1(v_job.job_id, 'outbound_worker');
                    v_error := TRUE;
                    v_items_processed := v_items_processed + 1;
                    CONTINUE;
            END;
            v_result := public.call_api(
                v_spec->>'url',
                COALESCE(v_spec->>'method', 'POST'),
                v_dispatch_headers,
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL
            );

            v_status := COALESCE((v_result->>'status')::INT, 0);
            v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

            IF v_result ? 'edge_dispatch' THEN
                UPDATE public.outbound_calls
                   SET status = 'pending_edge',
                       scheduled_at = now(),
                       lease_expires_at = NULL,
                       context = jsonb_set(
                           (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id'),
                           '{edge_dispatch}',
                           v_result->'edge_dispatch',
                           TRUE
                       )
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := v_result->'edge_dispatch',
                    p_decision_reason := 'Edge dispatch required for outbound HTTP execution.',
                    p_settings_resolution_id := v_settings_resolution_id
                );

                v_items_processed := v_items_processed + 1;
                CONTINUE;
            END IF;

            IF v_completed AND v_status BETWEEN 200 AND 299 THEN
                UPDATE public.outbound_calls
                   SET status = 'completed',
                       response_status_code = v_status,
                       response_body = v_result->'body',
                       response_headers = v_result->'headers',
                       latency_ms = NULLIF(v_result->>'latency_ms', '')::INT,
                       completed_at = now(),
                       error_message = NULL,
                       lease_expires_at = NULL,
                       context = (COALESCE(public.outbound_calls.context, '{}'::jsonb) - 'async_request_id' - 'edge_dispatch')
                 WHERE id = v_job.job_id;

                -- Response processing failures should not flip delivery state or trigger resends.
                BEGIN
                  PERFORM public.orchestrate_api_response_processing(v_job.job_id);
                EXCEPTION
                  WHEN OTHERS THEN
                    v_error := TRUE;
                    UPDATE public.outbound_calls
                       SET requires_investigation = TRUE,
                           root_cause = 'response_processing_exception',
                           resolution_notes = SQLERRM
                     WHERE id = v_job.job_id;

                    PERFORM public.log_decision(
                      p_organization_id := v_org,
                      p_decision_category := 'outbound_call',
                      p_resource_type := 'outbound_call',
                      p_resource_id := v_job.job_id,
                      p_decision_point := 'response_processing',
                      p_decision_outcome := 'exception',
                      p_performed_by_system := 'outbound_worker',
                      p_correlation_id := v_job.correlation_id,
                      p_decision_reason := SQLERRM
                    );
                END;

                -- F267 audit begin
                BEGIN
                    PERFORM public.log_api_call_event(
                        v_job.job_id, '{}'::jsonb,
                        jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                           'body', COALESCE(v_result->'body', '{}'::jsonb)),
                        v_status, NULL, NULL
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        -- Audit failure must not undo a delivered request or schedule a resend.
                        RAISE WARNING 'outbound_api_audit_failed';
                END;
                -- F267 audit end

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'success',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := jsonb_build_object(
                      'status', v_status,
                      'async_request_id', v_async_request_id
                    ),
                    p_decision_reason := 'Outbound HTTP request completed successfully.'
                );

                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
            ELSIF v_completed THEN
                -- F267 audit begin
                BEGIN
                    PERFORM public.log_api_call_event(
                        v_job.job_id, '{}'::jsonb,
                        jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                           'body', COALESCE(v_result->'body', '{}'::jsonb)),
                        v_status, NULL, 'outbound_call_failed'
                    );
                EXCEPTION
                    WHEN OTHERS THEN
                        -- Audit failure must not undo a delivered request or schedule a resend.
                        RAISE WARNING 'outbound_api_audit_failed';
                END;
                -- F267 audit end

                PERFORM public.mark_outbound_call_failure_v2(
                  p_job_id := v_job.job_id,
                  p_status_code := v_status,
                  p_headers := COALESCE(v_result->'headers', '{}'::jsonb),
                  p_body := COALESCE(v_result->'body', '{}'::jsonb),
                  p_error := COALESCE(v_result->'body'->>'error', format('HTTP %s failure', v_status)),
                  p_performed_by_system := 'outbound_worker',
                  p_correlation_id := v_job.correlation_id
                );


                BEGIN
                  PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                EXCEPTION
                  WHEN OTHERS THEN
                    NULL;
                END;
            ELSE
                UPDATE public.outbound_calls
                   SET status = 'pending',
                       scheduled_at = now() + make_interval(secs => v_poll_seconds),
                       lease_expires_at = NULL,
                       context = CASE
                           WHEN v_result ? 'request_id' THEN
                               jsonb_set(
                                   COALESCE(public.outbound_calls.context, '{}'::jsonb),
                                   '{async_request_id}',
                                   to_jsonb(v_result->>'request_id'),
                                   TRUE
                               )
                           ELSE public.outbound_calls.context
                       END
                 WHERE id = v_job.job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := v_job.job_id,
                    p_decision_point := 'http_execution',
                    p_decision_outcome := 'async_pending',
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id,
                    p_decision_inputs := COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('poll_seconds', v_poll_seconds),
                    p_decision_reason := 'HTTP request accepted asynchronously; awaiting polling.',
                    p_settings_resolution_id := v_settings_resolution_id
                );
            END IF;

            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;

                BEGIN
                  PERFORM public.mark_outbound_call_failure_v2(
                    p_job_id := v_job.job_id,
                    p_status_code := 0,
                    p_headers := '{}'::jsonb,
                    p_body := '{}'::jsonb,
                    p_error := format('exception: %s', SQLERRM),
                    p_performed_by_system := 'outbound_worker',
                    p_correlation_id := v_job.correlation_id
                  );

                  BEGIN
                    PERFORM public.finalize_outbound_workflow_step_v1(v_job.job_id, 'outbound_worker');
                  EXCEPTION
                    WHEN OTHERS THEN
                      NULL;
                  END;
                EXCEPTION
                  WHEN OTHERS THEN
                    UPDATE public.outbound_calls
                       SET status = 'permanently_failed',
                           retry_count = v_job.retry_count + 1,
                           error_message = SQLERRM,
                           completed_at = now(),
                           lease_expires_at = NULL
                     WHERE id = v_job.job_id;
                END;
        END;
    END LOOP;

    PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
    PERFORM public.update_cron_config('outbound_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_outbound_call_inline(p_job_id uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_job public.outbound_calls%ROWTYPE;
    v_org UUID;
    v_optout JSONB;
    v_spec JSONB;
    v_dispatch_headers JSONB;
    v_result JSONB := NULL;
    v_status INT := 0;
    v_completed BOOLEAN := FALSE;
    v_request_id BIGINT := NULL;
    v_poll JSONB := NULL;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_deadline TIMESTAMPTZ := NULL;
    v_latency_ms INT := NULL;

    -- Options (strict; no behavioral defaults in code)
    v_timeout_seconds INT := NULL;
    v_poll_max_seconds INT := NULL;
    v_poll_interval_ms INT := NULL;
    v_pending_reschedule_seconds INT := NULL;
    v_lease_seconds INT := NULL;
    v_performed_by_system TEXT := NULL;
    v_correlation_id UUID := NULL;
    v_sleep_seconds DOUBLE PRECISION := NULL;

    v_error TEXT := NULL;
BEGIN
    IF to_regclass('public.outbound_calls') IS NULL THEN
        RETURN jsonb_build_object('status', 'skipped', 'reason', 'outbound_calls_missing');
    END IF;

    IF p_job_id IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_id_missing');
    END IF;

    -- Parse options. Thresholds/timeouts are policy-driven; caller must provide.
    v_timeout_seconds := NULLIF(p_options->>'timeout_seconds', '')::INT;
    v_poll_max_seconds := NULLIF(p_options->>'poll_max_seconds', '')::INT;
    v_poll_interval_ms := NULLIF(p_options->>'poll_interval_ms', '')::INT;
    v_pending_reschedule_seconds := NULLIF(p_options->>'pending_reschedule_seconds', '')::INT;
    v_lease_seconds := NULLIF(p_options->>'lease_seconds', '')::INT;

    v_performed_by_system := NULLIF(p_options->>'performed_by_system', '');
    IF v_performed_by_system IS NULL THEN
        v_performed_by_system := 'dispatch_outbound_call_inline';
    END IF;

    BEGIN
        v_correlation_id := NULLIF(p_options->>'correlation_id', '')::UUID;
    EXCEPTION
        WHEN others THEN
            v_correlation_id := NULL;
    END;

    IF v_timeout_seconds IS NULL OR v_timeout_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_timeout_missing_or_invalid';
    END IF;
    IF v_poll_max_seconds IS NULL OR v_poll_max_seconds < 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_max_missing_or_invalid';
    END IF;
    IF v_poll_interval_ms IS NULL OR v_poll_interval_ms <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_poll_interval_missing_or_invalid';
    END IF;
    IF v_pending_reschedule_seconds IS NULL OR v_pending_reschedule_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_reschedule_missing_or_invalid';
    END IF;
    IF v_lease_seconds IS NULL OR v_lease_seconds <= 0 THEN
        RAISE EXCEPTION 'inline_dispatch_lease_missing_or_invalid';
    END IF;

    v_sleep_seconds := GREATEST(v_poll_interval_ms, 10)::DOUBLE PRECISION / 1000.0;

    SELECT *
      INTO v_job
      FROM public.outbound_calls
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'reason', 'job_not_found', 'job_id', p_job_id);
    END IF;

    -- Only dispatch queued jobs; completed/skipped etc are no-ops.
    IF v_job.status NOT IN ('pending', 'failed') THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_dispatchable',
            'job_id', p_job_id,
            'job_status', v_job.status
        );
    END IF;

    -- Respect due time (no early sends).
    IF v_job.scheduled_at IS NOT NULL AND v_job.scheduled_at > now() THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'job_not_due',
            'job_id', p_job_id,
            'scheduled_at', v_job.scheduled_at
        );
    END IF;

    -- Acquire a short lease so cron workers don't concurrently dispatch this job.
    UPDATE public.outbound_calls
       SET lease_expires_at = now() + make_interval(secs => v_lease_seconds)
     WHERE id = p_job_id;

    v_org := public.resolve_organization_id_strict('outbound_call', p_job_id);

    v_optout := public.should_skip_outbound_call_for_opt_out(
        v_job.call_type,
        v_job.shipment_id,
        COALESCE(v_job.context, '{}'::jsonb)
    );

    IF COALESCE((v_optout->>'skip')::BOOLEAN, FALSE) THEN
        UPDATE public.outbound_calls
           SET status = 'skipped',
               error_message = COALESCE(v_optout->>'reason', 'skipped'),
               completed_at = now(),
               lease_expires_at = NULL
         WHERE id = p_job_id;

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'opt_out',
            p_decision_outcome := 'skipped',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := v_optout,
            p_decision_reason := v_optout->>'reason'
        );

        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', v_optout->>'reason',
            'job_id', p_job_id
        );
    END IF;

    -- If an async pg_net request_id already exists, poll it first (avoid duplicate sends).
    BEGIN
        v_request_id := NULLIF(v_job.context->>'async_request_id', '')::BIGINT;
    EXCEPTION
        WHEN others THEN
            v_request_id := NULL;
    END;

    IF v_request_id IS NOT NULL THEN
        v_poll := public.check_async_response(v_request_id);
        v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
        v_status := COALESCE((v_poll->>'status')::INT, 0);

        IF v_completed THEN
            v_result := jsonb_build_object(
                'status', v_status,
                'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                'body', COALESCE(v_poll->'body', '{}'::jsonb),
                'completed', TRUE,
                'request_id', v_request_id
            );
        END IF;
    END IF;

    IF NOT v_completed AND v_request_id IS NULL THEN
        -- Dispatch a new HTTP request and optionally wait within the policy budget.
        v_spec := public.get_job_call_spec(p_job_id);
        BEGIN
            v_dispatch_headers := public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers', p_job_id);
        EXCEPTION
            WHEN invalid_parameter_value THEN
                IF SQLERRM <> 'outbound_url_invalid' THEN
                    RAISE;
                END IF;
                PERFORM public.mark_outbound_url_invalid_v1(p_job_id, v_performed_by_system);
                RETURN jsonb_build_object('status', 'failed', 'job_id', p_job_id, 'reason', 'outbound_url_invalid');
        END;
        v_result := public.call_api(
            v_spec->>'url',
            COALESCE(v_spec->>'method', 'POST'),
            v_dispatch_headers,
            COALESCE(v_spec->'body', '{}'::jsonb),
            v_timeout_seconds
        );

        v_status := COALESCE((v_result->>'status')::INT, 0);
        v_completed := COALESCE((v_result->>'completed')::BOOLEAN, FALSE);

        IF NOT v_completed THEN
            BEGIN
                v_request_id := NULLIF(v_result->>'request_id', '')::BIGINT;
            EXCEPTION
                WHEN others THEN
                    v_request_id := NULL;
            END;

            IF v_request_id IS NOT NULL THEN
                UPDATE public.outbound_calls
                   SET context = jsonb_set(
                       COALESCE(context, '{}'::jsonb),
                       '{async_request_id}',
                       to_jsonb(v_request_id),
                       TRUE
                   )
                 WHERE id = p_job_id;
            END IF;
        END IF;
    END IF;

    -- Extra polling budget (beyond call_api's internal poll window) to keep reply SLA <10s.
    IF NOT v_completed AND v_request_id IS NOT NULL AND v_poll_max_seconds > 0 THEN
        v_deadline := clock_timestamp() + make_interval(secs => v_poll_max_seconds);

        WHILE clock_timestamp() < v_deadline LOOP
            v_poll := public.check_async_response(v_request_id);
            v_completed := COALESCE((v_poll->>'completed')::BOOLEAN, FALSE);
            v_status := COALESCE((v_poll->>'status')::INT, 0);

            IF v_completed THEN
                v_result := jsonb_build_object(
                    'status', v_status,
                    'headers', COALESCE(v_poll->'headers', '{}'::jsonb),
                    'body', COALESCE(v_poll->'body', '{}'::jsonb),
                    'completed', TRUE,
                    'request_id', v_request_id
                );
                EXIT;
            END IF;

            PERFORM pg_sleep(v_sleep_seconds);
        END LOOP;
    END IF;

    v_latency_ms := ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT;

    IF v_completed AND v_status BETWEEN 200 AND 299 THEN
        UPDATE public.outbound_calls
           SET status = 'completed',
               response_status_code = v_status,
               response_body = COALESCE(v_result->'body', '{}'::jsonb),
               response_headers = COALESCE(v_result->'headers', '{}'::jsonb),
               latency_ms = v_latency_ms,
               completed_at = now(),
               error_message = NULL,
               lease_expires_at = NULL,
               context = (COALESCE(context, '{}'::jsonb) - 'async_request_id')
         WHERE id = p_job_id;

        -- Response processing failures should not flip delivery state or trigger resends.
        BEGIN
            PERFORM public.orchestrate_api_response_processing(p_job_id);
        EXCEPTION
            WHEN OTHERS THEN
                UPDATE public.outbound_calls
                   SET requires_investigation = TRUE,
                       root_cause = 'response_processing_exception',
                       resolution_notes = SQLERRM
                 WHERE id = p_job_id;

                PERFORM public.log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'outbound_call',
                    p_resource_type := 'outbound_call',
                    p_resource_id := p_job_id,
                    p_decision_point := 'response_processing',
                    p_decision_outcome := 'exception',
                    p_performed_by_system := v_performed_by_system,
                    p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
                    p_decision_reason := SQLERRM
                );
        END;

        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, NULL
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.log_decision(
            p_organization_id := v_org,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'http_execution',
            p_decision_outcome := 'success',
            p_performed_by_system := v_performed_by_system,
            p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
            p_decision_inputs := jsonb_build_object('status', v_status, 'latency_ms', v_latency_ms),
            p_decision_reason := 'Outbound HTTP request completed inline.'
        );

        RETURN jsonb_build_object(
            'status', 'completed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    IF v_completed THEN
        -- F267 audit begin
        BEGIN
            PERFORM public.log_api_call_event(
                p_job_id, '{}'::jsonb,
                jsonb_build_object('headers', COALESCE(v_result->'headers', '{}'::jsonb),
                                   'body', COALESCE(v_result->'body', '{}'::jsonb)),
                v_status, v_latency_ms, 'outbound_call_failed'
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- Audit failure must not undo a delivered request or schedule a resend.
                RAISE WARNING 'outbound_api_audit_failed';
        END;
        -- F267 audit end

        PERFORM public.mark_outbound_call_failure(
            p_job_id,
            v_status,
            COALESCE(v_result->'headers', '{}'::jsonb),
            COALESCE(v_result->'body', '{}'::jsonb),
            COALESCE(
                NULLIF(v_result->'body'->>'error', ''),
                NULLIF(v_result->'body'->>'message', ''),
                format('HTTP %s failure', v_status)
            )
        );


        UPDATE public.outbound_calls
           SET lease_expires_at = NULL
         WHERE id = p_job_id;

        RETURN jsonb_build_object(
            'status', 'failed',
            'job_id', p_job_id,
            'http_status', v_status,
            'completed', TRUE,
            'latency_ms', v_latency_ms
        );
    END IF;

    -- Still pending: release lease and reschedule for worker.
    UPDATE public.outbound_calls
       SET status = 'pending',
           scheduled_at = now() + make_interval(secs => v_pending_reschedule_seconds),
           lease_expires_at = NULL
     WHERE id = p_job_id;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'outbound_call',
        p_resource_type := 'outbound_call',
        p_resource_id := p_job_id,
        p_decision_point := 'http_execution',
        p_decision_outcome := 'async_pending',
        p_performed_by_system := v_performed_by_system,
        p_correlation_id := COALESCE(v_correlation_id, v_job.correlation_id),
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'status', v_status,
            'async_request_id', v_request_id,
            'latency_ms', v_latency_ms
        )),
        p_decision_reason := 'Inline dispatch did not complete within budget; left queued for worker.'
    );

    RETURN jsonb_build_object(
        'status', 'pending',
        'job_id', p_job_id,
        'completed', FALSE,
        'async_request_id', v_request_id,
        'latency_ms', v_latency_ms
    );
EXCEPTION
    WHEN OTHERS THEN
        v_error := SQLERRM;
        BEGIN
            UPDATE public.outbound_calls
               SET lease_expires_at = NULL
             WHERE id = p_job_id;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;
        RETURN jsonb_build_object('status', 'error', 'job_id', p_job_id, 'reason', v_error);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_claimed_edge_job_call_spec_v1(p_job_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_spec JSONB;
  v_error TEXT;
  v_org_text TEXT;
BEGIN
  SELECT oc.call_type, COALESCE(oc.context, '{}'::jsonb) AS context
  INTO v_job
  FROM public.outbound_calls oc
  WHERE oc.id = p_job_id
    AND oc.status = 'in_progress_edge'
    AND oc.edge_lease_token = p_lease_token
    AND oc.lease_expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: active lease for job % not found', p_job_id;
  END IF;

  BEGIN
    v_spec := public.get_job_call_spec(p_job_id);
    v_spec := v_spec || jsonb_build_object(
      'url', COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
      'headers', public.outbound_dispatch_headers_v1(
        COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
        COALESCE(v_job.context #> '{edge_dispatch,headers}', v_spec->'headers'),
        p_job_id
      )
    );
  EXCEPTION
    WHEN others THEN
      v_error := SQLERRM;
      UPDATE public.outbound_calls oc
      SET
        status = 'permanently_failed',
        error_message = v_error,
        completed_at = now(),
        lease_expires_at = NULL,
        edge_lease_token = NULL
      WHERE oc.id = p_job_id
        AND oc.status = 'in_progress_edge'
        AND oc.edge_lease_token = p_lease_token
        AND oc.lease_expires_at > now();

      IF NOT FOUND THEN
        RAISE EXCEPTION 'get_claimed_edge_job_call_spec_v1: lease for job % changed during spec resolution', p_job_id;
      END IF;

      v_org_text := COALESCE(v_job.context->>'organization_id', '');
      IF v_org_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        BEGIN
          PERFORM public.log_decision(
            p_organization_id := v_org_text::UUID,
            p_decision_category := 'outbound_call',
            p_resource_type := 'outbound_call',
            p_resource_id := p_job_id,
            p_decision_point := 'edge_claim_spec',
            p_decision_outcome := 'permanently_failed',
            p_performed_by_system := 'get_claimed_edge_job_call_spec_v1',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
              'call_type', v_job.call_type,
              'reason', 'spec_resolution_failed',
              'error', v_error
            )),
            p_decision_reason := 'Claimed Edge job has an invalid call specification.'
          );
        EXCEPTION WHEN OTHERS THEN
          IF v_error <> 'outbound_url_invalid' THEN
            RAISE;
          END IF;
          -- Preserve the terminal URL rejection if its audit insert fails.
          RAISE WARNING 'outbound_edge_claim_spec_audit_failed';
        END;
      END IF;
      RETURN NULL;
  END;

  RETURN jsonb_build_object(
    'url', v_spec->>'url',
    'method', COALESCE(upper((v_job.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', v_spec->'headers',
    'body', COALESCE((v_job.context->'edge_dispatch')->'body', v_spec->'body', '{}'::jsonb),
    'timeout_seconds', COALESCE(
      NULLIF((v_job.context->'edge_dispatch')->>'timeout_seconds', '')::INT,
      NULLIF(v_spec->>'timeout_seconds', '')::INT,
      30
    )
  ) || CASE WHEN v_spec->>'url' COLLATE "C" ~* '^http://' THEN
    jsonb_build_object('http_allowed_host',
      substring(lower((v_spec->>'url') COLLATE "C") FROM '^http://([a-z0-9.-]+)'))
  ELSE '{}'::jsonb END;
END;
$function$;

-- Report counts only. The workflow catalog also stores non-HTTP action identifiers.
DO $report$
DECLARE
  v_template_urls bigint;
  v_template_headers bigint;
  v_queued_urls bigint;
BEGIN
  SELECT count(*) FILTER (
           WHERE NOT public.outbound_placeholder_url_v1(ot.url_template)
             AND NOT public.outbound_url_allowed_v1(ot.url_template,
               CASE WHEN ot.url_template COLLATE "C" ~* '^http://'
                    THEN public.outbound_http_allowed_hosts_v1(p.organization_id) END
             )),
         count(*) FILTER (WHERE ot.headers_template <> public.filter_outbound_headers_v1(ot.headers_template))
    INTO v_template_urls, v_template_headers
    FROM public.operation_templates ot JOIN public.providers p ON p.id = ot.provider_id;
  SELECT count(*) INTO v_queued_urls
    FROM public.outbound_calls oc
   WHERE NOT public.outbound_placeholder_url_v1(oc.url)
     AND NOT public.outbound_url_allowed_v1(oc.url,
       CASE WHEN oc.url COLLATE "C" ~* '^http://' THEN public.outbound_job_http_allowed_hosts_v1(oc.id) END
     );
  RAISE NOTICE 'Outbound validation inventory: template URLs %, template headers %, queue URLs %',
    v_template_urls, v_template_headers, v_queued_urls;
END;
$report$;

CREATE TRIGGER validate_outbound_http_hosts_current_v1
  BEFORE INSERT OR UPDATE OF category, cached_value ON public.settings
  FOR EACH ROW WHEN (NEW.category = 'integration_plugin_egress_policy')
  EXECUTE FUNCTION public.validate_outbound_http_hosts_write_v1('cached_value');

CREATE TRIGGER validate_outbound_http_hosts_version_v1
  BEFORE INSERT OR UPDATE OF category, value ON public.settings_versions
  FOR EACH ROW WHEN (NEW.category = 'integration_plugin_egress_policy')
  EXECUTE FUNCTION public.validate_outbound_http_hosts_write_v1('value');

CREATE TRIGGER validate_outbound_integration_template_v1
  AFTER INSERT OR UPDATE OF provider_id, url_template, headers_template ON public.operation_templates
  FOR EACH ROW EXECUTE FUNCTION public.validate_outbound_integration_write_v1();

CREATE TRIGGER validate_outbound_integration_queue_v1
  AFTER INSERT OR UPDATE OF url, target_type, target_id, shipment_id ON public.outbound_calls
  FOR EACH ROW EXECUTE FUNCTION public.validate_outbound_integration_write_v1();

COMMENT ON FUNCTION public.outbound_dispatch_headers_v1(text, jsonb, uuid) IS
  'Checks the initial rendered URL and filters outbound headers. Route hostname traffic through the Edge guarded egress proxy to validate and pin the connected address for every request and redirect. The pg_net path does not check DNS answers or redirect destinations.';

COMMIT;
