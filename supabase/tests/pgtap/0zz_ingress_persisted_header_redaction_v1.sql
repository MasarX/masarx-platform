-- Test: canonical value-aware ingress persistence redaction

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

SELECT plan(147);

SELECT ok(
  (SELECT p.prosecdef AND ARRAY(
     SELECT cfg FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
   ) = ARRAY['search_path=public, extensions, pg_temp']::text[]
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.persist_ingress_execution_url_v1(uuid,text,uuid)')),
  'public.persist_ingress_execution_url_v1(uuid,text,uuid) retains SECURITY DEFINER with the exact safe search_path'
);

SELECT ok(
  (SELECT p.prosecdef AND ARRAY(
     SELECT cfg FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
   ) = ARRAY['search_path=public, extensions, pg_temp']::text[]
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_ingress_execution_url_v1(uuid)')),
  'public.resolve_ingress_execution_url_v1(uuid) retains SECURITY DEFINER with the exact safe search_path'
);

SELECT ok(
  (SELECT p.prosecdef AND ARRAY(
     SELECT cfg FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
   ) = ARRAY['search_path=public, extensions, pg_temp']::text[]
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.purge_obsolete_ingress_execution_url_v1()')),
  'public.purge_obsolete_ingress_execution_url_v1() retains SECURITY DEFINER with the exact safe search_path'
);

SELECT has_function('public', 'redact_sensitive_url', ARRAY['text', 'jsonb', 'boolean'], 'policy-aware redact_sensitive_url exists');
SELECT has_function('public', 'redact_sensitive_url', ARRAY['text'], 'one-argument redact_sensitive_url compatibility entrypoint exists');
SELECT has_function('public', 'resolve_protected_query_names_v1', ARRAY['jsonb'], 'canonical protected-query resolver exists');
SELECT has_function('public', 'redact_sensitive_query_string_v1', ARRAY['text', 'jsonb', 'boolean'], 'policy-aware standalone query-string sanitizer exists');
SELECT has_function('public', 'canonical_http_header_name_v1', ARRAY['text'], 'ASCII HTTP-token header canonicalizer exists');
SELECT has_function('public', 'resolve_ingress_protected_header_names_v1', ARRAY['jsonb'], 'row-driven protected-header resolver exists');
SELECT has_function('public', 'ingress_header_policy_snapshot_v1', ARRAY['jsonb'], 'value-free protected-header snapshot exists');
SELECT has_function('public', 'rebuild_ingress_headers_v1', ARRAY['jsonb', 'jsonb', 'text', 'boolean'], 'canonical case-insensitive header rebuild exists');
SELECT has_function('public', 'ingress_durable_surface_registry_v1', ARRAY[]::TEXT[], 'closed durable-surface registry exists');
SELECT has_function('public', 'redact_sensitive_headers', ARRAY['jsonb'], 'redact_sensitive_headers exists');
SELECT has_function('public', 'redact_ingress_header_container_v1', ARRAY['jsonb'], 'canonical malformed header-container sanitizer exists');
SELECT has_function('public', 'redact_ingress_forwarding_header_values_v1', ARRAY['jsonb'], 'forwarding-only value sanitizer exists');
SELECT has_function('public', 'prepare_ingress_provider_headers_v1', ARRAY['jsonb', 'jsonb'], 'policy-aware inbound provider-header preparation exists');
SELECT has_function('public', 'redact_api_gateway_persisted_headers_v1', ARRAY['jsonb', 'jsonb'], 'policy-aware API-gateway request projection exists');
SELECT has_function('public', 'resolve_api_gateway_persisted_headers_v1', ARRAY['jsonb', 'uuid'], 'API-route policy resolver exists');
SELECT has_function('public', 'sanitize_api_gateway_persisted_context_v1', ARRAY['jsonb'], 'API-gateway persisted context sanitizer exists');
SELECT has_function('public', 'redact_webhook_persisted_headers_v1', ARRAY['jsonb', 'jsonb'], 'policy-aware webhook projection exists');
SELECT has_function('public', 'resolve_webhook_persisted_headers_v1', ARRAY['jsonb', 'uuid', 'uuid'], 'stored webhook policy resolver exists');
SELECT has_function('public', 'redact_ingress_persisted_json_v1', ARRAY['jsonb'], 'recursive ingress sanitizer exists');
SELECT has_function('public', 'sanitize_ingress_workflow_context_v1', ARRAY['jsonb'], 'workflow context sanitizer exists');
SELECT has_function('public', 'redact_ingress_audit_row_v1', ARRAY['text', 'jsonb'], 'table-aware ingress audit sanitizer exists');
SELECT has_function('public', 'sanitize_ingress_persisted_projection_v1', ARRAY[]::TEXT[], 'persistence trigger function exists');
SELECT has_function('public', 'backfill_ingress_persisted_redaction_v1', ARRAY['integer'], 'bounded history repair function exists');
SELECT has_function('public', 'persist_ingress_execution_url_v1', ARRAY['uuid', 'text', 'uuid'], 'Vault-backed executable URL persistence function exists');
SELECT has_function('public', 'resolve_ingress_execution_url_v1', ARRAY['uuid'], 'dispatch-boundary executable URL resolver exists');
SELECT has_function('public', 'purge_obsolete_ingress_execution_url_v1', ARRAY[]::TEXT[], 'obsolete executable URL secret purge exists');
SELECT has_column('public', 'outbound_calls', 'execution_url_vault_id', 'outbound queue stores only a Vault reference for protected executable URLs');

SELECT is(
  public.redact_sensitive_url('/api-gateway/t/super-secret?safe=1'),
  '/api-gateway/t/REDACTED?safe=1',
  'modern gateway token path is redacted'
);

SELECT is(
  public.redact_sensitive_url('https://api.example.test/api-gateway/legacy-secret/jobs'),
  'https://api.example.test/api-gateway/REDACTED/jobs',
  'legacy gateway token path is redacted'
);

SELECT is(
  public.redact_sensitive_url('/api-gateway/t?safe=1'),
  '/api-gateway/t?safe=1',
  'reserved gateway route without a token is preserved'
);

SELECT is(
  public.redact_sensitive_url('/safe?ToKeN=secret&x=1#frag'),
  '/safe?ToKeN=REDACTED&x=1#frag',
  'mixed-case sensitive query value is redacted and fragment preserved'
);

SELECT is(
  public.redact_sensitive_url('/safe?api%5Fkey=secret&x=1'),
  '/safe?api%5Fkey=REDACTED&x=1',
  'encoded underscore in sensitive query key is normalized for matching'
);

SELECT is(
  public.redact_sensitive_url('/safe?%74oken=secret&to%6ben=second&x=1'),
  '/safe?%74oken=REDACTED&to%6ben=REDACTED&x=1',
  'generally percent-encoded sensitive query keys are decoded once for matching'
);

SELECT is(
  public.redact_sensitive_url('/safe?&&#fragment#tail'),
  '/safe?&&#fragment#tail',
  'safe empty query pairs and the complete fragment are preserved byte-for-byte'
);

SELECT is(
  public.redact_sensitive_url('/safe?not_token=visible&x=1'),
  '/safe?not_token=visible&x=1',
  'similarly named safe query key is preserved'
);

SELECT is(
  public.redact_sensitive_url('/safe?%ZZtoken=visible&%09token=also-visible&%2574oken=double-visible'),
  '/safe?%ZZtoken=REDACTED&%09token=REDACTED&%2574oken=REDACTED',
  'malformed, non-printable, and double-encoded query keys fail closed without over-decoding'
);

SELECT is(
  public.redact_sensitive_url('/safe?token&safe=value'),
  '/safe?token=REDACTED&safe=value',
  'a sensitive flag-style query key fails closed without corrupting safe pairs'
);

SELECT is(public.redact_sensitive_url(NULL), NULL::TEXT, 'NULL URL remains NULL');

SELECT is(
  public.redact_sensitive_url(public.redact_sensitive_url('/api-gateway/t/secret?signature=secret')),
  '/api-gateway/t/REDACTED?signature=REDACTED',
  'URL redaction is idempotent'
);

SELECT is(
  public.redact_sensitive_query_string_v1('ToKeN=secret&safe=visible'),
  'ToKeN=REDACTED&safe=visible',
  'standalone gateway query-string evidence is sanitized without requiring a URL prefix'
);

SELECT is(
  public.redact_sensitive_query_string_v1('?api%5Fkey=secret&safe=visible'),
  '?api%5Fkey=REDACTED&safe=visible',
  'standalone query-string sanitizer preserves an existing leading question mark'
);

SELECT is(
  public.redact_sensitive_query_string_v1(
    'ProviderKey=secret&providerkey=visible',
    '{"query":{"protected":[{"name":"ProviderKey"}]}}'::jsonb,
    FALSE
  ),
  'ProviderKey=REDACTED&providerkey=visible',
  'configured provider query names are exact and case-sensitive by default'
);

SELECT is(
  public.redact_sensitive_query_string_v1(
    'ProviderKey=secret&providerkey=second',
    '{"query":{"protected":[{"name":"ProviderKey","case_sensitive":false}]}}'::jsonb,
    FALSE
  ),
  'ProviderKey=REDACTED&providerkey=REDACTED',
  'providers may explicitly declare case-insensitive matching'
);

SELECT is(
  public.redact_sensitive_query_string_v1(
    'custom=first&safe=visible&custom=second',
    public.ingress_header_policy_snapshot_v1('{"query":{"protected":["custom"]}}'::jsonb),
    TRUE
  ),
  'custom=REDACTED&safe=visible&custom=REDACTED',
  'write-time query policy snapshots redact every duplicate without code changes'
);

SELECT is(
  public.redact_sensitive_query_string_v1('safe=visible&custom=secret', NULL, TRUE),
  'safe=REDACTED&custom=REDACTED',
  'history without an exact query-policy snapshot redacts the complete query projection'
);

SELECT throws_ok(
  $$SELECT public.resolve_protected_query_names_v1('{"snapshot_version":2,"protected_header_names":[],"protected_query_names":[]}'::jsonb)$$,
  'P0001',
  'invalid ingress protected-query snapshot',
  'shaped v2 snapshots without canonical provenance and digest are rejected'
);

SELECT throws_ok(
  $$
    WITH partial AS (
      SELECT (public.ingress_header_policy_snapshot_v1('{}'::jsonb) - 'snapshot_digest')
        || jsonb_build_object('protected_query_names', '[]'::jsonb) AS payload
    ), forged AS (
      SELECT payload || jsonb_build_object(
        'snapshot_digest', encode(extensions.digest(convert_to(payload::TEXT, 'UTF8'), 'sha256'), 'hex')
      ) AS snapshot
      FROM partial
    )
    SELECT public.resolve_protected_query_names_v1(snapshot) FROM forged
  $$,
  'P0001',
  'ingress protected-query snapshot omits mandatory protocol rules',
  'digest-valid snapshots cannot omit the mandatory protocol query baseline'
);

SELECT throws_ok(
  $$
    WITH partial AS (
      SELECT (public.ingress_header_policy_snapshot_v1('{}'::jsonb) - 'snapshot_digest')
        || jsonb_build_object('protected_header_names', '[]'::jsonb) AS payload
    ), forged AS (
      SELECT payload || jsonb_build_object(
        'snapshot_digest', encode(extensions.digest(convert_to(payload::TEXT, 'UTF8'), 'sha256'), 'hex')
      ) AS snapshot
      FROM partial
    )
    SELECT public.resolve_ingress_protected_header_names_v1(snapshot) FROM forged
  $$,
  'P0001',
  'ingress protected-header snapshot omits mandatory protocol names',
  'digest-valid snapshots cannot omit the mandatory protocol header baseline'
);

SELECT is(
  public.redact_sensitive_headers('{"authorization":"Bearer secret"}'::jsonb)->>'authorization',
  NULL::TEXT,
  'credential header is removed from durable evidence'
);

SELECT is(
  public.redact_sensitive_headers(jsonb_build_object(
    'x-forwarded-path', '/api-gateway/t/a',
    'x-forwarded-url', 'https://edge.test/api-gateway/b',
    'x-original-uri', '/safe?token=c',
    'x-rewrite-url', '/safe?auth_token=d',
    'x-envoy-original-path', '/safe?x-signature=e',
    'referer', 'https://edge.test/safe?password=f'
  )),
  jsonb_build_object(
    'x-forwarded-path', '/api-gateway/t/REDACTED',
    'x-forwarded-url', 'https://edge.test/api-gateway/REDACTED',
    'x-original-uri', '/safe?token=REDACTED',
    'x-rewrite-url', '/safe?auth_token=REDACTED',
    'x-envoy-original-path', '/safe?x-signature=REDACTED',
    'referer', 'https://edge.test/safe?password=REDACTED'
  ),
  'all six URL-bearing forwarding headers are sanitized'
);

SELECT is(
  public.redact_sensitive_headers('{"content-type":"application/json"}'::jsonb)->>'content-type',
  'application/json',
  'safe header is preserved'
);

SELECT is(
  public.redact_sensitive_headers('{"x-forwarded-url":{"token":"secret"}}'::jsonb)->>'x-forwarded-url',
  'REDACTED',
  'non-string URL-bearing header fails closed'
);

SELECT is(
  public.redact_ingress_persisted_json_v1('{"headers":"/api-gateway/t/malformed-secret"}'::jsonb)->>'headers',
  'REDACTED',
  'malformed non-object nested header container fails closed'
);

SELECT is(
  public.redact_ingress_header_container_v1('"historical-malformed-secret"'::jsonb),
  '"REDACTED"'::jsonb,
  'malformed historical request or ACK headers converge to the live REDACTED representation'
);

SELECT is(
  public.redact_ingress_header_container_v1(NULL),
  NULL::jsonb,
  'canonical malformed header-container sanitizer preserves SQL NULL'
);

SELECT is(
  public.redact_sensitive_headers(public.redact_sensitive_headers('{"referer":"/safe?secret=x"}'::jsonb)),
  '{"referer":"/safe?secret=REDACTED"}'::jsonb,
  'header redaction is idempotent'
);

SELECT is(
  public.redact_ingress_forwarding_header_values_v1(
    '{"x-api-key":"provider-policy-value","cookie":"provider-cookie","referer":"/api-gateway/t/inbound-secret"}'::jsonb
  ),
  '{"x-api-key":"provider-policy-value","cookie":"provider-cookie","referer":"/api-gateway/t/REDACTED"}'::jsonb,
  'forwarding-only sanitizer preserves executable provider credentials while redacting inbound URL values'
);

SELECT is(
  public.prepare_ingress_provider_headers_v1(
    '{"X-Api-Key":"caller-key","COOKIE":"caller-cookie","x-hub-signature-256":"caller-signature","referer":"/safe?token=caller","content-type":"application/json"}'::jsonb,
    '{}'::jsonb
  ),
  '{"referer":"/safe?token=REDACTED","content-type":"application/json"}'::jsonb,
  'provider-header preparation drops caller credentials case-insensitively and sanitizes forwarding URLs'
);

SELECT is(
  public.redact_api_gateway_persisted_headers_v1(
    '{"X-Partner-Secret":"caller-secret","x-caller-choice":"caller-value","content-type":"application/json"}'::jsonb,
    '{"auth":{"header":"x-partner-secret"},"headers":{"defaults":{"x-caller-choice":"provider-default"}}}'::jsonb
  ),
  '{"x-caller-choice":"caller-value","content-type":"application/json"}'::jsonb,
  'arbitrary policy auth.header is removed case-insensitively without stripping caller-overridable headers.defaults names'
);

SELECT is(public.canonical_http_header_name_v1(' X-Custom_Token '), 'x-custom_token', 'ASCII HTTP-token names canonicalize to lowercase');

SELECT throws_ok(
  $$SELECT public.canonical_http_header_name_v1('bad header')$$,
  'P0001',
  'invalid HTTP token header name',
  'malformed live header names are rejected'
);

SELECT ok(
  public.resolve_ingress_protected_header_names_v1(
    '{"auth":{"header":"X-Auth-Custom"},"headers":{"protected":["X-Protected"],"overrides":{"X-Override":"provider","x-default-only":"override"},"defaults":{"x-caller-choice":"default"}}}'::jsonb
  ) @> ARRAY['x-auth-custom','x-protected','x-override','x-default-only']::TEXT[]
  AND NOT ('x-caller-choice' = ANY(public.resolve_ingress_protected_header_names_v1(
    '{"headers":{"defaults":{"x-caller-choice":"default"}}}'::jsonb
  ))),
  'protected resolver includes auth/protected/override names but excludes ordinary defaults'
);

SELECT is(
  public.rebuild_ingress_headers_v1(
    '{"X-Auth-Custom":"caller-secret","X-Override":"caller-override","X-Caller-Choice":"caller","Safe":"yes"}'::jsonb,
    public.ingress_header_policy_snapshot_v1('{"auth":{"header":"x-auth-custom"},"headers":{"overrides":{"x-override":"provider"},"defaults":{"x-caller-choice":"default"}}}'::jsonb),
    'prepared',
    FALSE
  ),
  '{"safe":"yes","x-caller-choice":"caller"}'::jsonb,
  'prepared projection separates protected execution headers from caller-overridable defaults'
);

SELECT throws_ok(
  $$SELECT public.rebuild_ingress_headers_v1('{"X-Safe":"one","x-safe":"two"}'::jsonb, public.ingress_header_policy_snapshot_v1('{}'::jsonb), 'persisted', FALSE)$$,
  'P0001',
  'duplicate canonical HTTP header name x-safe',
  'live canonical case duplicates are rejected'
);

SELECT is(
  public.rebuild_ingress_headers_v1('{"X-Safe":"same","x-safe":"same"}'::jsonb, public.ingress_header_policy_snapshot_v1('{}'::jsonb), 'persisted', TRUE),
  '{"x-safe":"same"}'::jsonb,
  'historical identical canonical duplicates collapse deterministically'
);

SELECT is(
  public.rebuild_ingress_headers_v1('{"X-Safe":"one","x-safe":"two"}'::jsonb, public.ingress_header_policy_snapshot_v1('{}'::jsonb), 'persisted', TRUE),
  '"REDACTED"'::jsonb,
  'historical conflicting nonprotected canonical duplicates fail closed'
);

SELECT is(
  public.rebuild_ingress_headers_v1('{"safe":"unknown-policy"}'::jsonb, NULL, 'persisted', TRUE),
  '"REDACTED"'::jsonb,
  'historical API headers without an exact write-time policy snapshot are fully redacted'
);

SELECT is(public.rebuild_ingress_headers_v1('null'::jsonb, NULL, 'outbound', TRUE), '"REDACTED"'::jsonb, 'JSON null header containers use canonical REDACTED');
SELECT is(public.rebuild_ingress_headers_v1('42'::jsonb, NULL, 'outbound', TRUE), '"REDACTED"'::jsonb, 'scalar header containers use canonical REDACTED');

SELECT is(
  public.redact_sensitive_query_string_v1('safe=1&ToKeN=first&safe=2&to%6ben=second'),
  'safe=1&ToKeN=REDACTED&safe=2&to%6ben=REDACTED',
  'query duplicate order and original key spelling survive exactly one decode while sensitive values are redacted'
);

SELECT is(
  jsonb_array_length(public.ingress_durable_surface_registry_v1()),
  24,
  'closed durable-surface registry contains every declared header/query/policy projection'
);

SELECT is(
  public.sanitize_ingress_workflow_context_v1(
    '{"api_gateway":{"query_string":"token=persisted-secret&safe=visible","outbound_headers":{"x-api-key":"provider-key","cookie":"provider-cookie","referer":"/api-gateway/t/caller-secret"},"upstream_url":"https://provider.test/jobs?token=executable","payload":{"token":"business-value"},"metadata":{"signature":"business-metadata"}},"safe":"kept"}'::jsonb
  ),
  '{"api_gateway":{"query_string":"token=REDACTED&safe=REDACTED","outbound_headers":{"x-api-key":"provider-key","cookie":"provider-cookie","referer":"/api-gateway/t/REDACTED"},"upstream_url":"https://provider.test/jobs?token=REDACTED","payload":{"token":"business-value"},"metadata":{"signature":"business-metadata"}},"safe":"kept"}'::jsonb,
  'workflow sanitizer fully redacts historical URL/query projections while preserving executable credentials, payload, and metadata'
);

SELECT is(
  public.redact_ingress_persisted_json_v1(
    '{"request_headers":{"x-forwarded-url":"/api-gateway/t/nested"}}'::jsonb
  )->>'request_headers',
  'REDACTED',
  'recursive sanitizer fully redacts nested headers when exact policy is unavailable'
);

SELECT is(
  public.redact_ingress_persisted_json_v1(
    '[{"headers":{"referer":"/safe?credential=array-secret"}}]'::jsonb
  ) #>> '{0,headers}',
  'REDACTED',
  'recursive sanitizer conservatively handles header containers inside arrays'
);

SELECT is(
  public.redact_ingress_persisted_json_v1(
    '{"query_string":"token=audit-secret&safe=visible"}'::jsonb
  )->>'query_string',
  'token=REDACTED&safe=REDACTED',
  'recursive audit sanitizer recognizes standalone API-gateway query-string evidence'
);

SELECT is(
  public.redact_ingress_persisted_json_v1('"/api-gateway/ack-secret?signature=x"'::jsonb) #>> '{}',
  '/api-gateway/REDACTED?signature=REDACTED',
  'recursive sanitizer handles scalar URL strings'
);

SELECT is(
  public.redact_ingress_persisted_json_v1('{"status":"accepted","count":2}'::jsonb),
  '{"status":"accepted","count":2}'::jsonb,
  'recursive sanitizer preserves safe business values'
);

SELECT is(
  public.redact_ingress_persisted_json_v1(
    public.redact_ingress_persisted_json_v1('{"headers":{"x-original-uri":"/safe?hmac=x"}}'::jsonb)
  ),
  '{"headers":"REDACTED"}'::jsonb,
  'recursive sanitizer is idempotent'
);

SELECT has_trigger('public', 'api_gateway_requests', 'a00_ingress_persistence_redaction', 'gateway request sanitizer trigger exists');
SELECT has_trigger('public', 'webhook_inbox', 'a00_ingress_persistence_redaction', 'webhook inbox sanitizer trigger exists');
SELECT has_trigger('public', 'workflow_runs', 'a00_ingress_persistence_redaction', 'workflow runs sanitizer trigger exists');
SELECT has_trigger('public', 'outbound_calls', 'a00_ingress_persistence_redaction', 'scoped gateway outbound sanitizer trigger exists');
SELECT has_trigger('public', 'outbound_calls', 'z99_purge_obsolete_ingress_execution_url', 'outbound updates purge obsolete Vault execution secrets');
SELECT has_trigger('public', 'outbound_calls', 'z99_purge_deleted_ingress_execution_url', 'outbound deletion purges obsolete Vault execution secrets');
SELECT has_trigger('public', 'decision_log', 'a00_ingress_persistence_redaction', 'decision log sanitizer trigger exists');
SELECT has_trigger('public', 'audit_table_changes', 'a00_ingress_persistence_redaction', 'audit table sanitizer trigger exists');

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'a00_ingress_persistence_redaction'
      AND tgrelid = 'public.api_call_log'::regclass
  ),
  'API call log has no ingress sanitizer trigger'
);

SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.api_gateway_requests'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'persistence_policy_snapshot\\000gateway_policy_snapshot\\000request_headers\\000gateway_request_headers\\000query_string\\000query_string\\000path\\000text\\000', 'gateway request trigger snapshots policy before sanitizing durable header, query, and path evidence');
SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.webhook_inbox'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'headers\\000webhook_headers\\000ack_headers\\000headers\\000ack_body\\000json\\000ack_validation\\000json\\000', 'webhook trigger arguments are exact');
SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.workflow_runs'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'context\\000ingress_json\\000', 'workflow trigger arguments are exact');
SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.outbound_calls'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'execution_url_vault_id\\000gateway_execution_url_reference\\000url\\000gateway_outbound_url\\000headers\\000gateway_outbound_headers\\000response_headers\\000gateway_response_headers\\000context\\000gateway_outbound_context\\000', 'outbound trigger arguments cover the secure execution reference plus durable URL, request headers, response headers, and context');
SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.decision_log'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'decision_inputs\\000ingress_decision_json\\000', 'decision trigger arguments are exact');
SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger WHERE tgrelid = 'public.audit_table_changes'::regclass AND tgname = 'a00_ingress_persistence_redaction'), E'row_old\\000ingress_audit_json\\000row_new\\000ingress_audit_json\\000request_context\\000ingress_audit_json\\000', 'audit trigger arguments are exact');

