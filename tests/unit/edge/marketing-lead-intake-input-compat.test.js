const fs = require('fs');
const path = require('path');

describe('marketing-lead-intake payload compatibility', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/marketing-lead-intake/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');

  test('accepts organization_name aliases for company', () => {
    expect(source).toContain('organization_name?: unknown;');
    expect(source).toContain('organizationName?: unknown;');
    expect(source).toContain('asString(payload?.company) || asString(payload?.organization_name) || asString(payload?.organizationName)');
  });

  test('expands JWT auth attempts across anon/service api key planes', () => {
    expect(source).toContain('const apiKeyCandidates = [anonKey, asString(EDGE_SUPABASE_SECRET_KEY), asString(SUPABASE_SERVICE_KEY)]');
    expect(source).toContain('if (status !== 400 && status !== 401 && status !== 403) return false;');
    expect(source).toContain('addAttempt("db-jwt", {');
    expect(source).toContain('addAttempt(`db-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {');
    expect(source).toContain('addAttempt("service-jwt", {');
    expect(source).toContain('addAttempt(`service-jwt+apikey:${apiKey === anonKey ? "anon" : "service"}`, {');
    expect(source).toContain('addAttempt("service-secret-bearer+apikey", {');
    expect(source).toContain('message.includes("no api key")');
    expect(source).toContain('message.includes("permission denied for function")');
  });

  test('pins PostgREST RPC calls to the exposed api schema', () => {
    expect(source).toContain('"accept-profile": "api"');
    expect(source).toContain('"content-profile": "api"');
    expect(source).toContain('fetchWithTimeout(`${baseUrl}/rest/v1/rpc/${rpcName}`');
  });

  test('bounds local RPC fetches and falls back across local Supabase URL planes', () => {
    expect(source).toContain('const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);');
    expect(source).toContain('const resolveRpcBaseUrls = (): string[] => {');
    expect(source).toContain('candidates.push("http://kong:8000");');
    expect(source).toContain('controller.abort()');
    expect(source).toContain('throw new Error(`rpc_fetch_failed:${lastFetchError.message || "unknown"}`);');
  });

  test('uses the local Turnstile dummy token shortcut for loopback browser proof', () => {
    expect(source).toContain('const LOCAL_MARKETING_TURNSTILE_DUMMY_TOKEN = "EXAMPLE_PASSWORD";');
    expect(source).toContain('cors.localContext && turnstileToken === LOCAL_MARKETING_TURNSTILE_DUMMY_TOKEN');
    expect(source).toContain('? { success: true, hostname: "", errorCodes: [] }');
  });
});
