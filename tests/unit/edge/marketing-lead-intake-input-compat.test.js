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
  });
});