CREATE TEMP TABLE pgtap_snapshot_api (
  route_id UUID,
  persistence_policy_snapshot JSONB,
  request_headers JSONB
);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_snapshot_api
  FOR EACH ROW EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'persistence_policy_snapshot', 'gateway_policy_snapshot',
    'request_headers', 'gateway_request_headers'
  );

CREATE TEMP TABLE pgtap_snapshot_workflow (context JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_snapshot_workflow
  FOR EACH ROW EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'context', 'ingress_json'
  );

CREATE TEMP TABLE pgtap_snapshot_outbound (
  id UUID,
  status TEXT,
  url TEXT,
  execution_url_vault_id UUID,
  headers JSONB,
  context JSONB
);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_snapshot_outbound
  FOR EACH ROW EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'execution_url_vault_id', 'gateway_execution_url_reference',
    'url', 'gateway_outbound_url',
    'headers', 'gateway_outbound_headers',
    'context', 'gateway_outbound_context'
  );

SET LOCAL session_replication_role = replica;
INSERT INTO pgtap_snapshot_api VALUES (
  '00000000-0000-0000-0000-000000009901',
  public.ingress_header_policy_snapshot_v1('{}'::jsonb),
  '{}'::jsonb
);
INSERT INTO pgtap_snapshot_workflow VALUES (
  jsonb_build_object('api_gateway', jsonb_build_object(
    'route_id', '00000000-0000-0000-0000-000000009901',
    'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
  ))
);
INSERT INTO pgtap_snapshot_outbound VALUES (
  '00000000-0000-0000-0000-000000009902', 'completed', 'https://provider.test/safe', NULL, '{}',
  jsonb_build_object(
    'api_gateway_request_id', '00000000-0000-0000-0000-000000009903',
    'api_gateway_route_id', '00000000-0000-0000-0000-000000009901',
    'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
  )
);
SET LOCAL session_replication_role = origin;

