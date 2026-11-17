const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join("")),
});
const {
  applyGeocodingPolicy,
  buildAutoLearningPolicy,
  fetchScopedGeocodingPolicy,
  resolveGeocodingPolicy,
} = require('./helpers/geocodingPolicy');
const {
  ensureIntegrationFixturesPresent,
  resolvePrimaryFixtureOrgClientSender,
} = require('./helpers/integration-fixtures');

const CITY_NAME = 'AUTO_LEARN_CITY_TEST';
const PROVINCE_NAME = 'AUTO_LEARN_PROVINCE_TEST';
const DISTRICT_NAME = 'AUTO_LEARN_DISTRICT_TEST';
const ALIAS_CITY = 'AUTO_LEARN_ALIAS_CITY';
const ALIAS_DISTRICT = 'AUTO_LEARN_ALIAS_DISTRICT';
const COUNTRY_CODE = 'SA';
const GEOCODING_POLICY_CATEGORY = 'geocoding_policy';
const liveEnabled = process.env.RUN_LIVE_GEOCODING_TESTS === 'true';

async function ensureManualReviewTaskTypeValue(value, label) {
  await pool.query(
    `
      WITH def AS (
        SELECT id
        FROM public.lookup_definitions
        WHERE category = 'manual_review_task_type'
        LIMIT 1
      ),
      next_sort AS (
        SELECT COALESCE(MAX(sort_order), 0) + 10 AS sort_order
        FROM public.lookup_values
        WHERE lookup_definition_id = (SELECT id FROM def)
      )
      INSERT INTO public.lookup_values (
        lookup_definition_id,
        value,
        label,
        sort_order,
        is_default,
        status
      )
      SELECT
        def.id,
        $1::text,
        $2::text,
        next_sort.sort_order,
        FALSE,
        'active'
      FROM def, next_sort
      ON CONFLICT (lookup_definition_id, value)
      DO UPDATE SET
        label = EXCLUDED.label,
        status = 'active',
        updated_at = now()
    `,
    [value, label],
  );
}

async function ensureAutoLearningPolicy(organizationId, clientId, senderId, runner = pool) {
  const scopes = [
    { scopeType: 'global', scopeId: null },
    { scopeType: 'client', scopeId: clientId },
    ...(senderId ? [{ scopeType: 'sender', scopeId: senderId }] : []),
  ];
  const contexts = [];

  for (const scope of scopes) {
    const existing = await fetchScopedGeocodingPolicy(runner, scope.scopeType, scope.scopeId);
    let basePolicy = existing?.value;

    if (!basePolicy) {
      basePolicy =
        (await resolveGeocodingPolicy(runner, scope.scopeType, scope.scopeId)) ??
        (await resolveGeocodingPolicy(runner, 'client', clientId)) ??
        (await resolveGeocodingPolicy(runner, 'tenant', organizationId)) ??
        (await resolveGeocodingPolicy(runner, 'global', null)) ??
        {};
    }

    const overridePolicy = buildAutoLearningPolicy(basePolicy);
    const result = await applyGeocodingPolicy(
      runner,
      scope.scopeType,
      scope.scopeId,
      overridePolicy,
      existing?.settingsVersionId,
    );

    contexts.push({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      previous: existing,
      settingsVersionId: result.settingsVersionId,
      inserted: result.inserted,
    });
  }

  return contexts;
}

async function restoreAutoLearningPolicy(context) {
  return restoreAutoLearningPolicyWithRunner(context, pool);
}

async function restoreAutoLearningPolicyWithRunner(context, runner) {
  if (!context || !context.length) {
    return;
  }

  for (const item of [...context].reverse()) {
    const { scopeType, scopeId, previous, settingsVersionId, inserted } = item;

    if (previous?.value) {
      await applyGeocodingPolicy(
        runner,
        scopeType,
        scopeId,
        previous.value,
        previous.settingsVersionId,
        'Integration test auto-learn policy restore',
      );
      continue;
    }

    if (inserted) {
      await runner.query(
        `
          DELETE FROM settings
          WHERE category = $1
            AND scope_type = $2
            AND scope_id IS NOT DISTINCT FROM $3
        `,
        [GEOCODING_POLICY_CATEGORY, scopeType, scopeId],
      );

      await runner.query(
        `DELETE FROM settings_versions WHERE id = $1`,
        [settingsVersionId],
      );
    }
  }
}

