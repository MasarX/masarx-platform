-- Validate integration URLs and headers at persistence and delivery boundaries.
BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.outbound_url_allowed_v1(p_url text)
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

  -- Require a static, unescaped HTTPS authority. Only the path and query may be templated.
  v_authority := regexp_match(p_url COLLATE "C",
    '^https://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#]|$)', 'i');
  IF v_authority IS NULL OR v_authority[2]::integer NOT BETWEEN 1 AND 65535 THEN
    RETURN false;
  END IF;

  v_host := lower(rtrim(v_authority[1] COLLATE "C", '.'));
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
       AND v_host COLLATE "C" ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
       AND v_host !~ ('(^|\.)([0-9]+|0x[0-9a-f]*|local|internal|local' || 'host)$');
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
BEGIN
  IF TG_RELID = 'public.operation_templates'::regclass THEN
    IF (TG_OP = 'INSERT' OR NEW.url_template IS DISTINCT FROM OLD.url_template)
       AND NOT public.outbound_url_allowed_v1(NEW.url_template) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW.headers_template IS DISTINCT FROM OLD.headers_template)
       AND NEW.headers_template IS NOT NULL
       AND NEW.headers_template <> public.filter_outbound_headers_v1(NEW.headers_template) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_headers_invalid';
    END IF;
  ELSIF (TG_OP = 'INSERT' OR NEW.url IS DISTINCT FROM OLD.url)
        AND NOT public.outbound_url_allowed_v1(NEW.url) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.outbound_dispatch_headers_v1(p_url text, p_headers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
DECLARE
  v_headers jsonb;
BEGIN
  -- pg_net follows redirects and cannot validate DNS answers or the connected peer.
  -- See #211 for requiring guarded Edge proxy dispatch.
  IF NOT public.outbound_url_allowed_v1(p_url) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'outbound_url_invalid';
  END IF;

  v_headers := public.filter_outbound_headers_v1(p_headers);
  IF p_headers IS NOT NULL AND p_headers IS DISTINCT FROM v_headers THEN
    RAISE LOG 'outbound_headers_dropped';
  END IF;
  RETURN v_headers;
END;
$function$;

REVOKE ALL ON FUNCTION public.outbound_url_allowed_v1(text) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.filter_outbound_headers_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.validate_outbound_integration_write_v1() FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;
REVOKE ALL ON FUNCTION public.outbound_dispatch_headers_v1(text, jsonb) FROM PUBLIC, anon, authenticated, service_role, ui_rpc_executor;

-- Use the current catalog definitions to retain the workers' ownership, execution settings and later fixes.
DO $migration$
DECLARE
  v_signature regprocedure;
  v_before text;
  v_after text;
  v_definition text;
BEGIN
  FOR v_signature, v_before, v_after IN
    SELECT signature::regprocedure, prior, replacement
    FROM (VALUES
      ('public.run_outbound_worker()',
       $before$COALESCE(v_spec->'headers', '{}'::jsonb),
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL$before$,
       $after$public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers'),
                COALESCE(v_spec->'body', '{}'::jsonb),
                NULL$after$),
      ('public.dispatch_outbound_call_inline(uuid,jsonb)',
       $before$COALESCE(v_spec->'headers', '{}'::jsonb),
            COALESCE(v_spec->'body', '{}'::jsonb),
            v_timeout_seconds$before$,
       $after$public.outbound_dispatch_headers_v1(v_spec->>'url', v_spec->'headers'),
            COALESCE(v_spec->'body', '{}'::jsonb),
            v_timeout_seconds$after$),
      ('public.get_claimed_edge_job_call_spec_v1(uuid,uuid)',
       $before$    v_spec := public.get_job_call_spec(p_job_id);
  EXCEPTION$before$,
       $after$    v_spec := public.get_job_call_spec(p_job_id);
    v_spec := v_spec || jsonb_build_object(
      'url', COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
      'headers', public.outbound_dispatch_headers_v1(
        COALESCE(v_job.context #>> '{edge_dispatch,url}', v_spec->>'url'),
        COALESCE(v_job.context #> '{edge_dispatch,headers}', v_spec->'headers')
      )
    );
  EXCEPTION$after$),
      ('public.get_claimed_edge_job_call_spec_v1(uuid,uuid)',
       $before$    'url', COALESCE((v_job.context->'edge_dispatch')->>'url', v_spec->>'url'),
    'method', COALESCE(upper((v_job.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', COALESCE((v_job.context->'edge_dispatch')->'headers', v_spec->'headers', '{}'::jsonb),$before$,
       $after$    'url', v_spec->>'url',
    'method', COALESCE(upper((v_job.context->'edge_dispatch')->>'method'), upper(v_spec->>'method'), 'POST'),
    'headers', v_spec->'headers',$after$)
    ) AS edits(signature, prior, replacement)
  LOOP
    v_definition := pg_get_functiondef(v_signature);
    IF length(v_definition) - length(replace(v_definition, v_before, '')) <> length(v_before) THEN
      RAISE EXCEPTION 'Expected one outbound dispatch handoff in %', v_signature;
    END IF;
    EXECUTE replace(v_definition, v_before, v_after);
  END LOOP;
END;
$migration$;

-- Report counts only. The workflow catalog also stores non-HTTP action identifiers.
DO $report$
DECLARE
  v_template_urls bigint;
  v_template_headers bigint;
  v_queued_urls bigint;
BEGIN
  SELECT count(*) FILTER (WHERE url_template <> 'workflow://internal/' || operation_name
                            AND NOT public.outbound_url_allowed_v1(url_template)),
         count(*) FILTER (WHERE headers_template <> public.filter_outbound_headers_v1(headers_template))
    INTO v_template_urls, v_template_headers
    FROM public.operation_templates;
  SELECT count(*) INTO v_queued_urls
    FROM public.outbound_calls WHERE NOT public.outbound_url_allowed_v1(url);
  RAISE NOTICE 'Outbound validation inventory: template URLs %, template headers %, queue URLs %',
    v_template_urls, v_template_headers, v_queued_urls;
END;
$report$;

CREATE TRIGGER validate_outbound_integration_template_v1
  BEFORE INSERT OR UPDATE OF url_template, headers_template ON public.operation_templates
  FOR EACH ROW EXECUTE FUNCTION public.validate_outbound_integration_write_v1();

CREATE TRIGGER validate_outbound_integration_queue_v1
  BEFORE INSERT OR UPDATE OF url ON public.outbound_calls
  FOR EACH ROW EXECUTE FUNCTION public.validate_outbound_integration_write_v1();

COMMENT ON FUNCTION public.outbound_dispatch_headers_v1(text, jsonb) IS
  'Checks the initial rendered URL and filters outbound headers. Route hostname traffic through the Edge guarded egress proxy to validate and pin the connected address for every request and redirect. The pg_net path does not check DNS answers or redirect destinations.';

COMMIT;
