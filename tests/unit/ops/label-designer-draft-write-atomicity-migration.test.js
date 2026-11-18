const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const migrationName = '202610190901_label_designer_draft_write_atomicity_v1.sql';
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read(`supabase/migrations/${migrationName}`);
const historicalDefinitions = [
  ['label_designer_update_draft', '202602191150_label_designer_draft_write_rpcs_v1.sql'],
  ['label_designer_publish_label_design_draft', '202602191130_label_designer_capability_gates.sql'],
];

function definition(source, name) {
  const result = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`, 'i'));
  if (!result) throw new Error(`Missing function definition: ${name}`);
  return result[0];
}

const compact = (source) => source.replace(/\s+/g, ' ').trim();

describe('label designer draft write atomicity migration', () => {
  test.each(historicalDefinitions)('%s changes only the lock on the latest inherited body', (name, historicalName) => {
    const original = definition(read(`supabase/migrations/${historicalName}`), name);
    const replacement = definition(migration, name);
    expect(compact(replacement.replace(/\s+FOR UPDATE(?=;)/, ''))).toBe(compact(original));

    const definitions = fs.readdirSync(path.join(root, 'supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .filter((file) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, 'i')
        .test(read(`supabase/migrations/${file}`)));
    expect(definitions.at(-2)).toBe(historicalName);
    expect(definitions.at(-1)).toBe(migrationName);
    expect(replacement.match(/FOR UPDATE/g)).toHaveLength(1);
    expect(replacement).toMatch(/WHERE d\.id = p_draft_id\s+AND d\.organization_id = v_org\s+LIMIT 1\s+FOR UPDATE;/);
    expect(replacement.indexOf('FOR UPDATE;')).toBeLessThan(replacement.indexOf('IF NOT v_service_role'));
    expect(replacement.indexOf('FOR UPDATE;')).toBeLessThan(replacement.indexOf('.status IS DISTINCT FROM'));
  });

  test('guards the complete immutable row while retaining archive and timestamp updates', () => {
    const guard = definition(migration, 'label_design_drafts_guard_immutable_v1');
    const protectedFields = [
      'id', 'organization_id', 'scope_type', 'scope_id', 'label_type', 'draft_name',
      'draft_value', 'created_by', 'created_at', 'published_settings_version_id', 'published_at',
    ];
    const newFields = [...guard.matchAll(/NEW\.(\w+)/g)].map((match) => match[1]);
    const oldFields = [...guard.matchAll(/OLD\.(\w+)/g)].map((match) => match[1]);
    expect([...new Set(newFields)].sort()).toEqual([...protectedFields, 'status'].sort());
    expect([...new Set(oldFields)].sort()).toEqual([...protectedFields, 'status'].sort());
    expect(guard).toMatch(/OLD\.status IN \('published', 'archived'\)/);
    expect(guard).toMatch(/IS DISTINCT FROM\s+ROW\(OLD\.id/);
    expect(guard).toMatch(/NEW\.status IS DISTINCT FROM OLD\.status\s+AND NOT \(OLD\.status = 'published' AND NEW\.status IS NOT DISTINCT FROM 'archived'\)/);
    expect(guard).toContain("ERRCODE = '55000'");
    expect(guard).not.toContain('updated_at');
    expect(migration).toMatch(/CREATE TRIGGER trg_label_design_drafts_guard_immutable_v1\s+BEFORE UPDATE ON public\.label_design_drafts\s+FOR EACH ROW EXECUTE FUNCTION public\.label_design_drafts_guard_immutable_v1\(\)/);
  });

  test('adds no access-control relaxation, role creation, history replay, or data rewrite', () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*pg_advisory_xact_lock[\s\S]*COMMIT;\s*$/);
    expect(migration).toContain('SET LOCAL lock_timeout');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.label_design_drafts_guard_immutable_v1() FROM PUBLIC;');
    expect(migration).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|POLICY)|ALTER\s+(?:ROLE|TABLE)|DISABLE\s+TRIGGER|pg_get_functiondef|EXECUTE\s+format)\b/i);
    expect(migration).not.toMatch(/BEFORE\s+(?:UPDATE\s+OR\s+)?DELETE/i);
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(3);
  });

  test('forward ACL repair removes only public and anonymous write execution on the exact save and publish entrypoints', () => {
    const acl = read('supabase/migrations/202610202125_label_designer_draft_write_acl_v1.sql');
    expect(compact(acl.replace(/^--.*$/gm, ''))).toBe([
      "BEGIN; SET LOCAL lock_timeout = '30s';",
      'REVOKE EXECUTE ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;',
      'REVOKE EXECUTE ON FUNCTION api.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;',
      'REVOKE EXECUTE ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC, anon;',
      'REVOKE EXECUTE ON FUNCTION api.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC, anon;',
      'COMMIT;',
    ].join(' '));
  });

  test('native regression probes actual locks and authenticated API-view bypasses', () => {
    const native = read('supabase/tests/pgtap/0zz_label_designer_draft_write_atomicity_v1.sql');
    expect(native).toMatch(/UPDATE public\.settings_versions\s+SET effective_from = LEAST\(effective_from, public\.workflow_now\(\) - INTERVAL '1 microsecond'\)\s+WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = v_org\s+AND effective_until IS NULL AND approved_at IS NOT NULL;/);
    expect(native.indexOf('UPDATE public.settings_versions')).toBeLessThan(native.indexOf('v_value := public.resolve_settings_merged'));
    const planned = Number(native.match(/SELECT plan\((\d+)\)/)[1]);
    const assertions = (native.match(/RETURN NEXT (?:ok|is|throws_ok|lives_ok)\(/g) || []).length
      + (native.match(/^SELECT ok\(/gm) || []).length;
    expect(planned).toBe(assertions);
    expect(native.match(/xmax::text::bigint = txid_current\(\) % 4294967296/g)).toHaveLength(2);
    expect(native).toContain('api.label_designer_update_draft(v_save_id, NULL, NULL, \'[]\'::jsonb)');
    expect(native).toContain('api.label_designer_publish_label_design_draft(v_publish_probe_id');
    expect(native).toContain("SET LOCAL ROLE authenticated");
    expect(native).toContain("'role', 'authenticated'");
    expect(native).toContain('public.user_has_capability_v1');
    expect(native).toContain("'Label Atomicity Writer', 'ops_admin', 'active', 'tenant', NULL)");
    expect(native.match(/has_function_privilege\(/g)).toHaveLength(12);
    expect(native.match(/^SELECT ok\(/gm)).toHaveLength(13);
    expect(native).toContain('anonymous public draft-save execution remains denied');
    expect(native).toContain('anonymous API draft-save execution remains denied');
    expect(native).toContain('service_role retains public draft-save execution');
    expect(native).toContain('service_role retains API draft-save execution');
    expect(native).toContain('anonymous public draft-publish execution remains denied');
    expect(native).toContain('authenticated retains public draft-publish execution');
    expect(native).toContain('authenticated retains API draft-publish execution');
    expect(native).toContain('service_role retains API draft-publish execution');
    expect(native).toContain('anonymous API draft-publish execution remains denied');
    expect(native).toContain('UPDATE api.label_design_drafts SET draft_value');
    expect(native).toContain("SET status = ''draft''");
    expect(native).toContain("SET status = ''archived''");
    expect(native).toContain("api.label_designer_create_draft('tenant', v_org");
    expect(native).toMatch(/ROLLBACK;\s*$/);
  });
});
