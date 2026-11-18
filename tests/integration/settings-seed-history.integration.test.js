const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();
if (!process.env.DATABASE_URL) throw new Error('Admitted DATABASE_URL required; no fallback');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
const cases = [
  ['destination', 'ui_read_registry', '20260908101000_route_destination_map_projection_v1.sql', 'destination_registry_seed'],
  ['catalog', 'task_type_catalog', '20260909103000_task_completion_amount_guard_v1.sql', 'do'],
  ['catalog tenant', 'task_type_catalog', '20260909103000_task_completion_amount_guard_v1.sql', 'do'],
];
function actualSeed(filename, delimiter) {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations', filename), 'utf8');
  const token = `$${delimiter}$`;
  expect(sql.split(token)).toHaveLength(3);
  const start = sql.indexOf(`DO ${token}`), end = sql.indexOf(`${token};`, start + token.length + 3);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + token.length + 1);
}
describe('actual settings seed preserves selected authority and version history', () => {
  afterAll(() => pool.end());
  test('reassignment registry actual seed preserves closed history and replays without schema churn', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seed = actualSeed('20260909233000_reassignment_registry_scoped_read_v1.sql', 'registry');
      const baseline = (await client.query(`SELECT s.*,v.value,v.schema_version FROM public.settings s
        JOIN public.settings_versions v ON v.id=s.settings_version_id
        WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL`)).rows;
      expect(baseline).toHaveLength(1);
      const row = baseline[0];
      const beforeValue = { ...row.value,
        resources: row.value.resources.filter(r => r.key !== 'route_stop_reassignment_events') };
      await client.query('SELECT public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
        ['ui_read_registry','global',null,JSON.stringify(beforeValue),row.schema_version,'rollback E49 baseline']);
      const selectedBefore = (await client.query(`SELECT to_jsonb(v) AS value FROM public.settings s
        JOIN public.settings_versions v ON v.id=s.settings_version_id WHERE s.id=$1`,[row.id])).rows[0].value;
      expect(selectedBefore.approved_at).not.toBeNull();
      expect(selectedBefore.effective_until).toBeNull();
      const snapshot = async () => (await client.query(`SELECT to_jsonb(v) AS row FROM public.settings_versions v
        WHERE category='ui_read_registry' ORDER BY id`)).rows.map(r => r.row);
      const closed = (await snapshot()).filter(v => v.effective_until !== null || v.approved_at === null);
      expect(closed.length).toBeGreaterThan(0);
      await client.query(seed);
      const after = (await client.query(`SELECT s.settings_version_id,s.cached_value,v.value FROM public.settings s
        JOIN public.settings_versions v ON v.id=s.settings_version_id WHERE s.id=$1`,[row.id])).rows[0];
      expect(after.cached_value).toEqual(after.value);
      expect(after.settings_version_id).not.toBe(selectedBefore.id);
      expect(after.value.resources.filter(r => r.key !== 'route_stop_reassignment_events')).toEqual(beforeValue.resources);
      const selected = after.value.resources.filter(r => r.key === 'route_stop_reassignment_events');
      expect(selected).toHaveLength(1);
      expect(selected[0]).toMatchObject({ relation:'public.route_stop_reassignment_events',
        read_relation:'public.route_stop_reassignment_events_read_v1',
        capability_read:'routes.read',scope_columns:{tenant:'organization_id'},read_scope_types:['tenant'] });
      expect(selected[0].select).toEqual(['id','organization_id','route_stop_id','shipment_id',
        'source_route_run_id','target_route_run_id','event_type','actor_user_id','notes','payload','created_at']);
      const history = await snapshot();
      const selectedClosed = history.find(v => v.id===selectedBefore.id);
      expect(selectedClosed).toBeDefined();
      const {effective_until: oldUntil,...oldFields} = selectedBefore;
      const {effective_until: closedAt,...newFields} = selectedClosed;
      expect(newFields).toEqual(oldFields);
      expect(closedAt).not.toBeNull();
      expect((await client.query('SELECT effective_until>effective_from AS monotonic FROM public.settings_versions WHERE id=$1',
        [selectedBefore.id])).rows[0].monotonic).toBe(true);
      for (const previous of closed) expect(history.find(v => v.id===previous.id)).toEqual(previous);
      const schemaSnapshot = async () => (await client.query(`SELECT to_jsonb(s) AS row FROM public.schema_registry s
        WHERE category='ui_read_registry' ORDER BY version`)).rows.map(r => r.row);
      const schemas = await schemaSnapshot();
      expect(schemas.filter(s => s.is_active)).toHaveLength(1);
      expect(schemas.find(s => s.is_active).schema.properties.resources.items.properties.read_scope_types)
        .toMatchObject({type:'array',minItems:1,uniqueItems:true});
      const settings = (await client.query("SELECT * FROM public.settings WHERE category='ui_read_registry' ORDER BY id")).rows;
      await client.query(seed);
      expect(await snapshot()).toEqual(history);
      expect(await schemaSnapshot()).toEqual(schemas);
      expect((await client.query("SELECT * FROM public.settings WHERE category='ui_read_registry' ORDER BY id")).rows).toEqual(settings);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  },120000);
  test.each(cases)('%s seed transforms current version only and is idempotent', async (kind, category, filename, delimiter) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seed = actualSeed(filename, delimiter);
      const { rows: originals } = await client.query(`SELECT s.*,sv.value,sv.schema_version
        FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
        WHERE s.category=$1 AND s.scope_type='global' AND s.scope_id IS NULL`, [category]);
      expect(originals).toHaveLength(1);
      let original = originals[0];
      if (kind === 'catalog tenant') {
        const org = randomUUID();
        await client.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$3)', [org, 'Seed history regression', `seed-history-${org}`]);
        await client.query('SELECT * FROM public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
          [category, 'tenant', org, JSON.stringify(original.value), original.schema_version, 'rollback tenant seed regression']);
        original = (await client.query(`SELECT s.*,sv.value,sv.schema_version FROM public.settings s
          JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category=$1 AND s.scope_type='tenant' AND s.scope_id=$2`, [category,org])).rows[0];
        expect(original).toBeDefined();
      }
      const beforeValue = JSON.parse(JSON.stringify(original.value));
      let selected = 0;
      if (kind === 'destination') {
        beforeValue.resources = beforeValue.resources.map(resource => {
          if (resource.key !== 'route_stops') return resource;
          selected++;
          return { ...resource, select_fields: resource.select_fields.filter(field => field !== 'destination_address') };
        });
      } else {
        beforeValue.task_types = beforeValue.task_types.map(type => {
          if (!['cod_cash_handover', 'cod_cashier_count'].includes(type.key.trim().toLowerCase())) return type;
          selected++;
          const metadata = { ...type.metadata }; delete metadata.completion_amount_contract;
          return { ...type, metadata };
        });
      }
      expect(selected).toBeGreaterThan(0);
      await client.query('SELECT * FROM public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
        [category, original.scope_type, original.scope_id, JSON.stringify(beforeValue), original.schema_version, 'rollback seed regression baseline']);
      const { rows: baselineRows } = await client.query(`SELECT s.*,sv.value,sv.version,sv.schema_version
        FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1`, [original.id]);
      const baseline = baselineRows[0];
      // Selected authority is an approved, open, future-dated version. The SSOT
      // must preserve its effective_from and close it monotonically, not backdate it.
      await client.query(`UPDATE public.settings_versions SET effective_from=now()+interval '1 day'
        WHERE id=$1 AND approved_at IS NOT NULL AND effective_until IS NULL`, [baseline.settings_version_id]);
      expect((await client.query(`SELECT approved_at IS NOT NULL AND effective_until IS NULL
        AND effective_from > now() AS ready FROM public.settings_versions WHERE id=$1`, [baseline.settings_version_id])).rows[0].ready).toBe(true);
      const expiredId = randomUUID(), futureId = randomUUID();
      await client.query(`INSERT INTO public.settings_versions
        (id,category,scope_type,scope_id,version,value,schema_version,change_reason,approved_at,effective_from,effective_until)
        SELECT $1::uuid,category,scope_type,scope_id,version+100,value,schema_version,'expired preservation sentinel',
          now()-interval '3 days',now()-interval '3 days',now()-interval '2 days'
        FROM public.settings_versions WHERE id=$3
        UNION ALL SELECT $2::uuid,category,scope_type,scope_id,version+101,value,schema_version,'future preservation sentinel',
          NULL,now()+interval '3 days',NULL FROM public.settings_versions WHERE id=$3`,
      [expiredId, futureId, baseline.settings_version_id]);
      const snapshot = async () => (await client.query(`SELECT to_jsonb(v) AS row FROM public.settings_versions v
        WHERE category=$1 ORDER BY id`, [category])).rows.map(item => item.row);
      const before = await snapshot();
      const settingsBefore = (await client.query('SELECT * FROM public.settings WHERE category=$1 ORDER BY id', [category])).rows;
      await client.query(seed); // Execute the migration's actual named block, never a copied seed body.
      const { rows: afterRows } = await client.query(`SELECT s.*,sv.value,sv.version,sv.schema_version
        FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1`, [original.id]);
      const after = afterRows[0];
      const expected = JSON.parse(JSON.stringify(baseline.value));
      if (kind === 'destination') expected.resources = expected.resources.map(resource => resource.key === 'route_stops'
        ? { ...resource, select_fields: [...resource.select_fields, 'destination_address'] } : resource);
      else expected.task_types = expected.task_types.map(type => ['cod_cash_handover','cod_cashier_count'].includes(type.key.trim().toLowerCase())
        ? { ...type, metadata: { ...type.metadata, completion_amount_contract: { version: 1, field: 'amount', minimum: 0 } } } : type);
      expect(after.value).toEqual(expected); expect(after.cached_value).toEqual(after.value);
      expect(after.settings_version_id).not.toBe(baseline.settings_version_id);
      expect(after.version).toBe(baseline.version + 102);
      for (const key of ['id','category','scope_type','scope_id','scope_hash','schema_version']) expect(after[key]).toEqual(baseline[key]);
      const afterHistory = await snapshot();
      for (const prior of before) {
        const current = afterHistory.find(row => row.id === prior.id);
        expect(current).toBeDefined();
        // The SSOT helper may close approved open rows; their payload/version/dates otherwise stay immutable.
        if (prior.approved_at && prior.effective_until === null) {
          const { effective_until: ignoredBefore, ...oldImmutable } = prior;
          const { effective_until: closedAt, ...newImmutable } = current;
          expect(newImmutable).toEqual(oldImmutable);
          if (prior.scope_type === baseline.scope_type && prior.scope_id === baseline.scope_id) {
            expect(closedAt).not.toBeNull();
            expect((await client.query('SELECT effective_until > effective_from AS monotonic FROM public.settings_versions WHERE id=$1', [prior.id])).rows[0].monotonic).toBe(true);
          }
        } else expect(current).toEqual(prior);
      }
      for (const id of [expiredId, futureId]) expect(afterHistory.find(row => row.id === id)).toEqual(before.find(row => row.id === id));
      const settingsAfter = (await client.query('SELECT * FROM public.settings WHERE category=$1 ORDER BY id', [category])).rows;
      expect(settingsAfter.map(({id,category,scope_type,scope_id,scope_hash})=>({id,category,scope_type,scope_id,scope_hash})))
        .toEqual(settingsBefore.map(({id,category,scope_type,scope_id,scope_hash})=>({id,category,scope_type,scope_id,scope_hash})));
      if (kind === 'destination') expect(settingsAfter.filter(row => row.id !== original.id)).toEqual(settingsBefore.filter(row => row.id !== original.id));
      const stable = await snapshot();
      await client.query(seed);
      expect(await snapshot()).toEqual(stable);
      expect((await client.query('SELECT * FROM public.settings WHERE category=$1 ORDER BY id', [category])).rows).toEqual(settingsAfter);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }, 120000);
  test('F808 status correction preserves custom policy and version history', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seed = actualSeed('20260913090000_dashboard_shipment_reporting_status_keys_v1.sql', 'reporting_status_keys');
      const row = (await client.query("SELECT s.*,sv.value,sv.schema_version FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_dashboard_config' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL")).rows[0];
      const oldReporting = JSON.parse('{"enabled":true,"resource":"shipments","status_filter":"status","statuses":[{"key":"delivered","label_key":"delivered"},{"key":"in_transit","label_key":"in_transit"},{"key":"out_for_delivery","label_key":"out_for_delivery"},{"key":"pending","label_key":"pending"},{"key":"exceptions","label_key":"exceptions"},{"key":"cancelled","label_key":"cancelled"},{"key":"returned","label_key":"returned"}],"active_status_keys":["in_transit","out_for_delivery"],"delivered_status_key":"delivered","pending_status_key":"pending","exception_status_key":"exceptions","app_keys":["console"]}');
      const newReporting = JSON.parse('{"enabled":true,"resource":"shipments","status_filter":"status","statuses":[{"key":"delivered","label_key":"delivered"},{"key":"in_transit","label_key":"in_transit"},{"key":"out_for_delivery","label_key":"out_for_delivery"},{"key":"pending","label_key":"pending"},{"key":"delivery_failed","label_key":"exceptions"},{"key":"cancelled","label_key":"cancelled"},{"key":"return_to_origin","label_key":"returned"}],"active_status_keys":["in_transit","out_for_delivery"],"delivered_status_key":"delivered","pending_status_key":"pending","exception_status_key":"delivery_failed","app_keys":["console"]}');
      const oldValue = { ...row.value, shipment_reporting: oldReporting, retained_sibling: { value: true } };
      await client.query('SELECT public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
        ['ui_dashboard_config', row.scope_type, null, JSON.stringify(oldValue), row.schema_version,
         'Restore F808 reporting without overriding explicit dashboard policy']);
      const before = (await client.query("SELECT s.settings_version_id,s.cached_value,sv.value,sv.version,sv.schema_version FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1", [row.id])).rows[0];
      await client.query(seed);
      const after = (await client.query("SELECT s.settings_version_id,s.cached_value,sv.value,sv.version,sv.schema_version,sv.change_reason FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1", [row.id])).rows[0];
      expect(after.settings_version_id).not.toBe(before.settings_version_id);
      expect(after.cached_value).toEqual(after.value);
      expect(after.value.shipment_reporting).toEqual(newReporting);
      expect(after.value.retained_sibling).toEqual({ value: true });
      expect(after.schema_version).toBe(before.schema_version);
      expect(after.change_reason).toBe('Correct F808 reporting status keys to canonical shipment taxonomy');
      expect((await client.query('SELECT effective_until>effective_from AS monotonic FROM public.settings_versions WHERE id=$1', [before.settings_version_id])).rows[0].monotonic).toBe(true);
      const stable = (await client.query("SELECT s.*,sv.value,sv.version,sv.change_reason FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1", [row.id])).rows[0];
      const historyCount = (await client.query("SELECT count(*)::int AS count FROM public.settings_versions WHERE category=$1 AND scope_hash=$2", ['ui_dashboard_config', row.scope_hash])).rows[0].count;
      await client.query(seed);
      expect((await client.query("SELECT s.*,sv.value,sv.version,sv.change_reason FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.id=$1", [row.id])).rows[0]).toEqual(stable);
      expect((await client.query("SELECT count(*)::int AS count FROM public.settings_versions WHERE category=$1 AND scope_hash=$2", ['ui_dashboard_config', row.scope_hash])).rows[0].count).toBe(historyCount);

      const explicitOldValue = { ...after.value, shipment_reporting: oldReporting };
      await client.query('SELECT public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
        ['ui_dashboard_config', row.scope_type, null, JSON.stringify(explicitOldValue),
         row.schema_version, 'explicit current global policy matching historical bytes']);
      const explicitOldBefore = (await client.query('SELECT * FROM public.settings WHERE id=$1', [row.id])).rows[0];
      await client.query(seed);
      expect((await client.query('SELECT * FROM public.settings WHERE id=$1', [row.id])).rows[0])
        .toEqual(explicitOldBefore);

      const customValue = { ...after.value, shipment_reporting: { ...newReporting, exception_status_key: 'custom_failure' } };
      await client.query('SELECT public.upsert_settings_value_v1($1,$2,$3,$4::jsonb,$5,$6)',
        ['ui_dashboard_config', row.scope_type, null, JSON.stringify(customValue), row.schema_version, 'explicit custom global policy']);
      const customBefore = (await client.query('SELECT * FROM public.settings WHERE id=$1', [row.id])).rows[0];
      await client.query(seed);
      expect((await client.query('SELECT * FROM public.settings WHERE id=$1', [row.id])).rows[0]).toEqual(customBefore);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }, 120000);

});
