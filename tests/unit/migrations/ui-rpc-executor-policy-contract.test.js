const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../..');
const cutoff = '20261027030000';

// Check literal and dynamically quoted DDL alike; unknown relation names fail closed too.
function missingExecutorPolicies(source) {
  const sql = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\bformat\s*\(\s*'((?:[^']|'')*)'((?:\s*,\s*(?:'(?:[^']|'')*'|[a-z_][a-z_0-9.]*))*)\s*\)/gi,
      (_, template, argumentsSql) => {
        const args = [...argumentsSql.matchAll(/,\s*('(?:[^']|'')*'|[a-z_][a-z_0-9.]*)/gi)]
          .map(([ , arg]) => arg.startsWith("'") ? arg.slice(1, -1).replace(/''/g, "'") : null);
        let next = 0;
        return template.replace(/''/g, "'").replace(/%(?:(\d+)\$)?([%sIL])/g, (token, position, type) => {
          if (type === '%') return '%';
          const index = position ? Number(position) - 1 : next;
          next = index + 1;
          if (args[index] == null) return token;
          return type === 'I' ? `"${args[index].replace(/"/g, '""')}"` : args[index];
        });
      });
  const failures = [];
  for (const match of sql.matchAll(/\b(?:CREATE|ALTER)\s+POLICY\s+[^;]*?\bTO\s+([^;]*?)(?=\bUSING\b|\bWITH\s+CHECK\b|;|$)/gi)) {
    const roles = match[1].replace(/'/g, '').trim().split(/\s*,\s*/).map((role) =>
      role.startsWith('"') && role.endsWith('"') ? role.slice(1, -1).replace(/""/g, '"') : role.toLowerCase());
    if (/%(?:(?:\d+)\$)?[sIL]/.test(match[1])
      || (roles.includes('authenticated') && !roles.includes('ui_rpc_executor'))) failures.push(match[0].trim());
  }
  return failures;
}

test.each([
  ['CREATE POLICY read ON public.webhook_rules FOR SELECT TO authenticated USING (true);', 1],
  ['ALTER POLICY read ON public.webhook_rules TO authenticated;', 1],
  ['ALTER POLICY read ON public.webhook_rules TO AUTHENTICATED;', 1],
  ['ALTER POLICY read ON public.webhook_rules TO authenticated, "UI_RPC_EXECUTOR";', 1],
  ['ALTER POLICY read ON public.webhook_rules TO AUTHENTICATED, UI_RPC_EXECUTOR;', 0],
  ['CREATE POLICY read ON public.future_registry_table TO service_role, authenticated USING (true);', 1],
  ['CREATE POLICY read ON public.webhook_rules TO "authenticated", "ui_rpc_executor" USING (true);', 0],
  ['ALTER POLICY read ON public.webhook_rules TO ui_rpc_executor, authenticated;', 0],
  ["EXECUTE 'CREATE POLICY read ON public.%I TO authenticated USING (true)';", 1],
  ['CREATE POLICY read ON public.webhook_rules TO authenticated /* ui_rpc_executor */ USING (true);', 1],
  ['-- CREATE POLICY fake ON public.webhook_rules TO authenticated;\nSELECT 1;', 0],
  ['CREATE POLICY svc ON public.webhook_rules TO service_role USING (true);', 0],
  ["EXECUTE format('CREATE POLICY p ON public.t TO %s USING (true)', 'authenticated');", 1],
  ["EXECUTE format('ALTER POLICY p ON public.%I TO %s', table_name, 'authenticated');", 1],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %1$I, %2$I', 'authenticated', 'ui_rpc_executor');", 0],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %I', 'AUTHENTICATED');", 0],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %s', 'AUTHENTICATED');", 1],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %s', role_name);", 1],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %I', role_name);", 1],
  ["EXECUTE format('ALTER POLICY p ON public.t TO %2$I', table_name, role_name);", 1],
  ["EXECUTE format('ALTER POLICY p ON public.t TO ui_rpc_executor, %s', role_name);", 1],
  ["EXECUTE format('ALTER POLICY p ON public.%I TO service_role', table_name);", 0],
])('policy drift scanner: %s', (sql, count) => {
  expect(missingExecutorPolicies(sql)).toHaveLength(count);
});

