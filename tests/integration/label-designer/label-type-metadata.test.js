const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createOrganization, createUser, setAuthContext, setFixtureUserPolicyCapabilities } = require('../helpers/tenant-utils');
loadEnv();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for label metadata integration');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
async function transaction(run) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await db.query("SET LOCAL statement_timeout='10s'"); return await run(db); }
  finally { await db.query('ROLLBACK'); db.release(); }
}
async function fixture(db, provisionRbac = true) {
  const org = await createOrganization(db, 'Label metadata qualification');
  const userId = await createUser(db, org.id, 'label-' + randomUUID() + '@example.com',
    { accessScopeType: 'tenant', userType: 'ops_admin', provisionRbac });
  return { org, userId };
}
async function read(db, id) {
  return (await db.query("SELECT api.label_designer_list_drafts('tenant', $1::uuid) AS result", [id])).rows[0].result;
}
describe('Scoped label designer registry metadata', () => {
  afterAll(() => pool.end());
  test('API preserves distinct labels and canonical effectivity/order', () => transaction(async db => {
    const { org, userId } = await fixture(db, false);
    await setFixtureUserPolicyCapabilities(db, org.id, userId, ['label_design.read']);
    const category = await db.query("SELECT id FROM public.lookup_definitions WHERE category='label_type'");
    expect(category.rows).toHaveLength(1);
    const prefix = 'qa_' + randomUUID().replace(/-/g, '');
    const codes = ['a','b','future','expired','inactive'].map(x => prefix + x);
    for (let i=0;i<codes.length;i++) {
      await db.query(`INSERT INTO public.lookup_values
        (lookup_definition_id,value,label,sort_order,status,effective_from,effective_until)
        VALUES ($1,$2,$3,$4,$5,
          CASE WHEN $6 THEN now()+interval '1 day' ELSE now()-interval '1 day' END,
          CASE WHEN $7 THEN now()-interval '1 second' ELSE NULL END)`,
        [category.rows[0].id,codes[i],i===0?'Distinct first label':'Distinct second label',
          i===0?2:1,i===4?'draft':'active',i===2,i===3]);
    }
    await setAuthContext(db,userId);
    const permissions = (await db.query(
      "SELECT public.user_has_capability_v1('label_design.read','tenant',$1::uuid) AS designer, public.user_has_resource_capability_v1('lookup_values','read') AS lookup",
      [org.id])).rows[0];
    expect(permissions).toEqual({designer:true,lookup:false});
    const result = await read(db,org.id);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.drafts)).toBe(true);
    expect(result.label_types.filter(row => row.value.startsWith(prefix))).toEqual([
      {value:codes[1],label:'Distinct second label'},
      {value:codes[0],label:'Distinct first label'},
    ]);
  }));
  test('foreign scope cannot expose metadata', () => transaction(async db => {
    const { userId } = await fixture(db);
    const foreign = await createOrganization(db,'Foreign label scope');
    await setAuthContext(db,userId);
    const result = await read(db,foreign.id);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('label_types');
  }));
  test('missing capability cannot expose metadata', () => transaction(async db => {
    const { org,userId } = await fixture(db,false);
    await setFixtureUserPolicyCapabilities(db, org.id, userId, []);
    await setAuthContext(db,userId);
    const result = await read(db,org.id);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('label_types');
  }));
  test('missing authentication cannot expose metadata', () => transaction(async db => {
    const { org } = await fixture(db);
    await db.query("SELECT set_config('request.jwt.claims','{}',true), set_config('request.jwt.claim.sub','',true)");
    const result = await read(db,org.id);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('label_types');
  }));
});
