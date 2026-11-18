const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261029113000_extension_public_acl_v1.sql');
const fixture = read('supabase/tests/pgtap/0zz_ui_rpc_executor_role_v1.sql');
const tablePrivileges = ['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'];
const allowed = [
  ['net._http_response', tablePrivileges], ['net.http_request_queue', tablePrivileges],
  ['net.http_request_queue_id_seq', ['SELECT','UPDATE','USAGE']],
].flatMap(([object_name, privileges]) => ['anon','authenticated','ui_rpc_executor'].map(role_name =>
  ({ object_name, role_name, owner: 'supabase_admin', privileges })));

test('platform exception pins exactly nine object/role rows and 57 privileges', () => {
  const literal = sql.match(/v_platform_defaults CONSTANT jsonb := \$platform_defaults\$\n([\s\S]*?)\n\$platform_defaults\$/)[1];
  expect(JSON.parse(literal)).toEqual(allowed);
  expect(allowed.reduce((n, row) => n + row.privileges.length, 0)).toBe(57);
  expect(sql).toContain("n.nspname='net' AND c.relkind IN ('r','p','v','m','f','S')");
  expect(sql).toContain('ORDER BY object_name COLLATE "C",role_name COLLATE "C"');
});

test('unrepairable branch rejects provenance drift and repairable objects before one canonical alert', () => {
  const branch = sql.slice(sql.indexOf('  IF NOT v_can_repair THEN'), sql.indexOf('  SELECT pg_get_userbyid(p.proowner) INTO v_dispatch_owner'));
  expect(branch.indexOf('IF v_unreviewed THEN')).toBeLessThan(branch.indexOf('INSERT INTO public.ops_alerts'));
  expect(branch).toContain('IF v_exposure<>v_platform_defaults OR EXISTS (');
  expect(branch).toContain("WHERE pg_has_role(current_user,c.relowner,'USAGE')");
  expect(branch.indexOf('IF v_exposure<>v_platform_defaults')).toBeLessThan(branch.indexOf('INSERT INTO public.ops_alerts'));
  expect(branch.match(/INSERT INTO public\.ops_alerts/g)).toHaveLength(1);
  expect(branch).toContain("VALUES(public.marketplace_system_org_id_v1(),'platform_pg_net_exposure','warning'");
  expect(branch).toContain("'classification','platform_default'");
  expect(branch).toContain('RAISE WARNING');
  expect(branch).toContain('alert_id=%, exposure=%');
  expect(branch).toContain("USING ERRCODE='42501'");
});

test('stock PUBLIC provenance rejects grant options, column grants, membership and new privileges', () => {
  expect(sql).toContain("a.grantee=0 AND pg_get_userbyid(a.grantor)='supabase_admin' AND NOT a.is_grantable");
  expect(sql).toContain('AND a.privilege_type=ANY(CASE');
  expect(sql).toContain('aclexplode(att.attacl)');
  expect(sql).toContain("SELECT 1 FROM pg_auth_members WHERE member='ui_rpc_executor'::regrole");
  expect(sql).toContain("WHERE has_schema_privilege(role_name,'net','CREATE')");
  expect(sql).toContain("a.grantee=ANY(ARRAY[0,'anon'::regrole::oid,'authenticated'::regrole::oid])");
});

test('cleanup revokes only application-issued executor grants across all net object types', () => {
  const cleanup = sql.slice(sql.indexOf('-- Remove only grants made'), sql.indexOf('  IF NOT v_can_repair THEN'));
  expect(cleanup.match(/a.grantee='ui_rpc_executor'::regrole AND a.grantor=current_user::regrole/g)).toHaveLength(4);
  for (const kind of ['SCHEMA', 'SEQUENCE', 'TABLE', 'FUNCTION']) expect(cleanup).toContain(kind);
  expect(cleanup).toContain('EXECUTE v_relation.command;');
  expect(cleanup).not.toContain('FROM PUBLIC');
  expect(sql).not.toMatch(/GRANT\s+supabase_\w+\s+TO|SET\s+(?:LOCAL\s+)?ROLE/i);
});

test('owner-authorized repair and every existing postcondition remain byte-identical', () => {
  const tail = sql.slice(sql.indexOf('  SELECT pg_get_userbyid(p.proowner) INTO v_dispatch_owner'));
  expect(createHash('sha256').update(tail).digest('hex')).toBe('bef797c2f3a7dcfe413d0543b15754b61dbe52e4d656a088f9f68b2cbb55bd02');
});

test('pgTAP pins the same literal matrix and checks own grants without broad extension exemptions', () => {
  const literal = fixture.match(/\$platform_defaults\$([\s\S]*?)\$platform_defaults\$::jsonb/)[1];
  expect(JSON.parse(literal)).toEqual(allowed);
  expect(fixture).toContain('remaining pg_net exposure is empty or exactly the recorded platform object/role/privilege set');
  expect(fixture).toContain('executor has no direct net grants or membership path created by the application');
  expect(fixture).toContain("details->>'classification'='platform_default' AND details->'exposure'=value");
  expect(fixture).toContain("AND c.relname IN ('_http_response','http_request_queue')");
});

test('modified-function pgTAP compares resolved identities instead of qualification-sensitive text', () => {
  expect(fixture).toContain("array_agg(to_regprocedure(entry->>'signature')::oid ORDER BY to_regprocedure(entry->>'signature')::oid)");
  expect(fixture).toContain("'public.ui_assert_read_relation_allowed_v1(text,text,text,text)'::regprocedure");
  expect(fixture).toContain("'public.ui_filter_tree_sql_v1(jsonb,jsonb,boolean)'::regprocedure");
  expect(fixture).not.toContain("array_agg(entry->>'signature' ORDER BY entry->>'signature')");
});