test('later migrations preserve executor applicability on authenticated policies', () => {
  const dir = path.join(root, 'supabase/migrations');
  const failures = fs.readdirSync(dir).filter((file) => file.endsWith('.sql') && file.split('_')[0] > cutoff)
    .flatMap((file) => missingExecutorPolicies(fs.readFileSync(path.join(dir, file), 'utf8'))
      .map((ddl) => `${file}: ${ddl}`));
  expect(failures).toEqual([]);
});

test('rollback consumes exact forward before-images, drops only new helpers, and restores prior RPCs', () => {
  const file = '20261027030000_ui_rpc_executor_role_v1.sql';
  const forward = fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8');
  const rollback = fs.readFileSync(path.join(root, 'supabase/rollback', file), 'utf8');
  const entrypoints = new Set(['ui_get_resource_v1', 'ui_list_resource_v1', 'ui_update_resource_v1',
    'ui_delete_resource_v1', 'ui_filter_distinct_values_v1', 'ui_resource_metrics_v1']);
  const functions = [...forward.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((match) => match[1]);
  expect(functions.filter((name) => entrypoints.has(name)).sort()).toEqual([...entrypoints].sort());
  const helpers = functions.filter((name) => !entrypoints.has(name)).sort();
  const snapshotHelpers = [...forward.matchAll(/SELECT 'created_functions',[\s\S]*?FROM pg_proc WHERE oid='public\.(\w+)\([^']*\)'::regprocedure;/g)]
    .map((match) => match[1]);
  expect(rollback).toMatch(/jsonb_array_elements\(CASE WHEN s.key='created_functions' THEN s.value ELSE '\[\]'::jsonb END\) f\s+LOOP\s+EXECUTE format\('DROP FUNCTION %s',to_regprocedure\(entry->>'signature'\)\);/);
  const droppedHelpers = [...rollback.matchAll(/DROP FUNCTION public\.(\w+)\(/g)].map((match) => match[1]);
  expect([...droppedHelpers, ...snapshotHelpers].sort()).toEqual(helpers);
  expect(rollback.match(/DROP ROLE ui_rpc_executor;/g)).toHaveLength(1);
  expect(rollback).toContain('DROP TABLE public.ui_rpc_executor_rollback_state_v1;');
  expect(forward).toContain('CREATE TABLE public.ui_rpc_executor_rollback_state_v1');
  expect(forward.indexOf('pg_get_functiondef(p.oid)')).toBeLessThan(forward.indexOf('CREATE OR REPLACE FUNCTION public.ui_get_resource_v1('));
  expect(rollback).toContain("EXECUTE entry->>'definition'");
  expect(rollback).toMatch(/jsonb_array_elements\(CASE WHEN s.key='modified_functions' THEN s.value ELSE '\[\]'::jsonb END\) f\s+LOOP\s+EXECUTE entry->>'before_definition';/);
  expect(forward).toContain('COMMENT ON TABLE public.ui_rpc_executor_rollback_state_v1 IS %L');
  for (const source of [forward, rollback]) {
    expect(source).toContain('ui_rpc_executor_rollback_state_v1:sha256:');
    expect(source).toContain("pg_catalog.sha256(convert_to(COALESCE(jsonb_object_agg(key,value ORDER BY key),'{}'::jsonb)::text,'UTF8'))");
  }
  expect(rollback.indexOf('LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN ACCESS EXCLUSIVE MODE'))
    .toBeLessThan(rollback.indexOf('obj_description('));
  expect(rollback.indexOf('executor rollback snapshot integrity mismatch'))
    .toBeLessThan(rollback.indexOf('ALTER FUNCTION %s OWNER'));
  expect(forward.indexOf('$seal$;')).toBeGreaterThan(forward.indexOf('$grants$;'));
  expect(forward).toContain("'owner',pg_get_userbyid(p.proowner)");
  expect(rollback).toContain("ALTER FUNCTION %s OWNER TO %I");
  expect(rollback).toContain("entry->>'owner'");
  expect(rollback).toContain('WITH INHERIT TRUE, SET TRUE');
  expect(rollback).not.toContain('WITH INHERIT FALSE');
  expect(forward).toContain('WITH INHERIT FALSE, SET TRUE');
  expect(rollback).toContain('executor rollback blocked by later policies: %');
  expect(rollback).toContain("format('%I ON %s',p.polname,p.polrelid::regclass)");
  expect(rollback.indexOf('executor rollback blocked by later policies')).toBeLessThan(rollback.indexOf('ALTER FUNCTION %s OWNER'));
  expect(rollback).toContain("entry->'roles'");
  expect(rollback).toContain('DROP POLICY ui_rpc_executor_trusted');
  expect(rollback).toContain('REVOKE %s%s ON TABLE %s FROM ui_rpc_executor');
  expect(rollback).toContain('REVOKE EXECUTE ON FUNCTION %s FROM ui_rpc_executor');
  expect(rollback).toContain('REVOKE USAGE ON SCHEMA %I FROM ui_rpc_executor');
  for (const key of ['entrypoints', 'registry_schema', 'policies', 'trusted_relations', 'grants', 'settings:%']) {
    expect(forward).toContain(`'${key === 'settings:%' ? 'settings:' : key}'`);
    expect(rollback).toContain(`'${key}'`);
  }
  expect(rollback).toContain("ui_read_registry changed after executor installation");
  expect(rollback).not.toMatch(/CASCADE|DROP OWNED|DISABLE ROW LEVEL SECURITY/);
  expect(rollback.trim()).toMatch(/COMMIT;$/);
});

test('new rollback table follows the existing 003a service-only predicates through the canonical helper', () => {
  const forward = fs.readFileSync(path.join(root, 'supabase/migrations/20261027030000_ui_rpc_executor_role_v1.sql'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'supabase/migrations/202512261520_partition_leaf_rls_grants_lockdown.sql'), 'utf8');
  const contract = fs.readFileSync(path.join(root, 'supabase/tests/pgtap/003a_verify_rls_service_only.sql'), 'utf8');
  expect(forward).toContain("SELECT public.enforce_service_only_rls_v1('public.ui_rpc_executor_rollback_state_v1'::regclass)");
  expect(helper).toContain('ENABLE ROW LEVEL SECURITY');
  expect(forward).toContain('REVOKE ALL ON TABLE public.ui_rpc_executor_rollback_state_v1 FROM service_role, ui_rpc_executor;');
  for (const role of ['PUBLIC', 'anon', 'authenticated']) expect(helper).toContain(`REVOKE ALL ON TABLE %I.%I FROM ${role}`);
  expect(helper).toContain('FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)');
  for (const phrase of ['All service-only tables have RLS enabled', 'All service-only tables have a service_role ALL policy',
    'All service-only tables have no anon/authenticated grants']) expect(contract).toContain(phrase);
});

test('rollback state keys are inserted once as single rows before any update', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/migrations/20261027030000_ui_rpc_executor_role_v1.sql'), 'utf8');
  const inserted = new Map();
  for (const match of source.matchAll(/\b(INSERT INTO|UPDATE) public\.ui_rpc_executor_rollback_state_v1\b[\s\S]*?;/g)) {
    const statement = match[0];
    if (match[1] === 'INSERT INTO') {
      const keys = [...statement.matchAll(/(?:\bSELECT\s+|\bVALUES\s*\(|\)\s*,\s*\()\s*'([^']+)'/g)].map((key) => key[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(inserted.has(key)).toBe(false);
        inserted.set(key, match.index);
      }
      if (/\bSELECT\s+'/.test(statement)) {
        const aggregate = /\bSELECT\s+'[^']+'\s*,\s*(?:COALESCE\()?jsonb_agg\(/.test(statement)
          && !/\bGROUP BY\b/.test(statement);
        const uniqueOid = /\bFROM pg_(?:proc|class)(?: [a-z_]+)? WHERE (?:[a-z_]+\.)?oid='[^']+'::reg(?:procedure|class);$/.test(statement);
        expect(aggregate || uniqueOid).toBe(true);
      }
    } else {
      const key = statement.match(/\bWHERE key='([^']+)'/);
      expect(key).not.toBeNull();
      expect(inserted.has(key[1])).toBe(true);
      expect(inserted.get(key[1])).toBeLessThan(match.index);
    }
  }
  expect(source).toMatch(/SELECT 'modified_functions',jsonb_agg\([\s\S]*?ORDER BY oid::regprocedure::text\)/);
  expect(source).toContain("ORDER BY entry->>'signature'");
});
