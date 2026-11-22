const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (name) => readFileSync(join(__dirname, '../../..', name), 'utf8');
const source = read('supabase/migrations/20261027030000_ui_rpc_executor_role_v1.sql');
const proof = read('supabase/tests/pgtap/0zz_ui_rpc_executor_role_v1.sql');

test('the registry executor stays isolated from caller roles and relation ownership', () => {
  expect(source).toContain('CREATE ROLE ui_rpc_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
  expect(source).toContain('REVOKE CREATE ON SCHEMA public FROM ui_rpc_executor');
  expect(source).not.toMatch(/GRANT\s+(authenticated|service_role)\s+TO\s+ui_rpc_executor/i);
  expect(proof).toContain('executor owns no relation');
  expect(proof).toContain('explicit ACLs equal the registry/dependency privilege plan exactly');
  expect(proof).toContain('update denies foreign row');
  expect(proof).toContain('delete denies foreign row');
});
