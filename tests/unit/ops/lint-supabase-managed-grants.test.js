const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { findManagedMutations, scanFile, eventBaseSha } = require('../../../scripts/ops/ci/lint-supabase-managed-grants');
const rules = require('../../../config/ci/supabase-managed-grants.json');

test.each([
  'GRANT USAGE ON SCHEMA auth TO custom_role;',
  'REVOKE EXECUTE ON FUNCTION auth.uid() FROM PUBLIC;',
  'ALTER TABLE storage.objects OWNER TO postgres;',
  'ALTER TABLE ONLY auth.users ADD COLUMN x int;',
  'DROP SCHEMA vault CASCADE;',
  'DROP FUNCTION auth.uid();',
  'CREATE OR REPLACE FUNCTION "auth"."x"() RETURNS int AS $$SELECT 1$$ LANGUAGE sql;',
  'COMMENT ON FUNCTION vault.x() IS \'x\';',
  'CREATE POLICY x ON realtime.messages USING(true);',
  'CREATE TRIGGER x BEFORE INSERT ON supabase_functions.hooks EXECUTE FUNCTION public.x();',
  'CREATE INDEX x ON net.http_request_queue(id);',
  'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin GRANT SELECT ON TABLES TO postgres;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
  'CREATE SCHEMA app AUTHORIZATION supabase_admin;',
  'ALTER FUNCTION public.x() OWNER TO supabase_auth_admin;',
  'ALTER ROLE supabase_storage_admin BYPASSRLS;',
  'CREATE ROLE supabase_fake SUPERUSER;',
  'DROP ROLE supabase_auth_admin;',
  "EXECUTE 'GRANT USAGE ON SCHEMA ' || quote_ident(target_schema) || ' TO custom_role';",
  "EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO anon',schema_name);",
  'GRANT supabase_admin TO postgres;',
  'GRANT ordinary_role, supabase_admin TO postgres;',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres, supabase_admin GRANT SELECT ON TABLES TO anon;',
  'REVOKE supabase_admin FROM postgres;',
  'COMMENT ON ROLE supabase_admin IS \'x\';',
  'SET LOCAL ROLE supabase_auth_admin;',
  'CREATE EXTENSION IF NOT EXISTS supabase_vault;',
  "EXECUTE format('GRANT USAGE ON SCHEMA %I TO custom_role','auth');",
  "EXECUTE format('ALTER FUNCTION %s OWNER TO custom_role',target);",
  'GRANT USAGE ON SCHEMA public, graphql, vault TO custom_role;',
])('blocks managed mutation or unresolved dynamic authority: %s', source => {
  expect(findManagedMutations(source).length).toBeGreaterThan(0);
});

test.each([
  'SELECT auth.uid(),auth.jwt();',
  'CREATE FUNCTION public.x() RETURNS uuid LANGUAGE sql AS $$SELECT auth.uid()$$;',
  'CREATE VIEW public.own_objects AS SELECT * FROM storage.objects;',
  'GRANT EXECUTE ON FUNCTION public.x() TO authenticated;',
  'CREATE TABLE public.rows(id uuid REFERENCES auth.users(id));',
  '-- GRANT USAGE ON SCHEMA auth TO custom_role;\nSELECT 1;',
  '/* outer /* GRANT USAGE ON SCHEMA auth TO custom_role; */ still a comment */ SELECT 1;',
])('allows reads/application-owned DDL and ignores real comments: %s', source => {
  expect(findManagedMutations(source)).toEqual([]);
});

test('allowlist and historical baseline are exact-content bound with a mandatory review reason', () => {
  const file = 'supabase/migrations/20990101000000_reviewed.sql';
  const source = 'GRANT USAGE ON SCHEMA auth TO custom_role;';
  const sha256 = crypto.createHash('sha256').update(source).digest('hex');
  const scoped = { ...rules, baseline: { reason: 'unchanged dev history', files: {} }, allowlist: [{ file, sha256, reason: 'Controlled test of an explicit reviewed exception.' }] };
  expect(scanFile(file, source, scoped).allowed).toBe(true);
  expect(scanFile(file, source + '\nREVOKE ALL ON storage.objects FROM anon;', scoped).allowed).toBe(false);
  expect(scanFile(file, source, { ...scoped, allowlist: [{ file, sha256, reason: '' }] }).allowed).toBe(false);
  expect(scanFile(file, source, { ...scoped, allowlist: [], baseline: { ...scoped.baseline, files: { [file]: sha256 } } }).allowed).toBe(true);
});

test('the hosted lint lane includes both database guards', () => {
  const root = path.resolve(__dirname, '../../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts['lint:db:managed-grants']).toBe('node scripts/ops/ci/lint-supabase-managed-grants.js');
  expect(pkg.scripts['lint:db:fixtures']).toBe('node scripts/ops/ci/migration-fixture-guard.js');
  const lane = fs.readFileSync(path.join(root, 'scripts/ci-hosted/tasks.cjs'), 'utf8');
  expect(lane).toContain("npmScript('lint:db:fixtures')");
  expect(lane).toContain("npmScript('lint:db:managed-grants')");
});


test('General mode resolves the proven PR base with the shared resolver contract', () => {
  const resolveBaseRef = jest.fn(() => 'base-sha');
  const listChangedActiveMigrations = jest.fn(() => []);
  const oldEventPath = process.env.GITHUB_EVENT_PATH;
  delete process.env.GITHUB_EVENT_PATH;
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => {
      jest.doMock('../../../scripts/ops/ci/changed-migrations-regex', () => ({ resolveBaseRef }));
      jest.doMock('../../../scripts/ops/ci/migration-fixture-guard', () => ({ listChangedActiveMigrations }));
      const { main } = require('../../../scripts/ops/ci/lint-supabase-managed-grants');
      main([]);
      expect(resolveBaseRef).toHaveBeenCalledWith({});
      expect(listChangedActiveMigrations).toHaveBeenCalledWith({ baseRef: 'base-sha' });
      resolveBaseRef.mockReturnValue('');
      expect(() => main([])).toThrow('proven PR/base ref is required');
    });
  } finally {
    log.mockRestore();
    if (oldEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = oldEventPath;
    jest.dontMock('../../../scripts/ops/ci/changed-migrations-regex');
    jest.dontMock('../../../scripts/ops/ci/migration-fixture-guard');
  }
});


test.each([
  { pull_request: { base: { sha: 'a'.repeat(40) } } },
  { merge_group: { base_sha: 'a'.repeat(40) } },
  { inputs: { base_sha: 'a'.repeat(40) } },
])('uses exact PR, merge-group and manual event bases without requiring origin refs', event => {
  expect(eventBaseSha(event)).toBe('a'.repeat(40));
});

test('rejects malformed event base identity and leaves local-gate fallback available only when absent', () => {
  expect(eventBaseSha({})).toBe('');
  expect(() => eventBaseSha({ merge_group: { base_sha: 'dev' } })).toThrow('Invalid exact base SHA');
});
