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

  test('uses dynamic apikey header for JWT-vs-secret key compatibility', () => {
    expect(source).toContain('const isJwtLike = (value: string): boolean => String(value || "").trim().split(".").length === 3;');
    expect(source).toContain('const serviceKey = asString(EDGE_SUPABASE_SECRET_KEY) || asString(SUPABASE_SERVICE_KEY);');
    expect(source).toContain('const apiKeyHeader = isJwtLike(serviceKey)');
    expect(source).toContain('? (anonKey || serviceKey)');
    expect(source).toContain(': serviceKey;');
    expect(source).toContain('apikey: apiKeyHeader');
  });
});
