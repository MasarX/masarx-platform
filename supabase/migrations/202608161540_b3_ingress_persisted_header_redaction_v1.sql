-- Migration: Canonical ingress persisted-header value redaction
-- Purpose:
--   - Keep raw ingress headers transient for validation and routing.
--   - Redact credential-bearing gateway paths/query parameters before persistence.
--   - Enforce the sanitized projection at every ingress persistence boundary.
--   - Backfill current and audit history without exposing raw OLD rows to audit.

BEGIN;

DO $lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('202607191330_ingress_persisted_header_redaction_v1')) THEN
    RAISE EXCEPTION '202607191330_ingress_persisted_header_redaction_v1 is already running';
  END IF;
END;
$lock$;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.api_gateway_requests
  ADD COLUMN IF NOT EXISTS persistence_policy_snapshot JSONB;

ALTER TABLE public.outbound_calls
  ADD COLUMN IF NOT EXISTS execution_url_vault_id UUID;

ALTER TABLE public.outbound_calls
  DROP CONSTRAINT IF EXISTS outbound_calls_execution_url_vault_id_fkey;

ALTER TABLE public.outbound_calls
  ADD CONSTRAINT outbound_calls_execution_url_vault_id_fkey
  FOREIGN KEY (execution_url_vault_id) REFERENCES vault.secrets(id);

CREATE INDEX IF NOT EXISTS idx_outbound_calls_execution_url_vault_id
  ON public.outbound_calls(execution_url_vault_id)
  WHERE execution_url_vault_id IS NOT NULL;

COMMENT ON COLUMN public.outbound_calls.execution_url_vault_id
  IS 'Vault reference for the transient executable gateway URL; the public url projection remains permanently redacted.';

