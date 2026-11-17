const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

const runLiveGeocodingTests = /^(1|true|yes)$/i.test(
  String(process.env.RUN_LIVE_GEOCODING_TESTS || '').trim(),
);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!runLiveGeocodingTests) {
  describe('Geocoding scorer (trgm-based) unit coverage', () => {
    test.skip('requires RUN_LIVE_GEOCODING_TESTS=true', () => {});
  });
} else if (!databaseUrl) {
  describe('Geocoding scorer (trgm-based) unit coverage', () => {
    test.skip('requires DATABASE_URL (cloud db)', () => {});
  });
} else {
  describe('Geocoding scorer (trgm-based) unit coverage', () => {
    const pool = new Pool({ connectionString: databaseUrl });
  let sampleCity = null;
  let sampleDistrict = null;
  let seededCityId = null;
  let seededDistrictId = null;

  const cityScoreQuery = `
    WITH inputs AS (
      SELECT
        $1::text AS candidate,
        c.name_canonical,
        c.name_arabic,
        c.alternate_names
      FROM canonical_cities c
      WHERE c.id = $2::uuid
      LIMIT 1
    )
    SELECT GREATEST(
      similarity(lower(i.name_canonical), lower(i.candidate)),
      similarity(lower(COALESCE(i.name_arabic, '')), lower(i.candidate)),
      COALESCE(
        (SELECT MAX(similarity(lower(an), lower(i.candidate))) FROM unnest(COALESCE(i.alternate_names, ARRAY[]::text[])) AS an),
        0
      )
    ) AS score
    FROM inputs i;
  `;

  const districtScoreQuery = `
    WITH inputs AS (
      SELECT
        $1::text AS candidate,
        d.name_canonical,
        d.name_arabic,
        d.alternate_names
      FROM canonical_districts d
      WHERE d.id = $2::uuid
      LIMIT 1
    )
    SELECT GREATEST(
      similarity(lower(i.name_canonical), lower(i.candidate)),
      similarity(lower(COALESCE(i.name_arabic, '')), lower(i.candidate)),
      COALESCE(
        (SELECT MAX(similarity(lower(an), lower(i.candidate))) FROM unnest(COALESCE(i.alternate_names, ARRAY[]::text[])) AS an),
        0
      )
    ) AS score
    FROM inputs i;
  `;

  async function cityScore(candidate) {
    const { rows } = await pool.query(cityScoreQuery, [candidate, sampleCity.id]);
    return Number(rows[0]?.score ?? 0);
  }

  async function districtScore(candidate) {
    const { rows } = await pool.query(districtScoreQuery, [candidate, sampleDistrict.id]);
    return Number(rows[0]?.score ?? 0);
  }

  function makeTypo(value) {
    const text = String(value ?? '').trim();
    if (text.length === 0) return text;
    if (text.length < 4) return `${text}x`;
    return text.slice(0, -1);
  }

  beforeAll(async () => {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

    const { rows: cityRows } = await pool.query(
      `
        SELECT id, name_canonical, name_arabic
        FROM canonical_cities
        WHERE name_canonical IS NOT NULL
          AND name_arabic IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM canonical_districts d
            WHERE d.city_id = canonical_cities.id
          )
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    );
    if (!cityRows.length) {
      const { rows: orgRows } = await pool.query(
        `
          SELECT id
          FROM organizations
          ORDER BY created_at
          LIMIT 1
        `,
      );

      if (!orgRows.length) {
        throw new Error('Expected at least one organization for scorer tests');
      }

      const organizationId = orgRows[0].id;
      const suffix = randomUUID().slice(0, 8);
      const cityCanonical = `Unit Test City ${suffix}`;
      const cityArabic = `مدينة اختبار ${suffix}`;

      const { rows: insertedCities } = await pool.query(
        `
          INSERT INTO canonical_cities (
            organization_id,
            name_canonical,
            name_arabic,
            alternate_names,
            source,
            metadata
          )
          VALUES ($1, $2, $3, ARRAY_REMOVE(ARRAY[$2, $3], NULL), 'unit_test', jsonb_build_object('seed', 'unit_test'))
          RETURNING id, name_canonical, name_arabic
        `,
        [organizationId, cityCanonical, cityArabic],
      );

      sampleCity = insertedCities[0];
      seededCityId = sampleCity.id;

      const districtCanonical = `Unit Test District ${suffix}`;
      const districtArabic = `حي اختبار ${suffix}`;

      const { rows: insertedDistricts } = await pool.query(
        `
          INSERT INTO canonical_districts (
            organization_id,
            city_id,
            name_canonical,
            name_arabic,
            alternate_names,
            source,
            metadata
          )
          VALUES ($1, $2, $3, $4, ARRAY_REMOVE(ARRAY[$3, $4], NULL), 'unit_test', jsonb_build_object('seed', 'unit_test'))
          RETURNING id, name_canonical, name_arabic
        `,
        [organizationId, seededCityId, districtCanonical, districtArabic],
      );

      sampleDistrict = insertedDistricts[0];
      seededDistrictId = sampleDistrict.id;

      return;
    }
    sampleCity = cityRows[0];

    const { rows: districtRows } = await pool.query(
      `
        SELECT id, name_canonical, name_arabic
        FROM canonical_districts
        WHERE city_id = $1::uuid
          AND name_canonical IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [sampleCity.id],
    );
    if (!districtRows.length) {
      throw new Error(`Expected at least one canonical district for city_id=${sampleCity.id}`);
    }
    sampleDistrict = districtRows[0];
  });

  afterAll(async () => {
    try {
      if (seededDistrictId) {
        await pool.query(`DELETE FROM canonical_districts WHERE id = $1::uuid`, [
          seededDistrictId,
        ]);
      }

      if (seededCityId) {
        await pool.query(`DELETE FROM canonical_cities WHERE id = $1::uuid`, [
          seededCityId,
        ]);
      }
    } finally {
      await pool.end();
    }
  });

  test('Arabic vs English city scoring favors exact match', async () => {
    const english = await cityScore(sampleCity.name_canonical);
    const arabic = await cityScore(sampleCity.name_arabic);
    expect(english).toBeGreaterThanOrEqual(0.99);
    expect(arabic).toBeGreaterThanOrEqual(0.99);
  });

  test('Fuzzy/typo still scores high; mixed-language scores medium', async () => {
    const exact = await cityScore(sampleCity.name_canonical);
    const typo = await cityScore(makeTypo(sampleCity.name_canonical));
    const mixed = await cityScore(`${sampleCity.name_arabic} ${sampleCity.name_canonical}`);
    expect(exact).toBeGreaterThanOrEqual(0.99);
    expect(typo).toBeGreaterThan(0.45);
    expect(mixed).toBeGreaterThan(0.45);
  });

  test('District scoring prefers exact district over typo', async () => {
    const exact = await districtScore(sampleDistrict.name_canonical);
    const typo = await districtScore(makeTypo(sampleDistrict.name_canonical));
    expect(exact).toBeGreaterThan(0.45);
    expect(typo).toBeGreaterThan(0.35);
    expect(exact).toBeGreaterThanOrEqual(typo);

    if (sampleDistrict.name_arabic) {
      const arabic = await districtScore(sampleDistrict.name_arabic);
      expect(arabic).toBeGreaterThanOrEqual(0.99);
    }
  });
  });
}