beforeEach(async () => {
  await pool.query(
    `DELETE FROM canonical_districts WHERE name_canonical = $1`,
    [DISTRICT_NAME],
  );
  await pool.query(
    `DELETE FROM canonical_cities WHERE name_canonical = $1`,
    [CITY_NAME],
  );
  await pool.query(
    `DELETE FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval'`,
  );
});

beforeAll(async () => {
  await ensureIntegrationFixturesPresent();
  await ensureManualReviewTaskTypeValue('geocoding', 'Geocoding');
  await ensureManualReviewTaskTypeValue('geocoding_auto_learn', 'Geocoding Auto Learn');
});

afterAll(async () => {
  await pool.end();
});

describe('auto_learn_geography helper', () => {
  test('inserts canonical city and queues district manual review based on policy', async () => {
    const fixtureScope = await resolvePrimaryFixtureOrgClientSender(pool);
    expect(fixtureScope).toBeTruthy();
    const { organization_id, client_id, sender_id } = fixtureScope;

    let policyContext;
    let addressId;

    try {
      policyContext = await ensureAutoLearningPolicy(
        organization_id,
        client_id,
        sender_id,
      );

      addressId = (
        await pool.query(
          `
            INSERT INTO addresses (
              organization_id,
              client_id,
              raw_input,
              city,
              province,
              country,
              validation_status,
              district,
              created_at,
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3::jsonb,
              $4,
              $5,
              $6,
              $7,
              $8,
              now(),
              now()
            )
            RETURNING id
          `,
          [
            organization_id,
            client_id,
            {
              line1: 'Test',
              city: CITY_NAME,
              province: PROVINCE_NAME,
              country: COUNTRY_CODE,
            },
            CITY_NAME,
            PROVINCE_NAME,
            COUNTRY_CODE,
            'pending',
            DISTRICT_NAME,
          ],
        )
      ).rows[0].id;

      const providerPayload = {
        address_components: {
          city: CITY_NAME,
          district: DISTRICT_NAME,
          countryCode: COUNTRY_CODE,
        },
      };

      const result = (
        await pool.query(
          `
            SELECT auto_learn_geography(
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5::jsonb,
              $6::jsonb,
              $7::numeric,
              $8::text
            ) AS outcome
          `,
          [
            organization_id,
            client_id,
            sender_id,
            addressId,
            {
              city: CITY_NAME,
              district: DISTRICT_NAME,
              country: COUNTRY_CODE,
            },
            providerPayload,
            0.95,
            'here_geocoding',
          ],
        )
      ).rows[0].outcome;

      expect(result.processed).toBe(true);
      // City learning is required for auto-learn to provide value.
      expect(result.city_learned).toBe(true);

      // Assert that the helper respects the configured policy: when the
      // resolved geocoding_policy for this client uses queue_for_review for
      // district auto-learning, we expect manual_review_enqueued=true and a
      // corresponding manual_review_tasks row. When the policy uses
      // add_immediately (the current global default), we expect no manual
      // review to be enqueued.

      const cityRows = await pool.query(
        `SELECT * FROM canonical_cities WHERE organization_id = $1 AND name_canonical = $2`,
        [organization_id, CITY_NAME],
      );
      expect(cityRows.rows.length).toBe(1);

      const tasks = await pool.query(
        `SELECT * FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval' AND address_id = $1`,
        [addressId],
      );

      // Compute the effective policy using the same ladder as
      // auto_learn_geography(): sender -> client -> tenant -> global.
      let resolvedPolicy =
        (await resolveGeocodingPolicy(pool, 'sender', sender_id)) ||
        (await resolveGeocodingPolicy(pool, 'client', client_id)) ||
        (await resolveGeocodingPolicy(pool, 'tenant', organization_id)) ||
        (await resolveGeocodingPolicy(pool, 'global', null));

      const districtConfig =
        resolvedPolicy?.auto_learning?.components?.district || {};
      const districtAction = districtConfig.action_lookup || '';
      const expectsReview = districtAction.includes('queue_for_review');

      expect(result.manual_review_enqueued).toBe(expectsReview);
      expect(tasks.rows.length).toBe(expectsReview ? 1 : 0);
    } finally {
      if (addressId) {
        await pool.query(
          `DELETE FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval' AND address_id = $1`,
          [addressId],
        );
        // Address versions are append-only; avoid deleting addresses.
      }
      await restoreAutoLearningPolicy(policyContext);
      await pool.query(
        `DELETE FROM canonical_districts WHERE name_canonical = $1`,
        [DISTRICT_NAME],
      );
      await pool.query(
        `DELETE FROM canonical_cities WHERE name_canonical = $1`,
        [CITY_NAME],
      );
    }
  });

  test('records alias audit entries when confidence exceeds alias thresholds', async () => {
    const fixtureScope = await resolvePrimaryFixtureOrgClientSender(pool);
    expect(fixtureScope).toBeTruthy();
    const { organization_id, client_id, sender_id } = fixtureScope;

    let policyContext;
    let addressId;
    try {
      policyContext = await ensureAutoLearningPolicy(
        organization_id,
        client_id,
        sender_id,
      );

      addressId = (
        await pool.query(
          `
            INSERT INTO addresses (
              organization_id,
              client_id,
              raw_input,
              city,
              province,
              country,
              validation_status,
              district,
              created_at,
              updated_at
            )
            VALUES ($1::uuid, $2::uuid, '{}'::jsonb, $3::text, $4::text, $5::text, 'pending', $6::text, now(), now())
            RETURNING id
          `,
          [organization_id, client_id, ALIAS_CITY, PROVINCE_NAME, COUNTRY_CODE, ALIAS_DISTRICT],
        )
      ).rows[0].id;

      const providerPayload = {
        address_components: {
          city: ALIAS_CITY,
          district: ALIAS_DISTRICT,
          countryCode: COUNTRY_CODE,
        },
      };

      const result = (
        await pool.query(
          `SELECT auto_learn_geography($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6::jsonb,$7::numeric,$8::text) AS outcome`,
          [
            organization_id,
            client_id,
            sender_id,
            addressId,
            providerPayload,
            providerPayload,
            0.92,
            'here_geocoding',
          ],
        )
      ).rows[0].outcome;

      expect(result.processed).toBe(true);

      const { rows: aliasAuditRows } = await pool.query(
        `SELECT * FROM geocoding_alias_audit WHERE address_id = $1::uuid`,
        [addressId],
      );
      expect(aliasAuditRows.length).toBeGreaterThan(0);
      expect(aliasAuditRows[0].metadata.candidate_status).toBe('promote');
    } finally {
      if (addressId) {
        await pool.query(
          `DELETE FROM manual_review_tasks WHERE reason = 'Auto-learn district requires approval' AND address_id = $1::uuid`,
          [addressId],
        );
        await pool.query(`DELETE FROM geocoding_alias_audit WHERE address_id = $1::uuid`, [
          addressId,
        ]);
        // Address versions are append-only; avoid deleting addresses.
      }
      await restoreAutoLearningPolicy(policyContext);
      await pool.query(
        `DELETE FROM canonical_districts WHERE name_canonical IN ($1, $2)`,
        [DISTRICT_NAME, ALIAS_DISTRICT],
      );
      await pool.query(
        `DELETE FROM canonical_cities WHERE name_canonical IN ($1, $2)`,
        [CITY_NAME, ALIAS_CITY],
      );
    }
  });
});
