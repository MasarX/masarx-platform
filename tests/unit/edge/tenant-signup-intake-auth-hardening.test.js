const fs = require('fs');
const path = require('path');

describe('tenant-signup-intake auth hardening', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/tenant-signup-intake/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');

  test('supports secret-key fallback env for edge runtime', () => {
    expect(source).toContain('const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [');
    expect(source).toContain('"SUPABASE_SECRET_KEY"');
  });

  test('prefers canonical Supabase URL before edge-local aliases for local browser proof', () => {
    expect(source).toContain('const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);');
  });

  test('uses dynamic apikey header for JWT-vs-secret key compatibility', () => {
    expect(source).toContain('const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;');
    expect(source).toContain('const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);');
    expect(source).toContain('const apiKeyHeader = isJwtLike(serviceKey)');
    expect(source).toContain('? (anonKey || serviceKey)');
    expect(source).toContain(': serviceKey;');
    expect(source).toContain('apikey: apiKeyHeader');
  });

  test('pins browser-facing Supabase Data API calls to the api schema', () => {
    expect(source).toContain('const TENANT_SIGNUP_RPC_SCHEMA = "api";');
    expect(source).not.toContain('readEnv("TENANT_SIGNUP_RPC_SCHEMA"');
    expect(source).not.toContain('"EDGE_RPC_SCHEMA"');
    expect(source).not.toContain('"API_RPC_SCHEMA"');
    expect(source).not.toMatch(/schema:\s*["']public["']/);
    expect(source).toMatch(/db:\s*\{\s*schema:\s*TENANT_SIGNUP_RPC_SCHEMA,\s*\}/s);
  });

  test('shared tenant signup helper does not pin API-schema clients to public Supabase types', () => {
    const helperSource = fs.readFileSync(
      path.join(__dirname, '../../../supabase/functions/_shared/tenant_signup.ts'),
      'utf8',
    );

    expect(helperSource).not.toContain('type EdgeRpcClient = any;');
    expect(helperSource).not.toContain('serviceClient: SupabaseClient,');
    expect(helperSource).not.toContain('type EdgeRpcClient = SupabaseClient<any, "public"');
    expect(helperSource).toContain('type EdgeRpcClient = SupabaseClient<any, any, any, any, any>;');
  });

  test('public intake queues for review and cannot auto-approve tenants', () => {
    expect(source).not.toContain('approveTenantSignupRequest');
    expect(source).not.toContain('auto_approved_by_policy');
    expect(source).toContain('approval_required: true');
    expect(source).toContain('auto_approve: false');
    expect(source).toContain('auto_approve_applied: false');
  });

  test('public intake preserves canonical request id and duplicate state from the backend RPC', () => {
    expect(source).toContain('const deduped = Boolean(rpcBody.deduped);');
    expect(source).toContain('deduped,');
    expect(source).toContain('request_id: requestId || null');
    expect(source).toContain('tenant_signup_request_id: requestId || null');
  });

  test('allows dynamic loopback Landing origins only when the edge request is local', () => {
    expect(source).toContain('const isLoopbackOrigin = (value: string): boolean => {');
    expect(source).toContain('const requestLocalContext = isLocalRequest(req);');
    expect(source).toContain('const dynamicLocalOriginAllowed = requestLocalContext && origin ? isLoopbackOrigin(origin) : false;');
    expect(source).toContain('const effectiveConfigured = effectiveOrigins.size > 0 || dynamicLocalOriginAllowed;');
    expect(source).toContain('if (!effectiveOrigins.has(origin) && !dynamicLocalOriginAllowed) {');
  });
});
