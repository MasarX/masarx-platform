const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/202609060500_onboarding_label_design_readiness_v1.sql'), 'utf8');
const predecessor = fs.readFileSync(path.join(root, 'supabase/migrations/202604171830_onboarding_readiness_security_freshness_scope_v1.sql'), 'utf8');
const native = fs.readFileSync(path.join(root, 'supabase/tests/pgtap/0zz_onboarding_workflow_plugin_label_readiness_v1.sql'), 'utf8');
function snapshot(source) {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.onboarding_readiness_snapshot_v1(');
  return source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length);
}
test('grafts only label aggregation onto the latest guarded snapshot', () => {
  const expected = snapshot(predecessor)
    .replace("  v_category RECORD;", "  v_label_status JSONB := '{}'::jsonb;\n  v_label_findings JSONB := '[]'::jsonb;\n  v_category RECORD;")
    .replace("  v_blocking_findings := v_blocking_findings || v_plugin_findings;",
      "  v_label_status := public.onboarding_label_design_readiness_v1(v_scope_type, v_scope_id);\n  v_label_findings := COALESCE(v_label_status->'blocking_findings', '[]'::jsonb);\n\n  v_blocking_findings := v_blocking_findings || v_plugin_findings || v_label_findings;")
    .replace("    v_overall_status := 'pending_credentials';\n  ELSE",
      "    v_overall_status := 'pending_credentials';\n  ELSIF COALESCE(v_label_status->>'status', '') = 'warning' THEN\n    v_overall_status := 'warning';\n  ELSE")
    .replace("    'blocking_findings', v_blocking_findings", "    'label_design', v_label_status - 'blocking_findings',\n    'blocking_findings', v_blocking_findings");
  expect(snapshot(migration)).toBe(expected);
});
test('appends schema and settings history with locked pointer CAS', () => {
  expect(migration).toContain('INSERT INTO public.schema_registry');
  expect(migration).toContain('COALESCE(MAX(version), 0) + 1');
  expect(migration).not.toMatch(/UPDATE public\.schema_registry\s+SET schema/);
  expect(migration).toContain('FOR UPDATE OF s, sv');
  expect(migration).toContain('s.settings_version_id = v_row.settings_version_id');
  expect(migration).toContain('FROM closed RETURNING id, value');
  expect(migration).toContain('lost settings pointer CAS');
});
test('preserves explicit policy values and detects inconsistent source state', () => {
  expect(migration).toContain("public.jsonb_deep_merge(v_defaults, COALESCE(v_row.value->'label_design', '{}'::jsonb))");
  expect(migration).toContain('v_row.cached_value IS DISTINCT FROM v_row.value');
  expect(migration).not.toContain('upsert_settings_value_v1(');
});
test('fails closed for missing templates and redacts provider failures and credentials', () => {
  expect(migration).toContain("jsonb_typeof(v_value->'templates') IS DISTINCT FROM 'object'");
  expect(migration).toContain("v_provider_error := 'renderer_provider_configuration_unavailable'");
  expect(migration).not.toContain('SQLERRM');
  expect(migration).toContain("THEN NULL ELSE 'redacted' END");
  expect(migration).toContain("THEN NULL ELSE 'configured' END");
});
test('keeps service-only helpers and leaves the authenticated API wrapper unchanged', () => {
  expect(migration).toContain('REVOKE ALL ON FUNCTION public.onboarding_label_design_readiness_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated');
  expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.onboarding_label_design_readiness_v1(TEXT, UUID) TO service_role');
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.ui_get_onboarding_readiness_v1');
  expect(migration).not.toContain('CREATE OR REPLACE FUNCTION api.ui_get_onboarding_readiness_v1');
});
test('retains native boundary cases without claiming their execution here', () => {
  expect(native).toContain('SELECT plan(25)');
  for (const text of ['missing templates key', 'JSON null templates', 'provider-secret-sentinel-652',
    'explicit empty categories', 'required missing certification', 'optional missing certification', 'required JSON null certification', 'required false certification',
    'required numeric scalar certification', 'required string scalar certification', 'null leading certification alias']) {
    expect(native).toContain(text);
  }
  expect(native).toContain("EXECUTE current_setting('test.label_readiness.original_settings')");
  expect(native.trim().endsWith('ROLLBACK;')).toBe(true);
});