SELECT throws_ok(
  $$UPDATE pgtap_snapshot_api SET persistence_policy_snapshot = '{}'::jsonb$$,
  'api gateway persistence policy snapshot is immutable on route-preserving update',
  'API gateway UPDATE rejects direct snapshot mutation'
);
SELECT throws_ok(
  $$UPDATE pgtap_snapshot_workflow SET context = jsonb_set(context, '{api_gateway,persistence_policy_snapshot}', '{}'::jsonb, TRUE)$$,
  'workflow ingress persistence policy snapshot is immutable on route-preserving update',
  'workflow UPDATE rejects direct snapshot mutation'
);
SELECT throws_ok(
  $$UPDATE pgtap_snapshot_outbound SET context = jsonb_set(context, '{persistence_policy_snapshot}', '{}'::jsonb, TRUE)$$,
  'outbound ingress persistence policy snapshot is immutable on route-preserving update',
  'outbound UPDATE rejects direct snapshot mutation'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_trigger sanitizer
    JOIN pg_trigger audit
      ON audit.tgrelid = sanitizer.tgrelid
     AND audit.tgname = 'audit_row_change'
    WHERE sanitizer.tgname = 'a00_ingress_persistence_redaction'
      AND sanitizer.tgname >= audit.tgname
  ),
  'sanitizer trigger sorts before the audit trigger on every shared target'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = ANY(ARRAY[
      'public.redact_sensitive_url(text,jsonb,boolean)'::regprocedure,
      'public.resolve_protected_query_names_v1(jsonb)'::regprocedure,
      'public.redact_sensitive_query_string_v1(text,jsonb,boolean)'::regprocedure,
      'public.redact_sensitive_headers(jsonb)'::regprocedure,
      'public.redact_ingress_header_container_v1(jsonb)'::regprocedure,
      'public.redact_ingress_forwarding_header_values_v1(jsonb)'::regprocedure,
      'public.canonical_http_header_name_v1(text)'::regprocedure,
      'public.resolve_ingress_protected_header_names_v1(jsonb)'::regprocedure,
      'public.ingress_header_policy_snapshot_v1(jsonb)'::regprocedure,
      'public.rebuild_ingress_headers_v1(jsonb,jsonb,text,boolean)'::regprocedure,
      'public.ingress_durable_surface_registry_v1()'::regprocedure,
      'public.prepare_ingress_provider_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.redact_api_gateway_persisted_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.resolve_api_gateway_persisted_headers_v1(jsonb,uuid)'::regprocedure,
      'public.sanitize_api_gateway_persisted_context_v1(jsonb)'::regprocedure,
      'public.redact_webhook_persisted_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid)'::regprocedure,
      'public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid,boolean)'::regprocedure,
      'public.redact_ingress_persisted_json_v1(jsonb)'::regprocedure,
      'public.sanitize_ingress_workflow_context_v1(jsonb)'::regprocedure,
      'public.redact_ingress_audit_row_v1(text,jsonb)'::regprocedure,
      'public.sanitize_ingress_persisted_projection_v1()'::regprocedure,
      'public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure
    ]::OID[])
      AND NOT (COALESCE(proconfig, '{}'::TEXT[]) @> ARRAY['search_path=public, extensions, pg_temp']::TEXT[])
  ),
  'all sanitizer functions pin the expected search path'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = ANY(ARRAY[
      'public.redact_sensitive_url(text,jsonb,boolean)'::regprocedure,
      'public.resolve_protected_query_names_v1(jsonb)'::regprocedure,
      'public.redact_sensitive_query_string_v1(text,jsonb,boolean)'::regprocedure,
      'public.redact_sensitive_headers(jsonb)'::regprocedure,
      'public.redact_ingress_header_container_v1(jsonb)'::regprocedure,
      'public.redact_ingress_forwarding_header_values_v1(jsonb)'::regprocedure,
      'public.canonical_http_header_name_v1(text)'::regprocedure,
      'public.resolve_ingress_protected_header_names_v1(jsonb)'::regprocedure,
      'public.ingress_header_policy_snapshot_v1(jsonb)'::regprocedure,
      'public.rebuild_ingress_headers_v1(jsonb,jsonb,text,boolean)'::regprocedure,
      'public.ingress_durable_surface_registry_v1()'::regprocedure,
      'public.prepare_ingress_provider_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.redact_api_gateway_persisted_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.redact_webhook_persisted_headers_v1(jsonb,jsonb)'::regprocedure,
      'public.redact_ingress_persisted_json_v1(jsonb)'::regprocedure
    ]::OID[])
      AND (provolatile <> 'i' OR prosecdef)
  ),
  'pure sanitizers are immutable security invokers'
);