-------------------------------------------------------------------------------
-- Canonical value-aware redaction helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_protected_query_names_v1(p_policy_or_snapshot JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_rules JSONB := '[]'::jsonb;
  v_rule JSONB;
  v_name TEXT;
  v_match TEXT;
  v_case_sensitive BOOLEAN;
  v_revision TEXT;
  v_protocol_rules JSONB;
BEGIN
  IF p_policy_or_snapshot IS NULL OR p_policy_or_snapshot = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_policy_or_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'ingress query policy must be an object';
  END IF;

  IF p_policy_or_snapshot ? 'snapshot_version' THEN
    IF p_policy_or_snapshot ->> 'snapshot_version' <> '2'
      OR p_policy_or_snapshot <> jsonb_build_object(
        'snapshot_version', p_policy_or_snapshot -> 'snapshot_version',
        'snapshot_provenance', p_policy_or_snapshot -> 'snapshot_provenance',
        'snapshot_digest', p_policy_or_snapshot -> 'snapshot_digest',
        'policy_source', p_policy_or_snapshot -> 'policy_source',
        'policy_revision', p_policy_or_snapshot -> 'policy_revision',
        'protected_header_names', p_policy_or_snapshot -> 'protected_header_names',
        'protected_query_names', p_policy_or_snapshot -> 'protected_query_names'
      )
      OR p_policy_or_snapshot ->> 'snapshot_provenance' <> 'public.ingress_header_policy_snapshot_v1'
      OR p_policy_or_snapshot ->> 'policy_source' <> 'api_route.policy'
      OR COALESCE(p_policy_or_snapshot ->> 'policy_revision', '') !~ '^[0-9a-f]{64}$'
      OR COALESCE(p_policy_or_snapshot ->> 'snapshot_digest', '') !~ '^[0-9a-f]{64}$'
      OR p_policy_or_snapshot ->> 'snapshot_digest' <> encode(extensions.digest(
        convert_to((p_policy_or_snapshot - 'snapshot_digest')::TEXT, 'UTF8'),
        'sha256'
      ), 'hex')
      OR jsonb_typeof(p_policy_or_snapshot -> 'protected_header_names') <> 'array'
      OR jsonb_typeof(p_policy_or_snapshot -> 'protected_query_names') <> 'array'
    THEN
      RAISE EXCEPTION 'invalid ingress protected-query snapshot';
    END IF;
    FOR v_rule IN SELECT value FROM jsonb_array_elements(p_policy_or_snapshot -> 'protected_query_names') LOOP
      IF jsonb_typeof(v_rule) <> 'object'
        OR v_rule <> jsonb_build_object(
          'raw_name', v_rule -> 'raw_name',
          'match', v_rule -> 'match',
          'case_sensitive', v_rule -> 'case_sensitive',
          'source', v_rule -> 'source',
          'policy_revision', v_rule -> 'policy_revision'
        )
        OR jsonb_typeof(v_rule -> 'raw_name') <> 'string'
        OR jsonb_typeof(v_rule -> 'case_sensitive') <> 'boolean'
        OR COALESCE(v_rule ->> 'match', '') NOT IN ('exact', 'prefix')
        OR COALESCE(v_rule ->> 'source', '') = ''
        OR COALESCE(v_rule ->> 'policy_revision', '') = ''
        OR COALESCE(v_rule ->> 'source', '') NOT IN (
          'protocol.query-sensitive.v1',
          'api_route.policy.query.protected'
        )
        OR (
          v_rule ->> 'source' = 'protocol.query-sensitive.v1'
          AND v_rule ->> 'policy_revision' <> 'protocol.query-sensitive.v1'
        )
        OR (
          v_rule ->> 'source' = 'api_route.policy.query.protected'
          AND v_rule ->> 'policy_revision' <> p_policy_or_snapshot ->> 'policy_revision'
        )
      THEN
        RAISE EXCEPTION 'invalid ingress protected-query rule snapshot';
      END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_protocol_rules
      FROM jsonb_array_elements(public.resolve_protected_query_names_v1('{}'::jsonb))
     WHERE value ->> 'source' = 'protocol.query-sensitive.v1';
    IF NOT ((p_policy_or_snapshot -> 'protected_query_names') @> v_protocol_rules) THEN
      RAISE EXCEPTION 'ingress protected-query snapshot omits mandatory protocol rules';
    END IF;
    RETURN p_policy_or_snapshot -> 'protected_query_names';
  END IF;

  v_revision := encode(extensions.digest(convert_to(p_policy_or_snapshot::TEXT, 'UTF8'), 'sha256'), 'hex');
  FOR v_rule IN SELECT value FROM jsonb_array_elements(
    '["token","auth_token","access_token","refresh_token","api_key","apikey","secret","signing_secret","shared_secret","signature","hmac","x_signature","x-signature","x-hub-signature","x-hub-signature-256","key","password","credential"]'::jsonb
  ) LOOP
    v_rules := v_rules || jsonb_build_array(jsonb_build_object(
      'raw_name', v_rule #>> '{}',
      'match', 'exact',
      'case_sensitive', FALSE,
      'source', 'protocol.query-sensitive.v1',
      'policy_revision', 'protocol.query-sensitive.v1'
    ));
  END LOOP;

  IF p_policy_or_snapshot #> '{query,protected}' IS NOT NULL THEN
    IF jsonb_typeof(p_policy_or_snapshot #> '{query,protected}') <> 'array' THEN
      RAISE EXCEPTION 'query.protected must be an array';
    END IF;
    FOR v_rule IN SELECT value FROM jsonb_array_elements(p_policy_or_snapshot #> '{query,protected}') LOOP
      IF jsonb_typeof(v_rule) = 'string' THEN
        v_name := v_rule #>> '{}';
        v_match := 'exact';
        v_case_sensitive := TRUE;
      ELSIF jsonb_typeof(v_rule) = 'object'
        AND v_rule = jsonb_strip_nulls(jsonb_build_object(
          'name', v_rule -> 'name',
          'match', v_rule -> 'match',
          'case_sensitive', v_rule -> 'case_sensitive'
        ))
      THEN
        v_name := v_rule ->> 'name';
        v_match := COALESCE(NULLIF(v_rule ->> 'match', ''), 'exact');
        v_case_sensitive := COALESCE((v_rule ->> 'case_sensitive')::BOOLEAN, TRUE);
      ELSE
        RAISE EXCEPTION 'query.protected entries must be strings or closed rule objects';
      END IF;
      IF COALESCE(v_name, '') = '' OR v_name !~ '^[!-~]+$' OR v_name ~ '[=&?#]' THEN
        RAISE EXCEPTION 'invalid protected query name';
      END IF;
      IF v_match NOT IN ('exact', 'prefix') THEN
        RAISE EXCEPTION 'unsupported protected query matching mode %', v_match;
      END IF;
      v_rules := v_rules || jsonb_build_array(jsonb_build_object(
        'raw_name', v_name,
        'match', v_match,
        'case_sensitive', v_case_sensitive,
        'source', 'api_route.policy.query.protected',
        'policy_revision', v_revision
      ));
    END LOOP;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(rule ORDER BY rule ->> 'source', rule ->> 'raw_name', rule ->> 'match'), '[]'::jsonb)
    FROM (SELECT DISTINCT value AS rule FROM jsonb_array_elements(v_rules)) unique_rules
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_protected_query_names_v1(JSONB)
  IS 'Resolve fixed protocol names plus arbitrary row-driven query.protected rules with exact raw names, matching mode, case semantics, source, and immutable policy revision.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_query_string_v1(
  p_query_string TEXT,
  p_policy_or_snapshot JSONB DEFAULT '{}'::jsonb,
  p_historical BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_had_prefix BOOLEAN := left(COALESCE(p_query_string, ''), 1) = '?';
  v_query TEXT;
  v_fragment TEXT := '';
  v_pairs TEXT[];
  v_pair TEXT;
  v_key TEXT;
  v_key_decoded TEXT;
  v_out_pairs TEXT[] := ARRAY[]::TEXT[];
  v_index INT;
  v_hex TEXT;
  v_byte INT;
  v_ambiguous BOOLEAN;
  v_redact BOOLEAN;
  v_rules JSONB;
  v_rule JSONB;
  v_candidate TEXT;
  v_rule_name TEXT;
BEGIN
  IF p_query_string IS NULL OR p_query_string = '' THEN
    RETURN p_query_string;
  END IF;

  IF p_policy_or_snapshot IS NULL OR p_policy_or_snapshot = 'null'::jsonb THEN
    v_rules := NULL;
  ELSE
    BEGIN
      v_rules := public.resolve_protected_query_names_v1(p_policy_or_snapshot);
    EXCEPTION
      WHEN others THEN
        IF p_historical THEN
          v_rules := NULL;
        ELSE
          RAISE;
        END IF;
    END;
  END IF;

  v_query := CASE
    WHEN v_had_prefix THEN substring(p_query_string FROM 2)
    ELSE p_query_string
  END;

  IF position('#' IN v_query) > 0 THEN
    v_fragment := substring(v_query FROM position('#' IN v_query));
    v_query := split_part(v_query, '#', 1);
  END IF;

  v_pairs := string_to_array(v_query, '&');
  FOREACH v_pair IN ARRAY v_pairs LOOP
    IF v_pair IS NULL OR v_pair = '' THEN
      v_out_pairs := array_append(v_out_pairs, COALESCE(v_pair, ''));
      CONTINUE;
    END IF;

    v_key := split_part(v_pair, '=', 1);
    v_key_decoded := '';
    v_ambiguous := FALSE;
    v_index := 1;
    WHILE v_index <= length(COALESCE(v_key, '')) LOOP
      IF substring(v_key FROM v_index FOR 1) = '%' THEN
        IF substring(v_key FROM v_index + 1 FOR 2) !~ '^[0-9a-fA-F]{2}$' THEN
          v_ambiguous := TRUE;
          EXIT;
        END IF;
        v_hex := substring(v_key FROM v_index + 1 FOR 2);
        v_byte := get_byte(decode(v_hex, 'hex'), 0);
        IF v_byte < 33 OR v_byte > 126 THEN
          v_ambiguous := TRUE;
          EXIT;
        END IF;
        v_key_decoded := v_key_decoded || chr(v_byte);
        v_index := v_index + 3;
      ELSE
        v_key_decoded := v_key_decoded || substring(v_key FROM v_index FOR 1);
        v_index := v_index + 1;
      END IF;
    END LOOP;

    -- A remaining encoded byte after one decode is double-encoded ambiguity.
    IF v_key_decoded ~ '%[0-9a-fA-F]{2}' THEN
      v_ambiguous := TRUE;
    END IF;

    v_redact := v_ambiguous OR v_rules IS NULL;
    IF NOT v_redact THEN
      FOR v_rule IN SELECT value FROM jsonb_array_elements(v_rules) LOOP
        v_candidate := CASE
          WHEN (v_rule ->> 'case_sensitive')::BOOLEAN THEN v_key_decoded
          ELSE lower(v_key_decoded)
        END;
        v_rule_name := CASE
          WHEN (v_rule ->> 'case_sensitive')::BOOLEAN THEN v_rule ->> 'raw_name'
          ELSE lower(v_rule ->> 'raw_name')
        END;
        IF (v_rule ->> 'match' = 'exact' AND v_candidate = v_rule_name)
          OR (v_rule ->> 'match' = 'prefix' AND left(v_candidate, length(v_rule_name)) = v_rule_name)
        THEN
          v_redact := TRUE;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_redact THEN
      v_out_pairs := v_out_pairs || (COALESCE(v_key, '') || '=REDACTED');
    ELSE
      v_out_pairs := v_out_pairs || v_pair;
    END IF;
  END LOOP;

  RETURN CASE WHEN v_had_prefix THEN '?' ELSE '' END
    || COALESCE(array_to_string(v_out_pairs, '&'), '')
    || v_fragment;
END;
$function$;

COMMENT ON FUNCTION public.redact_sensitive_query_string_v1(TEXT, JSONB, BOOLEAN)
  IS 'Redact all duplicate matches using one-decode row-driven rules; unknown historical policy redacts every query value while transient executable query text remains separate.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_url(
  p_url TEXT,
  p_policy_or_snapshot JSONB DEFAULT '{}'::jsonb,
  p_historical BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_url TEXT := p_url;
  v_base TEXT;
  v_query_and_frag TEXT;
BEGIN
  IF v_url IS NULL OR v_url = '' THEN
    RETURN p_url;
  END IF;

  -- Canonical token paths. The exact reserved /api-gateway/t route is not a token.
  v_url := regexp_replace(
    v_url,
    '(/api-gateway/t/)[^/?#[:space:]]+',
    '\1REDACTED',
    'gi'
  );
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
$function$;

COMMENT ON FUNCTION public.redact_sensitive_url(TEXT, JSONB, BOOLEAN)
  IS 'Deterministically redact credential-bearing API gateway path segments and sensitive query values before persistence or logging.';

-- Preserve the established one-argument function identity because existing
-- database functions depend on that exact OID. Delegate it to the canonical
-- policy-aware implementation so exact-match overload resolution cannot keep
-- executing the legacy query-only redactor.
CREATE OR REPLACE FUNCTION public.redact_sensitive_url(p_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.redact_sensitive_url(p_url, '{}'::jsonb, FALSE);
$function$;

COMMENT ON FUNCTION public.redact_sensitive_url(TEXT)
  IS 'Compatibility entrypoint that delegates to the canonical policy-aware ingress URL redactor.';

CREATE OR REPLACE FUNCTION public.persist_ingress_execution_url_v1(
  p_outbound_call_id UUID,
  p_url TEXT,
  p_existing_vault_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_vault_id UUID := p_existing_vault_id;
  v_name TEXT;
BEGIN
  IF p_outbound_call_id IS NULL OR NULLIF(p_url, '') IS NULL THEN
    RAISE EXCEPTION 'ingress execution URL requires outbound call identity and non-empty URL';
  END IF;
  v_name := 'outbound_calls/' || p_outbound_call_id::TEXT || '/execution_url';
  IF v_vault_id IS NULL THEN
    SELECT vault.create_secret(
      p_url,
      v_name,
      'Transient executable ingress gateway URL; durable evidence is redacted',
      NULL
    ) INTO v_vault_id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_vault_id) THEN
      RAISE EXCEPTION 'ingress execution URL Vault reference % is missing', v_vault_id;
    END IF;
    PERFORM vault.update_secret(
      v_vault_id,
      p_url,
      v_name,
      'Transient executable ingress gateway URL; durable evidence is redacted'
    );
  END IF;
  IF v_vault_id IS NULL THEN
    RAISE EXCEPTION 'Vault did not return an ingress execution URL reference';
  END IF;
  RETURN v_vault_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_ingress_execution_url_v1(p_outbound_call_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, extensions, pg_temp
AS $function$
DECLARE
  v_job RECORD;
  v_url TEXT;
  v_snapshot JSONB;
BEGIN
  SELECT oc.url, oc.execution_url_vault_id, oc.context
    INTO v_job
    FROM public.outbound_calls oc
   WHERE oc.id = p_outbound_call_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingress execution URL job % is missing', p_outbound_call_id;
  END IF;
  IF COALESCE(v_job.context ->> 'api_gateway_request_id', '') = ''
    OR v_job.execution_url_vault_id IS NULL
  THEN
    RAISE EXCEPTION 'ingress execution URL reference is unavailable for job %', p_outbound_call_id;
  END IF;
  SELECT decrypted_secret
    INTO v_url
    FROM vault.decrypted_secrets
   WHERE id = v_job.execution_url_vault_id;
  IF NULLIF(v_url, '') IS NULL THEN
    RAISE EXCEPTION 'ingress execution URL secret is unavailable for job %', p_outbound_call_id;
  END IF;
  v_snapshot := NULLIF(v_job.context -> 'persistence_policy_snapshot', 'null'::jsonb);
  IF public.redact_sensitive_url(
       v_url,
       v_snapshot,
       v_snapshot IS NULL
     ) IS DISTINCT FROM v_job.url
  THEN
    RAISE EXCEPTION 'ingress execution URL reference does not match canonical durable projection for job %', p_outbound_call_id;
  END IF;
  RETURN v_url;
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_ingress_execution_url_v1(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_ingress_execution_url_v1(UUID) FROM PUBLIC;

DO $job_spec_wrap$
BEGIN
  IF to_regprocedure('public.get_job_call_spec_without_ingress_vault_v1(uuid)') IS NULL THEN
    IF to_regprocedure('public.get_job_call_spec(uuid)') IS NULL THEN
      RAISE EXCEPTION 'get_job_call_spec(uuid) is required for ingress execution URL wrapping';
    END IF;
    ALTER FUNCTION public.get_job_call_spec(UUID)
      RENAME TO get_job_call_spec_without_ingress_vault_v1;
  END IF;
END;
$job_spec_wrap$;

REVOKE ALL ON FUNCTION public.get_job_call_spec_without_ingress_vault_v1(UUID) FROM PUBLIC;
DO $job_spec_acl$
DECLARE
  v_role TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'edge_api_caller_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.get_job_call_spec_without_ingress_vault_v1(UUID) FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END;
$job_spec_acl$;

CREATE OR REPLACE FUNCTION public.get_job_call_spec(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_spec JSONB;
  v_execution_url_vault_id UUID;
  v_durable_url TEXT;
  v_enriched_url TEXT;
  v_execution_url TEXT;
  v_enrichment_suffix TEXT;
BEGIN
  v_spec := public.get_job_call_spec_without_ingress_vault_v1(p_job_id);
  SELECT execution_url_vault_id, url
    INTO v_execution_url_vault_id, v_durable_url
    FROM public.outbound_calls
   WHERE id = p_job_id;
  IF v_execution_url_vault_id IS NOT NULL THEN
    v_enriched_url := v_spec ->> 'url';
    v_execution_url := public.resolve_ingress_execution_url_v1(p_job_id);
    IF v_enriched_url IS NOT DISTINCT FROM v_durable_url THEN
      v_enrichment_suffix := '';
    ELSIF v_enriched_url IS NOT NULL
      AND left(v_enriched_url, length(v_durable_url)) = v_durable_url
      AND substring(v_enriched_url FROM length(v_durable_url) + 1 FOR 1) IN ('?', '&')
    THEN
      v_enrichment_suffix := substring(v_enriched_url FROM length(v_durable_url) + 1);
    ELSE
      RAISE EXCEPTION 'get_job_call_spec produced an unmergeable URL enrichment for ingress job %', p_job_id;
    END IF;
    v_spec := jsonb_set(
      v_spec,
      '{url}',
      to_jsonb(v_execution_url || v_enrichment_suffix),
      TRUE
    );
  END IF;
  RETURN v_spec;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_job_call_spec(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_job_call_spec(UUID) TO service_role;
DO $job_spec_wrapper_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_job_call_spec(UUID) TO edge_api_caller_role;
  END IF;
END;
$job_spec_wrapper_acl$;

COMMENT ON FUNCTION public.get_job_call_spec(UUID)
  IS 'Dispatch-boundary call specification; reconstructs protected ingress gateway URL values from Vault while durable outbound evidence remains redacted.';

CREATE OR REPLACE FUNCTION public.canonical_http_header_name_v1(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_name TEXT := lower(btrim(COALESCE(p_name, '')));
BEGIN
  IF v_name = '' OR v_name !~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$' THEN
    RAISE EXCEPTION 'invalid HTTP token header name';
  END IF;
  RETURN v_name;
END;
$function$;

COMMENT ON FUNCTION public.canonical_http_header_name_v1(TEXT)
  IS 'Validate an ASCII RFC HTTP-token header name and return its canonical lowercase representation.';

CREATE OR REPLACE FUNCTION public.resolve_ingress_protected_header_names_v1(p_policy_or_snapshot JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_names TEXT[] := ARRAY[
    'authorization', 'proxy-authorization', 'd360-api-key', 'x-api-key',
    'api-key', 'apikey', 'x-auth-token', 'x-internal-edge-token',
    'x-webhook-token', 'x-signature', 'signature', 'x-hub-signature',
    'x-hub-signature-256', 'x-api-signature', 'x-auth-signature',
    'x-hmac-signature', 'hmac', 'cookie', 'set-cookie'
  ]::TEXT[];
  v_protocol_names TEXT[];
  v_value JSONB;
  v_name TEXT;
  v_path TEXT[];
BEGIN
  v_protocol_names := v_names;
  IF p_policy_or_snapshot IS NULL OR p_policy_or_snapshot = 'null'::jsonb THEN
    p_policy_or_snapshot := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_policy_or_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'ingress header policy must be an object';
  END IF;

  IF p_policy_or_snapshot ? 'snapshot_version' THEN
    PERFORM public.resolve_protected_query_names_v1(p_policy_or_snapshot);
    v_names := ARRAY[]::TEXT[];
    FOR v_value IN SELECT value FROM jsonb_array_elements(p_policy_or_snapshot -> 'protected_header_names') LOOP
      IF jsonb_typeof(v_value) <> 'string' THEN
        RAISE EXCEPTION 'protected header snapshot names must be strings';
      END IF;
      v_names := array_append(v_names, public.canonical_http_header_name_v1(v_value #>> '{}'));
    END LOOP;
    IF NOT v_names @> v_protocol_names THEN
      RAISE EXCEPTION 'ingress protected-header snapshot omits mandatory protocol names';
    END IF;
  ELSE
    IF NULLIF(p_policy_or_snapshot #>> '{auth,header}', '') IS NOT NULL THEN
      v_names := array_append(
        v_names,
        public.canonical_http_header_name_v1(p_policy_or_snapshot #>> '{auth,header}')
      );
    END IF;

    FOR v_path IN SELECT path FROM (VALUES
      ('{validation,idempotency,header}'::TEXT[]),
      ('{validation,hmac,header}'::TEXT[])
    ) AS configured(path) LOOP
      IF NULLIF(p_policy_or_snapshot #>> v_path, '') IS NOT NULL THEN
        v_names := array_append(
          v_names,
          public.canonical_http_header_name_v1(p_policy_or_snapshot #>> v_path)
        );
      END IF;
    END LOOP;

    IF p_policy_or_snapshot #> '{headers,protected}' IS NOT NULL THEN
      IF jsonb_typeof(p_policy_or_snapshot #> '{headers,protected}') <> 'array' THEN
        RAISE EXCEPTION 'headers.protected must be an array';
      END IF;
      FOR v_value IN SELECT value FROM jsonb_array_elements(p_policy_or_snapshot #> '{headers,protected}') LOOP
        IF jsonb_typeof(v_value) <> 'string' THEN
          RAISE EXCEPTION 'headers.protected names must be strings';
        END IF;
        v_names := array_append(v_names, public.canonical_http_header_name_v1(v_value #>> '{}'));
      END LOOP;
    END IF;

    IF p_policy_or_snapshot #> '{headers,overrides}' IS NOT NULL THEN
      IF jsonb_typeof(p_policy_or_snapshot #> '{headers,overrides}') <> 'object' THEN
        RAISE EXCEPTION 'headers.overrides must be an object';
      END IF;
      FOR v_name IN SELECT key FROM jsonb_each(p_policy_or_snapshot #> '{headers,overrides}') LOOP
        v_names := array_append(v_names, public.canonical_http_header_name_v1(v_name));
      END LOOP;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT name ORDER BY name), ARRAY[]::TEXT[])
    INTO v_names
    FROM unnest(v_names) AS names(name);
  RETURN v_names;
END;
$function$;

COMMENT ON FUNCTION public.resolve_ingress_protected_header_names_v1(JSONB)
  IS 'Resolve protocol-sensitive names plus row-driven auth.header, headers.protected, validation headers, and override keys; ordinary headers.defaults remain caller-overridable.';

CREATE OR REPLACE FUNCTION public.ingress_header_policy_snapshot_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  WITH canonical AS (
    SELECT jsonb_build_object(
      'snapshot_version', 2,
      'snapshot_provenance', 'public.ingress_header_policy_snapshot_v1',
      'policy_source', 'api_route.policy',
      'policy_revision', encode(extensions.digest(
        convert_to(COALESCE(p_policy, '{}'::jsonb)::TEXT, 'UTF8'),
        'sha256'
      ), 'hex'),
      'protected_header_names', to_jsonb(public.resolve_ingress_protected_header_names_v1(COALESCE(p_policy, '{}'::jsonb))),
      'protected_query_names', public.resolve_protected_query_names_v1(COALESCE(p_policy, '{}'::jsonb))
    ) AS payload
  )
  SELECT payload || jsonb_build_object(
    'snapshot_digest', encode(extensions.digest(convert_to(payload::TEXT, 'UTF8'), 'sha256'), 'hex')
  )
  FROM canonical;
$function$;

COMMENT ON FUNCTION public.ingress_header_policy_snapshot_v1(JSONB)
  IS 'Capture exact value-free protected-header and protected-query rules, sources, matching semantics, and immutable policy revision used for durable redaction at write time.';

CREATE OR REPLACE FUNCTION public.rebuild_ingress_headers_v1(
  p_headers JSONB,
  p_policy_or_snapshot JSONB,
  p_projection TEXT,
  p_historical BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_projection TEXT := lower(COALESCE(NULLIF(btrim(p_projection), ''), ''));
  v_protected TEXT[] := ARRAY[]::TEXT[];
  v_out JSONB := '{}'::jsonb;
  v_seen JSONB := '{}'::jsonb;
  v_entry RECORD;
  v_name TEXT;
  v_value JSONB;
BEGIN
  IF p_headers IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_headers = 'null'::jsonb OR jsonb_typeof(p_headers) <> 'object' THEN
    RETURN to_jsonb('REDACTED'::TEXT);
  END IF;
  IF v_projection NOT IN ('persisted', 'prepared', 'outbound') THEN
    RAISE EXCEPTION 'unsupported ingress header projection %', v_projection;
  END IF;
  IF v_projection IN ('persisted', 'prepared') AND p_historical AND p_policy_or_snapshot IS NULL THEN
    RETURN to_jsonb('REDACTED'::TEXT);
  END IF;
  IF v_projection IN ('persisted', 'prepared') THEN
    BEGIN
      v_protected := public.resolve_ingress_protected_header_names_v1(COALESCE(p_policy_or_snapshot, '{}'::jsonb));
    EXCEPTION
      WHEN others THEN
        IF p_historical THEN
          RETURN to_jsonb('REDACTED'::TEXT);
        END IF;
        RAISE;
    END;
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each(p_headers) ORDER BY key COLLATE "C" LOOP
    BEGIN
      v_name := public.canonical_http_header_name_v1(v_entry.key);
    EXCEPTION
      WHEN others THEN
        IF p_historical THEN
          RETURN to_jsonb('REDACTED'::TEXT);
        END IF;
        RAISE;
    END;

    IF v_seen ? v_name THEN
      IF NOT p_historical THEN
        RAISE EXCEPTION 'duplicate canonical HTTP header name %', v_name;
      END IF;
      IF NOT (v_name = ANY(v_protected)) AND (v_seen -> v_name) IS DISTINCT FROM v_entry.value THEN
        RETURN to_jsonb('REDACTED'::TEXT);
      END IF;
      CONTINUE;
    END IF;
    v_seen := jsonb_set(v_seen, ARRAY[v_name], v_entry.value, TRUE);

    IF v_projection IN ('persisted', 'prepared') AND v_name = ANY(v_protected) THEN
      CONTINUE;
    END IF;

    v_value := v_entry.value;
    IF v_name IN (
      'x-forwarded-path', 'x-forwarded-url', 'x-original-uri',
      'x-rewrite-url', 'x-envoy-original-path', 'referer'
    ) THEN
      v_value := CASE
        WHEN jsonb_typeof(v_value) = 'string'
          THEN to_jsonb(public.redact_sensitive_url(
            v_value #>> '{}',
            p_policy_or_snapshot,
            p_historical
          ))
        ELSE to_jsonb('REDACTED'::TEXT)
      END;
    END IF;
    v_out := jsonb_set(v_out, ARRAY[v_name], v_value, TRUE);
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.rebuild_ingress_headers_v1(JSONB, JSONB, TEXT, BOOLEAN)
  IS 'Case-insensitively rebuild ingress headers: reject live canonical duplicates, fail closed on ambiguous historical keys, remove protected durable/prepared names, and preserve provider-owned outbound values.';

CREATE OR REPLACE FUNCTION public.ingress_durable_surface_registry_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT $registry$
  [
    {"surface_id":"api_gateway.policy_snapshot","schema":"public","table":"api_gateway_requests","column":"persistence_policy_snapshot","nested_path":[],"representation":"jsonb_policy_snapshot","classification":"policy","sanitizer":"gateway_policy_snapshot","policy_source":"api_routes.policy@write","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"conservative_legacy_null","malformed_semantics":"reject_live_redact_history","null_semantics":"legacy_unknown","mode":"gateway_policy_snapshot","version":2},
    {"surface_id":"api_gateway.request_headers","schema":"public","table":"api_gateway_requests","column":"request_headers","nested_path":[],"representation":"jsonb_object","classification":"header","sanitizer":"rebuild_ingress_headers_v1","policy_source":"persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"gateway_request_headers","version":2},
    {"surface_id":"api_gateway.query_projection","schema":"public","table":"api_gateway_requests","column":"query_string","nested_path":[],"representation":"text_query_string","classification":"query","sanitizer":"redact_sensitive_query_string_v1","policy_source":"persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"redact_all_values","null_semantics":"preserve_sql_null","mode":"query_string","version":2},
    {"surface_id":"api_gateway.path_projection","schema":"public","table":"api_gateway_requests","column":"path","nested_path":[],"representation":"text_url_path","classification":"both","sanitizer":"redact_sensitive_url","policy_source":"persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"text","version":2},
    {"surface_id":"webhook.headers","schema":"public","table":"webhook_inbox","column":"headers","nested_path":[],"representation":"jsonb_object","classification":"header","sanitizer":"resolve_webhook_persisted_headers_v1","policy_source":"policy_settings_id","writer":"workflow_intake_webhook_core_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"webhook_headers","version":2},
    {"surface_id":"webhook.ack_headers","schema":"public","table":"webhook_inbox","column":"ack_headers","nested_path":[],"representation":"jsonb_object","classification":"header","sanitizer":"rebuild_ingress_headers_v1","policy_source":"protocol_snapshot","writer":"webhook_ack+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"headers","version":2},
    {"surface_id":"webhook.ack_body","schema":"public","table":"webhook_inbox","column":"ack_body","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_persisted_json_v1","policy_source":"unknown_nested_redact_all","writer":"webhook_ack+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"json","version":2},
    {"surface_id":"webhook.ack_validation","schema":"public","table":"webhook_inbox","column":"ack_validation","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_persisted_json_v1","policy_source":"unknown_nested_redact_all","writer":"webhook_ack+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"json","version":2},
    {"surface_id":"workflow.webhook_headers","schema":"public","table":"workflow_runs","column":"context","nested_path":["headers"],"representation":"jsonb_object","classification":"header","sanitizer":"sanitize_ingress_workflow_context_v1","policy_source":"unknown_history_redact_all","writer":"workflow_intake_webhook_core_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_policy_snapshot","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","persistence_policy_snapshot"],"representation":"jsonb_policy_snapshot","classification":"both","sanitizer":"sanitize_api_gateway_persisted_context_v1","policy_source":"api_route.policy","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"redact_all_values","null_semantics":"legacy_unknown_redact_all","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_request_headers","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","request_headers"],"representation":"jsonb_object","classification":"header","sanitizer":"sanitize_api_gateway_persisted_context_v1","policy_source":"context.api_gateway.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_query_projection","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","query_string"],"representation":"text_query_string","classification":"query","sanitizer":"redact_sensitive_query_string_v1","policy_source":"context.api_gateway.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"redact_all_values","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_path_projection","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","path"],"representation":"text_url_path","classification":"both","sanitizer":"redact_sensitive_url","policy_source":"context.api_gateway.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_upstream_url_projection","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","upstream_url"],"representation":"text_url","classification":"both","sanitizer":"redact_sensitive_url","policy_source":"context.api_gateway.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"workflow.api_outbound_headers","schema":"public","table":"workflow_runs","column":"context","nested_path":["api_gateway","outbound_headers"],"representation":"jsonb_object","classification":"header","sanitizer":"rebuild_ingress_headers_v1","policy_source":"executable_provider_projection","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_json","version":2},
    {"surface_id":"outbound.gateway_execution_url_reference","schema":"public","table":"outbound_calls","column":"execution_url_vault_id","nested_path":[],"representation":"vault_uuid_reference","classification":"secure_execution_reference","sanitizer":"persist_ingress_execution_url_v1","policy_source":"context.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"reject","null_semantics":"allowed_only_without_protected_values","mode":"gateway_execution_url_reference","version":2},
    {"surface_id":"outbound.gateway_url_projection","schema":"public","table":"outbound_calls","column":"url","nested_path":[],"representation":"text_url","classification":"query","sanitizer":"redact_sensitive_url","policy_source":"context.persistence_policy_snapshot","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"redact_all_values","null_semantics":"not_null","mode":"gateway_outbound_url","version":2},
    {"surface_id":"outbound.gateway_headers","schema":"public","table":"outbound_calls","column":"headers","nested_path":[],"representation":"jsonb_object","classification":"header","sanitizer":"rebuild_ingress_headers_v1","policy_source":"executable_provider_projection","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"gateway_outbound_headers","version":2},
    {"surface_id":"outbound.gateway_response_headers","schema":"public","table":"outbound_calls","column":"response_headers","nested_path":[],"representation":"jsonb_object","classification":"header","sanitizer":"rebuild_ingress_headers_v1","policy_source":"context.persistence_policy_snapshot","writer":"outbound_worker+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_sql_null","mode":"gateway_response_headers","version":2},
    {"surface_id":"outbound.gateway_context","schema":"public","table":"outbound_calls","column":"context","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_persisted_json_v1","policy_source":"unknown_nested_redact_all","writer":"workflow_intake_api_gateway_v1+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"gateway_outbound_context","version":2},
    {"surface_id":"decision.ingress_recursive","schema":"public","table":"decision_log","column":"decision_inputs","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_persisted_json_v1","policy_source":"unknown_nested_redact_all","writer":"ingress_decision+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_decision_json","version":2},
    {"surface_id":"audit.row_old","schema":"public","table":"audit_table_changes","column":"row_old","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_audit_row_v1","policy_source":"audited_row_snapshot_or_redact_all","writer":"audit_capture_row_change+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_audit_json","version":2},
    {"surface_id":"audit.row_new","schema":"public","table":"audit_table_changes","column":"row_new","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_audit_row_v1","policy_source":"audited_row_snapshot_or_redact_all","writer":"audit_capture_row_change+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_audit_json","version":2},
    {"surface_id":"audit.request_context","schema":"public","table":"audit_table_changes","column":"request_context","nested_path":[],"representation":"jsonb_recursive","classification":"both","sanitizer":"redact_ingress_persisted_json_v1","policy_source":"unknown_nested_redact_all","writer":"audit_capture_row_change+table_trigger","backfill":"backfill_ingress_persisted_redaction_v1","malformed_semantics":"REDACTED","null_semantics":"preserve_json_null","mode":"ingress_audit_json","version":2}
  ]
  $registry$::jsonb;
$function$;

COMMENT ON FUNCTION public.ingress_durable_surface_registry_v1()
  IS 'Closed machine-readable registry of every durable ingress header/query/policy projection enforced by this migration.';

CREATE OR REPLACE FUNCTION public.redact_sensitive_headers(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1('{}'::jsonb),
    'persisted',
    TRUE
  );
$function$;

COMMENT ON FUNCTION public.redact_sensitive_headers(JSONB)
  IS 'Redact credential headers and sanitize URL-bearing forwarding header values for safe persistence and logging.';

CREATE OR REPLACE FUNCTION public.redact_ingress_header_container_v1(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1('{}'::jsonb),
    'persisted',
    TRUE
  );
$function$;

COMMENT ON FUNCTION public.redact_ingress_header_container_v1(JSONB)
  IS 'Canonical ingress header-container sanitizer: preserve NULL, sanitize objects, and replace malformed/scalar values with REDACTED.';

CREATE OR REPLACE FUNCTION public.redact_ingress_forwarding_header_values_v1(p_headers JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(p_headers, NULL, 'outbound', TRUE);
$function$;

COMMENT ON FUNCTION public.redact_ingress_forwarding_header_values_v1(JSONB)
  IS 'Sanitize only URL-bearing forwarding header values while preserving provider credentials already materialized by policy.';

CREATE OR REPLACE FUNCTION public.prepare_ingress_provider_headers_v1(
  p_headers JSONB,
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1(COALESCE(p_policy, '{}'::jsonb)),
    'prepared',
    FALSE
  );
$function$;

COMMENT ON FUNCTION public.prepare_ingress_provider_headers_v1(JSONB, JSONB)
  IS 'Drop caller-supplied credentials and sanitize forwarding URLs before row-driven provider headers are materialized.';

CREATE OR REPLACE FUNCTION public.redact_api_gateway_persisted_headers_v1(
  p_headers JSONB,
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1(COALESCE(p_policy, '{}'::jsonb)),
    'persisted',
    FALSE
  );
$function$;

COMMENT ON FUNCTION public.redact_api_gateway_persisted_headers_v1(JSONB, JSONB)
  IS 'Sanitize API-gateway request evidence and remove only internal tokens plus the policy-selected auth.header; headers.defaults remain caller-overridable and are not treated as credentials.';

CREATE OR REPLACE FUNCTION public.resolve_api_gateway_persisted_headers_v1(
  p_headers JSONB,
  p_route_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  -- Route-only history cannot prove the exact policy version used at write time.
  RETURN CASE
    WHEN p_headers IS NULL THEN NULL
    ELSE to_jsonb('REDACTED'::TEXT)
  END;
END;
$function$;

COMMENT ON FUNCTION public.resolve_api_gateway_persisted_headers_v1(JSONB, UUID)
  IS 'Legacy fail-closed compatibility helper: route-only history never guesses from current policy and is fully redacted without an exact write-time snapshot.';

REVOKE ALL ON FUNCTION public.resolve_api_gateway_persisted_headers_v1(JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_api_gateway_persisted_headers_v1(JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_api_gateway_persisted_headers_v1(JSONB, UUID) FROM authenticated;

CREATE OR REPLACE FUNCTION public.sanitize_api_gateway_persisted_context_v1(p_gateway JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out JSONB := p_gateway;
  v_value JSONB;
  v_snapshot JSONB := p_gateway -> 'persistence_policy_snapshot';
  v_field TEXT;
BEGIN
  IF p_gateway IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_gateway) <> 'object' THEN
    RETURN to_jsonb('REDACTED'::TEXT);
  END IF;

  IF p_gateway ? 'query_string' THEN
    v_value := p_gateway -> 'query_string';
    v_out := jsonb_set(
      v_out,
      '{query_string}',
      CASE
        WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
        WHEN jsonb_typeof(v_value) = 'string'
          THEN to_jsonb(public.redact_sensitive_query_string_v1(v_value #>> '{}', v_snapshot, TRUE))
        ELSE to_jsonb('REDACTED'::TEXT)
      END,
      TRUE
    );
  END IF;

  IF p_gateway ? 'request_headers' THEN
    v_value := p_gateway -> 'request_headers';
    v_out := jsonb_set(
      v_out,
      '{request_headers}',
      CASE
        WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
        ELSE public.rebuild_ingress_headers_v1(v_value, v_snapshot, 'persisted', TRUE)
      END,
      TRUE
    );
  END IF;

  IF p_gateway ? 'outbound_headers' THEN
    v_value := p_gateway -> 'outbound_headers';
    v_out := jsonb_set(
      v_out,
      '{outbound_headers}',
      CASE
        WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
        ELSE public.rebuild_ingress_headers_v1(
          v_value,
          v_snapshot,
          'outbound',
          TRUE
        )
      END,
      TRUE
    );
  END IF;

  FOREACH v_field IN ARRAY ARRAY['path', 'upstream_url']::TEXT[] LOOP
    IF p_gateway ? v_field THEN
      v_value := p_gateway -> v_field;
      v_out := jsonb_set(
        v_out,
        ARRAY[v_field],
        CASE
          WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
          WHEN jsonb_typeof(v_value) = 'string' THEN to_jsonb(public.redact_sensitive_url(
            v_value #>> '{}',
            v_snapshot,
            TRUE
          ))
          ELSE to_jsonb('REDACTED'::TEXT)
        END,
        TRUE
      );
    END IF;
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.sanitize_api_gateway_persisted_context_v1(JSONB)
  IS 'Sanitize durable API-gateway path/query/header/upstream URL evidence while preserving payload, metadata, and provider credentials; no raw query value survives in workflow or queue persistence.';

CREATE OR REPLACE FUNCTION public.redact_webhook_persisted_headers_v1(
  p_headers JSONB,
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1(COALESCE(p_policy, '{}'::jsonb)),
    'persisted',
    FALSE
  );
$function$;

COMMENT ON FUNCTION public.redact_webhook_persisted_headers_v1(JSONB, JSONB)
  IS 'Redact fixed credential headers and remove policy-selected idempotency and HMAC headers from webhook persistence.';

CREATE OR REPLACE FUNCTION public.resolve_webhook_persisted_headers_v1(
  p_headers JSONB,
  p_webhook_source_id UUID,
  p_policy_settings_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN public.resolve_webhook_persisted_headers_v1(
    p_headers,
    p_webhook_source_id,
    p_policy_settings_id,
    FALSE
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID)
  IS 'Resolve the exact stored webhook policy when available, otherwise the current canonical policy, and return its sanitized header projection.';

REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID) FROM authenticated;

CREATE OR REPLACE FUNCTION public.resolve_webhook_persisted_headers_v1(
  p_headers JSONB,
  p_webhook_source_id UUID,
  p_policy_settings_id UUID,
  p_historical BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
BEGIN
  IF p_headers IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_policy_settings_id IS NOT NULL THEN
    SELECT cached_value
      INTO v_policy
      FROM public.settings
     WHERE id = p_policy_settings_id
       AND category = 'webhook_ingest_policy';
  ELSIF NOT p_historical THEN
    SELECT policy
      INTO v_policy
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id)
     LIMIT 1;
  END IF;

  IF v_policy IS NULL THEN
    RETURN to_jsonb('REDACTED'::TEXT);
  END IF;

  RETURN public.rebuild_ingress_headers_v1(
    p_headers,
    public.ingress_header_policy_snapshot_v1(v_policy),
    'persisted',
    p_historical
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID, BOOLEAN)
  IS 'Use the exact stored webhook policy snapshot for history; live inserts may resolve the active policy, while unknown history is fully redacted rather than guessed.';

REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_webhook_persisted_headers_v1(JSONB, UUID, UUID, BOOLEAN) FROM authenticated;

CREATE OR REPLACE FUNCTION public.redact_ingress_persisted_json_v1(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
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

  IF jsonb_typeof(p_value) = 'object' THEN
    v_out := '{}'::jsonb;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_key_lower := lower(v_entry.key);

      IF v_key_lower IN (
        'headers',
        'request_headers',
        'response_headers',
        'outbound_headers',
        'ack_headers'
      ) THEN
        IF jsonb_typeof(v_entry.value) = 'object' THEN
          v_out := v_out || jsonb_build_object(
            v_entry.key,
            public.rebuild_ingress_headers_v1(v_entry.value, NULL, 'persisted', TRUE)
          );
        ELSIF v_entry.value = 'null'::jsonb THEN
          v_out := v_out || jsonb_build_object(v_entry.key, v_entry.value);
        ELSE
          v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
        END IF;
      ELSIF v_key_lower = 'query_string' THEN
        IF jsonb_typeof(v_entry.value) = 'string' THEN
          v_out := v_out || jsonb_build_object(
            v_entry.key,
            public.redact_sensitive_query_string_v1(v_entry.value #>> '{}', NULL, TRUE)
          );
        ELSIF v_entry.value = 'null'::jsonb THEN
          v_out := v_out || jsonb_build_object(v_entry.key, v_entry.value);
        ELSE
          v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
        END IF;
      ELSIF v_key_lower IN (
        'x-forwarded-path',
        'x-forwarded-url',
        'x-original-uri',
        'x-rewrite-url',
        'x-envoy-original-path',
        'referer'
      ) THEN
        IF jsonb_typeof(v_entry.value) = 'string' THEN
          v_out := v_out || jsonb_build_object(
            v_entry.key,
            public.redact_sensitive_url(v_entry.value #>> '{}', NULL, TRUE)
          );
        ELSE
          v_out := v_out || jsonb_build_object(v_entry.key, 'REDACTED');
        END IF;
      ELSE
        v_out := v_out || jsonb_build_object(
          v_entry.key,
          public.redact_ingress_persisted_json_v1(v_entry.value)
        );
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    SELECT COALESCE(
             jsonb_agg(public.redact_ingress_persisted_json_v1(value) ORDER BY ordinality),
             '[]'::jsonb
           )
      INTO v_out
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item(value, ordinality);
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) = 'string' THEN
    RETURN to_jsonb(public.redact_sensitive_url(p_value #>> '{}', NULL, TRUE));
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.redact_ingress_persisted_json_v1(JSONB)
  IS 'Recursively sanitize ingress header projections and credential-bearing URL strings before JSON persistence.';

CREATE OR REPLACE FUNCTION public.sanitize_ingress_workflow_context_v1(p_context JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out JSONB := p_context;
  v_headers JSONB;
BEGIN
  IF p_context IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_context) <> 'object' THEN
    RETURN p_context;
  END IF;

  -- Webhook validation has already completed before the workflow is created.
  IF p_context ? 'webhook_id' AND p_context ? 'headers' THEN
    v_headers := p_context -> 'headers';
    v_out := jsonb_set(
      v_out,
      '{headers}',
      CASE
        WHEN v_headers = 'null'::jsonb THEN 'null'::jsonb
        WHEN jsonb_typeof(v_headers) = 'object'
          THEN public.rebuild_ingress_headers_v1(v_headers, NULL, 'persisted', TRUE)
        ELSE to_jsonb('REDACTED'::TEXT)
      END,
      TRUE
    );
  END IF;

  -- Gateway workflows retain provider-owned outbound credentials, while paths,
  -- query evidence, and the evidence-only upstream URL are sanitized.
  IF jsonb_typeof(p_context -> 'api_gateway') = 'object' THEN
    v_out := jsonb_set(
      v_out,
      '{api_gateway}',
      public.sanitize_api_gateway_persisted_context_v1(p_context -> 'api_gateway'),
      TRUE
    );
  END IF;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.sanitize_ingress_workflow_context_v1(JSONB)
  IS 'Sanitize only ingress-owned workflow header projections while preserving executable payload, URL, metadata, and policy credentials.';

CREATE OR REPLACE FUNCTION public.redact_ingress_audit_row_v1(
  p_table_name TEXT,
  p_row JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_out JSONB;
  v_value JSONB;
BEGIN
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RETURN public.redact_ingress_persisted_json_v1(p_row);
  END IF;

  -- Unknown nested header policy is conservatively redacted first. Table-aware
  -- branches below restore only projections whose exact write-time policy or
  -- executable outbound semantics are available on the audited row itself.
  v_out := public.redact_ingress_persisted_json_v1(p_row);

  IF p_table_name = 'api_gateway_requests' AND p_row ? 'request_headers' THEN
    v_value := p_row -> 'request_headers';
    v_out := jsonb_set(
      v_out,
      '{request_headers}',
      CASE
        WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
        ELSE public.rebuild_ingress_headers_v1(
          v_value,
          NULLIF(p_row -> 'persistence_policy_snapshot', 'null'::jsonb),
          'persisted',
          TRUE
        )
      END,
      TRUE
    );
  ELSIF p_table_name = 'webhook_inbox' THEN
    IF p_row ? 'headers' THEN
      v_value := p_row -> 'headers';
      v_out := jsonb_set(
        v_out,
        '{headers}',
        CASE
          WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
          ELSE COALESCE(
            public.resolve_webhook_persisted_headers_v1(
              v_value,
              NULLIF(p_row ->> 'webhook_source_id', '')::UUID,
              NULLIF(p_row ->> 'policy_settings_id', '')::UUID,
              TRUE
            ),
            'null'::jsonb
          )
        END,
        TRUE
      );
    END IF;
    IF p_row ? 'ack_headers' THEN
      v_value := p_row -> 'ack_headers';
      v_out := jsonb_set(
        v_out,
        '{ack_headers}',
        CASE
          WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
          ELSE public.rebuild_ingress_headers_v1(
            v_value,
            public.ingress_header_policy_snapshot_v1('{}'::jsonb),
            'persisted',
            TRUE
          )
        END,
        TRUE
      );
    END IF;
  ELSIF p_table_name = 'workflow_runs' AND p_row ? 'context' THEN
    v_value := p_row -> 'context';
    v_out := jsonb_set(
      v_out,
      '{context}',
      COALESCE(public.sanitize_ingress_workflow_context_v1(v_value), 'null'::jsonb),
      TRUE
    );
  ELSIF p_table_name = 'outbound_calls' AND p_row ? 'headers' THEN
    v_value := p_row -> 'headers';
    v_out := jsonb_set(
      v_out,
      '{headers}',
      CASE
        WHEN v_value = 'null'::jsonb THEN 'null'::jsonb
        ELSE public.rebuild_ingress_headers_v1(v_value, NULL, 'outbound', TRUE)
      END,
      TRUE
    );
  END IF;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.redact_ingress_audit_row_v1(TEXT, JSONB)
  IS 'Sanitize ingress audit OLD/NEW rows with table-aware API-route and workflow context handling before applying recursive evidence redaction.';

-------------------------------------------------------------------------------
-- Generic, row-driven persistence trigger
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sanitize_ingress_persisted_projection_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_old_row JSONB;
  v_column TEXT;
  v_mode TEXT;
  v_value JSONB;
  v_index INT;
  v_is_ingress BOOLEAN;
  v_policy_settings_id UUID;
  v_webhook_source_id UUID;
  v_api_route_id UUID;
  v_policy JSONB;
  v_snapshot JSONB;
  v_old_snapshot JSONB;
  v_old_api_route_id UUID;
  v_raw_url TEXT;
  v_redacted_url TEXT;
  v_execution_url_vault_id UUID;
  v_dispatchable BOOLEAN;
  v_url_changed BOOLEAN;
  v_old_is_ingress BOOLEAN;
BEGIN
  IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'sanitize_ingress_persisted_projection_v1 only supports INSERT or UPDATE';
  END IF;

  IF TG_NARGS = 0 OR mod(TG_NARGS, 2) <> 0 THEN
    RAISE EXCEPTION 'sanitize_ingress_persisted_projection_v1 requires column/mode argument pairs';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_row := to_jsonb(OLD);
  END IF;

  FOR v_index IN 0..TG_NARGS - 1 BY 2 LOOP
    v_column := NULLIF(btrim(TG_ARGV[v_index]), '');
    v_mode := lower(COALESCE(NULLIF(btrim(TG_ARGV[v_index + 1]), ''), ''));

    IF v_column IS NULL OR NOT (v_row ? v_column) THEN
      RAISE EXCEPTION 'sanitize_ingress_persisted_projection_v1 missing configured column % on %.%',
        COALESCE(v_column, '<empty>'), TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END IF;

    v_value := v_row -> v_column;
    IF TG_OP = 'UPDATE'
      AND (to_jsonb(OLD) -> v_column) IS NOT DISTINCT FROM v_value
      AND v_mode IN ('headers', 'json', 'text', 'query_string')
    THEN
      CONTINUE;
    END IF;

    IF v_mode = 'headers' THEN
      IF v_value IS NULL OR v_value = 'null'::jsonb THEN
        v_value := 'null'::jsonb;
      ELSE
        v_value := public.rebuild_ingress_headers_v1(
          v_value,
          public.ingress_header_policy_snapshot_v1('{}'::jsonb),
          'persisted',
          FALSE
        );
      END IF;
    ELSIF v_mode = 'gateway_policy_snapshot' THEN
      v_api_route_id := NULLIF(v_row ->> 'route_id', '')::UUID;
      v_old_api_route_id := CASE WHEN TG_OP = 'UPDATE'
        THEN NULLIF(v_old_row ->> 'route_id', '')::UUID ELSE NULL END;
      v_old_snapshot := CASE WHEN TG_OP = 'UPDATE'
        THEN NULLIF(v_old_row -> v_column, 'null'::jsonb) ELSE NULL END;
      IF TG_OP = 'INSERT' OR v_api_route_id IS DISTINCT FROM v_old_api_route_id THEN
        SELECT policy
          INTO v_policy
          FROM public.api_routes
         WHERE id = v_api_route_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'api gateway route % unavailable for write-time redaction snapshot', v_api_route_id;
        END IF;
        v_value := public.ingress_header_policy_snapshot_v1(COALESCE(v_policy, '{}'::jsonb));
      ELSE
        IF NULLIF(v_value, 'null'::jsonb) IS DISTINCT FROM v_old_snapshot THEN
          RAISE EXCEPTION 'api gateway persistence policy snapshot is immutable on route-preserving update';
        END IF;
        v_value := COALESCE(v_old_snapshot, 'null'::jsonb);
      END IF;
    ELSIF v_mode = 'gateway_request_headers' THEN
      IF v_value IS NULL OR v_value = 'null'::jsonb THEN
        v_value := 'null'::jsonb;
      ELSE
        v_snapshot := NULLIF(v_row -> 'persistence_policy_snapshot', 'null'::jsonb);
        v_value := public.rebuild_ingress_headers_v1(
          v_value,
          v_snapshot,
          'persisted',
          v_snapshot IS NULL
        );
      END IF;
    ELSIF v_mode = 'webhook_headers' THEN
      v_policy_settings_id := NULLIF(v_row ->> 'policy_settings_id', '')::UUID;
      v_webhook_source_id := NULLIF(v_row ->> 'webhook_source_id', '')::UUID;
      IF v_webhook_source_id IS NULL THEN
        RAISE EXCEPTION 'sanitize_ingress_persisted_projection_v1 requires webhook_source_id for webhook_headers';
      END IF;
      v_value := COALESCE(
        public.resolve_webhook_persisted_headers_v1(
          CASE WHEN v_value = 'null'::jsonb THEN NULL ELSE v_value END,
          v_webhook_source_id,
          v_policy_settings_id
        ),
        'null'::jsonb
      );
    ELSIF v_mode = 'gateway_execution_url_reference' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND COALESCE(v_row #>> '{context,api_gateway_request_id}', '') <> '';
      v_old_is_ingress := TG_OP = 'UPDATE'
        AND jsonb_typeof(v_old_row -> 'context') = 'object'
        AND COALESCE(v_old_row #>> '{context,api_gateway_request_id}', '') <> '';
      IF v_old_is_ingress AND v_is_ingress IS NOT TRUE THEN
        RAISE EXCEPTION 'outbound ingress scope cannot be removed from a persisted gateway call';
      END IF;
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      v_api_route_id := NULLIF(v_row #>> '{context,api_gateway_route_id}', '')::UUID;
      v_old_api_route_id := CASE WHEN TG_OP = 'UPDATE'
        THEN NULLIF(v_old_row #>> '{context,api_gateway_route_id}', '')::UUID ELSE NULL END;
      v_old_snapshot := CASE WHEN TG_OP = 'UPDATE'
        THEN NULLIF(v_old_row #> '{context,persistence_policy_snapshot}', 'null'::jsonb) ELSE NULL END;
      IF (TG_OP = 'INSERT' AND NULLIF(v_value, 'null'::jsonb) IS NOT NULL)
        OR (
          TG_OP = 'UPDATE'
          AND NULLIF(v_value, 'null'::jsonb) IS DISTINCT FROM NULLIF(v_old_row -> v_column, 'null'::jsonb)
        )
      THEN
        RAISE EXCEPTION 'ingress execution URL Vault reference cannot be supplied or replaced directly';
      END IF;
      IF TG_OP = 'INSERT' OR v_api_route_id IS DISTINCT FROM v_old_api_route_id THEN
        SELECT public.ingress_header_policy_snapshot_v1(COALESCE(policy, '{}'::jsonb))
          INTO v_snapshot
          FROM public.api_routes
         WHERE id = v_api_route_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'api gateway route % unavailable for outbound persistence snapshot', v_api_route_id;
        END IF;
        v_row := jsonb_set(v_row, '{context,persistence_policy_snapshot}', COALESCE(v_snapshot, 'null'::jsonb), TRUE);
      ELSE
        IF NULLIF(v_row #> '{context,persistence_policy_snapshot}', 'null'::jsonb)
          IS DISTINCT FROM v_old_snapshot
        THEN
          RAISE EXCEPTION 'outbound ingress persistence policy snapshot is immutable on route-preserving update';
        END IF;
        v_snapshot := v_old_snapshot;
        v_row := jsonb_set(v_row, '{context,persistence_policy_snapshot}', COALESCE(v_snapshot, 'null'::jsonb), TRUE);
      END IF;
      v_execution_url_vault_id := CASE WHEN TG_OP = 'UPDATE'
        THEN NULLIF(v_old_row ->> v_column, '')::UUID ELSE NULL END;
      v_url_changed := TG_OP = 'INSERT'
        OR (v_row -> 'url') IS DISTINCT FROM (v_old_row -> 'url');
      v_raw_url := NULLIF(v_row ->> 'url', '');
      IF TG_OP = 'UPDATE' AND NOT v_url_changed AND v_execution_url_vault_id IS NOT NULL THEN
        SELECT decrypted_secret
          INTO v_raw_url
          FROM vault.decrypted_secrets
         WHERE id = v_execution_url_vault_id;
        IF NULLIF(v_raw_url, '') IS NULL THEN
          RAISE EXCEPTION 'active ingress outbound call execution URL Vault reference is missing';
        END IF;
        v_row := jsonb_set(v_row, '{url}', to_jsonb(v_raw_url), TRUE);
      END IF;
      v_redacted_url := public.redact_sensitive_url(v_raw_url, v_snapshot, FALSE);
      v_dispatchable := COALESCE(v_row ->> 'status', '') NOT IN (
        'completed', 'skipped', 'permanently_failed', 'cancelled'
      );
      IF v_dispatchable
        AND v_raw_url ~ '(^|[?&])[^=&#]+=[^&#]*REDACTED|/api-gateway/(t/)?REDACTED'
        AND v_execution_url_vault_id IS NULL
      THEN
        RAISE EXCEPTION 'active ingress outbound call already lost executable protected URL values';
      END IF;
      IF v_dispatchable
        AND v_raw_url IS NOT NULL
        AND v_redacted_url IS DISTINCT FROM v_raw_url
        AND (v_url_changed OR v_execution_url_vault_id IS NULL)
      THEN
        v_execution_url_vault_id := public.persist_ingress_execution_url_v1(
          NULLIF(v_row ->> 'id', '')::UUID,
          v_raw_url,
          v_execution_url_vault_id
        );
      ELSIF TG_OP = 'UPDATE'
        AND v_execution_url_vault_id IS NOT NULL
        AND v_redacted_url IS NOT DISTINCT FROM v_raw_url
      THEN
        v_execution_url_vault_id := NULL;
      ELSIF TG_OP = 'UPDATE' AND v_execution_url_vault_id IS NOT NULL AND NOT v_dispatchable THEN
        v_execution_url_vault_id := NULL;
      ELSIF TG_OP = 'UPDATE' AND v_execution_url_vault_id IS NOT NULL THEN
        v_execution_url_vault_id := NULLIF(v_old_row ->> v_column, '')::UUID;
      END IF;
      v_value := COALESCE(to_jsonb(v_execution_url_vault_id), 'null'::jsonb);
    ELSIF v_mode = 'gateway_outbound_url' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND COALESCE(v_row #>> '{context,api_gateway_request_id}', '') <> '';
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      v_snapshot := NULLIF(v_row #> '{context,persistence_policy_snapshot}', 'null'::jsonb);
      IF v_value IS NOT NULL AND v_value <> 'null'::jsonb THEN
        v_value := to_jsonb(public.redact_sensitive_url(
          v_row ->> v_column,
          v_snapshot,
          v_snapshot IS NULL
        ));
      END IF;
    ELSIF v_mode = 'gateway_outbound_headers' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND COALESCE(v_row #>> '{context,api_gateway_request_id}', '') <> '';
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      IF v_value = 'null'::jsonb THEN
        v_value := 'null'::jsonb;
      ELSE
        v_snapshot := NULLIF(v_row #> '{context,persistence_policy_snapshot}', 'null'::jsonb);
        v_value := public.rebuild_ingress_headers_v1(
          v_value,
          v_snapshot,
          'outbound',
          v_snapshot IS NULL
        );
      END IF;
    ELSIF v_mode = 'gateway_response_headers' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND COALESCE(v_row #>> '{context,api_gateway_request_id}', '') <> '';
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      IF v_value = 'null'::jsonb THEN
        v_value := 'null'::jsonb;
      ELSE
        v_snapshot := NULLIF(v_row #> '{context,persistence_policy_snapshot}', 'null'::jsonb);
        v_value := public.rebuild_ingress_headers_v1(
          v_value,
          v_snapshot,
          'persisted',
          v_snapshot IS NULL
        );
      END IF;
    ELSIF v_mode = 'gateway_outbound_context' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND COALESCE(v_row #>> '{context,api_gateway_request_id}', '') <> '';
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      v_value := COALESCE(public.redact_ingress_persisted_json_v1(v_value), 'null'::jsonb);
    ELSIF v_mode = 'json' THEN
      v_value := COALESCE(public.redact_ingress_persisted_json_v1(v_value), 'null'::jsonb);
    ELSIF v_mode = 'ingress_json' THEN
      v_is_ingress := jsonb_typeof(v_row -> 'context') = 'object'
        AND (
          (v_row -> 'context') ? 'webhook_id'
          OR jsonb_typeof(v_row #> '{context,api_gateway}') = 'object'
        );
      v_old_is_ingress := TG_OP = 'UPDATE'
        AND jsonb_typeof(v_old_row -> 'context') = 'object'
        AND (
          (v_old_row -> 'context') ? 'webhook_id'
          OR jsonb_typeof(v_old_row #> '{context,api_gateway}') = 'object'
        );
      IF v_old_is_ingress AND v_is_ingress IS NOT TRUE THEN
        RAISE EXCEPTION 'workflow ingress scope cannot be removed from a persisted workflow run';
      END IF;
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      IF jsonb_typeof(v_value -> 'api_gateway') = 'object' THEN
        v_api_route_id := NULLIF(v_value #>> '{api_gateway,route_id}', '')::UUID;
        v_old_api_route_id := CASE WHEN TG_OP = 'UPDATE'
          THEN NULLIF(v_old_row #>> '{context,api_gateway,route_id}', '')::UUID ELSE NULL END;
        v_old_snapshot := CASE WHEN TG_OP = 'UPDATE'
          THEN NULLIF(v_old_row #> '{context,api_gateway,persistence_policy_snapshot}', 'null'::jsonb) ELSE NULL END;
        IF TG_OP = 'INSERT' OR v_api_route_id IS DISTINCT FROM v_old_api_route_id THEN
          SELECT public.ingress_header_policy_snapshot_v1(COALESCE(policy, '{}'::jsonb))
            INTO v_snapshot
            FROM public.api_routes
           WHERE id = v_api_route_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'api gateway route % unavailable for workflow persistence snapshot', v_api_route_id;
          END IF;
        ELSE
          IF NULLIF(v_value #> '{api_gateway,persistence_policy_snapshot}', 'null'::jsonb)
            IS DISTINCT FROM v_old_snapshot
          THEN
            RAISE EXCEPTION 'workflow ingress persistence policy snapshot is immutable on route-preserving update';
          END IF;
          v_snapshot := v_old_snapshot;
        END IF;
        v_value := jsonb_set(
          v_value,
          '{api_gateway,persistence_policy_snapshot}',
          COALESCE(v_snapshot, 'null'::jsonb),
          TRUE
        );
      END IF;
      v_value := COALESCE(public.sanitize_ingress_workflow_context_v1(v_value), 'null'::jsonb);
    ELSIF v_mode = 'ingress_decision_json' THEN
      v_is_ingress := COALESCE(v_row ->> 'resource_type', '') IN (
          'webhook_inbox',
          'api_gateway_request'
        )
        OR COALESCE(v_row ->> 'performed_by_system', '') IN (
          'workflow_intake_webhook',
          'api_gateway'
        );
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      v_value := COALESCE(public.redact_ingress_persisted_json_v1(v_value), 'null'::jsonb);
    ELSIF v_mode = 'ingress_audit_json' THEN
      v_is_ingress := COALESCE(v_row ->> 'schema_name', '') = 'public'
        AND (
          COALESCE(v_row ->> 'table_name', '') IN (
            'api_gateway_requests',
            'webhook_inbox'
          )
          OR (
            COALESCE(v_row ->> 'table_name', '') = 'workflow_runs'
            AND (
              (v_row #> '{row_old,context}') ? 'webhook_id'
              OR jsonb_typeof(v_row #> '{row_old,context,api_gateway}') = 'object'
              OR (v_row #> '{row_new,context}') ? 'webhook_id'
              OR jsonb_typeof(v_row #> '{row_new,context,api_gateway}') = 'object'
            )
          )
          OR (
            COALESCE(v_row ->> 'table_name', '') = 'decision_log'
            AND (
              COALESCE(v_row #>> '{row_old,resource_type}', '') IN ('webhook_inbox', 'api_gateway_request')
              OR COALESCE(v_row #>> '{row_new,resource_type}', '') IN ('webhook_inbox', 'api_gateway_request')
              OR COALESCE(v_row #>> '{row_old,performed_by_system}', '') IN ('workflow_intake_webhook', 'api_gateway')
              OR COALESCE(v_row #>> '{row_new,performed_by_system}', '') IN ('workflow_intake_webhook', 'api_gateway')
            )
          )
          OR (
            COALESCE(v_row ->> 'table_name', '') = 'outbound_calls'
            AND COALESCE(
              v_row #>> '{row_old,context,api_gateway_request_id}',
              v_row #>> '{row_new,context,api_gateway_request_id}',
              ''
            ) <> ''
          )
        );
      IF v_is_ingress IS NOT TRUE THEN
        CONTINUE;
      END IF;
      v_value := COALESCE(
        public.redact_ingress_audit_row_v1(v_row ->> 'table_name', v_value),
        'null'::jsonb
      );
    ELSIF v_mode = 'text' THEN
      IF v_value IS NOT NULL AND v_value <> 'null'::jsonb THEN
        v_snapshot := NULLIF(v_row -> 'persistence_policy_snapshot', 'null'::jsonb);
        v_value := to_jsonb(public.redact_sensitive_url(
          v_row ->> v_column,
          v_snapshot,
          v_snapshot IS NULL
        ));
      END IF;
    ELSIF v_mode = 'query_string' THEN
      IF v_value IS NOT NULL AND v_value <> 'null'::jsonb THEN
        v_snapshot := NULLIF(v_row -> 'persistence_policy_snapshot', 'null'::jsonb);
        v_value := to_jsonb(public.redact_sensitive_query_string_v1(
          v_row ->> v_column,
          v_snapshot,
          v_snapshot IS NULL
        ));
      END IF;
    ELSE
      RAISE EXCEPTION 'sanitize_ingress_persisted_projection_v1 unsupported mode % for column %',
        COALESCE(v_mode, '<empty>'), v_column;
    END IF;

    v_row := jsonb_set(v_row, ARRAY[v_column], v_value, TRUE);
  END LOOP;

  NEW := jsonb_populate_record(NEW, v_row);
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sanitize_ingress_persisted_projection_v1()
  IS 'Fail-closed trigger that applies configured ingress sanitizers to column/mode pairs before INSERT or UPDATE.';

CREATE OR REPLACE FUNCTION public.purge_obsolete_ingress_execution_url_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, vault, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.execution_url_vault_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.execution_url_vault_id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.execution_url_vault_id IS NOT NULL
    AND NEW.execution_url_vault_id IS NULL
  THEN
    DELETE FROM vault.secrets WHERE id = OLD.execution_url_vault_id;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_obsolete_ingress_execution_url_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS z99_purge_obsolete_ingress_execution_url ON public.outbound_calls;
CREATE TRIGGER z99_purge_obsolete_ingress_execution_url
  AFTER UPDATE ON public.outbound_calls
  FOR EACH ROW
  WHEN (OLD.execution_url_vault_id IS NOT NULL AND NEW.execution_url_vault_id IS NULL)
  EXECUTE FUNCTION public.purge_obsolete_ingress_execution_url_v1();

DROP TRIGGER IF EXISTS z99_purge_deleted_ingress_execution_url ON public.outbound_calls;
CREATE TRIGGER z99_purge_deleted_ingress_execution_url
  AFTER DELETE ON public.outbound_calls
  FOR EACH ROW
  EXECUTE FUNCTION public.purge_obsolete_ingress_execution_url_v1();

-------------------------------------------------------------------------------
-- Webhook core: retain raw validation, expose only the sanitized projection
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core_v1(
  p_token TEXT,
  p_headers JSONB,
  p_raw_body TEXT,
  p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_headers JSONB := normalize_headers(COALESCE(p_headers, '{}'::jsonb));
  v_persisted_headers JSONB := '{}'::jsonb;
  v_payload JSONB := COALESCE(p_payload, NULL);
  v_source RECORD;
  v_policy RECORD;
  v_policy_body JSONB;
  v_mapping JSONB;
  v_validation JSONB := '{}'::jsonb;
  v_hmac_config JSONB;
  v_idempotency_config JSONB;
  v_idempotency_required BOOLEAN := TRUE;
  v_idempotency_key TEXT;
  v_existing_ack RECORD;
  v_webhook_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_processing_status TEXT := 'in_progress';
  v_ack_mode TEXT := 'accepted_async';
  v_ack_status INT := 202;
  v_bad_status INT := 400;
  v_ack_headers JSONB := '{}'::jsonb;
  v_ack_body JSONB;
  v_ack_outcome TEXT := 'ack_sent';
  v_ack_reason TEXT := NULL;
  v_organization_id UUID;
  v_policy_scope_type TEXT;
  v_policy_scope_id UUID;
  v_policy_settings_id UUID;
  v_policy_version INT;
  v_context_patch JSONB := '{}'::jsonb;
  v_template_id UUID;
  v_entry_template_id UUID;
  v_followup_run_id UUID;
  v_workflow_run_id UUID;
  v_payload_for_db JSONB := '{}'::jsonb;
  v_raw_body_json JSONB;
  v_started TIMESTAMPTZ := clock_timestamp();
  v_processing_ms INT := 0;
  v_decision_point TEXT;
  v_planned_shipment_id UUID;
  v_planned_tracking TEXT;
  v_tracking_policy JSONB;
  v_tracking_scope_type TEXT;
  v_tracking_scope_id UUID;
  v_response_outcome TEXT;
  v_intake_settings JSONB;
  v_defaults JSONB;
  v_event_type TEXT;
  v_raw_intent TEXT;
  v_canonical_intent TEXT;
  v_should_plan BOOLEAN := FALSE;
  v_intent_resolution JSONB := '{}'::jsonb;
BEGIN
  IF v_payload IS NULL AND p_raw_body IS NOT NULL THEN
    BEGIN
      v_raw_body_json := p_raw_body::jsonb;
      v_payload := v_raw_body_json;
    EXCEPTION
      WHEN others THEN
        v_payload := NULL;
    END;
  END IF;

  IF v_payload IS NULL THEN
    v_payload := '{}'::jsonb;
  END IF;

  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN jsonb_build_object(
      'status', 401,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Missing Authorization bearer token'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  SELECT * INTO v_source
  FROM get_webhook_source_by_token(p_token)
  LIMIT 1;

  IF v_source.id IS NULL OR v_source.enabled IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'status', 401,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Unauthorized webhook source'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  v_organization_id := v_source.organization_id;

  SELECT * INTO v_policy
  FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source.id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 500,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Webhook ingest policy not configured'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;

  v_policy_body := COALESCE(v_policy.policy, '{}'::jsonb);
  v_policy_scope_type := v_policy.scope_type;
  v_policy_scope_id := v_policy.scope_id;
  v_policy_settings_id := v_policy.settings_id;
  v_policy_version := v_policy.policy_version;
  v_decision_point := COALESCE(v_policy_body#>>'{logging,decision_point}', 'workflow_intake_ack');

  v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_organization_id);
  IF v_intake_settings IS NULL THEN
    v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
  END IF;
  v_defaults := COALESCE(v_intake_settings->'defaults', '{}'::jsonb);
  v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
  IF v_entry_template_id IS NULL THEN
    v_entry_template_id := '77770000-0000-0000-0000-000000770001'::UUID;
  END IF;

  v_ack_mode := COALESCE(v_policy_body->'ack'->>'mode', 'accepted_async');
  v_ack_status := COALESCE(
    (CASE WHEN v_ack_mode = 'accepted_async' THEN v_defaults->>'accepted_async_status' ELSE v_defaults->>'synchronous_success_status' END)::INT,
    CASE WHEN v_ack_mode = 'accepted_async' THEN 202 ELSE 200 END
  );
  v_bad_status := COALESCE((v_defaults->>'bad_request_status')::INT, 400);

  v_event_type := COALESCE(
    NULLIF(v_payload#>>'{event,type}', ''),
    NULLIF(v_payload#>>'{event,kind}', ''),
    NULLIF(v_payload->>'type', '')
  );
  v_raw_intent := NULLIF(v_policy_body#>>'{workflow,intent}', '');
  v_intent_resolution := public.resolve_webhook_shipment_intent_v1(v_payload, v_raw_intent, v_event_type);

  v_validation := v_validation || jsonb_build_object(
    'intent', jsonb_strip_nulls(jsonb_build_object(
      'raw', v_raw_intent,
      'received_event_type', v_event_type,
      'canonical', NULLIF(v_intent_resolution->>'canonical_intent', ''),
      'resolution_status', NULLIF(v_intent_resolution->>'status', ''),
      'reason', NULLIF(v_intent_resolution->>'reason', ''),
      'matched_signals', COALESCE(v_intent_resolution->'matched_signals', '[]'::jsonb)
    ))
  );

  IF COALESCE(v_intent_resolution->>'status', '') = 'ambiguous' THEN
    RETURN jsonb_build_object(
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_strip_nulls(jsonb_build_object(
        'error', COALESCE(v_intent_resolution->>'error', 'shipment_update_payload_ambiguous'),
        'event_type', COALESCE(v_event_type, 'shipment.updated'),
        'matched_signals', COALESCE(v_intent_resolution->'matched_signals', '[]'::jsonb)
      )),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', COALESCE(v_intent_resolution->>'error', 'shipment_update_payload_ambiguous'),
      'canonical_intent', NULL
    );
  END IF;

  v_canonical_intent := NULLIF(v_intent_resolution->>'canonical_intent', '');
  IF v_canonical_intent IS NULL OR btrim(v_canonical_intent) = '' THEN
    v_canonical_intent := 'shipment.create';
  END IF;
  v_event_type := COALESCE(NULLIF(v_intent_resolution->>'event_type', ''), v_event_type, v_canonical_intent);
  v_payload_for_db := COALESCE(v_intent_resolution->'transformed_payload', v_payload, '{}'::jsonb);
  v_policy_body := jsonb_set(v_policy_body, '{workflow,intent}', to_jsonb(v_canonical_intent), TRUE);
  v_should_plan := public.should_reserve_identifiers_for_shipment_intent_v1(v_canonical_intent, v_policy_body);

  v_idempotency_config := COALESCE(
    v_policy_body->'validation'->'idempotency',
    jsonb_build_object('header', 'Idempotency-Key', 'body_path', 'event.id', 'required', TRUE)
  );
  v_idempotency_required := COALESCE((v_idempotency_config->>'required')::BOOLEAN, TRUE);
  v_idempotency_key := NULLIF(v_headers->>lower(COALESCE(v_idempotency_config->>'header', 'Idempotency-Key')), '');
  IF v_idempotency_key IS NULL THEN
    v_idempotency_key := NULLIF((jsonb_resolve_path(v_payload, COALESCE(v_idempotency_config->>'body_path', 'event.id')))::TEXT, '');
  END IF;
  IF v_idempotency_key IS NOT NULL THEN
    v_idempotency_key := NULLIF(btrim(v_idempotency_key, '" '), '');
  END IF;

  v_validation := v_validation || jsonb_build_object(
    'idempotency', jsonb_build_object(
      'status', CASE
        WHEN v_idempotency_key IS NULL AND v_idempotency_required THEN 'failed'
        WHEN v_idempotency_key IS NULL THEN 'skipped'
        ELSE 'passed'
      END,
      'key', v_idempotency_key
    )
  );

  IF v_idempotency_key IS NULL AND v_idempotency_required THEN
    RETURN jsonb_build_object(
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Missing required idempotency key'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', 'missing_required_idempotency_key'
    );
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT webhook_inbox_id,
           ack_status_code AS status_code,
           ack_headers,
           ack_body,
           ack_outcome,
           ack_reason,
           ack_sent_at
    INTO v_existing_ack
    FROM webhook_ack_history
    WHERE webhook_source_id = v_source.id
      AND idempotency_key = v_idempotency_key
    ORDER BY ack_sent_at DESC
    LIMIT 1;

    IF v_existing_ack.ack_outcome IS NOT NULL THEN
      v_webhook_id := v_existing_ack.webhook_inbox_id;
      v_response_outcome := CASE
        WHEN v_existing_ack.ack_outcome = 'ack_failed' THEN 'response_failed'
        ELSE 'response_replayed'
      END;

      PERFORM log_decision(
        p_organization_id := v_organization_id,
        p_decision_category := 'http_response_emitted',
        p_resource_type := 'webhook_inbox',
        p_resource_id := v_webhook_id,
        p_decision_point := v_decision_point,
        p_decision_outcome := v_response_outcome,
        p_performed_by_system := 'workflow_intake_webhook',
        p_correlation_id := v_correlation_id,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'mode', v_ack_mode,
          'status', COALESCE(v_existing_ack.status_code, v_ack_status),
          'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
          'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
          'validation_results', COALESCE(v_validation, '{}'::jsonb),
          'idempotency_key', v_idempotency_key,
          'canonical_intent', v_canonical_intent
        )),
        p_decision_reason := v_existing_ack.ack_reason
      );

      RETURN jsonb_build_object(
        'status', COALESCE(v_existing_ack.status_code, v_ack_status),
        'headers', COALESCE(v_existing_ack.ack_headers, '{}'::jsonb),
        'body', COALESCE(v_existing_ack.ack_body, jsonb_build_object()),
        'ack_outcome', 'ack_replayed',
        'response_outcome', v_response_outcome,
        'response_mode', v_ack_mode,
        'response_reason', v_existing_ack.ack_reason,
        'webhook_id', v_webhook_id,
        'workflow_run_id', NULL,
        'followup_workflow_run_id', NULL,
        'canonical_intent', v_canonical_intent
      );
    END IF;
  END IF;

  v_hmac_config := v_policy_body->'validation'->'hmac';
  IF v_hmac_config ? 'enabled' AND v_hmac_config->>'enabled' = 'true' THEN
    DECLARE
      v_algorithm TEXT := upper(COALESCE(v_hmac_config->>'algorithm', 'HMAC-SHA256'));
      v_signature_header TEXT := lower(COALESCE(v_hmac_config->>'header', 'x-signature'));
      v_signature_encoding TEXT := lower(COALESCE(v_hmac_config->>'signature_encoding', 'hex'));
      v_provided_signature TEXT := v_headers->>v_signature_header;
      v_auth_config_id UUID := NULLIF(v_hmac_config->>'auth_config_id', '')::UUID;
      v_secret TEXT;
      v_computed BYTEA;
      v_expected TEXT;
    BEGIN
      IF v_provided_signature IS NULL THEN
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', format('Missing signature header %s', v_signature_header)));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := format('Missing signature header %s', v_signature_header);
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
      ELSIF v_auth_config_id IS NULL THEN
        v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Missing auth_config reference for HMAC validation'));
        v_ack_outcome := 'ack_failed';
        v_ack_reason := 'Missing auth_config reference for HMAC validation';
        v_ack_status := GREATEST(v_ack_status, v_bad_status);
      ELSE
        SELECT COALESCE(credentials->>'signing_secret', credentials->>'secret', credentials->>'api_key')
          INTO v_secret
          FROM provider_auth_configs
         WHERE id = v_auth_config_id;
        IF v_secret IS NULL THEN
          v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'Signing secret missing in provider_auth_configs.credentials'));
          v_ack_outcome := 'ack_failed';
          v_ack_reason := 'Signing secret missing';
          v_ack_status := GREATEST(v_ack_status, v_bad_status);
        ELSE
          v_computed := hmac(coalesce(p_raw_body, '')::bytea, v_secret::bytea, CASE WHEN v_algorithm = 'HMAC-SHA512' THEN 'sha512' ELSE 'sha256' END);
          IF v_signature_encoding = 'base64' THEN
            v_expected := encode(v_computed, 'base64');
          ELSE
            v_expected := encode(v_computed, 'hex');
          END IF;
          IF v_expected <> v_provided_signature THEN
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'failed', 'message', 'HMAC signature mismatch'));
            v_ack_outcome := 'ack_failed';
            v_ack_reason := 'HMAC signature mismatch';
            v_ack_status := GREATEST(v_ack_status, v_bad_status);
          ELSE
            v_validation := v_validation || jsonb_build_object('hmac', jsonb_build_object('status', 'passed'));
          END IF;
        END IF;
      END IF;
    END;
  END IF;

  v_persisted_headers := public.redact_webhook_persisted_headers_v1(
    v_headers,
    v_policy_body
  );

  PERFORM insert_webhook_inbox_record(
    v_webhook_id,
    v_source.id,
    v_source.provider_type,
    COALESCE(v_payload, '{}'::jsonb),
    v_persisted_headers,
    CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END,
    v_correlation_id,
    v_idempotency_key
  );
  UPDATE webhook_inbox
     SET transformed_payload = v_payload_for_db,
         event_type = v_event_type,
         processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE v_processing_status END
   WHERE id = v_webhook_id;

  IF v_should_plan THEN
    v_tracking_scope_type := CASE WHEN v_source.client_id IS NOT NULL THEN 'client' ELSE 'tenant' END;
    v_tracking_scope_id := COALESCE(v_source.client_id, v_organization_id);
    v_tracking_policy := resolve_settings('tracking_policy', v_tracking_scope_type, v_tracking_scope_id);
    v_planned_shipment_id := gen_random_uuid();
    v_planned_tracking := generate_tracking_number(v_tracking_scope_type, v_tracking_scope_id, v_tracking_policy);
  ELSE
    v_planned_shipment_id := NULL;
    v_planned_tracking := NULL;
  END IF;

  IF v_policy_body->'ack' ? 'response_mapping_id' THEN
    SELECT mapping_config INTO v_mapping
      FROM mapping_configs
     WHERE id = NULLIF(v_policy_body->'ack'->>'response_mapping_id', '')::UUID;
  ELSE
    v_mapping := NULL;
  END IF;

  IF v_mapping ? 'status_code' THEN
    v_ack_status := COALESCE((v_mapping->>'status_code')::INT, v_ack_status);
  END IF;

  IF v_mapping ? 'headers' THEN
    v_ack_headers := jsonb_strip_nulls(COALESCE(v_mapping->'headers', '{}'::jsonb));
  END IF;

  IF v_mapping ? 'body' THEN
    v_ack_body := render_template(
      v_mapping->'body',
      jsonb_build_object(
        'webhook', jsonb_build_object(
          'id', v_webhook_id,
          'correlation_id', v_correlation_id,
          'source_identifier', v_source.source_identifier
        ),
        'payload', v_payload,
        'transformed_payload', v_payload_for_db,
        'headers', v_persisted_headers,
        'policy', v_policy_body,
        'validation', v_validation,
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object(
            'type', 'shipment',
            'id', v_planned_shipment_id,
            'tracking_number', v_planned_tracking
          )
          ELSE NULL
        END
      )
    );
  END IF;

  IF v_ack_body IS NULL OR v_ack_body::TEXT = 'null' THEN
    IF v_ack_mode = 'accepted_async' THEN
      v_ack_body := jsonb_strip_nulls(jsonb_build_object(
        'status', 'accepted_async',
        'correlation_id', v_correlation_id,
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object('type', 'shipment', 'id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
          ELSE NULL
        END
      ));
    ELSE
      v_ack_body := jsonb_strip_nulls(jsonb_build_object(
        'status', 'accepted',
        'resource', CASE
          WHEN v_should_plan THEN jsonb_build_object('type', 'shipment', 'id', v_planned_shipment_id, 'tracking_number', v_planned_tracking)
          ELSE NULL
        END
      ));
    END IF;
  END IF;

  IF v_ack_outcome = 'ack_failed' THEN
    v_ack_status := GREATEST(v_ack_status, v_bad_status);
    v_ack_headers := COALESCE(v_ack_headers, '{}'::jsonb) || jsonb_build_object('content-type', 'application/json');
    v_ack_body := jsonb_build_object('error', COALESCE(v_ack_reason, 'Webhook acknowledgement failed'));
  ELSE
    IF v_ack_headers IS NULL THEN
      v_ack_headers := '{}'::jsonb;
    END IF;
    IF NOT (v_ack_headers ? 'content-type') THEN
      v_ack_headers := v_ack_headers || jsonb_build_object('content-type', 'application/json');
    END IF;
  END IF;

  v_response_outcome := CASE
    WHEN v_ack_outcome = 'ack_failed' THEN 'response_failed'
    ELSE 'response_sent'
  END;

  UPDATE webhook_inbox
     SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'in_progress' END,
         organization_id = COALESCE(organization_id, v_organization_id),
         policy_scope_type = v_policy_scope_type,
         policy_scope_id = v_policy_scope_id,
         policy_settings_id = v_policy_settings_id,
         policy_version = v_policy_version,
         updated_at = now()
   WHERE id = v_webhook_id;

  v_template_id := public.resolve_webhook_followup_template_id_v1(v_policy_body, v_canonical_intent);
  IF v_ack_outcome <> 'ack_failed' AND v_entry_template_id IS NOT NULL THEN
    v_context_patch := COALESCE(v_policy_body->'workflow'->'context_patch', '{}'::jsonb);
    v_context_patch := jsonb_strip_nulls(
      COALESCE(v_context_patch, '{}'::jsonb)
      || jsonb_build_object(
        'canonical_intent', v_canonical_intent,
        'reserve_identifiers', v_should_plan,
        'reserve_new_tracking', CASE WHEN v_canonical_intent = 'shipment.swap' THEN v_should_plan ELSE NULL END,
        'planned_shipment_id', v_planned_shipment_id,
        'planned_tracking_number', v_planned_tracking,
        'client_id', v_source.client_id,
        'sender_id', v_source.sender_id,
        'source_identifier', v_source.source_identifier,
        'followup_template_id', v_template_id
      )
    );
    v_context_patch := jsonb_strip_nulls(
      jsonb_build_object(
        'workflow',
        jsonb_build_object('context_patch', v_context_patch)
      ) || v_context_patch
    );

    v_workflow_run_id := start_workflow_run(
      v_entry_template_id,
      jsonb_strip_nulls(
        jsonb_build_object(
          'webhook_id', v_webhook_id,
          'correlation_id', v_correlation_id,
          'organization_id', v_organization_id,
          'payload', v_payload,
          'transformed_payload', v_payload_for_db,
          'headers', v_persisted_headers,
          'policy', v_policy_body
        ) || v_context_patch
      )
    );

    UPDATE webhook_inbox
       SET workflow_run_id = v_workflow_run_id
     WHERE id = v_webhook_id;

    IF v_template_id IS NOT NULL AND v_template_id <> v_entry_template_id THEN
      v_followup_run_id := start_workflow_run(
        v_template_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'webhook_id', v_webhook_id,
            'correlation_id', v_correlation_id,
            'organization_id', v_organization_id,
            'started_by_run_id', v_workflow_run_id,
            'payload', v_payload,
            'transformed_payload', v_payload_for_db,
            'headers', v_persisted_headers,
            'policy', v_policy_body
          ) || v_context_patch
        )
      );

      UPDATE workflow_runs
         SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('started_by_run_id', v_workflow_run_id))
       WHERE id = v_followup_run_id;
    END IF;
  END IF;

  v_ack_body := jsonb_strip_nulls(COALESCE(v_ack_body, '{}'::jsonb) || jsonb_build_object(
    'workflow_run_id', v_workflow_run_id,
    'followup_workflow_run_id', v_followup_run_id
  ));

  PERFORM log_decision(
    p_organization_id := v_organization_id,
    p_decision_category := 'http_response_emitted',
    p_resource_type := 'webhook_inbox',
    p_resource_id := v_webhook_id,
    p_decision_point := v_decision_point,
    p_decision_outcome := v_response_outcome,
    p_performed_by_system := 'workflow_intake_webhook',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'mode', v_ack_mode,
      'status', v_ack_status,
      'headers', v_ack_headers,
      'body', v_ack_body,
      'validation_results', v_validation,
      'idempotency_key', v_idempotency_key,
      'workflow_run_id', v_workflow_run_id,
      'followup_workflow_run_id', v_followup_run_id,
      'canonical_intent', v_canonical_intent
    )),
    p_decision_reason := v_ack_reason
  );

  v_processing_ms := GREATEST(0, (extract(epoch FROM clock_timestamp() - v_started) * 1000)::INT);

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'status', v_ack_status,
    'headers', v_ack_headers,
    'body', v_ack_body,
    'ack_outcome', v_ack_outcome,
    'response_outcome', v_response_outcome,
    'response_mode', v_ack_mode,
    'response_reason', v_ack_reason,
    'processing_time_ms', v_processing_ms,
    'webhook_id', v_webhook_id,
    'workflow_run_id', v_workflow_run_id,
    'followup_workflow_run_id', v_followup_run_id,
    'canonical_intent', v_canonical_intent
  ));
END;
$function$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Workflow intake core with raw transient validation and a value-aware sanitized header projection for ACK rendering and persistence.';

CREATE OR REPLACE FUNCTION public.workflow_intake_api_gateway_base_v1(
  p_token TEXT,
  p_method TEXT,
  p_path TEXT,
  p_query_string TEXT DEFAULT NULL,
  p_headers JSONB DEFAULT '{}'::jsonb,
  p_body JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_method TEXT := upper(COALESCE(p_method, ''));
  v_path TEXT := public.normalize_api_path(p_path);
  v_query TEXT := COALESCE(p_query_string, '');
  v_query_projection TEXT;
  v_url_projection TEXT;
  v_headers JSONB := COALESCE(p_headers, '{}'::jsonb);
  v_body JSONB := COALESCE(p_body, '{}'::jsonb);

  v_source RECORD;
  v_org UUID;
  v_client UUID;
  v_sender UUID;

  v_corr UUID;
  v_corr_text TEXT;
  v_rate_limit INT;
  v_window TIMESTAMPTZ;
  v_count INT;

  v_route JSONB;
  v_route_id UUID;
  v_settings_resolution_id UUID;
  v_path_params JSONB;
  v_route_row public.api_routes%ROWTYPE;

  v_provider_id UUID;
  v_base_url TEXT;
  v_upstream_path TEXT;
  v_upstream_method TEXT;
  v_url TEXT;

  v_policy JSONB;
  v_delivery JSONB;
  v_delivery_mode TEXT;
  v_timeout_seconds INT;

  v_auth JSONB;
  v_auth_mode TEXT;
  v_auth_type TEXT;
  v_auth_fields JSONB;
  v_safe_body JSONB;
  v_safe_headers JSONB;

  v_provider_account_policy JSONB;
  v_provider_account_category TEXT;
  v_provider_account_required BOOLEAN;
  v_provider_account_require_company_id BOOLEAN;
  v_provider_account_require_auth_config_id BOOLEAN;
  v_provider_account JSONB;
  v_provider_account_settings_id UUID;
  v_provider_account_settings_version_id UUID;
  v_provider_account_scope_type TEXT;
  v_provider_account_scope_id UUID;
  v_provider_account_version INT;
  v_provider_account_scope_path JSONB;
  v_provider_account_settings_resolution_id UUID;
  v_provider_account_company_id TEXT;
  v_path_company_id TEXT;
  v_provider_account_auth_config_id UUID;
  v_auth_config_count INT;

  v_outbound_headers JSONB;
  v_header_defaults JSONB;
  v_header_overrides JSONB;
  v_header_render_context JSONB;
  v_header_entry RECORD;
  v_header_name TEXT;
  v_header_value TEXT;

  v_request_id UUID;
  v_outbound_id UUID;

  -- Optional workflow mode (route.policy.workflow)
  v_workflow JSONB;
  v_workflow_enabled BOOLEAN;
  v_workflow_template_name TEXT;
  v_workflow_template_id UUID;
  v_workflow_run_id UUID;
  v_workflow_context JSONB;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN jsonb_build_object('action', 'error', 'status', 401, 'body', jsonb_build_object('error', 'missing_token'));
  END IF;

  SELECT * INTO v_source
  FROM public.get_webhook_source_by_token(p_token)
  LIMIT 1;

  IF v_source.id IS NULL OR COALESCE(v_source.enabled, FALSE) IS FALSE THEN
    RETURN jsonb_build_object('action', 'error', 'status', 401, 'body', jsonb_build_object('error', 'invalid_token'));
  END IF;

  v_org := v_source.organization_id;
  v_sender := v_source.sender_id;
  v_client := v_source.client_id;

  -- Correlation ID handling:
  -- - Prefer client-provided x-correlation-id (or x-request-id) when valid UUID.
  -- - Otherwise use existing request.correlation_id or generate a new one.
  v_corr_text := NULLIF(v_headers->>'x-correlation-id', '');
  IF v_corr_text IS NULL THEN
    v_corr_text := NULLIF(v_headers->>'x-request-id', '');
  END IF;

  IF v_corr_text IS NOT NULL
    AND v_corr_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_corr := v_corr_text::UUID;
    PERFORM set_config('request.correlation_id', v_corr::text, true);
  ELSE
    v_corr := public.current_correlation_id();
    IF v_corr IS NULL THEN
      v_corr := gen_random_uuid();
      PERFORM set_config('request.correlation_id', v_corr::text, true);
    END IF;
  END IF;

  -- Normalize query string (accept '?a=b' or 'a=b').
  IF v_query IS NOT NULL AND left(v_query, 1) = '?' THEN
    v_query := substring(v_query FROM 2);
  END IF;

  -- Rate limiting (per source, per hour) using webhook_sources.rate_limit_per_hour.
  SELECT rate_limit_per_hour INTO v_rate_limit
  FROM public.webhook_sources
  WHERE id = v_source.id;

  v_rate_limit := COALESCE(v_rate_limit, 0);
  v_window := date_trunc('hour', v_now);

  IF v_rate_limit > 0 THEN
    INSERT INTO public.api_gateway_rate_limits (source_id, window_start, request_count, updated_at)
    VALUES (v_source.id, v_window, 1, v_now)
    ON CONFLICT (source_id, window_start) DO UPDATE
      SET request_count = public.api_gateway_rate_limits.request_count + 1,
          updated_at = EXCLUDED.updated_at
    RETURNING request_count INTO v_count;

    IF v_count > v_rate_limit THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'rate_limiting',
        p_resource_type := 'webhook_source',
        p_resource_id := v_source.id,
        p_decision_point := 'api_gateway_intake',
        p_decision_outcome := 'rate_limited',
        p_performed_by_system := 'api_gateway',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'window_start', v_window,
          'count', v_count,
          'limit', v_rate_limit,
          'method', v_method,
          'path', v_path
        )),
        p_decision_reason := 'API gateway request rejected by per-source hourly rate limit.'
      );

      RETURN jsonb_build_object(
        'action', 'error',
        'status', 429,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'rate_limited')
      );
    END IF;
  END IF;

  v_route := public.resolve_api_route_v1(v_method, v_path, v_org, v_client, v_sender, v_source.id);
  IF COALESCE((v_route->>'found')::BOOLEAN, FALSE) IS FALSE THEN
    RETURN jsonb_build_object(
      'action', 'error',
      'status', 404,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'route_not_found')
    );
  END IF;

  v_route_id := NULLIF(v_route->>'route_id', '')::UUID;
  v_settings_resolution_id := NULLIF(v_route->>'settings_resolution_id', '')::UUID;
  v_path_params := COALESCE(v_route->'path_params', '{}'::jsonb);

  SELECT * INTO v_route_row
  FROM public.api_routes
  WHERE id = v_route_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'route_missing'));
  END IF;

  v_policy := COALESCE(v_route_row.policy, '{}'::jsonb);
  v_query_projection := public.redact_sensitive_query_string_v1(
    v_query,
    public.ingress_header_policy_snapshot_v1(v_policy),
    FALSE
  );
  v_delivery := COALESCE(v_policy->'delivery', '{}'::jsonb);
  v_delivery_mode := COALESCE(NULLIF(v_delivery->>'mode', ''), 'proxy');
  v_timeout_seconds := COALESCE(NULLIF(v_delivery->>'timeout_seconds', '')::INT, 30);

  v_auth := COALESCE(v_policy->'auth', '{}'::jsonb);
  v_auth_mode := NULLIF(v_auth->>'mode', '');
  v_auth_type := NULLIF(v_auth->>'auth_type', '');
  v_auth_fields := COALESCE(v_auth->'fields', '{}'::jsonb);

  v_provider_account_policy := COALESCE(v_policy->'provider_account', '{}'::jsonb);
  v_provider_account_category := NULLIF(v_provider_account_policy->>'category', '');
  IF v_provider_account_category IS NULL THEN
    -- Back-compat: allow auth.binding_category for older policies.
    v_provider_account_category := NULLIF(v_auth->>'binding_category', '');
  END IF;

  BEGIN
    v_provider_account_required := COALESCE((v_provider_account_policy->>'required')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_required := TRUE;
  END;

  BEGIN
    v_provider_account_require_company_id := COALESCE((v_provider_account_policy->>'require_company_id')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_company_id := FALSE;
  END;

  BEGIN
    v_provider_account_require_auth_config_id := COALESCE(
      (v_provider_account_policy->>'require_auth_config_id')::BOOLEAN,
      (v_auth_mode IS NOT NULL)
    );
  EXCEPTION
    WHEN others THEN
      v_provider_account_require_auth_config_id := (v_auth_mode IS NOT NULL);
  END;

  -- Strip sensitive headers (defense-in-depth) + internal tokens.
  v_safe_headers := public.redact_api_gateway_persisted_headers_v1(
    v_headers,
    v_policy
  );

  -- Strip auth fields from stored body when using body_fields injection.
  v_safe_body := v_body;
  IF v_auth_mode = 'body_fields' AND jsonb_typeof(v_safe_body) = 'object' AND jsonb_typeof(v_auth_fields) = 'object' THEN
    SELECT COALESCE(
      jsonb_object_agg(kv.key, kv.value) FILTER (WHERE kv.key IS NOT NULL),
      '{}'::jsonb
    )
    INTO v_safe_body
    FROM (
      SELECT key, value
      FROM jsonb_each(v_safe_body)
      WHERE key NOT IN (SELECT key FROM jsonb_each_text(v_auth_fields))
    ) kv;
  END IF;

  v_safe_body := public.redact_sensitive_json(COALESCE(v_safe_body, '{}'::jsonb));

  -- Insert inbound request log (redacted).
  INSERT INTO public.api_gateway_requests (
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    settings_resolution_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  ) VALUES (
    v_org,
    v_client,
    v_sender,
    v_source.id,
    v_corr,
    v_route_id,
    v_settings_resolution_id,
    v_method,
    v_path,
    NULLIF(v_query_projection, ''),
    COALESCE(v_safe_headers, '{}'::jsonb),
    COALESCE(v_safe_body, '{}'::jsonb),
    v_now,
    v_now,
    v_now
  )
  RETURNING id INTO v_request_id;

  -- Build outbound call spec (provider proxy).
  v_provider_id := v_route_row.provider_id;
  IF v_provider_id IS NULL THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'provider_missing'));
  END IF;

  SELECT COALESCE(metadata->>'base_url', '') INTO v_base_url
  FROM public.providers
  WHERE id = v_provider_id;

  IF v_base_url IS NULL OR btrim(v_base_url) = '' THEN
    RETURN jsonb_build_object('action', 'error', 'status', 500, 'body', jsonb_build_object('error', 'provider_base_url_missing'));
  END IF;

  v_upstream_method := upper(COALESCE(NULLIF(v_route_row.upstream_method, ''), v_method));
  v_upstream_path := public.api_render_path_template(
    COALESCE(NULLIF(v_route_row.upstream_path_template, ''), v_route_row.path_template),
    v_path_params
  );

  v_url := rtrim(v_base_url, '/') || v_upstream_path;
  IF v_query IS NOT NULL AND btrim(v_query) <> '' THEN
    v_url := v_url || '?' || v_query;
  END IF;

  v_url_projection := public.redact_sensitive_url(
    v_url,
    public.ingress_header_policy_snapshot_v1(v_policy),
    FALSE
  );

  -- Provider account (ladder-driven settings):
  v_provider_account := NULL;
  v_provider_account_settings_resolution_id := NULL;
  v_provider_account_company_id := NULL;
  v_provider_account_auth_config_id := NULL;

  IF v_provider_account_category IS NOT NULL AND btrim(v_provider_account_category) <> '' THEN
    SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path
      INTO v_provider_account_settings_id,
           v_provider_account_settings_version_id,
           v_provider_account_scope_type,
           v_provider_account_scope_id,
           v_provider_account,
           v_provider_account_version,
           v_provider_account_scope_path
      FROM public.resolve_settings_row_from_context(
        v_provider_account_category,
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_org,
          'client_id', v_client,
          'sender_id', v_sender,
          'webhook_source_id', v_source.id
        ))
      )
      LIMIT 1;

    IF v_provider_account_settings_id IS NOT NULL THEN
      v_provider_account_settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org,
        p_category := v_provider_account_category,
        p_winning_scope_type := v_provider_account_scope_type,
        p_winning_scope_id := v_provider_account_scope_id,
        p_winning_settings_id := v_provider_account_settings_id,
        p_winning_settings_version_id := v_provider_account_settings_version_id,
        p_winning_version := v_provider_account_version,
        p_scope_path := v_provider_account_scope_path,
        p_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_id', v_provider_id,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'method', v_method,
          'path', v_path
        ))
      );
    END IF;

    IF v_provider_account_required AND v_provider_account_settings_id IS NULL THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'api_gateway_request',
        p_resource_id := v_request_id,
        p_decision_point := 'api_gateway_provider_account_resolved',
        p_decision_outcome := 'missing',
        p_performed_by_system := 'api_gateway',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'provider_id', v_provider_id,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'category', v_provider_account_category
        )),
        p_decision_reason := 'Provider account settings category missing for this scope; cannot proceed safely.',
        p_settings_resolution_id := v_provider_account_settings_resolution_id
      );

      RETURN jsonb_build_object(
        'action', 'error',
        'status', 500,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'provider_account_missing')
      );
    END IF;

    v_provider_account_company_id := NULLIF(COALESCE(v_provider_account->>'company_id', ''), '');
    BEGIN
      v_provider_account_auth_config_id := NULLIF(COALESCE(v_provider_account->>'auth_config_id', ''), '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_provider_account_auth_config_id := NULL;
    END;

    IF v_provider_account_require_company_id AND v_provider_account_company_id IS NULL THEN
      RETURN jsonb_build_object(
        'action', 'error',
        'status', 500,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object('error', 'provider_company_id_missing')
      );
    END IF;

    IF v_provider_account_require_company_id THEN
      v_path_company_id := NULLIF(COALESCE(v_path_params->>'companyId', v_path_params->>'company_id', ''), '');
      IF v_path_company_id IS NOT NULL AND v_path_company_id <> v_provider_account_company_id THEN
        PERFORM public.log_decision(
          p_organization_id := v_org,
          p_decision_category := 'settings_resolution',
          p_resource_type := 'api_gateway_request',
          p_resource_id := v_request_id,
          p_decision_point := 'api_gateway_provider_account_company_id_checked',
          p_decision_outcome := 'mismatch',
          p_performed_by_system := 'api_gateway',
          p_correlation_id := v_corr,
          p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'provider_id', v_provider_id,
            'route_id', v_route_id,
            'route_name', v_route_row.route_name,
            'category', v_provider_account_category,
            'expected_company_id', v_provider_account_company_id,
            'path_company_id', v_path_company_id
          )),
          p_decision_reason := 'Inbound path companyId does not match ladder-resolved provider_account.company_id; refusing to dispatch upstream.',
          p_settings_resolution_id := v_provider_account_settings_resolution_id
        );

        RETURN jsonb_build_object(
          'action', 'error',
          'status', 400,
          'headers', jsonb_build_object('content-type', 'application/json'),
          'body', jsonb_build_object('error', 'provider_company_id_mismatch')
        );
      END IF;
    END IF;

    -- Auth config selection safety:
    -- - If a specific auth_config_id is configured for this scope, use it.
    -- - Otherwise only allow fallback when there is exactly ONE provider_auth_configs row for provider+auth_type.
    IF v_auth_mode IS NOT NULL THEN
      IF v_provider_account_auth_config_id IS NOT NULL THEN
        v_auth := jsonb_set(v_auth, '{auth_config_id}', to_jsonb(v_provider_account_auth_config_id), TRUE);
      ELSIF v_provider_account_require_auth_config_id THEN
        SELECT count(*) INTO v_auth_config_count
        FROM public.provider_auth_configs
        WHERE provider_id = v_provider_id
          AND auth_type = v_auth_type;

        v_auth_config_count := COALESCE(v_auth_config_count, 0);
        IF v_auth_config_count = 0 THEN
          RETURN jsonb_build_object(
            'action', 'error',
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'provider_auth_config_missing')
          );
        ELSIF v_auth_config_count > 1 THEN
          RETURN jsonb_build_object(
            'action', 'error',
            'status', 500,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'provider_auth_config_ambiguous')
          );
        END IF;
      END IF;
    END IF;

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request_id,
      p_decision_point := 'api_gateway_provider_account_resolved',
      p_decision_outcome := 'resolved',
      p_performed_by_system := 'api_gateway',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'provider_id', v_provider_id,
        'route_id', v_route_id,
        'route_name', v_route_row.route_name,
        'category', v_provider_account_category,
        'company_id', v_provider_account_company_id,
        'auth_config_id', v_provider_account_auth_config_id
      )),
      p_decision_reason := 'Provider account settings resolved via ladder.',
      p_settings_resolution_id := v_provider_account_settings_resolution_id
    );
  END IF;

  -- Optional workflow mode branch (route.policy.workflow.enabled):
  -- (moved below, after outbound URL/headers computation, so the workflow gets the same precomputed upstream spec)

  -- Outbound headers:
  -- - Strip internal/gateway auth headers (defense-in-depth).
  -- - Apply row-driven defaults/overrides rendered via render_template().
  v_outbound_headers := public.prepare_ingress_provider_headers_v1(
    COALESCE(v_headers, '{}'::jsonb),
    v_policy
  )
    - 'authorization'
    - 'proxy-authorization'
    - 'x-webhook-token'
    - 'x-internal-edge-token';

  v_header_render_context := jsonb_build_object(
    'path_params', COALESCE(v_path_params, '{}'::jsonb),
    'headers', COALESCE(v_safe_headers, '{}'::jsonb),
    'body', COALESCE(v_safe_body, '{}'::jsonb),
    'source', jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'source_id', v_source.id
    )),
    'provider', jsonb_strip_nulls(jsonb_build_object(
      'id', v_provider_id
    )),
    'provider_account', COALESCE(v_provider_account, '{}'::jsonb)
  );

  -- Defaults: set only when missing.
  v_header_defaults := COALESCE(v_policy #> '{headers,defaults}', '{}'::jsonb);
  IF jsonb_typeof(v_header_defaults) = 'object' THEN
    v_header_defaults := public.render_template(v_header_defaults, v_header_render_context);
    IF jsonb_typeof(v_header_defaults) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_defaults) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::text));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        IF (v_outbound_headers ? v_header_name) IS FALSE OR btrim(COALESCE(v_outbound_headers->>v_header_name, '')) = '' THEN
          v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Overrides: always set (when non-empty).
  v_header_overrides := COALESCE(v_policy #> '{headers,overrides}', '{}'::jsonb);
  IF jsonb_typeof(v_header_overrides) = 'object' THEN
    v_header_overrides := public.render_template(v_header_overrides, v_header_render_context);
    IF jsonb_typeof(v_header_overrides) = 'object' THEN
      FOR v_header_entry IN SELECT key, value FROM jsonb_each(v_header_overrides) LOOP
        v_header_name := lower(btrim(v_header_entry.key));
        IF v_header_name IS NULL OR v_header_name = '' THEN
          CONTINUE;
        END IF;

        IF v_header_name IN ('authorization', 'proxy-authorization', 'x-webhook-token', 'x-internal-edge-token') THEN
          CONTINUE;
        END IF;

        v_header_value := btrim(trim(both '"' FROM v_header_entry.value::text));
        IF v_header_value IS NULL OR v_header_value = '' THEN
          CONTINUE;
        END IF;

        v_outbound_headers := jsonb_set(v_outbound_headers, ARRAY[v_header_name], to_jsonb(v_header_value), TRUE);
      END LOOP;
    END IF;
  END IF;

  -- Optional workflow mode branch (route.policy.workflow.enabled):
  v_workflow := COALESCE(v_policy->'workflow', '{}'::jsonb);
  BEGIN
    v_workflow_enabled := COALESCE((v_workflow->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_workflow_enabled := FALSE;
  END;

  v_workflow_template_name := NULLIF(v_workflow->>'template_name', '');

  IF v_workflow_enabled THEN
    IF v_workflow_template_name IS NULL THEN
      RAISE EXCEPTION 'api_gateway workflow enabled but template_name missing for route %', v_route_id;
    END IF;

    SELECT id
    INTO v_workflow_template_id
    FROM public.workflow_templates
    WHERE name = v_workflow_template_name
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_workflow_template_id IS NULL THEN
      RAISE EXCEPTION 'api_gateway workflow template not found for name=% (route %)', v_workflow_template_name, v_route_id;
    END IF;

    v_workflow_context := jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender,
        'source_id', v_source.id,
        'correlation_id', v_corr,
        'api_gateway', jsonb_strip_nulls(jsonb_build_object(
          'api_gateway_request_id', v_request_id,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'path_params', v_path_params,
          'method', v_method,
          'path', v_path,
          'query_string', NULLIF(v_query_projection, ''),
          'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1(v_policy),
      'request_headers', COALESCE(v_safe_headers, '{}'::jsonb),
          'request_body', COALESCE(v_safe_body, '{}'::jsonb),
          'provider_id', v_provider_id,
          'upstream_method', v_upstream_method,
          'upstream_url', v_url_projection,
          'outbound_headers', COALESCE(v_outbound_headers, '{}'::jsonb),
          'priority', COALESCE(NULLIF(v_policy->>'priority', '')::INT, 100),
          'max_retries', COALESCE(NULLIF(v_policy->>'max_retries', '')::INT, 3),
          'provider_account', COALESCE(v_provider_account, '{}'::jsonb),
          'provider_account_category', v_provider_account_category,
          'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
          'auth', v_auth
        ))
      )
    );

    v_workflow_run_id := start_workflow_run(v_workflow_template_id, v_workflow_context);

    UPDATE public.api_gateway_requests
    SET workflow_run_id = v_workflow_run_id,
        updated_at = v_now
    WHERE id = v_request_id;

    PERFORM public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'api_gateway_request',
      p_resource_id := v_request_id,
      p_decision_point := 'api_gateway_workflow_enqueued',
      p_decision_outcome := 'enqueued',
      p_performed_by_system := 'api_gateway',
      p_correlation_id := v_corr,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'method', v_method,
        'path', v_path,
        'route_id', v_route_id,
        'route_name', v_route_row.route_name,
        'workflow_template_id', v_workflow_template_id,
        'workflow_template_name', v_workflow_template_name,
        'workflow_run_id', v_workflow_run_id
      )),
      p_decision_reason := 'API gateway route resolved and workflow started (workflow mode).',
      p_settings_resolution_id := v_settings_resolution_id
    );

    RETURN jsonb_strip_nulls(jsonb_build_object(
      'action', 'accepted_async',
      'status', COALESCE(NULLIF(v_delivery->>'status_code', '')::INT, 202),
      'headers', COALESCE(v_delivery->'headers', jsonb_build_object('content-type', 'application/json')),
      'body', COALESCE(
        v_delivery->'body',
        jsonb_build_object(
          'status', 'accepted_async',
          'correlation_id', v_corr,
          'workflow_run_id', v_workflow_run_id,
          'api_gateway_request_id', v_request_id
        )
      ),
      'api_gateway_request_id', v_request_id,
      'workflow_run_id', v_workflow_run_id,
      'correlation_id', v_corr
    ));
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    max_retries,
    scheduled_at,
    correlation_id,
    context,
    created_at
  ) VALUES (
    'provider_api',
    'provider',
    v_provider_id,
    v_upstream_method,
    v_url,
    COALESCE(v_outbound_headers, '{}'::jsonb),
    COALESCE(v_safe_body, '{}'::jsonb),
    'pending_edge',
    COALESCE(NULLIF(v_policy->>'priority', '')::INT, 100),
    COALESCE(NULLIF(v_policy->>'max_retries', '')::INT, 3),
    v_now,
    v_corr,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'source_id', v_source.id,
      'api_gateway_request_id', v_request_id,
      'api_gateway_route_id', v_route_id,
      'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1(v_policy),
      'api_gateway_route_name', v_route_row.route_name,
      'api_gateway_path_params', v_path_params,
      'provider_account_category', v_provider_account_category,
      'provider_account_settings_resolution_id', v_provider_account_settings_resolution_id,
      'auth', v_auth
    )),
    v_now
  )
  RETURNING id INTO v_outbound_id;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_outbound_id,
      updated_at = v_now
  WHERE id = v_request_id;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'settings_resolution',
    p_resource_type := 'api_gateway_request',
    p_resource_id := v_request_id,
    p_decision_point := 'api_gateway_route_resolved',
    p_decision_outcome := 'resolved',
    p_performed_by_system := 'api_gateway',
    p_correlation_id := v_corr,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'method', v_method,
      'path', v_path,
      'route_id', v_route_id,
      'route_name', v_route_row.route_name,
      'provider_id', v_provider_id,
      'outbound_call_id', v_outbound_id
    )),
    p_decision_reason := 'API gateway route resolved and outbound call enqueued.',
    p_settings_resolution_id := v_settings_resolution_id
  );

  IF v_delivery_mode = 'accepted_async' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'action', 'accepted_async',
      'status', COALESCE(NULLIF(v_delivery->>'status_code', '')::INT, 202),
      'headers', COALESCE(v_delivery->'headers', jsonb_build_object('content-type', 'application/json')),
      'body', COALESCE(v_delivery->'body', jsonb_build_object('status', 'accepted_async', 'correlation_id', v_corr)),
      'api_gateway_request_id', v_request_id,
      'outbound_call_id', v_outbound_id,
      'correlation_id', v_corr
    ));
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'action', 'proxy',
    'status', 200,
    'api_gateway_request_id', v_request_id,
    'outbound_call_id', v_outbound_id,
    'timeout_seconds', v_timeout_seconds,
    'correlation_id', v_corr
  ));
END;
$$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_base_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'API gateway base intake with raw query text limited to transient URL construction and the outbound BEFORE trigger, which stores the executable URL in Vault while committing only redacted durable projections.';

-------------------------------------------------------------------------------
-- Enforce only ingress-owned persistence boundaries
-------------------------------------------------------------------------------

COMMENT ON COLUMN public.api_gateway_requests.persistence_policy_snapshot
  IS 'Exact value-free protected-header name snapshot captured when the gateway request was written; NULL on legacy history forces conservative full header redaction.';

DO $registry_install$
DECLARE
  v_registry JSONB := public.ingress_durable_surface_registry_v1();
  v_target RECORD;
  v_args TEXT;
  v_missing TEXT;
BEGIN
  IF jsonb_typeof(v_registry) <> 'array' OR jsonb_array_length(v_registry) <> 24 THEN
    RAISE EXCEPTION 'ingress durable-surface registry must contain exactly 24 v2 surfaces';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_registry) item
    WHERE item ->> 'version' <> '2'
       OR item <> jsonb_build_object(
         'surface_id', item -> 'surface_id', 'schema', item -> 'schema',
         'table', item -> 'table', 'column', item -> 'column',
         'nested_path', item -> 'nested_path', 'representation', item -> 'representation',
         'classification', item -> 'classification', 'sanitizer', item -> 'sanitizer',
         'policy_source', item -> 'policy_source', 'writer', item -> 'writer',
         'backfill', item -> 'backfill', 'malformed_semantics', item -> 'malformed_semantics',
         'null_semantics', item -> 'null_semantics', 'mode', item -> 'mode',
         'version', item -> 'version'
       )
       OR jsonb_typeof(item -> 'nested_path') <> 'array'
       OR COALESCE(item ->> 'surface_id', '') = ''
  ) THEN
    RAISE EXCEPTION 'ingress durable-surface registry entry is malformed or open-ended';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_registry) item
    GROUP BY item ->> 'surface_id' HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'ingress durable-surface registry surface_id values must be unique';
  END IF;

  SELECT string_agg(format('%I.%I.%I', item ->> 'schema', item ->> 'table', item ->> 'column'), ', ')
    INTO v_missing
    FROM jsonb_array_elements(v_registry) item
    LEFT JOIN information_schema.columns columns
      ON columns.table_schema = item ->> 'schema'
     AND columns.table_name = item ->> 'table'
     AND columns.column_name = item ->> 'column'
   WHERE columns.column_name IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'registered ingress durable columns are missing: %', v_missing;
  END IF;

  -- Independent physical-column discovery fails if a new ingress-owned header,
  -- query, context, decision, or audit path exists without a registry entry.
  SELECT string_agg(format('%I.%I.%I', columns.table_schema, columns.table_name, columns.column_name), ', ')
    INTO v_missing
    FROM information_schema.columns columns
   WHERE columns.table_schema = 'public'
     AND columns.table_name IN (
       'api_gateway_requests', 'webhook_inbox', 'workflow_runs',
       'outbound_calls', 'decision_log', 'audit_table_changes'
     )
     AND CASE columns.table_name
       WHEN 'api_gateway_requests' THEN
         columns.column_name = 'persistence_policy_snapshot'
         OR columns.column_name ~ '(^|_)(headers?|query|url|path)($|_)'
       WHEN 'webhook_inbox' THEN
         columns.column_name IN ('headers', 'ack_headers', 'ack_body', 'ack_validation')
         OR columns.column_name ~ '^(request_)?(headers?|query|url|path)($|_)'
       WHEN 'workflow_runs' THEN columns.column_name = 'context'
        WHEN 'outbound_calls' THEN
          columns.column_name IN ('url', 'headers', 'response_headers', 'context')
         OR columns.column_name ~ '^request_.*(headers?|query|url|path)'
       WHEN 'decision_log' THEN columns.column_name = 'decision_inputs'
       WHEN 'audit_table_changes' THEN columns.column_name IN ('row_old', 'row_new', 'request_context')
       ELSE FALSE
     END
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_registry) item
       WHERE item ->> 'schema' = columns.table_schema
         AND item ->> 'table' = columns.table_name
         AND item ->> 'column' = columns.column_name
     );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'unregistered ingress durable columns discovered: %', v_missing;
  END IF;

  FOR v_target IN
    SELECT item ->> 'schema' AS schema_name, item ->> 'table' AS table_name
    FROM jsonb_array_elements(v_registry) item
    GROUP BY item ->> 'schema', item ->> 'table'
    ORDER BY item ->> 'schema', item ->> 'table'
  LOOP
    SELECT string_agg(format('%L, %L', column_name, mode), ', ' ORDER BY first_ordinality)
      INTO v_args
      FROM (
        SELECT item ->> 'column' AS column_name,
               item ->> 'mode' AS mode,
               min(ordinality) AS first_ordinality
        FROM jsonb_array_elements(v_registry) WITH ORDINALITY entries(item, ordinality)
        WHERE item ->> 'schema' = v_target.schema_name
          AND item ->> 'table' = v_target.table_name
        GROUP BY item ->> 'column', item ->> 'mode'
      ) physical_modes;
    EXECUTE format('DROP TRIGGER IF EXISTS a00_ingress_persistence_redaction ON %I.%I', v_target.schema_name, v_target.table_name);
    EXECUTE format(
      'CREATE TRIGGER a00_ingress_persistence_redaction BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(%s)',
      v_target.schema_name,
      v_target.table_name,
      v_args
    );
  END LOOP;
END;
$registry_install$;

-------------------------------------------------------------------------------
-- Bounded online history repair (repeat until has_more=false)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.backfill_ingress_persisted_redaction_v1(
  p_batch_size INT DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_batch_size, 500), 1), 2000);
  v_gateway_count INT := 0;
  v_webhook_count INT := 0;
  v_workflow_count INT := 0;
  v_outbound_count INT := 0;
  v_decision_count INT := 0;
  v_audit_count INT := 0;
  v_has_more BOOLEAN := FALSE;
  v_registry JSONB := public.ingress_durable_surface_registry_v1();
  v_unrecoverable_count BIGINT := 0;
  v_unrecoverable_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF jsonb_array_length(v_registry) <> 24
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_registry) item
      WHERE COALESCE(item ->> 'backfill', '') = ''
    )
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT item ->> 'schema' AS schema_name, item ->> 'table' AS table_name
        FROM jsonb_array_elements(v_registry) item
      ) registered
      LEFT JOIN pg_namespace namespace ON namespace.nspname = registered.schema_name
      LEFT JOIN pg_class target
        ON target.relname = registered.table_name
       AND target.relnamespace = namespace.oid
      LEFT JOIN pg_trigger trigger
        ON trigger.tgrelid = target.oid
       AND trigger.tgname = 'a00_ingress_persistence_redaction'
       AND NOT trigger.tgisinternal
      WHERE trigger.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'ingress durable-surface registry/backfill trigger contract is incomplete';
  END IF;

  SELECT count(*)
    INTO v_unrecoverable_count
    FROM public.outbound_calls
   WHERE jsonb_typeof(context) = 'object'
     AND COALESCE(context ->> 'api_gateway_request_id', '') <> ''
     AND status NOT IN ('completed', 'skipped', 'permanently_failed', 'cancelled')
     AND execution_url_vault_id IS NULL
     AND url ~ '(^|[?&])[^=&#]+=[^&#]*REDACTED|/api-gateway/(t/)?REDACTED';

  IF v_unrecoverable_count > 0 THEN
    SELECT array_agg(id ORDER BY id)
      INTO v_unrecoverable_ids
      FROM (
        SELECT id
          FROM public.outbound_calls
         WHERE jsonb_typeof(context) = 'object'
           AND COALESCE(context ->> 'api_gateway_request_id', '') <> ''
           AND status NOT IN ('completed', 'skipped', 'permanently_failed', 'cancelled')
           AND execution_url_vault_id IS NULL
           AND url ~ '(^|[?&])[^=&#]+=[^&#]*REDACTED|/api-gateway/(t/)?REDACTED'
         ORDER BY id
         LIMIT 10
      ) offenders;
    RAISE EXCEPTION
      'active ingress outbound calls contain unrecoverable redacted execution URLs without Vault references (count %, sample ids %)',
      v_unrecoverable_count,
      v_unrecoverable_ids;
  END IF;

  WITH candidates AS (
    SELECT id
    FROM public.api_gateway_requests target
    WHERE target.request_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
            target.request_headers,
            target.persistence_policy_snapshot,
            'persisted',
            TRUE
          )
       OR target.query_string IS DISTINCT FROM public.redact_sensitive_query_string_v1(
         target.query_string,
         target.persistence_policy_snapshot,
         TRUE
       )
       OR target.path IS DISTINCT FROM public.redact_sensitive_url(
         target.path,
         target.persistence_policy_snapshot,
         TRUE
       )
    ORDER BY created_at, id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.api_gateway_requests target
    SET request_headers = public.rebuild_ingress_headers_v1(
          target.request_headers,
          target.persistence_policy_snapshot,
          'persisted',
          TRUE
        ),
        query_string = public.redact_sensitive_query_string_v1(
          target.query_string,
          target.persistence_policy_snapshot,
          TRUE
        ),
        path = public.redact_sensitive_url(
          target.path,
          target.persistence_policy_snapshot,
          TRUE
        )
    FROM candidates
    WHERE target.id = candidates.id
    RETURNING 1
  )
  SELECT count(*) INTO v_gateway_count FROM changed;

  WITH candidates AS (
    SELECT target.id,
           public.resolve_webhook_persisted_headers_v1(
             target.headers,
             target.webhook_source_id,
             target.policy_settings_id,
             TRUE
           ) AS sanitized_headers
    FROM public.webhook_inbox target
    WHERE (
      target.headers IS NOT NULL
      AND target.headers IS DISTINCT FROM public.resolve_webhook_persisted_headers_v1(
        target.headers,
        target.webhook_source_id,
        target.policy_settings_id,
        TRUE
      )
    )
      OR (
        target.ack_headers IS NOT NULL
        AND target.ack_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
          target.ack_headers,
          public.ingress_header_policy_snapshot_v1('{}'::jsonb),
          'persisted',
          TRUE
        )
      )
      OR target.ack_body IS DISTINCT FROM public.redact_ingress_persisted_json_v1(target.ack_body)
      OR target.ack_validation IS DISTINCT FROM public.redact_ingress_persisted_json_v1(target.ack_validation)
    ORDER BY target.created_at, target.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.webhook_inbox target
    SET headers = CASE
          WHEN target.headers IS NULL THEN NULL
          ELSE candidates.sanitized_headers
        END,
        ack_headers = CASE
          WHEN target.ack_headers IS NULL THEN NULL
          ELSE public.rebuild_ingress_headers_v1(
            target.ack_headers,
            public.ingress_header_policy_snapshot_v1('{}'::jsonb),
            'persisted',
            TRUE
          )
        END,
        ack_body = public.redact_ingress_persisted_json_v1(target.ack_body),
        ack_validation = public.redact_ingress_persisted_json_v1(target.ack_validation)
    FROM candidates
    WHERE target.id = candidates.id
    RETURNING 1
  )
  SELECT count(*) INTO v_webhook_count FROM changed;

  WITH candidates AS (
    SELECT id
    FROM public.workflow_runs
    WHERE jsonb_typeof(context) = 'object'
      AND (
        context ? 'webhook_id'
        OR jsonb_typeof(context->'api_gateway') = 'object'
      )
      AND (
        context IS DISTINCT FROM public.sanitize_ingress_workflow_context_v1(context)
      )
    ORDER BY created_at, id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.workflow_runs target
    SET context = public.sanitize_ingress_workflow_context_v1(target.context)
    FROM candidates
    WHERE target.id = candidates.id
    RETURNING 1
  )
  SELECT count(*) INTO v_workflow_count FROM changed;

  WITH candidates AS (
    SELECT id
    FROM public.outbound_calls
    WHERE jsonb_typeof(context) = 'object'
      AND COALESCE(context ->> 'api_gateway_request_id', '') <> ''
      AND (
        url IS DISTINCT FROM public.redact_sensitive_url(
          url,
          NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
          TRUE
        )
        OR headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
          headers,
          NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
          'outbound',
          TRUE
        )
        OR response_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
          response_headers,
          NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
          'persisted',
          TRUE
        )
        OR context IS DISTINCT FROM public.redact_ingress_persisted_json_v1(context)
      )
    ORDER BY created_at, id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.outbound_calls target
    SET url = target.url,
        headers = public.rebuild_ingress_headers_v1(
          target.headers,
          NULLIF(target.context -> 'persistence_policy_snapshot', 'null'::jsonb),
          'outbound',
          TRUE
        ),
        response_headers = public.rebuild_ingress_headers_v1(
          target.response_headers,
          NULLIF(target.context -> 'persistence_policy_snapshot', 'null'::jsonb),
          'persisted',
          TRUE
        ),
        context = public.redact_ingress_persisted_json_v1(target.context)
    FROM candidates
    WHERE target.id = candidates.id
    RETURNING 1
  )
  SELECT count(*) INTO v_outbound_count FROM changed;

  WITH candidates AS (
    SELECT id, organization_id, timestamp
    FROM public.decision_log
    WHERE (
      resource_type IN ('webhook_inbox', 'api_gateway_request')
      OR performed_by_system IN ('workflow_intake_webhook', 'api_gateway')
    )
      AND decision_inputs IS DISTINCT FROM public.redact_ingress_persisted_json_v1(decision_inputs)
    ORDER BY timestamp, id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.decision_log target
    SET decision_inputs = public.redact_ingress_persisted_json_v1(target.decision_inputs)
    FROM candidates
    WHERE target.id = candidates.id
      AND target.organization_id = candidates.organization_id
      AND target.timestamp = candidates.timestamp
    RETURNING 1
  )
  SELECT count(*) INTO v_decision_count FROM changed;

  WITH candidates AS (
    SELECT id, organization_id, created_at
    FROM public.audit_table_changes
    WHERE schema_name = 'public'
      AND (
        table_name IN ('api_gateway_requests', 'webhook_inbox')
        OR (
          table_name = 'workflow_runs'
          AND (
            (row_old->'context') ? 'webhook_id'
            OR jsonb_typeof(row_old #> '{context,api_gateway}') = 'object'
            OR (row_new->'context') ? 'webhook_id'
            OR jsonb_typeof(row_new #> '{context,api_gateway}') = 'object'
          )
        )
        OR (
          table_name = 'decision_log'
          AND (
            COALESCE(row_old->>'resource_type', '') IN ('webhook_inbox', 'api_gateway_request')
            OR COALESCE(row_new->>'resource_type', '') IN ('webhook_inbox', 'api_gateway_request')
            OR COALESCE(row_old->>'performed_by_system', '') IN ('workflow_intake_webhook', 'api_gateway')
            OR COALESCE(row_new->>'performed_by_system', '') IN ('workflow_intake_webhook', 'api_gateway')
          )
        )
        OR (
          table_name = 'outbound_calls'
          AND COALESCE(
            row_old #>> '{context,api_gateway_request_id}',
            row_new #>> '{context,api_gateway_request_id}',
            ''
          ) <> ''
        )
      )
      AND (
        row_old IS DISTINCT FROM public.redact_ingress_audit_row_v1(table_name, row_old)
        OR row_new IS DISTINCT FROM public.redact_ingress_audit_row_v1(table_name, row_new)
        OR request_context IS DISTINCT FROM public.redact_ingress_persisted_json_v1(request_context)
      )
    ORDER BY created_at, id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.audit_table_changes target
    SET row_old = public.redact_ingress_audit_row_v1(target.table_name, target.row_old),
        row_new = public.redact_ingress_audit_row_v1(target.table_name, target.row_new),
        request_context = public.redact_ingress_persisted_json_v1(target.request_context)
    FROM candidates
    WHERE target.id = candidates.id
      AND target.organization_id IS NOT DISTINCT FROM candidates.organization_id
      AND target.created_at = candidates.created_at
    RETURNING 1
  )
  SELECT count(*) INTO v_audit_count FROM changed;

  -- This authoritative backlog probe intentionally does not use SKIP LOCKED.
  -- MVCC can still observe qualifying locked rows, so completion cannot be
  -- reported while another worker temporarily owns an eligible row.
  SELECT
    EXISTS (
      SELECT 1
      FROM public.api_gateway_requests target
      WHERE target.request_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
              target.request_headers,
              target.persistence_policy_snapshot,
              'persisted',
              TRUE
            )
         OR target.query_string IS DISTINCT FROM public.redact_sensitive_query_string_v1(
           target.query_string,
           target.persistence_policy_snapshot,
           TRUE
         )
         OR target.path IS DISTINCT FROM public.redact_sensitive_url(
           target.path,
           target.persistence_policy_snapshot,
           TRUE
         )
    )
    OR EXISTS (
      SELECT 1
      FROM public.webhook_inbox target
      WHERE (
        target.headers IS NOT NULL
        AND target.headers IS DISTINCT FROM public.resolve_webhook_persisted_headers_v1(
          target.headers,
          target.webhook_source_id,
          target.policy_settings_id,
          TRUE
        )
      )
        OR (
          target.ack_headers IS NOT NULL
          AND target.ack_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
            target.ack_headers,
            public.ingress_header_policy_snapshot_v1('{}'::jsonb),
            'persisted',
            TRUE
          )
        )
        OR target.ack_body IS DISTINCT FROM public.redact_ingress_persisted_json_v1(target.ack_body)
        OR target.ack_validation IS DISTINCT FROM public.redact_ingress_persisted_json_v1(target.ack_validation)
    )
    OR EXISTS (
      SELECT 1
      FROM public.workflow_runs
      WHERE jsonb_typeof(context) = 'object'
        AND (
          context ? 'webhook_id'
          OR jsonb_typeof(context->'api_gateway') = 'object'
        )
        AND context IS DISTINCT FROM public.sanitize_ingress_workflow_context_v1(context)
    )
    OR EXISTS (
      SELECT 1
      FROM public.outbound_calls
      WHERE jsonb_typeof(context) = 'object'
        AND COALESCE(context ->> 'api_gateway_request_id', '') <> ''
        AND (
          url IS DISTINCT FROM public.redact_sensitive_url(
            url,
            NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
            TRUE
          )
          OR headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
            headers,
            NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
            'outbound',
            TRUE
          )
          OR response_headers IS DISTINCT FROM public.rebuild_ingress_headers_v1(
            response_headers,
            NULLIF(context -> 'persistence_policy_snapshot', 'null'::jsonb),
            'persisted',
            TRUE
          )
          OR context IS DISTINCT FROM public.redact_ingress_persisted_json_v1(context)
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.decision_log
      WHERE (
        resource_type IN ('webhook_inbox', 'api_gateway_request')
        OR performed_by_system IN ('workflow_intake_webhook', 'api_gateway')
      )
        AND decision_inputs IS DISTINCT FROM public.redact_ingress_persisted_json_v1(decision_inputs)
    )
    OR EXISTS (
      SELECT 1
      FROM public.audit_table_changes
      WHERE schema_name = 'public'
        AND (
          table_name IN ('api_gateway_requests', 'webhook_inbox')
          OR (
            table_name = 'workflow_runs'
            AND (
              (row_old->'context') ? 'webhook_id'
              OR jsonb_typeof(row_old #> '{context,api_gateway}') = 'object'
              OR (row_new->'context') ? 'webhook_id'
              OR jsonb_typeof(row_new #> '{context,api_gateway}') = 'object'
            )
          )
          OR (
            table_name = 'decision_log'
            AND (
              COALESCE(row_old->>'resource_type', '') IN ('webhook_inbox', 'api_gateway_request')
              OR COALESCE(row_new->>'resource_type', '') IN ('webhook_inbox', 'api_gateway_request')
              OR COALESCE(row_old->>'performed_by_system', '') IN ('workflow_intake_webhook', 'api_gateway')
              OR COALESCE(row_new->>'performed_by_system', '') IN ('workflow_intake_webhook', 'api_gateway')
            )
          )
          OR (
            table_name = 'outbound_calls'
            AND COALESCE(
              row_old #>> '{context,api_gateway_request_id}',
              row_new #>> '{context,api_gateway_request_id}',
              ''
            ) <> ''
          )
        )
        AND (
          row_old IS DISTINCT FROM public.redact_ingress_audit_row_v1(table_name, row_old)
          OR row_new IS DISTINCT FROM public.redact_ingress_audit_row_v1(table_name, row_new)
          OR request_context IS DISTINCT FROM public.redact_ingress_persisted_json_v1(request_context)
        )
    )
  INTO v_has_more;

  RETURN jsonb_build_object(
    'batch_size', v_limit,
    'updated', jsonb_build_object(
      'api_gateway_requests', v_gateway_count,
      'webhook_inbox', v_webhook_count,
      'workflow_runs', v_workflow_count,
      'outbound_calls', v_outbound_count,
      'decision_log', v_decision_count,
      'audit_table_changes', v_audit_count
    ),
    'has_more', v_has_more
  );
END;
$function$;

COMMENT ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT)
  IS 'Repair at most p_batch_size rows per ingress persistence table using SKIP LOCKED; repeat until has_more is false.';

REVOKE ALL ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) FROM anon;
REVOKE ALL ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) TO service_role;

-- One deliberately small deploy cohort; post-deploy maintenance repeats the same
-- idempotent function until its machine-readable has_more field is false.
SELECT public.backfill_ingress_persisted_redaction_v1(100);

COMMIT;
