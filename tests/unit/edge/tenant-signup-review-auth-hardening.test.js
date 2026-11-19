const fs = require('fs');
const path = require('path');

describe('tenant-signup-review auth hardening', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/tenant-signup-review/index.ts',
  );
  const source = fs.readFileSync(functionPath, 'utf8');

  test('supports secret-key fallback env for edge runtime', () => {
    expect(source).toContain('const EDGE_SUPABASE_SECRET_KEY = readEnv("EDGE_SUPABASE_SECRET_KEY", [');
    expect(source).toContain('"SUPABASE_SECRET_KEY"');
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

  test('shared tenant signup helper does not pin review clients to public Supabase types', () => {
    const helperSource = fs.readFileSync(
      path.join(__dirname, '../../../supabase/functions/_shared/tenant_signup.ts'),
      'utf8',
    );

    expect(helperSource).not.toContain('type EdgeRpcClient = any;');
    expect(helperSource).not.toContain('serviceClient: SupabaseClient,');
    expect(helperSource).not.toContain('type EdgeRpcClient = SupabaseClient<any, "public"');
    expect(helperSource).toContain('type EdgeRpcClient = SupabaseClient<any, any, any, any, any>;');
  });

  test('is browser-safe for Console V2 function invocation', () => {
    expect(source).toContain('if (req.method === "OPTIONS")');
    expect(source).toContain('"access-control-allow-origin"');
    expect(source).toContain('"access-control-allow-methods": "POST, OPTIONS"');
    expect(source).toContain('"access-control-allow-headers": "authorization, content-type, apikey, x-client-info"');
  });
});
