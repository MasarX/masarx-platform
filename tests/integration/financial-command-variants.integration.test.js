// Draft destination: tests/integration/financial-command-variants.integration.test.js
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { loadEnv } = require('../../scripts/utils/load-env');
loadEnv();
if (!process.env.DATABASE_URL) throw new Error('Admitted DATABASE_URL required; no fallback');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
const category = 'ui_command_registry';
const names = ['cod_cash_handover', 'cod_cashier_count'];
const variant = {
  normalization: 'financial_amount_v1', title: 'Financial task completion',
  description: 'Record the amount using an authorized operational session. Settlement approval remains a separate workflow outcome.',
  fields: [{ key: 'amount', type: 'number', required: true, label: 'Amount' }],
};
function actualSeed() {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20260909112000_financial_task_command_variants_v1.sql'), 'utf8');
  const token = '$variants$';
  expect(sql.split(token)).toHaveLength(3);
  const start = sql.indexOf(`DO ${token}`), end = sql.indexOf(`${token};`, start + token.length + 3);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + token.length + 1);
}
const command = value => {
  const found = value.commands.filter(item => item.key === 'tasks.complete');
  expect(found).toHaveLength(1);
  return found[0];
};
const withoutTargets = value => {
  const copy = structuredClone(value);
  const overrides = command(copy).execution.input_schema.task_type_overrides;
  if (overrides) for (const key of names) delete overrides[key];
  return copy;
};
async function current(db, scope = 'global', id = null) {
  const { rows } = await db.query(`SELECT s.*,sv.value,sv.version,sv.schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category=$1 AND s.scope_type=$2 AND s.scope_id IS NOT DISTINCT FROM $3::uuid`, [category, scope, id]);
  expect(rows).toHaveLength(1);
  return rows[0];
}
async function upsert(db, scope, id, value, schema) {
  await db.query('SELECT * FROM public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
    [category, scope, id, JSON.stringify(value), schema, 'rollback financial command regression']);
}
async function prepareHistoricalVariantScopes(db) {
  // The historical seed scans every scope. Reconstruct its precondition only
  // inside this rolled-back fixture; current successor variants are not replay
  // inputs for the old amount-only migration and must never be overwritten live.
  const { rows } = await db.query(`SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category=$1 ORDER BY s.id`, [category]);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Array.isArray(row.value.commands)).toBe(true);
    const targets = row.value.commands.filter(item => item.key === 'tasks.complete');
    expect(targets.length).toBeLessThanOrEqual(1);
    if (!targets.length) continue;
    const value = withoutTargets(row.value);
    if (JSON.stringify(value) !== JSON.stringify(row.value)) {
      await upsert(db, row.scope_type, row.scope_id, value, row.schema_version);
    }
  }
}
async function snapshot(db) {
  return {
    settings: (await db.query('SELECT to_jsonb(s) AS row FROM public.settings s WHERE category=$1 ORDER BY id', [category])).rows.map(r => r.row),
    history: (await db.query('SELECT to_jsonb(v) AS row FROM public.settings_versions v WHERE category=$1 ORDER BY id', [category])).rows.map(r => r.row),
  };
}
async function validPointedSchema(db, row) {
  const { rows } = await db.query('SELECT schema FROM public.schema_registry WHERE category=$1 AND version=$2', [category, row.schema_version]);
  expect(rows).toHaveLength(1);
  const schema = rows[0].schema;
  const Validator = String(schema.$schema || '').includes('draft/2020-12') ? Ajv2020 : Ajv;
  const ajv = new Validator({ strict: false, allErrors: true, allowUnionTypes: true, addUsedSchema: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  expect({ valid: validate(row.value), errors: validate.errors }).toEqual({ valid: true, errors: null });
}
async function transaction(body) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await body(db); }
  finally { try { await db.query('ROLLBACK'); } finally { db.release(); } }
}
async function tenant(db) {
  const org = randomUUID(), actor = randomUUID();
  await db.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$3)', [org, 'Financial config regression', `financial-config-${org}`]);
  await db.query(`INSERT INTO public.users(id,organization_id,email,full_name,access_scope_type)
    VALUES($1,$2,$3,$4,'tenant')`, [actor, org, `${actor}@example.com`, 'Financial config actor']);
  return { org, actor };
}
describe('F675 exact configuration migration history, scope and API contract', () => {
  afterAll(() => pool.end());
  test.each(['global', 'tenant'])('%s: preserves defaults/history/schema and is replay-idempotent', async scope => transaction(async db => {
    await prepareHistoricalVariantScopes(db);
    const seed = actualSeed(), root = await current(db);
    const id = scope === 'tenant' ? (await tenant(db)).org : null;
    const baselineValue = withoutTargets(root.value);
    command(baselineValue).execution.input_schema.task_type_overrides = {
      ...command(baselineValue).execution.input_schema.task_type_overrides,
      unrelated_regression_type: { title: 'Unrelated override', fields: [] },
    };
    await upsert(db, scope, id, baselineValue, root.schema_version);
    const baseline = await current(db, scope, id);
    const closed = randomUUID(), future = randomUUID();
    await db.query(`INSERT INTO public.settings_versions
      (id,category,scope_type,scope_id,version,value,schema_version,change_reason,approved_at,effective_from,effective_until)
      SELECT $1::uuid,category,scope_type,scope_id,version+100,value,schema_version,'closed sentinel',
        now()-interval '3 days',now()-interval '3 days',now()-interval '2 days'
      FROM public.settings_versions WHERE id=$3
      UNION ALL SELECT $2::uuid,category,scope_type,scope_id,version+101,value,schema_version,'future sentinel',
        NULL,now()+interval '3 days',NULL FROM public.settings_versions WHERE id=$3`, [closed, future, baseline.settings_version_id]);
    const before = await snapshot(db);
    await db.query(seed);
    const after = await current(db, scope, id);
    expect(after.scope_type).toBe(scope); expect(after.scope_id).toBe(id);
    expect(after.schema_version).toBe(baseline.schema_version);
    expect(after.settings_version_id).not.toBe(baseline.settings_version_id);
    expect(after.version).toBe(baseline.version + 102);
    expect(after.cached_value).toEqual(after.value);
    for (const name of names) expect(command(after.value).execution.input_schema.task_type_overrides[name]).toEqual(variant);
    expect(withoutTargets(after.value)).toEqual(baselineValue);
    await validPointedSchema(db, after);
    const changed = await snapshot(db);
    for (const old of before.history) {
      const next = changed.history.find(row => row.id === old.id);
      expect(next).toBeDefined();
      if (old.approved_at && old.effective_until === null) {
        const { effective_until: ignored, ...oldImmutable } = old;
        const { effective_until: until, ...newImmutable } = next;
        expect(newImmutable).toEqual(oldImmutable);
        if (old.scope_type === scope && old.scope_id === id) {
          expect(until).not.toBeNull();
          expect((await db.query('SELECT effective_until>effective_from AS ok FROM public.settings_versions WHERE id=$1', [old.id])).rows[0].ok).toBe(true);
        }
      } else expect(next).toEqual(old);
    }
    for (const sentinel of [closed, future]) expect(changed.history.find(row => row.id === sentinel)).toEqual(before.history.find(row => row.id === sentinel));
    await db.query(seed);
    expect(await snapshot(db)).toEqual(changed);
  }), 120000);

  test.each([true, false])('tenant registry present=%s preserves actual ladder selection through authenticated API', async present => transaction(async db => {
    await prepareHistoricalVariantScopes(db);
    const seed = actualSeed(), root = await current(db), { org, actor } = await tenant(db);
    await upsert(db, 'global', null, withoutTargets(root.value), root.schema_version);
    const partial = { ...root.value, commands: root.value.commands.filter(item => item.key !== 'tasks.complete') };
    if (present) await upsert(db, 'tenant', org, partial, root.schema_version);
    const before = present ? await current(db, 'tenant', org) : null;
    await db.query(seed);
    if (present) expect(await current(db, 'tenant', org)).toEqual(before);
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),
      set_config('request.jwt.claim.role','authenticated',true),
      set_config('request.jwt.claims',$2,true)`, [actor, JSON.stringify({ role: 'authenticated', sub: actor })]);
    await db.query('SET LOCAL ROLE authenticated');
    const result = (await db.query(`SELECT auth.uid() AS actor,public.current_user_org_id() AS org,
      api.ui_command_registry_v1() AS registry,
      public.ui_command_registry_v1() AS public_registry`)).rows[0];
    expect(result.actor).toBe(actor); expect(result.org).toBe(org);
    expect(result.registry).toEqual(result.public_registry);
    if (present) {
      // Canonical array merge defaults to replace; omitted commands stay omitted.
      expect(result.registry.commands).toEqual(partial.commands);
      expect(result.registry.commands.some(item => item.key === 'tasks.complete')).toBe(false);
    } else {
      const input = command(result.registry).execution.input_schema;
      for (const name of names) expect(input.task_type_overrides[name]).toEqual(variant);
      expect(input.fields).toEqual(command(root.value).execution.input_schema.fields);
    }
    await db.query('RESET ROLE');
    await validPointedSchema(db, { ...root, value: result.registry });
  }), 120000);

  test.each([
    ['conflicting target', v => { command(v).execution.input_schema.task_type_overrides = { cod_cash_handover: { fields: [] } }; }, 'Financial task override conflict'],
    ['malformed override', v => { command(v).execution.input_schema.task_type_overrides = []; }, 'Financial task overrides invalid'],
    ['missing input schema', v => { delete command(v).execution.input_schema; }, 'Financial command input schema absent'],
    ['duplicate identity', v => { v.commands.push(structuredClone(command(v))); }, 'Duplicate tasks.complete command'],
    ['malformed registry', v => { v.commands = {}; }, 'Financial command registry shape invalid'],
  ])('%s fails atomically', async (_name, corrupt, message) => transaction(async db => {
    await prepareHistoricalVariantScopes(db);
    const seed = actualSeed(), root = await current(db), { org } = await tenant(db);
    const value = withoutTargets(root.value); corrupt(value);
    await upsert(db, 'tenant', org, value, root.schema_version);
    const before = await snapshot(db);
    await db.query('SAVEPOINT rejected_seed');
    await expect(db.query(seed)).rejects.toThrow(message);
    await db.query('ROLLBACK TO SAVEPOINT rejected_seed');
    expect(await snapshot(db)).toEqual(before);
  }), 120000);

  test('missing tasks.complete everywhere fails without partial history changes', async () => transaction(async db => {
    const seed = actualSeed();
    const { rows } = await db.query(`SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
      FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category=$1`, [category]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) await upsert(db, row.scope_type, row.scope_id,
      { ...row.value, commands: row.value.commands.filter(item => item.key !== 'tasks.complete') }, row.schema_version);
    const before = await snapshot(db);
    await db.query('SAVEPOINT rejected_seed');
    await expect(db.query(seed)).rejects.toThrow('No tasks.complete registry command found');
    await db.query('ROLLBACK TO SAVEPOINT rejected_seed');
    expect(await snapshot(db)).toEqual(before);
  }), 120000);
  function zeroSelectionMigration() {
    const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20260909113000_ui_command_zero_selection_schema_v1.sql'), 'utf8');
    const token = '$zero_selection$';
    expect(sql.split(token)).toHaveLength(3);
    return {
      body: 'DO ' + token + sql.split(token)[1] + token + ';',
      max: JSON.parse(sql.split('$zero_max$')[1]),
      guard: JSON.parse(sql.split('$zero_guard$')[1]),
    };
  }
  test('bootstrap preserves successor pointers and all five zero guards', async () => transaction(async db => {
    const migration = zeroSelectionMigration(), root = await current(db);
    const pointed = (await db.query('SELECT schema,is_active FROM public.schema_registry WHERE category=$1 AND version=$2', [category, root.schema_version])).rows;
    expect(pointed).toHaveLength(1);
    expect(pointed[0].is_active).toBe(true);
    expect(pointed[0].schema.properties.commands.items.properties.selection.properties.max_count).toEqual(migration.max);
    expect(pointed[0].schema.properties.commands.items.properties.selection.allOf).toEqual(migration.guard);
    expect(pointed[0].schema.properties.commands.items.properties.execution.properties.result_contract).toBeDefined();
    for (const suffix of ['document', 'vehicle_registration', 'vehicle_photos', 'cleaning', 'pre_shift']) {
      const found = root.value.commands.filter(c => c.key === 'driver_self_kyc.' + suffix);
      expect(found).toHaveLength(1);
      expect(found[0].selection).toEqual({ mode: 'none', max_count: 0 });
    }
    await validPointedSchema(db, root);
  }), 120000);
  test('repoints unchanged tenant values through new history and replay changes nothing', async () => transaction(async db => {
    const migration = zeroSelectionMigration(), root = await current(db), { org } = await tenant(db);
    const schemasBefore = (await db.query('SELECT version,schema,is_active FROM public.schema_registry WHERE category=$1 ORDER BY version', [category])).rows;
    const original = structuredClone(schemasBefore.find(row => row.version === root.schema_version).schema);
    original.properties.commands.items.properties.selection.properties.max_count = { type: 'integer', minimum: 1 };
    delete original.properties.commands.items.properties.selection.allOf;
    const old = (await db.query('SELECT version FROM public.schema_registry WHERE category=$1 AND schema=$2::jsonb ORDER BY version', [category, JSON.stringify(original)])).rows;
    expect(old).toHaveLength(1);
    await upsert(db, 'tenant', org, root.value, old[0].version);
    const before = await current(db, 'tenant', org), historyBefore = await snapshot(db);
    await db.query(migration.body);
    const after = await current(db, 'tenant', org);
    expect(after.value).toEqual(before.value);
    expect(after.schema_version).toBe(root.schema_version);
    expect(after.version).toBe(before.version + 1);
    expect(after.settings_version_id).not.toBe(before.settings_version_id);
    const historyAfter = await snapshot(db);
    for (const prior of historyBefore.history) {
      const retained = historyAfter.history.find(row => row.id === prior.id);
      expect(retained).toBeDefined();
      if (prior.id === before.settings_version_id) {
        expect(retained.effective_until).not.toBeNull();
        expect({ ...retained, effective_until: prior.effective_until }).toEqual(prior);
      } else expect(retained).toEqual(prior);
    }
    await validPointedSchema(db, after);
    await db.query(migration.body);
    expect(await snapshot(db)).toEqual(historyAfter);
    expect((await db.query('SELECT version,schema,is_active FROM public.schema_registry WHERE category=$1 ORDER BY version', [category])).rows).toEqual(schemasBefore);
  }), 120000);
  test('custom pointed schema fails closed without touching values or history', async () => transaction(async db => {
    const migration = zeroSelectionMigration(), root = await current(db), { org } = await tenant(db);
    const custom = (await db.query('SELECT schema FROM public.schema_registry WHERE category=$1 AND version=$2', [category, root.schema_version])).rows[0].schema;
    custom.maxProperties = 20;
    const inserted = (await db.query('INSERT INTO public.schema_registry(category,version,schema,is_active) SELECT $1,MAX(version)+1,$2::jsonb,false FROM public.schema_registry WHERE category=$1 RETURNING version', [category, JSON.stringify(custom)])).rows[0];
    await upsert(db, 'tenant', org, root.value, inserted.version);
    const before = await snapshot(db);
    await db.query('SAVEPOINT custom_schema');
    await expect(db.query(migration.body)).rejects.toThrow('Custom command registry schema requires explicit zero-selection review');
    await db.query('ROLLBACK TO SAVEPOINT custom_schema');
    expect(await snapshot(db)).toEqual(before);
  }), 120000);
});
