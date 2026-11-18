const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

// Invoke only through the admitted disposable DB lane; never load fallback env files.
if (!process.env.DATABASE_URL) throw new Error('Admitted DATABASE_URL required; no fallback');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 60000 });

test('actual KYC permission resync selects effective scoped policies and preserves idempotent registry rows', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/202610201000_b3_access_policy_kyc_permission_resync_trim_v1.sql'), 'utf8');
  const match = sql.match(/^(?:--[^\n]*\n|\s)*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/);
  expect(match).not.toBeNull();
  const seed = match[1];
  // Exact current migration has no internal transaction commands or executable blocks.
  expect(seed).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|DO|CALL)\b\s*(?:;|\$)/i);
  expect(seed.match(/SET search_path TO public, extensions, pg_temp;/g)).toHaveLength(1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = randomUUID(), otherOrg = randomUUID(), prefix = `f164_${randomUUID().replace(/-/g, '')}`;
    await client.query('INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$2),($3,$4,$4)',
      [org, `f164-${org}`, otherOrg, `f164-${otherOrg}`]);
    const baseline = (await client.query(`SELECT value,schema_version FROM public.settings_versions
      WHERE category='access_control_policy' AND approved_at IS NOT NULL
      ORDER BY version DESC LIMIT 1`)).rows[0];
    expect(baseline).toBeDefined();
    const policy = key => ({ ...baseline.value,
      roles: [{ key:'f164_test', capability_keys:[`${key}.role`, ` ${key}.role `, ` ${key}.trimmed `, '*', ' * ', '', '  '] }],
      capabilities: [{key:`${key}.cap`}, {key:' * '}] });
    const fixtures = [
      [org,1,'old',true,-3,2], [org,2,'current',true,-2,2],
      [org,3,'unapproved',false,-1,null], [org,4,'future',true,1,2],
      [org,5,'expired',true,-3,-2], [otherOrg,1,'other',true,-1,2],
    ];
    // Preserve onboarding histories and place owned policies above their versions.
    const versions = new Map((await client.query(`SELECT scope_id,COALESCE(max(version),0)::int AS version
      FROM public.settings_versions WHERE category='access_control_policy' AND scope_type='tenant'
      AND scope_id=ANY($1::uuid[]) GROUP BY scope_id`,[[org,otherOrg]])).rows.map(row=>[row.scope_id,row.version]));
    for (const [scope,version,label,approved,from,until] of fixtures) {
      try {
      await client.query(`INSERT INTO public.settings_versions
        (category,scope_type,scope_id,version,value,schema_version,approved_at,effective_from,effective_until,change_reason)
        VALUES('access_control_policy','tenant',$1,$2,$3::jsonb,$4,
        CASE WHEN $5 THEN now() ELSE NULL END,now()+$6*interval '1 day',
        CASE WHEN $7::int IS NULL THEN NULL ELSE now()+$7*interval '1 day' END,'F164 rollback fixture')`,
      [scope,(versions.get(scope)||0)+version,JSON.stringify(policy(`${prefix}.${label}`)),baseline.schema_version,approved,from,until]);
      } catch (error) {
        // Never expose PostgreSQL DETAIL, policy values, or connection data.
        const code = /^[A-Z0-9]{5}$/.test(String(error.code || '')) ? error.code : 'unknown';
        const constraint = /^[a-zA-Z0-9_]{1,128}$/.test(String(error.constraint || '')) ? error.constraint : 'unknown';
        throw new Error(`F164 owned fixture ${label}: SQLSTATE ${code}; constraint ${constraint}; approved=${approved}; finiteEnd=${until !== null}`);
      }
    }
    const definition = (await client.query("SELECT id FROM public.lookup_definitions WHERE category='rbac_permission'")).rows;
    expect(definition).toHaveLength(1);
    const definitionId = definition[0].id;
    // Existing excluded rows must remain byte-for-byte intact, not be cleaned up or reactivated.
    await client.query(`INSERT INTO public.lookup_values(lookup_definition_id,value,label,description,sort_order,is_default,status,metadata)
      SELECT $1,value,'Excluded existing row','Preserved excluded metadata',122,false,'archived','{"f164":"excluded"}'
      FROM unnest(ARRAY['*',' * ','','  ']) AS excluded(value)
      ON CONFLICT (lookup_definition_id,value) DO NOTHING`, [definitionId]);
    await client.query(`INSERT INTO public.lookup_values(lookup_definition_id,value,label,description,sort_order,is_default,status,metadata)
      VALUES($1,$2,'Preserved label','Preserved description',123,false,'active','{"f164":"preserve"}')`,
    [definitionId,`${prefix}.current.role`]);
    await client.query(`INSERT INTO public.lookup_values(lookup_definition_id,value,label,description,sort_order,is_default,status,metadata)
      VALUES($1,$2,'','',124,false,'active','{"f164":"fallback"}')`,
    [definitionId,`${prefix}.current.cap`]);
    // Exercise fixed-key reactivation without deleting potentially referenced rows.
    const fixedBefore = (await client.query(`UPDATE public.lookup_values SET status='archived'
      WHERE lookup_definition_id=$1 AND value IN ('kyc.write','settings_category_registry.read') RETURNING value`,[definitionId])).rows;
    expect(fixedBefore.map(r=>r.value).sort()).toEqual(['kyc.write','settings_category_registry.read']);
    const policiesBefore = (await client.query(`SELECT to_jsonb(v) AS row FROM public.settings_versions v
      WHERE category='access_control_policy' ORDER BY id`)).rows;
    const excluded = async () => (await client.query(`SELECT to_jsonb(v) AS row FROM public.lookup_values v
      WHERE lookup_definition_id=$1 AND (btrim(value)='*' OR btrim(value)='') ORDER BY id`,[definitionId])).rows;
    const excludedBefore = await excluded();
    expect(excludedBefore.map(entry=>entry.row.value)).toEqual(expect.arrayContaining(['*',' * ','','  ']));
    // Rollback must not hide deferred scope/schema fixture violations.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query(seed);
    expect(await excluded()).toEqual(excludedBefore);
    const rows = async () => (await client.query(`SELECT value,label,description,status,metadata,sort_order,is_default
      FROM public.lookup_values WHERE lookup_definition_id=$1 AND starts_with(value,$2) ORDER BY value`,
    [definitionId,`${prefix}.`])).rows;
    const first = await rows();
    expect(first.map(r=>r.value)).toEqual(['current.cap','current.role','current.trimmed','other.cap','other.role','other.trimmed'].map(k=>`${prefix}.${k}`));
    expect(first.every(r=>r.status==='active' && r.is_default===false)).toBe(true);
    const preserved = first.find(r=>r.value===`${prefix}.current.role`);
    expect(preserved).toMatchObject({label:'Preserved label',description:'Preserved description',sort_order:123});
    expect(preserved.metadata).toEqual({f164:'preserve',source:'access_policy_kyc_permission_resync_v1',
      settings_category:'access_control_policy',capability_key:`${prefix}.current.role`});
    const fallback = first.find(r=>r.value===`${prefix}.current.cap`);
    const expectedLabel = (await client.query("SELECT initcap(replace($1,'.',' ')) AS label",[fallback.value])).rows[0].label;
    expect(fallback).toMatchObject({label:expectedLabel,description:'Access policy capability mirrored for RBAC grant materialization',sort_order:124});
    expect(fallback.metadata).toEqual({f164:'fallback',source:'access_policy_kyc_permission_resync_v1',
      settings_category:'access_control_policy',capability_key:`${prefix}.current.cap`});
    expect((await client.query(`SELECT value FROM public.lookup_values WHERE lookup_definition_id=$1
      AND value IN ('kyc.write','settings_category_registry.read') AND status='active' ORDER BY value`,[definitionId])).rows)
      .toEqual([{value:'kyc.write'},{value:'settings_category_registry.read'}]);
    await client.query(seed);
    expect(await rows()).toEqual(first);
    expect(await excluded()).toEqual(excludedBefore);
    expect((await client.query(`SELECT to_jsonb(v) AS row FROM public.settings_versions v
      WHERE category='access_control_policy' ORDER BY id`)).rows).toEqual(policiesBefore);
  } finally {
    // Destroy even after rollback: migration uses session-level SET search_path.
    try { await client.query('ROLLBACK'); } finally { client.release(true); }
  }
},120000);

afterAll(() => pool.end());
