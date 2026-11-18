const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20261106193000_call_api_revoke_public_execute_v1.sql');
const fixture = read('supabase/tests/pgtap/0zz_call_api_public_execute_revoke_v1.sql');

const functions = [
  'public.call_api(TEXT, TEXT, JSONB, JSONB, INT)',
  'public.call_api_wait(TEXT, TEXT, JSONB, JSONB, INT, INT)',
  'public.dispatch_api_request_v1(TEXT, TEXT, JSONB, JSONB, INT)',
];

test('revokes browser execution only from every public pg_net wrapper', () => {
  expect(functions.every((signature) => migration.includes(`REVOKE EXECUTE ON FUNCTION ${signature}`))).toBe(true);
  expect(migration.match(/REVOKE EXECUTE ON FUNCTION/g)).toHaveLength(functions.length);
  expect(migration).not.toMatch(/GRANT EXECUTE|ALTER DEFAULT PRIVILEGES/i);
  expect(migration).toContain('FROM PUBLIC, anon, authenticated;');
});

test('pgTAP pins the exact browser denial and service-role retention contract', () => {
  expect(fixture).toContain('SELECT plan(12);');
  expect(fixture.match(/has_function_privilege\(/g)).toHaveLength(9);
  for (const name of ['call_api', 'call_api_wait', 'dispatch_api_request_v1']) {
    expect(fixture).toContain(`public.${name}`);
  }
  expect(fixture).toContain("has_function_privilege('service_role'");
  expect(fixture).toContain("has_function_privilege('anon'");
  expect(fixture).toContain("has_function_privilege('authenticated'");
});