SELECT ok(
  obj_description('public.redact_sensitive_url(text,jsonb,boolean)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.resolve_protected_query_names_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_sensitive_query_string_v1(text,jsonb,boolean)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_sensitive_headers(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_ingress_header_container_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_ingress_forwarding_header_values_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.canonical_http_header_name_v1(text)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.resolve_ingress_protected_header_names_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.ingress_header_policy_snapshot_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.rebuild_ingress_headers_v1(jsonb,jsonb,text,boolean)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.ingress_durable_surface_registry_v1()'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.prepare_ingress_provider_headers_v1(jsonb,jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_api_gateway_persisted_headers_v1(jsonb,jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.resolve_api_gateway_persisted_headers_v1(jsonb,uuid)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.sanitize_api_gateway_persisted_context_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_webhook_persisted_headers_v1(jsonb,jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid,boolean)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_ingress_persisted_json_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.sanitize_ingress_workflow_context_v1(jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.redact_ingress_audit_row_v1(text,jsonb)'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.sanitize_ingress_persisted_projection_v1()'::regprocedure, 'pg_proc') IS NOT NULL
  AND obj_description('public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure, 'pg_proc') IS NOT NULL,
  'all sanitizer functions are documented'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.resolve_webhook_persisted_headers_v1(jsonb,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.resolve_api_gateway_persisted_headers_v1(jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.resolve_api_gateway_persisted_headers_v1(jsonb,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)', 'EXECUTE')
  AND has_function_privilege('edge_api_gateway_role', 'public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)', 'EXECUTE'),
  'policy resolver and dynamically replaced gateway intake retain their least-privilege ACL matrix'
);

SELECT ok(
  has_function_privilege('service_role', 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)', 'EXECUTE'),
  'dynamic webhook and gateway replacements remain executable by the trusted service role'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_proc function_row,
           LATERAL aclexplode(COALESCE(function_row.proacl, acldefault('f', function_row.proowner))) privilege
     WHERE function_row.oid = 'public.get_job_call_spec_without_ingress_vault_v1(uuid)'::regprocedure
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  )
  AND NOT has_function_privilege('anon', 'public.get_job_call_spec_without_ingress_vault_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.get_job_call_spec_without_ingress_vault_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.get_job_call_spec_without_ingress_vault_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('edge_api_caller_role', 'public.get_job_call_spec_without_ingress_vault_v1(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.get_job_call_spec(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('edge_api_caller_role', 'public.get_job_call_spec(uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.get_claimed_edge_job_call_spec_v1(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('edge_api_caller_role', 'public.get_claimed_edge_job_call_spec_v1(uuid,uuid)', 'EXECUTE'),
  'service and Edge can reach the dispatch wrapper only through the leased spec'
);

SELECT ok(
  has_function_privilege('anon', 'public.redact_sensitive_url(text,jsonb,boolean)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.redact_sensitive_headers(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.redact_ingress_persisted_json_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.backfill_ingress_persisted_redaction_v1(integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.backfill_ingress_persisted_redaction_v1(integer)', 'EXECUTE'),
  'existing pure-helper ACL compatibility is preserved for trigger callers'
);

SELECT ok(
  pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    LIKE '%v_idempotency_key := NULLIF(v_headers->>lower(%'
  AND pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    LIKE '%v_provided_signature TEXT := v_headers->>v_signature_header%'
  AND pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    NOT LIKE '%''headers'', v_headers,%'
  AND pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    LIKE '%''headers'', v_persisted_headers,%',
  'webhook core keeps raw validation and only renders or persists the sanitized projection'
);

SELECT ok(
  position('v_corr_text := NULLIF(v_headers->>''x-correlation-id''' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('prepare_ingress_provider_headers_v1' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('redact_api_gateway_persisted_headers_v1' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('v_query_projection := public.redact_sensitive_query_string_v1' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('v_url := v_url || ''?'' || v_query' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('v_url_projection := public.redact_sensitive_url' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('''upstream_url'', v_url_projection' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > 0
  AND position('''upstream_url'', v_url,' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) = 0
  AND position('v_header_overrides := COALESCE' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )) > position('prepare_ingress_provider_headers_v1' IN pg_get_functiondef(
    'public.workflow_intake_api_gateway_base_v1(text,text,text,text,jsonb,jsonb)'::regprocedure
  )),
  'API gateway keeps raw transient routing/execution and sanitizes durable header/query projections before persistence'
);

SELECT ok(
  pg_get_functiondef('public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure)
    LIKE '%FOR UPDATE SKIP LOCKED%'
  AND pg_get_functiondef('public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure)
    LIKE '%schema_name = ''public''%'
  AND pg_get_functiondef('public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure)
    LIKE '%UPDATE public.outbound_calls%'
  AND pg_get_functiondef('public.backfill_ingress_persisted_redaction_v1(integer)'::regprocedure)
    LIKE '%WHEN target.headers IS NULL THEN NULL%',
  'history repair is bounded, uses the actual audit schema column, preserves NULL, and scopes executable outbound rows'
);

CREATE TABLE public.pgtap_ingress_header_projection (
  id UUID PRIMARY KEY,
  headers JSONB,
  context JSONB
);

INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns)
VALUES ('public', 'pgtap_ingress_header_projection', 'denylist', ARRAY['headers', 'context']::TEXT[]);

CREATE TRIGGER audit_row_change
  BEFORE INSERT OR UPDATE OR DELETE ON public.pgtap_ingress_header_projection
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_capture_row_change();

INSERT INTO public.pgtap_ingress_header_projection (id, headers, context)
VALUES (
  '00000000-0000-0000-0000-000000001901',
  '{"x-forwarded-url":"/api-gateway/t/historical-secret"}'::jsonb,
  '{"headers":{"referer":"/safe?token=historical-secret"}}'::jsonb
);

CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON public.pgtap_ingress_header_projection
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'headers', 'headers',
    'context', 'json'
  );

UPDATE public.pgtap_ingress_header_projection
SET headers = public.redact_sensitive_headers(headers),
    context = public.redact_ingress_persisted_json_v1(context)
WHERE id = '00000000-0000-0000-0000-000000001901';

SELECT is(
  (SELECT headers->>'x-forwarded-url' FROM public.pgtap_ingress_header_projection WHERE id = '00000000-0000-0000-0000-000000001901'),
  '/api-gateway/t/REDACTED',
  'backfill-style UPDATE sanitizes a historical stored header value'
);

SELECT is(
  (
    SELECT row_old->>'headers'
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_ingress_header_projection' AND op = 'UPDATE'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  '[REDACTED]',
  'audit rule redacts historical raw OLD before the sanitizer backfill'
);

SELECT is(
  (
    SELECT row_new->>'headers'
    FROM public.audit_table_changes
    WHERE table_name = 'pgtap_ingress_header_projection' AND op = 'UPDATE'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  '[REDACTED]',
  'audit rule redacts sanitized NEW during the backfill'
);

INSERT INTO public.pgtap_ingress_header_projection (id, headers, context)
VALUES (
  '00000000-0000-0000-0000-000000001902',
  '{"referer":"/safe?credential=insert-secret"}'::jsonb,
  '{"headers":{"x-original-uri":"/api-gateway/insert-secret"}}'::jsonb
);

SELECT is(
  (SELECT headers->>'referer' FROM public.pgtap_ingress_header_projection WHERE id = '00000000-0000-0000-0000-000000001902'),
  '/safe?credential=REDACTED',
  'sanitizer trigger redacts INSERT header projection'
);

SELECT is(
  (SELECT context->>'headers' FROM public.pgtap_ingress_header_projection WHERE id = '00000000-0000-0000-0000-000000001902'),
  'REDACTED',
  'sanitizer trigger conservatively redacts INSERT nested context without an exact policy snapshot'
);

UPDATE public.pgtap_ingress_header_projection
SET headers = '{"x-rewrite-url":"/safe?signature=update-secret"}'::jsonb
WHERE id = '00000000-0000-0000-0000-000000001902';

SELECT is(
  (SELECT headers->>'x-rewrite-url' FROM public.pgtap_ingress_header_projection WHERE id = '00000000-0000-0000-0000-000000001902'),
  '/safe?signature=REDACTED',
  'sanitizer trigger re-applies redaction on UPDATE'
);

CREATE TEMP TABLE pgtap_ingress_invalid_mode (headers JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_ingress_invalid_mode
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1('headers', 'unsupported');

SELECT throws_ok(
  $$INSERT INTO pgtap_ingress_invalid_mode VALUES ('{}'::jsonb)$$,
  'P0001',
  'sanitize_ingress_persisted_projection_v1 unsupported mode unsupported for column headers'
);

CREATE TEMP TABLE pgtap_ingress_odd_args (headers JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_ingress_odd_args
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1('headers');

SELECT throws_ok(
  $$INSERT INTO pgtap_ingress_odd_args VALUES ('{}'::jsonb)$$,
  'P0001',
  'sanitize_ingress_persisted_projection_v1 requires column/mode argument pairs'
);

CREATE TEMP TABLE pgtap_scoped_decision (
  resource_type TEXT,
  performed_by_system TEXT,
  decision_inputs JSONB
);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_scoped_decision
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'decision_inputs', 'ingress_decision_json'
  );

INSERT INTO pgtap_scoped_decision VALUES
  ('shipment', 'shipment_engine', '{"headers":{"authorization":"non-ingress-required"}}'::jsonb),
  ('webhook_inbox', 'workflow_intake_webhook', '{"headers":{"authorization":"ingress-secret"},"echo":"/api-gateway/t/decision-secret"}'::jsonb);

SELECT is(
  (SELECT decision_inputs #>> '{headers,authorization}' FROM pgtap_scoped_decision WHERE resource_type = 'shipment'),
  'non-ingress-required',
  'non-ingress decision evidence remains unchanged'
);

SELECT is(
  (SELECT decision_inputs #>> '{headers,authorization}' FROM pgtap_scoped_decision WHERE resource_type = 'webhook_inbox'),
  NULL,
  'ingress decision evidence removes protected header values'
);

CREATE TEMP TABLE pgtap_scoped_audit (
  schema_name TEXT,
  table_name TEXT,
  row_old JSONB,
  row_new JSONB,
  request_context JSONB
);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_scoped_audit
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'row_old', 'ingress_audit_json',
    'row_new', 'ingress_audit_json',
    'request_context', 'ingress_audit_json'
  );

INSERT INTO pgtap_scoped_audit VALUES
  ('public', 'shipments', NULL, '{"headers":{"authorization":"non-ingress-audit"}}'::jsonb, '{}'::jsonb),
  ('public', 'api_gateway_requests', NULL, '{"request_headers":{"referer":"/api-gateway/t/audit-secret"}}'::jsonb, '{}'::jsonb);

SELECT is(
  (SELECT row_new #>> '{headers,authorization}' FROM pgtap_scoped_audit WHERE table_name = 'shipments'),
  'non-ingress-audit',
  'non-ingress audit evidence remains unchanged'
);

SELECT is(
  (SELECT row_new #>> '{request_headers,referer}' FROM pgtap_scoped_audit WHERE table_name = 'api_gateway_requests'),
  NULL,
  'ingress audit evidence removes protected forwarding URLs using schema_name routing'
);

CREATE TEMP TABLE pgtap_non_ingress_workflow (context JSONB, metadata JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_non_ingress_workflow
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'context', 'ingress_json',
    'metadata', 'ingress_json'
  );

INSERT INTO pgtap_non_ingress_workflow (context, metadata)
VALUES (
  '{"headers":{"authorization":"required-runtime-value"}}'::jsonb,
  '{"safe":true}'::jsonb
);

SELECT is(
  (SELECT context->'headers'->>'authorization' FROM pgtap_non_ingress_workflow LIMIT 1),
  'required-runtime-value',
  'non-ingress workflow context is outside the ingress persistence sanitizer scope'
);

CREATE TEMP TABLE pgtap_scoped_outbound (headers JSONB, context JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_scoped_outbound
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'headers', 'gateway_outbound_headers'
  );

INSERT INTO pgtap_scoped_outbound VALUES
  ('{"x-api-key":"non-gateway-key","referer":"/api-gateway/t/non-gateway-secret"}'::jsonb, NULL),
  ('{"x-api-key":"provider-key","referer":"/api-gateway/t/gateway-secret"}'::jsonb, '{"api_gateway_request_id":"00000000-0000-0000-0000-000000001990"}'::jsonb);

SELECT is(
  (SELECT headers FROM pgtap_scoped_outbound WHERE context IS NULL),
  '{"x-api-key":"non-gateway-key","referer":"/api-gateway/t/non-gateway-secret"}'::jsonb,
  'NULL ingress scope fails closed by leaving a non-gateway outbound row unchanged'
);

SELECT is(
  (SELECT headers FROM pgtap_scoped_outbound WHERE context IS NOT NULL),
  '{"x-api-key":"provider-key","referer":"/api-gateway/t/REDACTED"}'::jsonb,
  'scoped outbound trigger preserves provider credentials and sanitizes forwarding URLs'
);

UPDATE pgtap_scoped_outbound
SET context = '{"api_gateway_request_id":"00000000-0000-0000-0000-000000001991"}'::jsonb
WHERE context IS NULL;

SELECT is(
  (SELECT headers FROM pgtap_scoped_outbound WHERE headers->>'x-api-key' = 'non-gateway-key'),
  '{"x-api-key":"non-gateway-key","referer":"/api-gateway/t/REDACTED"}'::jsonb,
  'context-only UPDATE into gateway scope sanitizes unchanged outbound headers'
);

INSERT INTO pgtap_scoped_outbound VALUES
  ('"malformed-provider-headers"'::jsonb, '{"api_gateway_request_id":"00000000-0000-0000-0000-000000001992"}'::jsonb);

SELECT is(
  (SELECT headers FROM pgtap_scoped_outbound WHERE jsonb_typeof(headers) = 'string'),
  '"REDACTED"'::jsonb,
  'malformed live gateway outbound headers fail closed to the canonical REDACTED representation'
);

CREATE TEMP TABLE pgtap_scoped_outbound_response (response_headers JSONB, context JSONB);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_scoped_outbound_response
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'response_headers', 'gateway_response_headers'
  );

INSERT INTO pgtap_scoped_outbound_response VALUES
  ('{"authorization":"non-gateway-secret","referer":"/api-gateway/t/non-gateway-response","x-safe":"visible"}'::jsonb, NULL),
  (
    '{"authorization":"gateway-secret","set-cookie":"session=secret","referer":"/api-gateway/t/gateway-response","x-safe":"visible"}'::jsonb,
    jsonb_build_object(
      'api_gateway_request_id', '00000000-0000-0000-0000-000000001993',
      'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
    )
  ),
  (
    '"malformed-response-headers"'::jsonb,
    jsonb_build_object(
      'api_gateway_request_id', '00000000-0000-0000-0000-000000001994',
      'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
    )
  ),
  (
    NULL,
    jsonb_build_object(
      'api_gateway_request_id', '00000000-0000-0000-0000-000000001995',
      'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
    )
  );

SELECT is(
  (SELECT response_headers FROM pgtap_scoped_outbound_response WHERE context IS NULL),
  '{"authorization":"non-gateway-secret","referer":"/api-gateway/t/non-gateway-response","x-safe":"visible"}'::jsonb,
  'non-gateway response headers remain outside ingress redaction scope'
);

SELECT is(
  (SELECT response_headers FROM pgtap_scoped_outbound_response WHERE response_headers->>'x-safe' = 'visible' AND context IS NOT NULL),
  '{"referer":"/api-gateway/t/REDACTED","x-safe":"visible"}'::jsonb,
  'gateway response headers remove credentials and sanitize forwarding URLs before persistence'
);

UPDATE pgtap_scoped_outbound_response
SET context = jsonb_build_object(
  'api_gateway_request_id', '00000000-0000-0000-0000-000000001996',
  'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1('{}'::jsonb)
)
WHERE context IS NULL;

SELECT is(
  (SELECT response_headers FROM pgtap_scoped_outbound_response WHERE response_headers->>'x-safe' = 'visible' AND context->>'api_gateway_request_id' = '00000000-0000-0000-0000-000000001996'),
  '{"referer":"/api-gateway/t/REDACTED","x-safe":"visible"}'::jsonb,
  'context-only UPDATE into gateway scope re-sanitizes unchanged response headers'
);

SELECT ok(
  (SELECT response_headers FROM pgtap_scoped_outbound_response WHERE jsonb_typeof(response_headers) = 'string') = '"REDACTED"'::jsonb
  AND (SELECT count(*) FROM pgtap_scoped_outbound_response WHERE response_headers IS NULL) = 1,
  'malformed gateway response headers fail closed while SQL NULL remains NULL'
);

INSERT INTO pgtap_scoped_audit VALUES
  ('private', 'api_gateway_requests', NULL, '{"request_headers":{"referer":"/api-gateway/t/private-secret"}}'::jsonb, NULL);

SELECT is(
  (SELECT row_new #>> '{request_headers,referer}' FROM pgtap_scoped_audit WHERE schema_name = 'private'),
  '/api-gateway/t/private-secret',
  'non-public audit rows remain outside ingress audit sanitization'
);

INSERT INTO public.organizations (id, name, slug) VALUES
  ('f1000000-0000-0000-0000-000000001901', 'Ingress Redaction 1901', 'ingress-redaction-1901'),
  ('f1000000-0000-0000-0000-000000001902', 'Ingress Redaction 1902', 'ingress-redaction-1902')
ON CONFLICT (id) DO NOTHING;

SET LOCAL session_replication_role = replica;

INSERT INTO public.workflow_templates (
  id, name, description, version, status, scope_type
) VALUES (
  'f8100000-0000-0000-0000-000000001901',
  'pgtap_ingress_redaction_backfill',
  'Fixture workflow for ingress redaction backfill tests',
  1,
  'active',
  'global'
);

INSERT INTO public.workflow_template_steps (
  id, workflow_template_id, sequence_order, operation_name,
  transition_condition, handler_key, handler_version, enabled
) VALUES (
  'f8200000-0000-0000-0000-000000001901',
  'f8100000-0000-0000-0000-000000001901',
  1,
  'workflow_control',
  'always',
  'workflow_control',
  'v1',
  TRUE
);

INSERT INTO public.workflow_runs (
  id, workflow_template_id, workflow_template_version,
  entry_point, workflow_status, context
) VALUES (
  'f8300000-0000-0000-0000-000000001901',
  'f8100000-0000-0000-0000-000000001901',
  1,
  'test',
  'pending',
  '{}'::jsonb
);

INSERT INTO public.workflow_run_steps (
  id, workflow_run_id, workflow_template_step_id, sequence_order,
  step_status, operation_name, handler_key, handler_version,
  max_retries, enqueued_at, created_at, updated_at
) VALUES (
  'f8000000-0000-0000-0000-000000001901',
  'f8300000-0000-0000-0000-000000001901',
  'f8200000-0000-0000-0000-000000001901',
  1,
  'pending',
  'workflow_control',
  'workflow_control',
  'v1',
  1,
  now(),
  now(),
  now()
);

INSERT INTO public.decision_log (
  id, organization_id, decision_category, resource_type, resource_id,
  decision_point, decision_outcome, decision_inputs, performed_by_system, timestamp
) VALUES
  ('f2000000-0000-0000-0000-000000001901', 'f1000000-0000-0000-0000-000000001901', 'webhook_routing', 'webhook_inbox', 'f3000000-0000-0000-0000-000000001901', 'pgtap', 'accepted', '{"headers":{"authorization":"first-secret"}}', 'workflow_intake_webhook', now() - interval '3 seconds'),
  ('f2000000-0000-0000-0000-000000001901', 'f1000000-0000-0000-0000-000000001902', 'provider_selection', 'shipment', 'f3000000-0000-0000-0000-000000001902', 'pgtap', 'accepted', '{"headers":{"authorization":"composite-decoy"}}', 'shipment_engine', now() - interval '2 seconds'),
  ('f2000000-0000-0000-0000-000000001903', 'f1000000-0000-0000-0000-000000001901', 'webhook_routing', 'api_gateway_request', 'f3000000-0000-0000-0000-000000001903', 'pgtap', 'accepted', '{"headers":{"authorization":"second-secret"}}', 'api_gateway', now() - interval '1 second');

INSERT INTO public.audit_table_changes (
  id, organization_id, schema_name, table_name, op, row_new, request_context, created_at
) VALUES
  ('f4000000-0000-0000-0000-000000001901', 'f1000000-0000-0000-0000-000000001901', 'public', 'api_gateway_requests', 'INSERT', '{"request_headers":{"referer":"/api-gateway/t/first-audit-secret"}}', NULL, now() - interval '3 seconds'),
  ('f4000000-0000-0000-0000-000000001901', 'f1000000-0000-0000-0000-000000001902', 'private', 'api_gateway_requests', 'INSERT', '{"request_headers":{"referer":"/api-gateway/t/composite-audit-decoy"}}', NULL, now() - interval '2 seconds'),
  ('f4000000-0000-0000-0000-000000001903', 'f1000000-0000-0000-0000-000000001901', 'public', 'webhook_inbox', 'INSERT', '{"headers":{"authorization":"second-audit-secret"}}', NULL, now() - interval '1 second');

INSERT INTO public.outbound_calls (
  id, call_type, target_type, target_id, method, url, headers, body,
  response_headers, context, workflow_run_step_id, created_at
) VALUES
  ('f5000000-0000-0000-0000-000000001901', 'provider_api', 'provider', 'f6000000-0000-0000-0000-000000001901', 'POST', 'https://provider.test/first?token=first&safe=one', '{"x-api-key":"provider-one","referer":"/api-gateway/t/first-outbound-secret"}', '{}', '{"set-cookie":"session=first","referer":"/api-gateway/t/first-response-secret","x-safe":"one"}', '{"api_gateway_request_id":"f7000000-0000-0000-0000-000000001901"}', 'f8000000-0000-0000-0000-000000001901', now() - interval '3 seconds'),
  ('f5000000-0000-0000-0000-000000001902', 'provider_api', 'provider', 'f6000000-0000-0000-0000-000000001902', 'POST', 'https://provider.test/second?token=second&safe=two', '{"x-api-key":"provider-two","referer":"/api-gateway/t/second-outbound-secret"}', '{}', '{"authorization":"response-secret","referer":"/api-gateway/t/second-response-secret","x-safe":"two"}', '{"api_gateway_request_id":"f7000000-0000-0000-0000-000000001902"}', 'f8000000-0000-0000-0000-000000001901', now() - interval '2 seconds'),
  ('f5000000-0000-0000-0000-000000001903', 'provider_api', 'provider', 'f6000000-0000-0000-0000-000000001903', 'POST', 'https://provider.test/non-gateway', '{"x-api-key":"non-gateway","referer":"/api-gateway/t/non-gateway-secret"}', '{}', '{"set-cookie":"non-gateway-cookie","referer":"/api-gateway/t/non-gateway-response"}', '{}', 'f8000000-0000-0000-0000-000000001901', now() - interval '1 second'),
  ('f5000000-0000-0000-0000-000000001904', 'provider_api', 'provider', 'f6000000-0000-0000-0000-000000001904', 'POST', 'https://provider.test/null', NULL, '{}', NULL, '{"api_gateway_request_id":"f7000000-0000-0000-0000-000000001904"}', 'f8000000-0000-0000-0000-000000001901', now()),
  ('f5000000-0000-0000-0000-000000001905', 'provider_api', 'provider', 'f6000000-0000-0000-0000-000000001905', 'POST', 'https://provider.test/malformed', '"historical-malformed-provider-headers"', '{}', '"historical-malformed-response-headers"', '{"api_gateway_request_id":"f7000000-0000-0000-0000-000000001905"}', 'f8000000-0000-0000-0000-000000001901', now() + interval '1 second');

SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE pgtap_ingress_backfill_first AS
SELECT public.backfill_ingress_persisted_redaction_v1(1) AS result;

SELECT is((SELECT (result #>> '{updated,decision_log}')::INT FROM pgtap_ingress_backfill_first), 1, 'backfill obeys the per-table batch limit for partitioned decisions');
SELECT is((SELECT (result #>> '{updated,audit_table_changes}')::INT FROM pgtap_ingress_backfill_first), 1, 'backfill obeys the per-table batch limit for partitioned audit rows');
SELECT is((SELECT (result #>> '{updated,outbound_calls}')::INT FROM pgtap_ingress_backfill_first), 1, 'backfill obeys the per-table batch limit for gateway outbound rows');
SELECT ok((SELECT (result->>'has_more')::BOOLEAN FROM pgtap_ingress_backfill_first), 'backfill reports remaining eligible work after a bounded cohort');

SELECT ok(
  (SELECT decision_inputs #>> '{headers,authorization}' FROM public.decision_log WHERE id = 'f2000000-0000-0000-0000-000000001901' AND organization_id = 'f1000000-0000-0000-0000-000000001902') = 'composite-decoy'
  AND (SELECT row_new #>> '{request_headers,referer}' FROM public.audit_table_changes WHERE id = 'f4000000-0000-0000-0000-000000001901' AND organization_id = 'f1000000-0000-0000-0000-000000001902') = '/api-gateway/t/composite-audit-decoy'
  AND (SELECT headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001904') IS NULL,
  'composite joins do not touch same-id decoys and NULL outbound headers remain NULL'
);

CREATE TEMP TABLE pgtap_ingress_backfill_final AS
SELECT public.backfill_ingress_persisted_redaction_v1(2000) AS result;

SELECT ok(
  NOT (SELECT (result->>'has_more')::BOOLEAN FROM pgtap_ingress_backfill_final)
  AND (SELECT decision_inputs #>> '{headers,authorization}' FROM public.decision_log WHERE id = 'f2000000-0000-0000-0000-000000001903') IS NULL
  AND (SELECT row_new #>> '{headers,authorization}' FROM public.audit_table_changes WHERE id = 'f4000000-0000-0000-0000-000000001903') IS NULL
  AND (SELECT headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902') = '{}'::jsonb
  AND (SELECT url FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902') = 'https://provider.test/second?token=REDACTED&safe=REDACTED'
  AND (SELECT headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001905') = '"REDACTED"'::jsonb
  AND (SELECT headers->>'referer' FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001903') = '/api-gateway/t/non-gateway-secret',
  'final cohort clears has_more, repairs malformed history, strips persisted gateway credentials, and preserves non-gateway state'
);

SELECT ok(
  (SELECT response_headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902') = '"REDACTED"'::jsonb
  AND (SELECT response_headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001905') = '"REDACTED"'::jsonb
  AND (SELECT response_headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001903') = '{"set-cookie":"non-gateway-cookie","referer":"/api-gateway/t/non-gateway-response"}'::jsonb
  AND (SELECT response_headers FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001904') IS NULL,
  'backfill sanitizes direct gateway response-header history, preserves non-gateway rows, and preserves SQL NULL'
);

SELECT ok(
  (SELECT execution_url_vault_id IS NOT NULL FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902')
  AND public.resolve_ingress_execution_url_v1('f5000000-0000-0000-0000-000000001902')
    = 'https://provider.test/second?token=second&safe=two'
  AND public.get_job_call_spec('f5000000-0000-0000-0000-000000001902')->>'url'
    = 'https://provider.test/second?token=second&safe=two',
  'backfill preserves queued executable URL semantics only through the Vault reference and dispatch boundary'
);

UPDATE public.outbound_calls
   SET status = 'in_progress_edge',
       edge_lease_token = 'f9000000-0000-0000-0000-000000001902'::UUID,
       lease_expires_at = now() + interval '5 minutes'
 WHERE id = 'f5000000-0000-0000-0000-000000001902';

SELECT throws_ok(
  $sql$
    DO $call$
    BEGIN
      SET LOCAL ROLE edge_api_caller_role;
      PERFORM api.get_claimed_edge_job_call_spec_v1('f5000000-0000-0000-0000-000000001902'::uuid, NULL::uuid);
      RESET ROLE;
    END;
    $call$;
  $sql$::text,
  'P0001', 'get_claimed_edge_job_call_spec_v1: active lease for job f5000000-0000-0000-0000-000000001902 not found',
  'the Edge API caller cannot resolve a protected execution URL without presenting its active lease'
);

SELECT ok(
  (SELECT url FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902')
    = 'https://provider.test/second?token=REDACTED&safe=REDACTED'
  AND public.get_claimed_edge_job_call_spec_v1(
        'f5000000-0000-0000-0000-000000001902',
        'f9000000-0000-0000-0000-000000001902'
      )->>'url' = 'https://provider.test/second?token=second&safe=two',
  'claimed edge dispatch restores the executable URL while the durable row remains redacted'
);

CREATE TEMP TABLE pgtap_protected_update_ref AS
SELECT execution_url_vault_id
  FROM public.outbound_calls
 WHERE id = 'f5000000-0000-0000-0000-000000001902';

UPDATE public.outbound_calls
   SET url = 'https://provider.test/third?token=third&safe=three'
 WHERE id = 'f5000000-0000-0000-0000-000000001902';

SELECT ok(
  (SELECT execution_url_vault_id FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902')
    = (SELECT execution_url_vault_id FROM pgtap_protected_update_ref)
  AND (SELECT url FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902')
    = 'https://provider.test/third?token=REDACTED&safe=REDACTED'
  AND public.resolve_ingress_execution_url_v1('f5000000-0000-0000-0000-000000001902')
    = 'https://provider.test/third?token=third&safe=three',
  'protected-to-protected URL update keeps the reference and atomically updates its Vault secret'
);

CREATE OR REPLACE FUNCTION public.get_job_call_spec_without_ingress_vault_v1(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_job public.outbound_calls%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_job FROM public.outbound_calls WHERE id = p_job_id;
  RETURN jsonb_build_object(
    'url', v_job.url || '&api_key=injected-secret',
    'method', v_job.method,
    'headers', COALESCE(v_job.headers, '{}'::jsonb),
    'body', COALESCE(v_job.body, '{}'::jsonb)
  );
END;
$function$;

SELECT is(
  public.get_job_call_spec('f5000000-0000-0000-0000-000000001902')->>'url',
  'https://provider.test/third?token=third&safe=three&api_key=injected-secret',
  'dispatch wrapper restores the raw URL first and appends existing auth-query enrichment without reordering it'
);

CREATE TEMP TABLE pgtap_execution_url_vault_refs AS
SELECT id, execution_url_vault_id
  FROM public.outbound_calls
 WHERE id IN (
   'f5000000-0000-0000-0000-000000001901',
   'f5000000-0000-0000-0000-000000001902'
 );

UPDATE public.outbound_calls
   SET url = 'https://provider.test/safe'
 WHERE id = 'f5000000-0000-0000-0000-000000001902';

SELECT ok(
  (SELECT execution_url_vault_id IS NULL FROM public.outbound_calls WHERE id = 'f5000000-0000-0000-0000-000000001902')
  AND NOT EXISTS (
    SELECT 1 FROM vault.secrets
     WHERE id = (SELECT execution_url_vault_id FROM pgtap_execution_url_vault_refs WHERE id = 'f5000000-0000-0000-0000-000000001902')
  ),
  'protected-to-safe active URL update clears the stale reference and purges its Vault secret'
);

INSERT INTO public.api_route_packs (id, name)
VALUES ('f8100000-0000-0000-0000-000000001900', 'pgtap-ingress-vault-policy-transition');
INSERT INTO public.api_routes (id, pack_id, method, path_template, policy) VALUES
  (
    'f8200000-0000-0000-0000-000000001901',
    'f8100000-0000-0000-0000-000000001900',
    'POST', '/pgtap/ingress-vault/protected',
    '{"query":{"protected":[{"name":"tenant_secret"}]}}'::jsonb
  ),
  (
    'f8200000-0000-0000-0000-000000001902',
    'f8100000-0000-0000-0000-000000001900',
    'POST', '/pgtap/ingress-vault/safe',
    '{}'::jsonb
  );

CREATE TEMP TABLE pgtap_route_policy_outbound (
  id UUID,
  status TEXT,
  url TEXT,
  execution_url_vault_id UUID,
  headers JSONB,
  context JSONB
);
CREATE TRIGGER a00_ingress_persistence_redaction
  BEFORE INSERT OR UPDATE ON pgtap_route_policy_outbound
  FOR EACH ROW EXECUTE FUNCTION public.sanitize_ingress_persisted_projection_v1(
    'execution_url_vault_id', 'gateway_execution_url_reference',
    'url', 'gateway_outbound_url',
    'headers', 'gateway_outbound_headers',
    'context', 'gateway_outbound_context'
  );
CREATE TRIGGER z99_purge_obsolete_ingress_execution_url
  AFTER UPDATE ON pgtap_route_policy_outbound
  FOR EACH ROW
  WHEN (OLD.execution_url_vault_id IS NOT NULL AND NEW.execution_url_vault_id IS NULL)
  EXECUTE FUNCTION public.purge_obsolete_ingress_execution_url_v1();

SET LOCAL session_replication_role = replica;
INSERT INTO pgtap_route_policy_outbound VALUES (
  'f8300000-0000-0000-0000-000000001901',
  'pending',
  'https://provider.test/jobs?tenant_secret=REDACTED',
  public.persist_ingress_execution_url_v1(
    'f8300000-0000-0000-0000-000000001901',
    'https://provider.test/jobs?tenant_secret=raw',
    NULL
  ),
  '{}'::jsonb,
  jsonb_build_object(
    'api_gateway_request_id', 'f8400000-0000-0000-0000-000000001901',
    'api_gateway_route_id', 'f8200000-0000-0000-0000-000000001901',
    'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1(
      '{"query":{"protected":[{"name":"tenant_secret"}]}}'::jsonb
    )
  )
);
SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE pgtap_route_policy_ref AS
SELECT execution_url_vault_id FROM pgtap_route_policy_outbound;

UPDATE pgtap_route_policy_outbound
   SET context = jsonb_set(
     context,
     '{api_gateway_route_id}',
     to_jsonb('f8200000-0000-0000-0000-000000001902'::TEXT),
     TRUE
   );

SELECT ok(
  (SELECT execution_url_vault_id IS NULL FROM pgtap_route_policy_outbound)
  AND (SELECT url FROM pgtap_route_policy_outbound) = 'https://provider.test/jobs?tenant_secret=raw'
  AND NOT EXISTS (
    SELECT 1 FROM vault.secrets
     WHERE id = (SELECT execution_url_vault_id FROM pgtap_route_policy_ref)
  ),
  'route-policy protected-to-safe transition clears the unchanged URL reference and purges its Vault secret'
);

DELETE FROM public.outbound_calls
 WHERE id = 'f5000000-0000-0000-0000-000000001901';

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM vault.secrets
     WHERE id = (SELECT execution_url_vault_id FROM pgtap_execution_url_vault_refs WHERE id = 'f5000000-0000-0000-0000-000000001901')
  ),
  'outbound row deletion purges its Vault execution secret'
);

SELECT finish();
ROLLBACK;