test('uses one fail-closed certification shape fact after normalizing JSON null aliases', () => {
  for (const alias of ["v_print_profile->'printer_certification'", "v_print_profile->'certification'",
    "v_print_profile->'certified_printers'", "v_print_profile#>'{media,certification}'"]) {
    expect(migration).toContain(`NULLIF(${alias}, 'null'::jsonb)`);
  }
  expect(migration).toContain("jsonb_typeof(v_certification) IN ('object', 'array')");
  expect(migration).toContain("v_certification NOT IN ('{}'::jsonb, '[]'::jsonb), FALSE");
  expect(migration).toContain('IF NOT v_certification_valid THEN');
  expect(migration).toContain("WHEN NOT v_certification_valid THEN 'missing'");
});

describe('persistable printer certification aliases', () => {
  const { upsertSettings } = require('../../../scripts/utils/settings-upsert.js');
  const schemaMigration = fs.readFileSync(path.join(root,
    'supabase/migrations/202609060800_label_print_profile_certification_schema_v1.sql'), 'utf8');
  const persistedNative = fs.readFileSync(path.join(root,
    'supabase/tests/pgtap/0zz_label_print_profile_certification_persisted_v1.sql'), 'utf8');
  const schema = JSON.parse(schemaMigration.match(/v_extended JSONB := '([^']+)'::jsonb/)[1]);
  const canonical = JSON.parse(schemaMigration.match(/v_canonical JSONB := '([^']+)'::jsonb/)[1]);
  const profiles = JSON.parse(persistedNative.match(/\$profiles\$([\s\S]*?)\$profiles\$/)[1]);
  function adapter(activeSchema = schema, schemaVersion = 2) {
    const writes = [];
    const db = { query: jest.fn(async (sql, args) => {
      if (sql.includes('information_schema.tables')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FROM public.scope_type_registry')) {
        return { rowCount: 1, rows: [{ scope_type: 'global', entity_table: null }] };
      }
      if (sql.includes('FROM public.schema_registry')) {
        return { rowCount: 1, rows: [{ version: schemaVersion, schema: JSON.parse(JSON.stringify(activeSchema)) }] };
      }
      if (sql.includes('FROM public.settings s')) return { rowCount: 0, rows: [] };
      if (sql.includes('public.upsert_settings_value_v1(')) {
        writes.push(args);
        return { rowCount: 1, rows: [{ settings_version_id: 'fixture', settings_version_number: 1 }] };
      }
      throw new Error('Unexpected settings admission query');
    }) };
    return { db, writes };
  }
  async function admit(value, activeSchema = schema) {
    const probe = adapter(activeSchema);
    await upsertSettings({ db: probe.db, category: 'label_print_profile',
      scopeType: 'global', value, changeReason: 'certification schema contract' });
    return probe;
  }
  test.each(profiles.map((fixture, index) => [index, fixture]))(
    'admits exact full native profile %s through actual Ajv2020 settings admission', async (_index, fixture) => {
      const probe = await admit(fixture.value);
      expect(probe.writes).toHaveLength(1);
      expect(JSON.parse(probe.writes[0][3])).toEqual(fixture.value);
      expect(probe.writes[0][4]).toBe(2);
    });
  test.each([
    ['draft07', 'http://json-schema.org/draft-07/schema#'],
    ['draft2020', 'https://json-schema.org/draft/2020-12/schema'],
  ])('repeated %s reads use fresh same-id schemas and current constraints', async (name, meta) => {
    const definitionsKey = name === 'draft2020' ? '$defs' : 'definitions';
    const active = {
      $schema: meta, $id: 'urn:masarx:settings-admission:' + name,
      type: 'object', additionalProperties: false, required: ['count'],
      properties: { count: { $ref: '#/' + definitionsKey + '/count' } },
      [definitionsKey]: { count: { type: 'integer', maximum: 2 } },
    };
    const write = (probe, count) => upsertSettings({ db: probe.db,
      category: 'label_print_profile', scopeType: 'global', value: { count } });
    const initial = adapter(active);
    await write(initial, 2);
    await write(initial, 2);
    expect(initial.writes).toHaveLength(2);
    const narrower = JSON.parse(JSON.stringify(active));
    narrower[definitionsKey].count.maximum = 1;
    const replacement = adapter(narrower, 3);
    await expect(write(replacement, 2)).rejects.toThrow('Schema validation failed');
    expect(replacement.writes).toHaveLength(0);
    await write(replacement, 1);
    expect(replacement.writes[0][4]).toBe(3);
    const broader = JSON.parse(JSON.stringify(active));
    broader[definitionsKey].count.maximum = 4;
    const latest = adapter(broader, 4);
    await write(latest, 3);
    expect(latest.writes[0][4]).toBe(4);
  });
  test('only adds the four optional aliases, retaining every original constraint', () => {
    const stripped = JSON.parse(JSON.stringify(schema));
    for (const alias of ['printer_certification', 'certification', 'certified_printers']) {
      delete stripped.properties[alias];
    }
    delete stripped.properties.media.properties.certification;
    expect(stripped).toEqual(canonical);
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    const predecessorSchema = JSON.parse(fs.readFileSync(path.join(root,
      'supabase/migrations/202512261700_label_print_profile_defaults.sql'), 'utf8')
      .match(/SELECT \$\$([\s\S]*?)\$\$::jsonb AS schema_doc/)[1]);
    expect(canonical).toEqual(predecessorSchema);
  });
  const aliases = ['printer_certification', 'certification', 'certified_printers', 'media.certification'];
  const invalidProfiles = aliases.flatMap(alias => [false, 7, 'invalid', {}, []].map(evidence => ({
    version: 1, profile_key: 'fixture', dpi: 203,
    ...(alias === 'media.certification' ? { media: { certification: evidence } } : { [alias]: evidence }),
  })));
  invalidProfiles.push(
    { profile_key: 'fixture', dpi: 203 },
    { version: 1, profile_key: '', dpi: 203 },
    { version: 1, profile_key: 'fixture', dpi: 601 },
    { version: 1, profile_key: 'fixture', dpi: 203, unexpected: true },
    { version: 1, profile_key: 'fixture', dpi: 203, media: { unexpected: true } },
    { version: 1, profile_key: 'fixture', dpi: 203, media: { darkness: 31 } },
    { version: 1, profile_key: 'fixture', dpi: 203, barcode: { target_module_width_dots: 11 } },
  );
  test.each(invalidProfiles.map((value, index) => [index, value]))(
    'rejects invalid evidence or prior profile constraint %s before canonical mutation', async (_index, value) => {
      const probe = adapter();
      await expect(upsertSettings({ db: probe.db, category: 'label_print_profile',
        scopeType: 'global', value })).rejects.toThrow('Schema validation failed');
      expect(probe.writes).toHaveLength(0);
    });
  test('does not bypass explicit narrower schema constraints during admission', async () => {
    const custom = JSON.parse(JSON.stringify(schema));
    custom.properties.dpi.maximum = 200;
    await expect(admit(profiles[0].value, custom)).rejects.toThrow('Schema validation failed');
  });
  test('schema append is guarded and never rewrites settings values or pointers', () => {
    expect(schemaMigration).toContain('LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE');
    expect(schemaMigration).toContain('IF v_current.schema = v_extended THEN');
    expect(schemaMigration).toContain('IF v_current.schema IS DISTINCT FROM v_canonical THEN');
    expect(schemaMigration).toContain('COALESCE(MAX(version), 0) + 1');
    expect(schemaMigration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.settings/);
    expect(schemaMigration).not.toMatch(/UPDATE public\.schema_registry SET schema/);
    expect(persistedNative).toContain('public.upsert_settings_value_v1(');
    expect(persistedNative).toContain('public.resolve_settings_row(');
    expect(persistedNative).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
    expect(persistedNative.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(persistedNative).toContain('SELECT plan(' + (1 + profiles.length * 2) + ')');
  });
});
