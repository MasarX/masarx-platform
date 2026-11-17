const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('supabase/migrations/20261019024000_automation_marketplace_oauth_attempts_v1.sql');
const native = read('supabase/tests/pgtap/0zhl_automation_marketplace_oauth_attempts_v1.sql');
const names = ['context', 'begin', 'consume', 'finish'];

function rpc(name, schema = 'public') {
  const pattern = new RegExp(`CREATE FUNCTION ${schema}\\.integration_connection_oauth_${name}_v1\\([\\s\\S]*?\\n\\$function\\$;`);
  const match = source.match(pattern);
  if (!match) throw new Error(`Missing OAuth ${schema}.${name} function`);
  return match[0];
}

describe('OAuth attempt persistence source contract (native execution remains separate)', () => {
  test('exposes exactly four narrow API wrappers with their existing parameter names', () => {
    expect([...source.matchAll(/CREATE FUNCTION api\.(\w+)\(/g)].map((match) => match[1]))
      .toEqual(names.map((name) => `integration_connection_oauth_${name}_v1`));
    for (const name of names) {
      expect(rpc(name, 'api')).toContain(`SELECT public.integration_connection_oauth_${name}_v1(`);
      expect(rpc(name, 'api')).not.toContain('SECURITY DEFINER');
    }
    expect(rpc('consume')).toMatch(/p_state_hash TEXT,p_actor_user_id UUID,p_session_id TEXT,p_connection_id UUID,p_operation TEXT/);
    expect(rpc('finish')).toMatch(/p_attempt_id UUID,p_claim_token UUID,p_secret_payload JSONB,p_oauth_metadata JSONB,\s+p_status TEXT,p_expires_at TIMESTAMPTZ,p_status_reason TEXT/);
    expect(source).toMatch(/GRANT EXECUTE ON FUNCTION api\.integration_connection_oauth_context_v1\(UUID\),api\.integration_connection_oauth_begin_v1\(UUID,TEXT,TEXT,TEXT,TEXT\) TO authenticated;/);
    expect(source).toMatch(/GRANT EXECUTE ON FUNCTION api\.integration_connection_oauth_consume_v1\(TEXT,UUID,TEXT,UUID,TEXT\),api\.integration_connection_oauth_finish_v1\(UUID,UUID,JSONB,JSONB,TEXT,TIMESTAMPTZ,TEXT\) TO service_role;/);
  });

  test('keeps state hashed, verifier sealed, and refresh generation claimed only once', () => {
    const table = source.slice(source.indexOf('CREATE TABLE'), source.indexOf('CREATE FUNCTION'));
    expect(table).toContain("CHECK(state_hash ~ '^[a-f0-9]{64}$')");
    expect(table).toContain('pkce_verifier_vault_id UUID REFERENCES vault.secrets(id)');
    expect(table).not.toMatch(/\b(?:pkce_verifier|refresh_token|access_token|state) TEXT/);
    expect(table).toMatch(/UNIQUE INDEX[\s\S]*\(connection_id,credential_generation\)\s+WHERE operation='refresh' AND consumed_at IS NOT NULL/);
    expect(table).toContain('ENABLE ROW LEVEL SECURITY');
    expect(table).toContain('REVOKE ALL ON TABLE public.integration_connection_oauth_attempts FROM PUBLIC,anon,authenticated,service_role');
    expect(rpc('begin')).toContain("deadline:=started_at+INTERVAL '5 minutes'");
    expect(rpc('begin')).toContain("automation_marketplace_store_secret_payload_v1(NULL,jsonb_build_object('pkce_verifier',p_pkce_verifier))");
  });

  test('checks live database actor/session and explicit hierarchy even under the service role', () => {
    const guard = rpc('assert_actor');
    for (const token of ['FROM auth.sessions s', 'JOIN auth.users au', 's.user_id=p_user_id', 's.id::text=p_session_id',
      's.not_after>clock_timestamp()', "lower(u.status)='active'", 'au.deleted_at IS NULL', 'au.banned_until',
      "actor_scope='tenant'", 'actor_scope=target_type AND actor_scope_id=p_scope_id', "actor_scope='client' AND target_type='sender'",
      'actor_org_id=p_organization_id', "user_capability_eval_v1('automation_marketplace.manage_connections'"])
      expect(guard).toContain(token);
    expect(guard).not.toContain('IF public.request_role_is_service_v1()');
    for (const [guc, previous] of [['claims', 'previous_claims'], ['claim.sub', 'previous_sub'], ['claim.role', 'previous_role']]) {
      expect(guard.match(new RegExp(`set_config\\('request\\.jwt\\.${guc.replaceAll('.', '\\.')}',COALESCE\\(${previous},''\\),TRUE\\)`, 'g'))).toHaveLength(2);
    }
  });

  test.each(['consume', 'finish'])('%s rechecks ownership, capability, policy, and generation before Vault access', (name) => {
    const body = rpc(name);
    expect(body).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(body).toMatch(/FROM public\.integration_connection_oauth_attempts[\s\S]*?FOR UPDATE;/);
    expect(body).toMatch(/FROM public\.integration_connections WHERE id=attempt\.connection_id FOR UPDATE;/);
    for (const token of ['attempt.expires_at<=clock_timestamp()', 'connection.credential_generation<>attempt.credential_generation',
      'connection.organization_id<>attempt.organization_id', 'connection.owner_scope_type<>attempt.owner_scope_type',
      'connection.owner_scope_id<>attempt.owner_scope_id', 'connection.revoked_at IS NOT NULL',
      "connection.status IN ('revoked','disabled')", 'integration_connection_oauth_assert_actor_v1(attempt.actor_user_id,attempt.actor_session_id',
      'integration_connection_oauth_binding_v1(connection.id)', "context->>'binding_hash' IS DISTINCT FROM attempt.binding_hash",
      "context->'provider_binding' IS DISTINCT FROM attempt.provider_binding"])
      expect(body).toContain(token);
    expect(body.indexOf('integration_connection_oauth_assert_actor_v1')).toBeLessThan(body.indexOf('vault.decrypted_secrets'));
    expect(body.indexOf('integration_connection_oauth_binding_v1')).toBeLessThan(body.indexOf('vault.decrypted_secrets'));
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'OAuth (?:attempt invalid|completion conflict)'/);
  });

  test('uses trusted owner policy and exact callbacks, without seeded OAuth providers', () => {
    const binding = rpc('binding');
    expect(binding).toContain("#> ARRAY['oauth','providers',connection.provider_key]");
    expect(binding).not.toContain('connection.config');
    expect(binding).toContain("integration_connection_oauth_callback_valid_v1(provider->>'console_origin',provider->>'redirect_uri')");
    const callback = rpc('callback_valid');
    const pathPattern = new RegExp(callback.match(/substring\(p_redirect_uri FROM char_length\(p_console_origin\)\+1\) ~ '((?:[^']|'')+)'/)[1].replaceAll("''", "'"));
    const traversalPattern = new RegExp(callback.match(/substring\(p_redirect_uri FROM char_length\(p_console_origin\)\+1\) !~ '([^']+)'/)[1]);
    const origin = 'https://console.example.invalid';
    const callbackSuffix = '/api/automation-marketplace/oauth/callback';
    const matchesSqlPathContract = (redirect) => !/[\u0000-\u001f\u007f]/.test(redirect) && redirect.startsWith(`${origin}/`)
      && pathPattern.test(redirect.slice(origin.length)) && !traversalPattern.test(redirect.slice(origin.length));
    for (const base of ['', '/ops', '/ops/team', '/console', '/ops-v2/team_1/~preview/.hidden', '/ops+team', "/ops!$&'()*+,;=:@/team-v2._~"])
      expect(matchesSqlPathContract(`${origin}${base}${callbackSuffix}`)).toBe(true);
    for (const redirect of [`https://other.example.invalid/ops${callbackSuffix}`, `https://console.example.invalid.evil/ops${callbackSuffix}`,
      `http://console.example.invalid/ops${callbackSuffix}`, `${origin}/ops/callback`, `${origin}/ops/..${callbackSuffix}`,
      `${origin}/ops/.${callbackSuffix}`, `${origin}/ops/%2e%2e${callbackSuffix}`, `${origin}/ops/${callbackSuffix}`,
      `${origin}/ops\\${callbackSuffix}`, `${origin}/ops${callbackSuffix}?extra=1`, `${origin}/ops${callbackSuffix}#extra`, `${origin}/ops${callbackSuffix}\n`,
      `${origin}/ops%2Bteam${callbackSuffix}`, `${origin}/ops+team/${callbackSuffix}`])
      expect(matchesSqlPathContract(redirect)).toBe(false);
    expect(callback).toContain("p_console_origin ~ '^https://");
    expect(callback).toContain("p_console_origin !~ '[[:cntrl:]]'");
    expect(callback).toContain("p_redirect_uri !~ '[[:cntrl:]]'");
    expect(callback).toContain('strpos(p_console_origin,chr(92))=0');
    expect(callback).toContain("strpos(p_console_origin,'%')=0");
    expect(source).toMatch(/integration_connection_oauth_callback_valid_v1\(TEXT,TEXT\)\s+FROM PUBLIC,anon,authenticated,service_role;/);
    expect(binding).toContain("encode(digest(binding::text,'sha256'),'hex')");
    expect(rpc('context')).toContain("jsonb_build_object('configured',FALSE)");
    const foundation = read('supabase/migrations/20261019021000_automation_marketplace_control_plane_v1.sql');
    expect(foundation).toMatch(/"providers":\s*\{\}/);
    const schema = JSON.parse(foundation.match(/'automation_marketplace_policy',\s*1,\s*'([\s\S]*?)'::jsonb/)[1]);
    expect(schema.properties.oauth.properties.providers).toMatchObject({
      type: 'object', default: {}, additionalProperties: { type: 'object', additionalProperties: false },
    });
    expect(schema.properties.oauth.properties.providers.additionalProperties.required).toEqual([
      'provider_key', 'authorization_url', 'token_url', 'client_id', 'scopes', 'redirect_uri', 'console_origin',
    ]);
    expect(source).not.toMatch(/CREATE ROLE|GRANT\s+(?:SELECT|ALL)\s+ON.*oauth_attempts/i);
  });

  test('clears only owned verifier secrets and bounds abandoned-attempt cleanup', () => {
    const consume = rpc('consume');
    expect(consume).toContain('SET pkce_verifier_vault_id=NULL WHERE id=attempt.id');
    expect(consume).toContain('DELETE FROM vault.secrets WHERE id=attempt.pkce_verifier_vault_id');
    expect(consume).not.toContain('DELETE FROM vault.secrets WHERE id=connection.credentials_vault_id');
    const begin = rpc('begin');
    expect(begin).toContain('connection_id=connection.id AND actor_user_id=auth.uid()');
    expect(begin).toContain('LIMIT 32 FOR UPDATE SKIP LOCKED');
    expect(begin).toContain('DELETE FROM vault.secrets WHERE id=expired.pkce_verifier_vault_id');
  });

  test('finishes with claim-token CAS, advances generation, and synchronizes or invalidates runtime credentials', () => {
    const finish = rpc('finish');
    expect(finish).toContain('attempt.claim_token IS DISTINCT FROM p_claim_token');
    expect(finish).toContain('credential_generation=credential_generation+1');
    expect(finish).toContain('WHERE id=connection.id AND credential_generation=attempt.credential_generation AND revoked_at IS NULL');
    expect(finish).toContain('public.automation_marketplace_sync_runtime_auth_config_v1(connection.id)');
    expect(finish).toContain("UPDATE public.provider_auth_configs SET credentials='{}'::jsonb,credentials_vault_id=NULL,expires_at=clock_timestamp()");
    expect(finish).toContain("previous_secret->>'refresh_token'");
    expect(finish).toContain("p_status_reason NOT IN ('authorization_denied','token_exchange_failed')");
    expect(finish).toContain("RETURN jsonb_build_object('ok',TRUE)");
    expect(finish).not.toMatch(/RETURN[^;]*p_secret_payload/);
  });

  test('native fixtures cover real scope/session/claim/expiry/revoke/generation boundaries with a matching plan', () => {
    const planned = Number(native.match(/SELECT plan\((\d+)\)/)[1]);
    const assertions = (native.match(/RETURN NEXT (?:ok|is|throws_ok)\(/g) || []).length
      + (native.match(/^SELECT ok\(/gm) || []).length;
    expect(planned).toBe(assertions);
    for (const token of ['INSERT INTO auth.sessions', 'INSERT INTO auth.users', 'foreign_connection',
      'a second overlapping attempt', 'capability revocation', 'trusted provider configuration changes',
      'revocation after consume', 'logout session revocation', 'credential rotation between begin',
      'consume erases only its own verifier', 'new begin cleans expired verifiers', 'finish rechecks trusted provider binding',
      'finish rechecks capability revocation', 'finish also rechecks live session', 'refresh failure requires reauthorization']) expect(native).toContain(token);
    expect(native).toMatch(/ROLLBACK;\s*$/);
  });
});
