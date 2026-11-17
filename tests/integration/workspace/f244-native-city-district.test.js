const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../../scripts/utils/load-env');
const { createOrganization, createClient, createSender, withFixtureAdminContext } = require('../helpers/tenant-utils');
const { ensureBasePublicTrackingFixtures, deterministicUuid } = require('../../../scripts/qa/lib/public-tracking-fixtures');
loadEnv();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for native fixture identity proof');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
afterAll(() => pool.end());

test('F244 conflicting natural keys retain persisted city/district IDs and downstream ownership', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await withFixtureAdminContext(db, async () => {
      const { id:org } = await createOrganization(db, 'F244 owned ' + randomUUID());
      const { id:foreign } = await createOrganization(db, 'F244 foreign ' + randomUUID());
      const { id:clientId } = await createClient(db, org, 'F244 client');
      const senderId = await createSender(db, clientId, 'F244 sender');
      const cityId = randomUUID(), districtId = randomUUID();
      const foreignCity = randomUUID(), foreignDistrict = randomUUID();
      expect(cityId).not.toBe(deterministicUuid('qa-public-tracking-city:' + org));
      expect(districtId).not.toBe(deterministicUuid('qa-public-tracking-district:' + org));
      await db.query(`INSERT INTO public.canonical_cities
        (id,organization_id,name_canonical,province,country_code,source,is_active,metadata)
        VALUES($1,$2,'Riyadh','Riyadh','SA','manual_seed',true,'{"f244":"owned"}'),
              ($3,$4,'Riyadh','Riyadh','SA','manual_seed',true,'{"f244":"foreign"}')`,
      [cityId,org,foreignCity,foreign]);
      await db.query(`INSERT INTO public.canonical_districts
        (id,organization_id,city_id,name_canonical,source,is_active,metadata)
        VALUES($1,$2,$3,'Al Olaya','manual_seed',true,'{"f244":"owned"}'),
              ($4,$5,$6,'Al Olaya','manual_seed',true,'{"f244":"foreign"}')`,
      [districtId,org,cityId,foreignDistrict,foreign,foreignCity]);
      const snapshot = async () => (await db.query(`
        SELECT 'city' kind,to_jsonb(c) row FROM public.canonical_cities c WHERE id=$1 AND organization_id=$3
        UNION ALL SELECT 'district',to_jsonb(d) FROM public.canonical_districts d WHERE id=$2 AND organization_id=$3
        ORDER BY kind`,[foreignCity,foreignDistrict,foreign])).rows;
      const before = await snapshot();
      expect(before.map(row => row.kind)).toEqual(['city','district']);
      const demo = { organizationId:org, clientId, senderId };
      const first = await ensureBasePublicTrackingFixtures(db,demo);
      const repeat = await ensureBasePublicTrackingFixtures(db,demo);
      // Returned identity stability only; helper appends shipment-action evidence.
      expect(first).toEqual(repeat);
      expect(first).toMatchObject({cityId,districtId});
      expect((await db.query(`SELECT id,city_id FROM public.canonical_districts
        WHERE organization_id=$1 AND name_canonical='Al Olaya' AND source_district_id IS NULL`,[org])).rows)
        .toEqual([{id:districtId,city_id:cityId}]);
      expect((await db.query(`SELECT canonical_district_id FROM public.zone_districts
        WHERE zone_id=$1`,[first.zoneId])).rows).toEqual([{canonical_district_id:districtId}]);
      expect((await db.query(`SELECT s.id FROM public.shipments s
        JOIN public.zone_districts z ON z.zone_id=s.zone_id
        JOIN public.canonical_districts d ON d.id=z.canonical_district_id
        WHERE s.organization_id=$1 AND s.client_id=$2 AND s.sender_id=$3
          AND d.organization_id=$1 AND d.id=$4 AND d.city_id=$5 ORDER BY s.id`,[org,clientId,senderId,districtId,cityId])).rows)
        .toEqual([first.shipmentOneId,first.shipmentTwoId].sort().map(id => ({id})));
      expect((await db.query(`SELECT id FROM public.canonical_cities WHERE id=$1
        UNION ALL SELECT id FROM public.canonical_districts WHERE id=$2`,
      [deterministicUuid('qa-public-tracking-city:'+org),
       deterministicUuid('qa-public-tracking-district:'+org)])).rows).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  } finally {
    try { await db.query('ROLLBACK'); } finally { db.release(); }
  }
},120000);
