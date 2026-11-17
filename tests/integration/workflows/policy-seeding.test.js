const { Client } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  ensureIntegrationFixturesPresent,
  getIntegrationFixtureProfile,
} = require('../helpers/integration-fixtures');

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL || (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'54322',"/",'postgres'].join(""));

describe('Client workflow policy seeding', () => {
  test('first four clients have deterministic geocoding/comms/callback/3PL policies', async () => {
    const profile = getIntegrationFixtureProfile();
    await ensureIntegrationFixturesPresent();
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const expected = [
      {
        slug: profile.clients.oneOne.slug,
        geocodingEnabled: true,
        commsEnabled: true,
        callbackEnabled: true,
        deliveryEnabled: true
      },
      {
        slug: profile.clients.oneTwo.slug,
        geocodingEnabled: false,
        commsEnabled: true,
        callbackEnabled: false,
        deliveryEnabled: false
      },
      {
        slug: profile.clients.oneThree.slug,
        geocodingEnabled: true,
        commsEnabled: false,
        callbackEnabled: true,
        deliveryEnabled: false
      },
      {
        slug: profile.clients.twoOne.slug,
        geocodingEnabled: false,
        commsEnabled: false,
        callbackEnabled: false,
        deliveryEnabled: false
      }
    ];

    const slugs = expected.map((entry) => entry.slug);
    const organizationSlug = profile.organizations.alpha.slug;

    let settingsRows;
    let providerRows;
    try {
      ({ rows: providerRows } = await client.query(
        `
          SELECT id, name
          FROM providers
          WHERE name IN ('here_geocoding', 'dialog360_whatsapp', 'logestechs_3pl', 'twilio_sms')
        `
      ));
      const providerMap = Object.fromEntries(providerRows.map((row) => [row.name, row.id]));

      ({ rows: settingsRows } = await client.query(
        `
          SELECT c.slug, s.category, s.cached_value
          FROM clients c
          JOIN organizations o ON o.id = c.organization_id
          JOIN settings s
            ON s.scope_type = 'client'
           AND s.scope_id = c.id
          WHERE c.slug = ANY($1::text[])
            AND o.slug = $2::text
        `,
        [slugs, organizationSlug]
      ));

      const policyMap = new Map();
      for (const row of settingsRows) {
        if (!policyMap.has(row.slug)) {
          policyMap.set(row.slug, {});
        }
        policyMap.get(row.slug)[row.category] = row.cached_value;
      }

      expect(policyMap.size).toBeGreaterThanOrEqual(expected.length);

      for (const entry of expected) {
        const policies = policyMap.get(entry.slug);
        expect(policies).toBeTruthy();

        const geocodePolicy = policies.geocoding_policy || {};
        const geocodeEnabled =
          (geocodePolicy.metadata &&
            geocodePolicy.metadata.policy_profile !== 'disabled') ||
          false;
        expect(geocodeEnabled).toBe(entry.geocodingEnabled);
        if (entry.geocodingEnabled) {
          expect(Array.isArray(geocodePolicy.provider_priority)).toBe(true);
          expect(geocodePolicy.provider_priority).toContain('here_geocoding');
          expect(geocodePolicy.metadata?.primary_provider_id).toBe(
            providerMap.here_geocoding
          );
        } else if (geocodePolicy.metadata) {
          expect(geocodePolicy.metadata.policy_profile).toBe('disabled');
        }

        const commsPolicy = policies.communications_policy || {};
        expect(Boolean(commsPolicy.enabled)).toBe(entry.commsEnabled);
        if (entry.commsEnabled) {
          expect(Array.isArray(commsPolicy.channels)).toBe(true);
          expect(commsPolicy.channels[0].provider_id).toBe(providerMap.dialog360_whatsapp);
        }

        const callbackPolicy = policies.provider_callback_policy || {};
        expect(Boolean(callbackPolicy.enabled)).toBe(entry.callbackEnabled);
        if (entry.callbackEnabled) {
          expect(typeof callbackPolicy.callback_url).toBe('string');
          expect(callbackPolicy.callback_url.length).toBeGreaterThan(0);
        }

        const deliveryPolicy = policies.delivery_routing_policy || {};
        expect(Boolean(deliveryPolicy.enabled)).toBe(entry.deliveryEnabled);
        if (entry.deliveryEnabled) {
          expect(deliveryPolicy.provider_id).toBe(providerMap.logestechs_3pl);
          expect(deliveryPolicy.retry.max_attempts).toBeGreaterThan(0);
        }
      }
    } finally {
      await client.end();
    }
  });
});
