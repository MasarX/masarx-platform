/**
 * Faker.js Seed Data Generator
 * Task Group 9: Generate realistic test data for local development
 * FIXED: Updated to match actual Plan.md schema (no external_reference column)
 *
 * Features:
 * - Mixed-language seed data (EN system defaults + optional AR payload rows)
 * - Deterministic output with fixed seed
 * - Configurable volumes: 100, 10000, 100000
 * - Progress indicator every 1000 records
 * - Realistic data: organizations, clients, senders, shipments
 *
 * Usage:
 *   node scripts/data/seed-test-data.js [volume]
 *
 * Examples:
 *   node scripts/data/seed-test-data.js 100     # Small (< 5s)
 *   node scripts/data/seed-test-data.js 10000   # Medium (< 30s, DEFAULT)
 *   node scripts/data/seed-test-data.js 100000  # Large (< 5m)
 */

const { faker } = require('@faker-js/faker'); // English default (system structure)
const { faker: fakerAr } = require('@faker-js/faker/locale/ar');
const { createHash, randomUUID } = require('crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { attachPoolErrorGuard } = require('../utils/pg-pool-guard');
const { normalizeWebhookIngestPolicy } = require('../utils/webhook-ingest-policy');
const { upsertProviderAuthCredentialsVault } = require('../utils/provider-auth-vault');
const { assertMutationAllowed } = require('../utils/production-mutation-guard');
const {
  loadSeedServiceTypes,
  loadSeedShipmentStatuses,
} = require('./seed-lookup-values');

// Ensure ENV_FILE and other .env files are honoured so DATABASE_URL
// is available when running from local-verify.
loadEnv();
attachPoolErrorGuard();

assertMutationAllowed({
  operation: 'seed-test-data',
  allowProductionEnvVar: 'SEED_TEST_DATA_ALLOW_PRODUCTION',
});

// Fixed seeds for deterministic output (EN + AR)
faker.seed(12345);
fakerAr.seed(12345);

// Database connection pool
if (!process.env.DATABASE_URL) {
  throw new Error('[seed-test-data] DATABASE_URL is required. Export it or set ENV_FILE.');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SEED_DATA_ONBOARDING_SOURCE = 'provision_demo_accounts_v1';
const SEED_DATA_POST_PROVISION_BOOTSTRAP_SOURCE = 'seed-test-data:post-provision';

async function ensurePublicSearchPath(client) {
  await client.query('SET search_path TO public, extensions');
}

async function getOrganizationOnboardingSource(client) {
  const result = await client.query(
    "SELECT current_setting('app.organization_onboarding_source', true) AS source"
  );
  return result.rows?.[0]?.source ?? '';
}

async function setOrganizationOnboardingSource(client, source) {
  await client.query(
    "SELECT set_config('app.organization_onboarding_source', $1, false)",
    [source ?? '']
  );
}

async function withOrganizationOnboardingSource(client, source, action) {
  const previousSource = await getOrganizationOnboardingSource(client);
  await setOrganizationOnboardingSource(client, source);
  try {
    return await action();
  } finally {
    await setOrganizationOnboardingSource(client, previousSource);
  }
}

async function runSeedTenantOnboardingBootstrap(client, orgIds) {
  const results = [];
  for (const orgId of orgIds) {
    const result = await client.query(
      `
        SELECT public.bootstrap_tenant_onboarding_v1($1::uuid, $2::text) AS result
      `,
      [orgId, SEED_DATA_POST_PROVISION_BOOTSTRAP_SOURCE]
    );
    const payload = result.rows?.[0]?.result;
    if (payload && typeof payload === 'object' && payload.ok === false) {
      throw new Error(`Tenant onboarding bootstrap failed for seed organization ${orgId}: ${JSON.stringify(payload)}`);
    }
    results.push(payload);
  }
  return results;
}

function normalizeSeedSettingsValue(category, value) {
  const normalizedValue =
    category === 'webhook_ingest_policy'
      ? normalizeWebhookIngestPolicy(value)
      : value;
  if (
    category === 'geocoding_policy' &&
    normalizedValue &&
    typeof normalizedValue === 'object' &&
    !Array.isArray(normalizedValue)
  ) {
    delete normalizedValue.enabled;
  }

  return normalizedValue;
}

async function upsertScopedSettings(client, category, scopeType, scopeId, value, changeReason) {
  const normalizedValue = normalizeSeedSettingsValue(category, value);
  const valueJson = JSON.stringify(normalizedValue ?? {});
  const defaultChangeReason = changeReason ?? 'Seed baseline settings';

  if (category === 'webhook_ingest_policy') {
    const { rows } = await client.query(
      `SELECT public.upsert_webhook_ingest_policy($1, $2, $3::jsonb) AS settings_id`,
      [scopeType, scopeId, valueJson]
    );
    const current = await client.query(
      `SELECT settings_version_id FROM public.settings WHERE id = $1::uuid`,
      [rows[0].settings_id]
    );
    return current.rows[0].settings_version_id;
  }

  const nilUuid = '00000000-0000-0000-0000-000000000000';
  const scopeHash = scopeId || nilUuid;
  const versionMergeExpr =
    category === 'geocoding_policy'
      ? `jsonb_strip_nulls((COALESCE(value, '{}'::jsonb) - 'enabled') || $1::jsonb)`
      : `jsonb_strip_nulls(COALESCE(value, '{}'::jsonb) || $1::jsonb)`;
  const cachedMergeExpr =
    category === 'geocoding_policy'
      ? `jsonb_strip_nulls((COALESCE(settings.cached_value, '{}'::jsonb) - 'enabled') || $6::jsonb)`
      : `jsonb_strip_nulls(COALESCE(settings.cached_value, '{}'::jsonb) || $6::jsonb)`;

  const activeSchemas = await client.query(
    `
      SELECT version
      FROM public.schema_registry
      WHERE category = $1
        AND is_active = TRUE
      ORDER BY version
    `,
    [category]
  );
  if (activeSchemas.rowCount !== 1) {
    throw new Error(
      `[seed-test-data] Expected exactly one active schema_registry version for ${category}; found ${activeSchemas.rowCount}`
    );
  }
  const schemaVersion = activeSchemas.rows[0].version;

  const existingVersion = await client.query(
    `
      SELECT id, value
      FROM settings_versions
      WHERE category = $1
        AND scope_type = $2
        AND scope_id IS NOT DISTINCT FROM $3
        AND effective_until IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [category, scopeType, scopeId]
  );

  let settingsVersionId;

  if (existingVersion.rowCount > 0) {
    settingsVersionId = existingVersion.rows[0].id;

    await client.query(
      `
        UPDATE settings_versions
        SET value = ${versionMergeExpr},
            change_reason = $2,
            schema_version = $4,
            approved_at = now(),
            effective_from = now()
        WHERE id = $3
      `,
      [valueJson, defaultChangeReason, settingsVersionId, schemaVersion]
    );
  } else {
    const { rows } = await client.query(
      `
        INSERT INTO settings_versions (
          category,
          scope_type,
          scope_id,
          version,
          value,
          schema_version,
          change_reason,
          approved_at,
          effective_from
        )
        VALUES ($1, $2, $3, 1, $4::jsonb, $5::int, $6, now(), now())
        RETURNING id
      `,
      [category, scopeType, scopeId, valueJson, schemaVersion, defaultChangeReason]
    );

    settingsVersionId = rows[0].id;
  }

  await client.query(
    `
      INSERT INTO settings (
        category,
        scope_type,
        scope_id,
        scope_hash,
        settings_version_id,
        cached_value,
        last_updated
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
      ON CONFLICT (category, scope_type, scope_hash)
      DO UPDATE SET
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = ${cachedMergeExpr},
        last_updated = now()
    `,
    [category, scopeType, scopeId, scopeHash, settingsVersionId, valueJson]
  );

  return settingsVersionId;
}

/**
 * Validate command-line arguments
 */
function validateArgs() {
  const volume = parseInt(process.argv[2]) || 10000;

  if (![100, 10000, 100000].includes(volume)) {
    console.error('ERROR: Volume must be 100, 10000, or 100000');
    console.error('Usage: node scripts/data/seed-test-data.js [volume]');
    process.exit(1);
  }

  return volume;
}

/**
 * Generate Saudi Arabia address using Arabic locale
 */
function generateSaudiAddress(fakerInstance) {
  const f = fakerInstance || faker;
  const cities = ['Riyadh', 'Jeddah', 'Mecca', 'Medina', 'Dammam', 'Khobar', 'Tabuk'];
  const districts = ['Al Olaya', 'Al Malaz', 'Al Naseem', 'Al Rawdah', 'Al Sulay', 'Al Muruj'];

  return {
    street_line1: f.location.streetAddress(),
    district: f.helpers.arrayElement(districts),
    city: f.helpers.arrayElement(cities),
    postal_code: f.location.zipCode('#####'),
    province: f.helpers.arrayElement(['Riyadh Province', 'Makkah Province', 'Eastern Province']),
    country_code: 'SA',
    latitude: f.location.latitude({ min: 16.0, max: 32.0 }), // Saudi Arabia bounds
    longitude: f.location.longitude({ min: 34.0, max: 56.0 }), // Saudi Arabia bounds
    location_accuracy: f.helpers.arrayElement(['exact', 'approximate', 'city_level'])
  };
}

/**
 * Generate phone number in Saudi format
 */
function generateSaudiPhone() {
  // Saudi phone format: +966XXXXXXXXX (9 digits after country code)
  return `+966${faker.string.numeric(9)}`;
}

function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(String(seed), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const repeatWords = (base, n) => (
  Array.from({ length: n }).map(() => base).join(' ')
);

const noteTemplates = {
  en: [
    'Fragile - handle with care.',
    'Deliver between 9-5.',
    'Call on arrival.',
    'Leave at reception if unavailable.',
    'Do not bend.',
  ],
  ar: [
    'يرجى التعامل بحذر.',
    'يرجى الاتصال عند الوصول.',
    'يرجى التوصيل بين ٩-٥.',
    'اترك الشحنة عند الاستقبال إذا لم يكن أحد متاحاً.',
    'لا تقم بثني الشحنة.',
  ],
};

const cityBank = [
  { en: { city: 'Riyadh', province: 'Riyadh', country: 'SA' }, ar: { city: 'الرياض', province: 'الرياض', country: 'SA' } },
  { en: { city: 'Jeddah', province: 'Makkah', country: 'SA' }, ar: { city: 'جدة', province: 'مكة', country: 'SA' } },
  { en: { city: 'Mecca', province: 'Makkah', country: 'SA' }, ar: { city: 'مكة', province: 'مكة', country: 'SA' } },
  { en: { city: 'Medina', province: 'Medina', country: 'SA' }, ar: { city: 'المدينة', province: 'المدينة', country: 'SA' } },
  { en: { city: 'Dammam', province: 'Eastern', country: 'SA' }, ar: { city: 'الدمام', province: 'الشرقية', country: 'SA' } },
  { en: { city: 'Al Khobar', province: 'Eastern', country: 'SA' }, ar: { city: 'الخبر', province: 'الشرقية', country: 'SA' } },
  { en: { city: 'Tabuk', province: 'Tabuk', country: 'SA' }, ar: { city: 'تبوك', province: 'تبوك', country: 'SA' } },
  { en: { city: 'Abha', province: 'Asir', country: 'SA' }, ar: { city: 'أبها', province: 'عسير', country: 'SA' } },
];

const districtBank = {
  en: ['Al Olaya', 'Al Malaz', 'Al Naseem', 'Al Rawdah', 'Al Sulay', 'Al Muruj'],
  ar: ['العليا', 'الملز', 'النسيم', 'الروضة', 'السلي', 'المروج'],
};

const pickLang = (i) => (i % 5 === 0 ? 'ar' : 'en'); // ~20% Arabic rows by default

const makeNote = (lang, i) => {
  const base = (noteTemplates[lang] || noteTemplates.en)[i % (noteTemplates[lang] || noteTemplates.en).length];
  if (lang === 'ar') return `${base} ${repeatWords('يرجى', i % 6)}`.trim();
  return `${base} ${repeatWords('Please', i % 6)}`.trim();
};

const makeAddressRow = ({ lang, clientId, organizationId, i }) => {
  const f = lang === 'ar' ? fakerAr : faker;
  const city = cityBank[i % cityBank.length][lang];
  const district = districtBank[lang][i % districtBank[lang].length];
  const line1 = f.location.streetAddress();
  const postal = f.location.zipCode('#####');
  const raw = [line1, district, city.city, city.province, city.country].filter(Boolean).join(', ');
  return {
    id: deterministicUuid(`seed-address:${organizationId}:${clientId}:${lang}:${i}`),
    organization_id: organizationId,
    client_id: clientId,
    raw_input: raw,
    normalized_line1: line1,
    normalized_line2: null,
    district,
    city: city.city,
    province: city.province,
    postal_code: postal,
    country: city.country,
    validation_status: 'pending',
    lang,
  };
};

const makeRecipientRow = ({ lang, clientId, organizationId, i }) => {
  const f = lang === 'ar' ? fakerAr : faker;
  return {
    id: deterministicUuid(`seed-recipient:${organizationId}:${clientId}:${lang}:${i}`),
    organization_id: organizationId,
    client_id: clientId,
    name: f.person.fullName(),
    phone_number: generateSaudiPhone(),
    preferred_language: lang,
  };
};

async function seedRecipientAndAddressPools(client, clientIds, volume) {
  console.log('[3.5/5] Seeding recipients + addresses pools (EN/AR mix)...');

  const { rows: clientRows } = await client.query(
    `
      SELECT id, organization_id
      FROM clients
      WHERE id = ANY($1::uuid[])
    `,
    [clientIds]
  );
  const orgIdByClientId = new Map(clientRows.map((r) => [r.id, r.organization_id]));

  const perClientBase = Math.max(30, Math.ceil(Math.sqrt(volume)));
  const recipientsPerClient = Math.min(200, perClientBase);
  const addressesPerClient = Math.min(200, perClientBase);

  const poolsByClientId = new Map();
  let totalRecipients = 0;
  let totalAddresses = 0;

  const insertRecipients = async (rows) => {
    if (!rows.length) return;
    await client.query(
      `
        INSERT INTO recipients (
          id, organization_id, client_id, name, phone_number, preferred_language, created_at, updated_at
        )
        SELECT t.id, t.organization_id, t.client_id, t.name, t.phone_number, t.preferred_language, now(), now()
        FROM UNNEST(
          $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[]
        ) AS t(id, organization_id, client_id, name, phone_number, preferred_language)
        ON CONFLICT DO NOTHING
      `,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.organization_id),
        rows.map((r) => r.client_id),
        rows.map((r) => r.name),
        rows.map((r) => r.phone_number),
        rows.map((r) => r.preferred_language),
      ]
    );
  };

  const insertAddresses = async (rows) => {
    if (!rows.length) return;
    await client.query(
      `
        INSERT INTO addresses (
          id, organization_id, client_id, raw_input, normalized_line1, normalized_line2,
          district, city, province, postal_code, country, validation_status, created_at, updated_at
        )
        SELECT
          t.id, t.organization_id, t.client_id, t.raw_input, t.normalized_line1, t.normalized_line2,
          t.district, t.city, t.province, t.postal_code, t.country, t.validation_status, now(), now()
        FROM UNNEST(
          $1::uuid[], $2::uuid[], $3::uuid[],
          $4::text[], $5::text[], $6::text[],
          $7::text[], $8::text[], $9::text[],
          $10::text[], $11::text[], $12::text[]
        ) AS t(
          id, organization_id, client_id,
          raw_input, normalized_line1, normalized_line2,
          district, city, province,
          postal_code, country, validation_status
        )
        ON CONFLICT DO NOTHING
      `,
      [
        rows.map((r) => r.id),
        rows.map((r) => r.organization_id),
        rows.map((r) => r.client_id),
        rows.map((r) => r.raw_input),
        rows.map((r) => r.normalized_line1),
        rows.map((r) => r.normalized_line2),
        rows.map((r) => r.district),
        rows.map((r) => r.city),
        rows.map((r) => r.province),
        rows.map((r) => r.postal_code),
        rows.map((r) => r.country),
        rows.map((r) => r.validation_status),
      ]
    );
  };

  for (let c = 0; c < clientIds.length; c += 1) {
    const clientId = clientIds[c];
    const organizationId = orgIdByClientId.get(clientId);
    if (!organizationId) continue;

    const recipientRows = [];
    const addressRows = [];

    for (let i = 0; i < recipientsPerClient; i += 1) {
      const lang = pickLang(i + c * 97);
      recipientRows.push(makeRecipientRow({ lang, clientId, organizationId, i }));
    }
    for (let i = 0; i < addressesPerClient; i += 1) {
      const lang = pickLang(i + c * 131);
      addressRows.push(makeAddressRow({ lang, clientId, organizationId, i }));
    }

    for (let i = 0; i < recipientRows.length; i += 500) {
      await insertRecipients(recipientRows.slice(i, i + 500));
    }
    for (let i = 0; i < addressRows.length; i += 500) {
      await insertAddresses(addressRows.slice(i, i + 500));
    }

    const recipientPools = { en: [], ar: [] };
    for (const r of recipientRows) recipientPools[r.preferred_language].push(r.id);

    const addressPools = { en: [], ar: [] };
    for (const a of addressRows) addressPools[a.lang].push(a.id);

    poolsByClientId.set(clientId, { organizationId, recipients: recipientPools, addresses: addressPools });
    totalRecipients += recipientRows.length;
    totalAddresses += addressRows.length;
  }

  console.log(`  Pools ready: ${totalRecipients} recipients, ${totalAddresses} addresses`);

  return {
    orgIdByClientId,
    poolsByClientId,
    totals: { recipients: totalRecipients, addresses: totalAddresses },
  };
}

async function seedShipments(
  client,
  clientIds,
  senderIds,
  volume,
  poolState,
  shipmentStatuses,
  seededServiceTypes
) {
  console.log(`[4/5] Seeding ${volume} shipments (label-ready: recipients/addresses/boxes + EN/AR metadata)...`);
  console.log('  This may take a few moments...\n');

  const orgIdByClientId = poolState && poolState.orgIdByClientId ? poolState.orgIdByClientId : new Map();
  const poolsByClientId = poolState && poolState.poolsByClientId ? poolState.poolsByClientId : new Map();

  let seeded = 0;
  const batchSize = volume >= 100000 ? 1000 : 500;
  const serviceTypes =
    Array.isArray(seededServiceTypes) && seededServiceTypes.length
      ? seededServiceTypes
      : await loadSeedServiceTypes(client);
  const statuses =
    Array.isArray(shipmentStatuses) && shipmentStatuses.length
      ? shipmentStatuses
      : await loadSeedShipmentStatuses(client);
  const serviceLevels = ['economy', 'standard', 'premium', 'express'];

  while (seeded < volume) {
    const n = Math.min(batchSize, volume - seeded);

    const orgIds = [];
    const clientIdArr = [];
    const senderIdArr = [];
    const recipientIdArr = [];
    const originAddressIdArr = [];
    const destAddressIdArr = [];
    const serviceTypeArr = [];
    const trackingArr = [];
    const carrierRefArr = [];
    const clientRefArr = [];
    const boxCountArr = [];
    const serviceLevelArr = [];
    const specialArr = [];
    const declaredArr = [];
    const codArr = [];
    const codCurrencyArr = [];
    const statusArr = [];
    const priorityArr = [];
    const createdAtArr = [];
    const metadataArr = [];

    for (let i = 0; i < n; i += 1) {
      const globalIdx = seeded + i;
      const clientIndex = globalIdx % clientIds.length;
      const clientId = clientIds[clientIndex];
      const senderId = senderIds[clientIndex];
      const organizationId = orgIdByClientId.get(clientId) || poolsByClientId.get(clientId)?.organizationId;

      if (!organizationId) {
        throw new Error(`[seedShipments] Missing organization_id for client_id=${clientId}`);
      }

      const lang = pickLang(globalIdx);
      const pool = poolsByClientId.get(clientId);
      const recPool = pool && pool.recipients
        ? (pool.recipients[lang].length ? pool.recipients[lang] : pool.recipients.en)
        : [];
      const addrPool = pool && pool.addresses
        ? (pool.addresses[lang].length ? pool.addresses[lang] : pool.addresses.en)
        : [];

      const recipientId = recPool.length ? recPool[globalIdx % recPool.length] : null;
      const originAddressId = addrPool.length ? addrPool[(globalIdx + 7) % addrPool.length] : null;
      const destinationAddressId = addrPool.length ? addrPool[(globalIdx + 13) % addrPool.length] : null;

      const trackingNumber = `DLX${String(globalIdx + 1).padStart(9, '0')}`;
      const serviceType = serviceTypes[globalIdx % serviceTypes.length];
      const shipmentStatus = statuses[globalIdx % statuses.length];
      const serviceLevel = serviceLevels[globalIdx % serviceLevels.length];
      const priority = Number((((globalIdx * 7) % 10000) / 100).toFixed(2));
      const createdAt = new Date(Date.now() - ((globalIdx % 30) * 86400000) - ((globalIdx % 3600) * 1000));

      const declaredValue = Number((10 + (globalIdx % 990) + ((globalIdx % 100) / 100)).toFixed(2));
      const codAmount = globalIdx % 4 === 0
        ? null
        : (globalIdx % 4 === 1 ? 0 : Number((25 + (globalIdx % 975) + 0.75).toFixed(2)));
      const codCurrency = globalIdx % 5 === 0 ? 'SAR' : 'AED';

      const headerBrandMode = globalIdx % 3 === 0 ? 'text' : 'logo';
      const senderPhone = `+966${String((globalIdx * 741852963) % 1000000000).padStart(9, '0')}`;

      const metadata = {
        header_brand_mode: headerBrandMode,
        sender_phone: senderPhone,
        notes: makeNote(lang, globalIdx),
      };

      orgIds.push(organizationId);
      clientIdArr.push(clientId);
      senderIdArr.push(senderId);
      recipientIdArr.push(recipientId);
      originAddressIdArr.push(originAddressId);
      destAddressIdArr.push(destinationAddressId);

      serviceTypeArr.push(serviceType);
      trackingArr.push(trackingNumber);
      carrierRefArr.push(`CARRIER-${String((globalIdx * 9301 + 49297) % 1000000000).padStart(9, '0')}`);
      clientRefArr.push(`CLIENT-${String((globalIdx * 233280 + 49297) % 1000000000).padStart(9, '0')}`);
      boxCountArr.push(1);
      serviceLevelArr.push(serviceLevel);
      specialArr.push(lang === 'ar' ? 'يرجى التعامل بحذر' : 'Handle with care');
      declaredArr.push(declaredValue);
      codArr.push(codAmount);
      codCurrencyArr.push(codCurrency);
      statusArr.push(shipmentStatus);
      priorityArr.push(priority);
      createdAtArr.push(createdAt);
      metadataArr.push(JSON.stringify(metadata));
    }

    const { rows: upserted } = await client.query(
      `
        INSERT INTO shipments (
          organization_id,
          client_id,
          sender_id,
          recipient_id,
          origin_address_id,
          destination_address_id,
          service_type,
          tracking_number,
          carrier_reference_number,
          client_reference_number,
          box_count,
          service_level,
          special_instructions,
          declared_value,
          cod_amount,
          cod_currency,
          status,
          priority_score,
          metadata,
          created_at,
          updated_at
        )
        SELECT
          t.organization_id,
          t.client_id,
          t.sender_id,
          t.recipient_id,
          t.origin_address_id,
          t.destination_address_id,
          t.service_type,
          t.tracking_number,
          t.carrier_reference_number,
          t.client_reference_number,
          t.box_count,
          t.service_level,
          t.special_instructions,
          t.declared_value,
          t.cod_amount,
          t.cod_currency,
          t.status,
          t.priority_score,
          t.metadata_text::jsonb,
          t.created_at,
          t.created_at
        FROM UNNEST(
          $1::uuid[],  $2::uuid[],  $3::uuid[],
          $4::uuid[],  $5::uuid[],  $6::uuid[],
          $7::text[],  $8::text[],  $9::text[],
          $10::text[], $11::int[],  $12::text[],
          $13::text[], $14::numeric[], $15::numeric[],
          $16::text[], $17::text[], $18::numeric[],
          $19::text[], $20::timestamptz[]
        ) AS t(
          organization_id, client_id, sender_id,
          recipient_id, origin_address_id, destination_address_id,
          service_type, tracking_number, carrier_reference_number,
          client_reference_number, box_count, service_level,
          special_instructions, declared_value, cod_amount,
          cod_currency, status, priority_score,
          metadata_text, created_at
        )
        ON CONFLICT (tracking_number, client_id)
        DO UPDATE SET
          sender_id = EXCLUDED.sender_id,
          recipient_id = EXCLUDED.recipient_id,
          origin_address_id = EXCLUDED.origin_address_id,
          destination_address_id = EXCLUDED.destination_address_id,
          service_type = EXCLUDED.service_type,
          carrier_reference_number = EXCLUDED.carrier_reference_number,
          client_reference_number = EXCLUDED.client_reference_number,
          box_count = EXCLUDED.box_count,
          service_level = EXCLUDED.service_level,
          special_instructions = EXCLUDED.special_instructions,
          declared_value = EXCLUDED.declared_value,
          cod_amount = EXCLUDED.cod_amount,
          cod_currency = EXCLUDED.cod_currency,
          status = EXCLUDED.status,
          priority_score = EXCLUDED.priority_score,
          metadata = jsonb_strip_nulls(COALESCE(shipments.metadata, '{}'::jsonb) || EXCLUDED.metadata),
          updated_at = now()
        RETURNING id, tracking_number, organization_id, client_id
      `,
      [
        orgIds,
        clientIdArr,
        senderIdArr,
        recipientIdArr,
        originAddressIdArr,
        destAddressIdArr,
        serviceTypeArr,
        trackingArr,
        carrierRefArr,
        clientRefArr,
        boxCountArr,
        serviceLevelArr,
        specialArr,
        declaredArr,
        codArr,
        codCurrencyArr,
        statusArr,
        priorityArr,
        metadataArr,
        createdAtArr,
      ]
    );

    const boxShipmentIds = [];
    const boxNumbers = [];
    const boxOrgIds = [];
    const boxClientIds = [];
    const boxBarcodes = [];
    const boxWeights = [];
    const boxVolWeights = [];
    const boxContents = [];
    const boxStatus = [];

    for (let i = 0; i < upserted.length; i += 1) {
      const row = upserted[i];
      const boxNumber = 1;
      const barcode = `${row.tracking_number}:${boxNumber}`;
      const weight = Number((((seeded + i) % 15) + 0.5).toFixed(2));
      boxShipmentIds.push(row.id);
      boxNumbers.push(boxNumber);
      boxOrgIds.push(row.organization_id);
      boxClientIds.push(row.client_id);
      boxBarcodes.push(barcode);
      boxWeights.push(weight);
      boxVolWeights.push(null);
      boxContents.push('Seeded box');
      boxStatus.push('pending');
    }

    if (boxShipmentIds.length) {
      await client.query(
        `
          INSERT INTO shipment_boxes (
            shipment_id, box_number, organization_id, client_id, barcode, weight_kg, volumetric_weight_kg, contents_description, status
          )
          SELECT * FROM UNNEST(
            $1::uuid[], $2::int[], $3::uuid[], $4::uuid[], $5::text[], $6::numeric[], $7::numeric[], $8::text[], $9::text[]
          ) AS t(shipment_id, box_number, organization_id, client_id, barcode, weight_kg, volumetric_weight_kg, contents_description, status)
          ON CONFLICT (barcode) DO NOTHING
        `,
        [boxShipmentIds, boxNumbers, boxOrgIds, boxClientIds, boxBarcodes, boxWeights, boxVolWeights, boxContents, boxStatus]
      );
    }

    seeded += n;

    if (seeded % 1000 === 0 || seeded === volume) {
      console.log(`  Progress: ${seeded}/${volume} shipments (${Math.round(seeded / volume * 100)}%)`);
    }
  }

  console.log(`\n  Seeded ${volume} shipments`);
}

/**
 * Seed organizations (3 test organizations)
 */
async function seedOrganizations(client) {
  console.log('\n[1/5] Seeding organizations...');

  const organizations = [
    { name: 'Test Organization Alpha', slug: 'test-org-alpha' },
    { name: 'Test Organization Beta', slug: 'test-org-beta' },
    { name: 'Test Organization Gamma', slug: 'test-org-gamma' }
  ];

  const orgIds = [];

  for (const org of organizations) {
    const result = await withOrganizationOnboardingSource(
      client,
      SEED_DATA_ONBOARDING_SOURCE,
      () => client.query(`
        INSERT INTO organizations (name, slug, timezone, locale, billing_status)
        VALUES ($1, $2, 'Asia/Riyadh', 'ar-SA', 'active')
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [org.name, org.slug])
    );

    orgIds.push(result.rows[0].id);
  }

  console.log(`  âœ“ Seeded ${orgIds.length} organizations`);
  return orgIds;
}

/**
 * Seed clients (3 clients per organization)
 */
async function seedClients(client, orgIds) {
  console.log('[2/5] Seeding clients...');

  const clientIds = [];

  for (const orgId of orgIds) {
    for (let i = 1; i <= 3; i++) {
      // Keep load-test/demo seed clients namespaced so they never collide with
      // the reserved integration fixture slugs (`test-client-*`).
      const clientSlug = `seed-client-${orgIds.indexOf(orgId) + 1}-${i}`;
      const result = await client.query(`
        INSERT INTO clients (
          organization_id, name, slug, sla_tier, status, settings_override
        )
        VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)
        ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [
        orgId,
        faker.company.name(),
        clientSlug,
        faker.helpers.arrayElement(['economy', 'standard', 'premium'])
      ]);

      clientIds.push(result.rows[0].id);
    }
  }

  console.log(`  âœ“ Seeded ${clientIds.length} clients (3 per organization)`);
  return clientIds;
}

/**
 * Seed senders (1 sender per client for simplicity)
 */
async function seedSenders(client, clientIds) {
  console.log('[3/5] Seeding senders...');

  const senderIds = [];

  for (let i = 0; i < clientIds.length; i += 1) {
    const clientId = clientIds[i];
    const lang = pickLang(i);
    const f = lang === 'ar' ? fakerAr : faker;
    const result = await client.query(`
      INSERT INTO senders (
        client_id, name, brand_name, auto_provisioned, auto_recreate, status
      )
      VALUES ($1, $2, $3, false, true, 'active')
      RETURNING id
    `, [
      clientId,
      f.company.name(),
      f.company.catchPhrase()
    ]);

    senderIds.push(result.rows[0].id);
  }

  console.log(`  âœ“ Seeded ${senderIds.length} senders`);
  return senderIds;
}

/**
 * Seed shipments (distributed evenly across clients)
 * FIXED: Uses actual schema columns (no external_reference, uses carrier/client_reference_number)
 */
async function seedShipmentsLegacy(
  client,
  clientIds,
  senderIds,
  volume,
  shipmentStatuses,
  seededServiceTypes
) {
  console.log(`[4/5] Seeding ${volume} shipments...`);
  console.log('  This may take a few moments...\n');

  // Get first organization ID for shipments
  const orgResult = await client.query('SELECT id FROM organizations LIMIT 1');
  const organizationId = orgResult.rows[0].id;

  let seeded = 0;
  const statuses =
    Array.isArray(shipmentStatuses) && shipmentStatuses.length
      ? shipmentStatuses
      : await loadSeedShipmentStatuses(client);
  const serviceTypes =
    Array.isArray(seededServiceTypes) && seededServiceTypes.length
      ? seededServiceTypes
      : await loadSeedServiceTypes(client);

  while (seeded < volume) {
    const clientIndex = seeded % clientIds.length;
    const clientId = clientIds[clientIndex];
    const senderId = senderIds[clientIndex];
    const trackingNumber = `DLX${String(seeded + 1).padStart(9, '0')}`;
    const serviceType = faker.helpers.arrayElement(serviceTypes);
    const status = faker.helpers.arrayElement(statuses);
    const priority = faker.number.float({ min: 0, max: 100, fractionDigits: 2 });
    const createdAt = faker.date.recent({ days: 30 });

    // Insert shipment using ACTUAL schema (Plan.md Section 4.5)
    await client.query(`
      INSERT INTO shipments_p0 (
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        carrier_reference_number,
        client_reference_number,
        box_count,
        service_level,
        special_instructions,
        declared_value,
        cod_amount,
        cod_currency,
        status,
        priority_score,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16
      )
      ON CONFLICT (tracking_number, client_id) DO NOTHING
    `, [
      organizationId,
      clientId,
      senderId,
      serviceType,
      trackingNumber,
      `CARRIER-${faker.string.alphanumeric(10).toUpperCase()}`, // carrier_reference_number
      `CLIENT-${faker.string.alphanumeric(8).toUpperCase()}`,   // client_reference_number
      faker.number.int({ min: 1, max: 5 }), // box_count
      faker.helpers.arrayElement(['economy', 'standard', 'premium', 'express']), // service_level
      faker.lorem.sentence(), // special_instructions
      faker.number.float({ min: 10, max: 1000, fractionDigits: 2 }), // declared_value
      faker.datatype.boolean() ? faker.number.float({ min: 50, max: 500, fractionDigits: 2 }) : null, // cod_amount
      'SAR', // cod_currency
      status,
      priority,
      createdAt
    ]);

    seeded++;

    // Progress indicator every 1000 records
    if (seeded % 1000 === 0 || seeded === volume) {
      console.log(`  Progress: ${seeded}/${volume} shipments (${Math.round(seeded / volume * 100)}%)`);
    }
  }

  console.log(`\n  âœ“ Seeded ${volume} shipments`);
}

/**
 * Seed providers, auth configs, mapping configs, webhook sources, and webhook ingest policies
 */
async function seedWebhookInfrastructure(client, { organizationId, clientId, senderId }) {
  console.log('\n[Bonus] Seeding webhook + provider infrastructure...');

  const upsertProvider = async ({ name, type, metadata, priority = 100 }) => {
    const existing = await client.query(
      `SELECT id FROM providers WHERE organization_id = $1 AND name = $2`,
      [organizationId, name]
    );

    if (existing.rows.length) {
      const providerId = existing.rows[0].id;
      await client.query(
        `
          UPDATE providers
          SET provider_type = $2,
              priority_rank = $3,
              metadata = $4,
              updated_at = now()
          WHERE id = $1
        `,
        [providerId, type, priority, metadata]
      );
      return providerId;
    }

    const { rows } = await client.query(
      `
        INSERT INTO providers (organization_id, name, provider_type, priority_rank, metadata)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [organizationId, name, type, priority, metadata]
    );
    return rows[0].id;
  };

  const upsertProviderAuth = async (providerId, authType, credentials) => {
    if (!providerId || !authType) return null;

    const { authConfigId } = await upsertProviderAuthCredentialsVault(client, {
      providerId,
      authType,
      credentials,
      expiresAt: null,
    });

    return authConfigId;
  };
  const LOGESTECHS_PROVIDER_DEFAULTS = {
    service_type: 'STANDARD',
    shipment_type: 'REGULAR',
    integration_source: 'INTEGRATION',
    sender_name: 'AutomationSender',
    business_sender_name: 'AutomationSender',
    sender_phone: '544288859',
    receiver_name: 'QA Receiver',
    receiver_phone: '+12025550123',
    receiver_phone_secondary: null,
    package_item_name: 'Automation Item',
    package_notes: '',
    description: 'Automation order',
    destination_village: 'Ø§Ù„Ø±ÙŠØ§Ø¶',
    unit_type: 'METRIC',
    package_weight: 1,
    package_width: null,
    package_length: null,
    package_height: null,
    cod: 0,
    package_template: {
      weight: 1,
      quantity: 1,
      width: 10,
      length: 10,
      height: 10,
      packageItemsToDeliverList: null
    },
    origin_template: {
      addressLine1: 'Automation Warehouse',
      cityId: 230194,
      villageId: 343332,
      regionId: 1265
    },
    destination_template: {
      addressLine1: 'Automation Customer',
      cityId: 230194,
      villageId: 343332,
      regionId: 1265
    },
    package_items: null
  };

  const DIALOG360_PROVIDER_DEFAULTS = {
    default_recipient: '+12025550123',
    messaging_product: 'whatsapp'
  };

const resolveProviderAuth = (providerName) => {
  switch (providerName) {
    case 'twilio_sms': {
      const signingSecret = process.env.TWILIO_SIGNING_SECRET;
      return signingSecret
        ? { type: 'hmac', credentials: { signing_secret: signingSecret } }
        : null;
    }
    case 'here_geocoding': {
      const apiKey = process.env.HERE_GEOCODING_API_KEY;
      return apiKey ? { type: 'api_key', credentials: { api_key: apiKey } } : null;
    }
    case 'dialog360_whatsapp': {
      const apiKey = process.env.DIALOG360_API_KEY;
      return apiKey ? { type: 'api_key', credentials: { api_key: apiKey } } : null;
    }
    case 'logestechs_3pl': {
      const username = process.env.LOGESTECHS_USERNAME;
      const password = process.env.LOGESTECHS_PASSWORD;
      return username && password
        ? { type: 'basic_auth', credentials: { username, password } }
        : null;
    }
    default:
      return null;
  }
};

const providers = [
  {
    name: 'twilio_sms',
    type: 'comms',
    metadata: { channel: 'sms', region: 'global' }
  },
  {
    name: 'here_geocoding',
    type: 'geocoding',
    metadata: { base_url: 'https://geocode.search.hereapi.com/v1' }
  },
  {
    name: 'dialog360_whatsapp',
    type: 'comms',
    metadata: {
      channel: 'whatsapp',
      base_url: 'https://waba-sandbox.360dialog.io'
    }
  },
  {
    name: 'logestechs_3pl',
    type: 'delivery',
    metadata: {
      base_url: 'https://apisv2.logestechs.com',
      company_id: '362'
    }
  }
].map((provider) => ({
  ...provider,
  auth: resolveProviderAuth(provider.name)
}));

  const providerIds = {};
  const providerAuthIds = {};
  for (const provider of providers) {
    const providerId = await upsertProvider(provider);
    providerIds[provider.name] = providerId;
    if (provider.auth) {
      providerAuthIds[provider.name] = await upsertProviderAuth(
        providerId,
        provider.auth.type,
        provider.auth.credentials
      );
    }
    if (provider.name === 'logestechs_3pl') {
      await upsertScopedSettings(
        client,
        'provider_defaults',
        'resource',
        providerId,
        LOGESTECHS_PROVIDER_DEFAULTS,
        'Seed Logestechs provider defaults (seed-test-data)'
      );
    } else if (provider.name === 'dialog360_whatsapp') {
      await upsertScopedSettings(
        client,
        'provider_defaults',
        'resource',
        providerId,
        DIALOG360_PROVIDER_DEFAULTS,
        'Seed 360dialog provider defaults (seed-test-data)'
      );
    }
  }

  const upsertMapping = async (mappingKey, description, transforms) => {
    const { rows } = await client.query(
      `
        INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config, notes)
        VALUES ('webhook_inbound', $1, $2, $3)
        ON CONFLICT (mapping_type, mapping_key) DO UPDATE
          SET mapping_config = EXCLUDED.mapping_config,
              mapping_version = mapping_configs.mapping_version + 1,
              updated_at = now(),
              notes = EXCLUDED.notes
        RETURNING id
      `,
      [
        mappingKey,
        {
          description,
          external_id_path: 'event.id',
          event_type_path: 'event.type',
          transforms
        },
        description
      ]
    );
    return rows[0].id;
  };

  const basicMappingId = await upsertMapping(
    'test-basic-source::shipment.created',
    'Basic shipment.created mapping for integration tests',
    {
      shipment: {
        tracking_number: 'shipment.tracking_number',
        status: 'shipment.status',
        delivered_at: 'shipment.delivered_at'
      }
    }
  );

  const hmacMappingId = await upsertMapping(
    'test-hmac-source::shipment.created',
    'HMAC protected webhook source mapping',
    {}
  );

  const asyncMappingId = await upsertMapping(
    'test-async-source::shipment.created',
    'Async webhook source mapping with geocoding + comms expectations',
    {
      shipment: {
        tracking_number: 'shipment.tracking_number',
        customer_phone: 'shipment.customer.phone',
        requires_geocoding: 'shipment.requested_services',
        delivery_city: 'shipment.address.city'
      }
    }
  );

  const insertSource = async ({ identifier, name, providerType, token, mappingId }) => {
    const { rows } = await client.query(
      `
        INSERT INTO webhook_sources (
          organization_id,
          source_identifier,
          name,
          provider_type,
          auth_token,
          mapping_config_id,
          sender_id,
          rate_limit_per_hour,
          enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, true)
        ON CONFLICT (organization_id, source_identifier) DO UPDATE
          SET mapping_config_id = EXCLUDED.mapping_config_id,
              auth_token = EXCLUDED.auth_token,
              sender_id = EXCLUDED.sender_id,
              updated_at = now()
        RETURNING id
      `,
      [
        organizationId,
        identifier,
        name,
        providerType,
        token,
        mappingId,
        senderId
      ]
    );
    return rows[0].id;
  };

  const basicSourceId = await insertSource({
    identifier: 'test-basic-source',
    name: 'Test Shopify Webhook Source',
    providerType: 'shopify',
    token: 'EXAMPLE_PASSWORD',
    mappingId: basicMappingId
  });

  const hmacSourceId = await insertSource({
    identifier: 'test-hmac-source',
    name: 'Test ERP Webhook Source (HMAC)',
    providerType: 'custom_erp',
    token: 'EXAMPLE_PASSWORD',
    mappingId: hmacMappingId
  });

  const asyncSourceId = await insertSource({
    identifier: 'test-async-source',
    name: 'Test Async 3PL Webhook Source',
    providerType: 'async_3pl',
    token: 'EXAMPLE_PASSWORD',
    mappingId: asyncMappingId
  });

  const selectTemplate = async (name) => {
    const { rows } = await client.query(
      `SELECT id FROM workflow_templates WHERE name = $1 LIMIT 1`,
      [name]
    );
    if (!rows[0]) {
      throw new Error(`workflow_templates entry "${name}" must exist before seeding webhook infrastructure.`);
    }
    return rows[0].id;
  };

  const webhookIntakeTemplateId = await selectTemplate('webhook_intake_v1');
  const asyncFollowupTemplateId = await selectTemplate('async_provider_dispatch_v1');

  await upsertScopedSettings(
    client,
    'webhook_intake',
    'global',
    null,
    { entry_template_id: webhookIntakeTemplateId },
    'Seed webhook intake entry template'
  );

  const globalPolicyValue = {
    ack: {
      mode: 'accepted_async',
      status_code: 202,
      default_headers: {
        'content-type': 'application/json'
      }
    },
    validation: {
      idempotency: {
        body_path: 'event.id'
      }
    },
    logging: {
      decision_point: 'edge_ack'
    }
  };

  const twilioAuthConfigId = providerAuthIds['twilio_sms'] || null;
  const asyncCallbackSecret = process.env.PROVIDER_CALLBACK_SECRET || 'callback-secret';
  const normalizedSupaUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const supaCallbackUrl = normalizedSupaUrl
    ? `${normalizedSupaUrl}/functions/v1/webhook-receiver`
    : '';

  const asyncCallbackUrl =
    process.env.PROVIDER_CALLBACK_URL ||
    process.env.WEBHOOK_RECEIVER_URL ||
    supaCallbackUrl;

  if (!asyncCallbackUrl) {
    throw new Error(
      '[seed-test-data] Missing callback URL. Set PROVIDER_CALLBACK_URL, WEBHOOK_RECEIVER_URL, or SUPABASE_URL.'
    );
  }

  const hmacPolicyValue = {
    ack: {
      mode: 'synchronous_success',
      status_code: 200,
      default_headers: {
        'content-type': 'application/json'
      }
    },
    validation: {
      idempotency: {
        body_path: 'event.id'
      }
    },
    logging: {
      decision_point: 'edge_ack'
    }
  };

  hmacPolicyValue.validation.hmac = twilioAuthConfigId
    ? {
        enabled: true,
        algorithm: 'HMAC-SHA256',
        header: 'x-signature',
        signature_encoding: 'hex',
        auth_config_id: twilioAuthConfigId
      }
    : {
        enabled: false,
        algorithm: 'HMAC-SHA256',
        header: 'x-signature',
        signature_encoding: 'hex'
      };

  const asyncPolicyValue = {
    ack: {
      mode: 'accepted_async',
      status_code: 202,
      default_headers: {
        'content-type': 'application/json'
      },
      body_template: {
        status: 'accepted_async',
        correlation_id: '{{ webhook.correlation_id }}'
      }
    },
    validation: {
      idempotency: {
        body_path: 'event.id'
      }
    },
    workflow: {
      template_id: webhookIntakeTemplateId,
      launch_mode: 'in_background',
      context_patch: {
        followup_template_id: asyncFollowupTemplateId
      }
    },
    logging: {
      decision_point: 'workflow_intake_ack'
    }
  };

  await upsertScopedSettings(
    client,
    'webhook_ingest_policy',
    'global',
    null,
    globalPolicyValue,
    'Integration seed baseline'
  );

  const insertSourcePolicy = async (sourceId, value, reason) => {
    await upsertScopedSettings(client, 'webhook_ingest_policy', 'source', sourceId, value, reason);
  };

  await insertSourcePolicy(hmacSourceId, hmacPolicyValue, 'HMAC webhook policy');
  await insertSourcePolicy(asyncSourceId, asyncPolicyValue, 'Async webhook policy');

  const seededAuthProviders = Object.keys(providerAuthIds);
  if (seededAuthProviders.length) {
    console.log(`  - Provider auth configs seeded for: ${seededAuthProviders.join(', ')}`);
  } else {
    console.log('  - Provider auth configs skipped (use npm run configure:provider-auth)');
  }
  console.log('  - Providers seeded');
  console.log('  - Mapping configs seeded for test sources');
  console.log('  - Webhook sources seeded with test tokens');
  console.log('  - Webhook ingest policies (global + source) seeded');

  return {
    providerIds,
    providerAuthIds,
    basicSourceId,
    basicMappingId,
    hmacSourceId,
    hmacMappingId,
    asyncSourceId,
    asyncMappingId,
    asyncCallbackUrl,
    asyncCallbackSecret
  };
}

async function seedClientWorkflowPolicies(
  client,
  { providerIds, asyncCallbackUrl, asyncCallbackSecret, basicMappingId, asyncMappingId },
  policyRows
) {
  const upsertClientPolicy = async (category, scopeId, value, reason) => {
    await upsertScopedSettings(client, category, 'client', scopeId, value, reason);
  };

  console.log(
    '  - Preparing client workflow policies for slugs:',
    policyRows.map((row) => row.slug).join(', ')
  );

  const profiles = [
    {
      key: 'full_processing',
      geocoding: {
        provider_priority: ['here_geocoding'],
        metadata: {
          policy_profile: 'cache_first',
          primary_provider_id: providerIds.here_geocoding
        },
        provider_chain: [
          {
            provider_id: providerIds.here_geocoding,
            max_retries: 1,
            use_cache: true
          }
        ],
        confidence_threshold: 0.65,
        manual_review: {
          enabled: true,
          notify_ops: true
        }
      },
      communications: {
        enabled: true,
        channels: [
          {
            provider_id: providerIds.dialog360_whatsapp,
            channel: 'whatsapp',
            template: 'shipment_created_notification'
          },
          {
            provider_id: providerIds.twilio_sms,
            channel: 'sms',
            fallback: true
          }
        ],
        triggers: ['shipment.created', 'shipment.status_change'],
        budget_scope: 'client'
      },
      callback: {
        enabled: true,
        callback_url: asyncCallbackUrl,
        shared_secret: asyncCallbackSecret,
        trigger_events: ['shipment_processed', 'shipment_label_generated']
      },
      delivery: {
        enabled: true,
        provider_id: providerIds.logestechs_3pl,
        mode: 'synchronous',
        retry: {
          max_attempts: 3,
          strategy: 'exponential'
        }
      }
    },
    {
      key: 'comms_only',
      geocoding: {
        provider_priority: [],
        metadata: {
          policy_profile: 'disabled'
        }
      },
      communications: {
        enabled: true,
        channels: [
          {
            provider_id: providerIds.dialog360_whatsapp,
            channel: 'whatsapp',
            template: 'shipment_created_notification'
          }
        ],
        triggers: ['shipment.created'],
        budget_scope: 'client'
      },
      callback: {
        enabled: false
      },
      delivery: {
        enabled: false
      }
    },
    {
      key: 'geocode_only',
      geocoding: {
        provider_priority: ['here_geocoding'],
        metadata: {
          policy_profile: 'cache_first',
          primary_provider_id: providerIds.here_geocoding
        },
        provider_chain: [
          {
            provider_id: providerIds.here_geocoding,
            max_retries: 2,
            use_cache: false
          }
        ],
        confidence_threshold: 0.75,
        manual_review: {
          enabled: true,
          notify_ops: false
        }
      },
      communications: {
        enabled: false
      },
      callback: {
        enabled: true,
        callback_url: asyncCallbackUrl,
        shared_secret: asyncCallbackSecret,
        trigger_events: ['geocode_completed']
      },
      delivery: {
        enabled: false
      }
    },
    {
      key: 'no_processing',
      geocoding: {
        provider_priority: [],
        metadata: {
          policy_profile: 'disabled'
        }
      },
      communications: {
        enabled: false
      },
      callback: {
        enabled: false
      },
      delivery: {
        enabled: false
      }
    }
  ];

  const totalProfiles = profiles.length;
  for (let index = 0; index < policyRows.length; index += 1) {
    const row = policyRows[index];
    const profile = profiles[index % totalProfiles];
    await upsertClientPolicy(
      'geocoding_policy',
      row.client_id,
      profile.geocoding,
      `${profile.key} geocoding policy`
    );
    await upsertClientPolicy(
      'communications_policy',
      row.client_id,
      profile.communications,
      `${profile.key} communications policy`
    );
    await upsertClientPolicy(
      'provider_callback_policy',
      row.client_id,
      profile.callback,
      `${profile.key} callback policy`
    );
    await upsertClientPolicy(
      'delivery_routing_policy',
      row.client_id,
      profile.delivery,
      `${profile.key} 3PL routing policy`
    );
  }

  await seedClientWebhookSources(client, {
    policyRows,
    basicMappingId,
    asyncMappingId
  });
}

async function seedClientWebhookSources(
  client,
  { policyRows, basicMappingId, asyncMappingId }
) {
  const sourceForProfile = async ({ clientId, slug, profileIndex }) => {
    const senderResult = await client.query(
      `
        SELECT s.id AS sender_id, c.organization_id
        FROM senders s
        JOIN clients c ON c.id = s.client_id
        WHERE s.client_id = $1
        ORDER BY s.created_at
        LIMIT 1
      `,
      [clientId]
    );

    if (!senderResult.rows.length) {
      console.warn(`No sender found for client ${clientId}; skipping webhook source seed.`);
      return null;
    }

    const { sender_id: senderId, organization_id: organizationId } = senderResult.rows[0];

    const identifier = `${slug}-webhook`;
    const token = `token-${slug}`;

    let providerType = 'shopify';
    let mappingId = basicMappingId;

    if (profileIndex === 3) {
      providerType = 'async_3pl';
      mappingId = asyncMappingId;
    }

    const { rows } = await client.query(
      `
        INSERT INTO webhook_sources (
          organization_id,
          source_identifier,
          name,
          provider_type,
          auth_token,
          mapping_config_id,
          sender_id,
          rate_limit_per_hour,
          enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, true)
        ON CONFLICT (organization_id, source_identifier) DO UPDATE
          SET mapping_config_id = EXCLUDED.mapping_config_id,
              auth_token = EXCLUDED.auth_token,
              sender_id = EXCLUDED.sender_id,
              organization_id = EXCLUDED.organization_id,
              updated_at = now()
        RETURNING id
      `,
      [
        organizationId,
        identifier,
        `Client ${slug} Webhook Source`,
        providerType,
        token,
        mappingId,
        senderId
      ]
    );

    return rows[0].id;
  };

  console.log('  - Seeding client-specific webhook sources...');
  for (let index = 0; index < policyRows.length; index += 1) {
    await sourceForProfile({
      clientId: policyRows[index].client_id,
      slug: policyRows[index].slug,
      profileIndex: index
    });
  }
}

async function seedWorkflowOrchestration(client) {
  console.log('[5/5] Seeding workflow templates, steps, and operation metadata...');

  const workflowSeedSql = `
    WITH logestechs_provider AS (
        SELECT
            id,
            COALESCE(metadata->>'base_url', 'https://apisv2.logestechs.com') AS base_url
        FROM providers
        WHERE name = 'logestechs_3pl'
        LIMIT 1
    ),
    dialog_provider AS (
        SELECT
            id,
            COALESCE(metadata->>'base_url', 'https://waba-sandbox.360dialog.io') AS base_url
        FROM providers
        WHERE name = 'dialog360_whatsapp'
        LIMIT 1
    ),
    logestechs_mapping AS (
        INSERT INTO mapping_configs (
            id,
            mapping_type,
            mapping_key,
            mapping_config,
            mapping_version,
            notes
        )
        VALUES (
            '99990000-0000-0000-0000-000000210001',
            'provider_response',
            'logestechs::create_shipment::v1',
            $$
            {
                "success_path": "$.status",
                "success_values": ["SUCCESS", "OK"],
                "field_mappings": {
                    "shipment_id": "$.data.shipmentId",
                    "reference_id": "$.data.orderId",
                    "status": "$.status",
                    "message": "$.message"
                }
            }$$::jsonb,
            1,
            'Logestechs create shipment provider response mapping'
        )
        ON CONFLICT (id) DO UPDATE
            SET mapping_config = EXCLUDED.mapping_config,
                mapping_version = EXCLUDED.mapping_version,
                notes = EXCLUDED.notes,
                updated_at = now()
        RETURNING id
    ),
    dialog_mapping AS (
        INSERT INTO mapping_configs (
            id,
            mapping_type,
            mapping_key,
            mapping_config,
            mapping_version,
            notes
        )
        VALUES (
            '99990000-0000-0000-0000-000000210002',
            'provider_response',
            'dialog360::send_whatsapp::v1',
            $$
            {
                "success_path": "$.messages[0].id",
                "field_mappings": {
                    "message_id": "$.messages[0].id",
                    "status": "$.messages[0].status",
                    "timestamp": "$.messages[0].timestamp"
                }
            }$$::jsonb,
            1,
            '360dialog WhatsApp send response mapping'
        )
        ON CONFLICT (id) DO UPDATE
            SET mapping_config = EXCLUDED.mapping_config,
                mapping_version = EXCLUDED.mapping_version,
                notes = EXCLUDED.notes,
                updated_at = now()
        RETURNING id
    ),
    logestechs_operation AS (
        INSERT INTO operation_templates (
            id,
            provider_id,
            operation_name,
            method,
            url_template,
            headers_template,
            body_template,
            request_mappings,
            mapping_config_id,
            call_type,
            timeout_seconds,
            idempotency_key_template,
            handler_key,
            handler_version
        )
        SELECT
            '99990000-0000-0000-0000-000000220001',
            lp.id,
            'logestechs_create_shipment_v1',
            'POST',
            lp.base_url || '/api/v2/shipments',
            jsonb_build_object(
                'content-type', 'application/json'
            ),
            '{}'::jsonb,
            $$
            {
                "body": {
                    "companyId": "$.provider_defaults.companyId",
                    "serviceType": "$.payload.shipment.service_type",
                    "shipmentType": "$.provider_defaults.shipmentType",
                    "integrationSource": "$.provider_defaults.integrationSource",
                    "senderName": "$.provider_defaults.senderName",
                    "senderPhone": "$.provider_defaults.senderPhone",
                    "receiverName": "$.payload.shipment.receiver_name",
                    "receiverPhone": "$.payload.shipment.receiver_phone",
                    "cod": "$.payload.shipment.cod",
                    "description": "$.payload.shipment.description",
                    "destinationVillage": "$.payload.shipment.destination_village",
                    "packageItems": "$.payload.shipment.package_items",
                    "packageTemplate": "$.provider_defaults.packageTemplate",
                    "originTemplate": "$.provider_defaults.originTemplate",
                    "destinationTemplate": "$.provider_defaults.destinationTemplate"
                },
                "headers": {
                    "x-trace-id": "$.context.trace_id"
                }
            }
            $$::jsonb,
            (SELECT id FROM logestechs_mapping),
            'provider_api',
            45,
            NULL,
            'outbound_http',
            'v1'
        FROM logestechs_provider lp
        ON CONFLICT (provider_id, operation_name) DO UPDATE
            SET method = EXCLUDED.method,
                url_template = EXCLUDED.url_template,
                headers_template = EXCLUDED.headers_template,
                body_template = EXCLUDED.body_template,
                request_mappings = EXCLUDED.request_mappings,
                mapping_config_id = EXCLUDED.mapping_config_id,
                call_type = EXCLUDED.call_type,
                timeout_seconds = EXCLUDED.timeout_seconds,
                idempotency_key_template = EXCLUDED.idempotency_key_template,
                handler_key = EXCLUDED.handler_key,
                handler_version = EXCLUDED.handler_version,
                updated_at = now()
        RETURNING id
    ),
    dialog_operation AS (
        INSERT INTO operation_templates (
            id,
            provider_id,
            operation_name,
            method,
            url_template,
            headers_template,
            body_template,
            request_mappings,
            mapping_config_id,
            call_type,
            timeout_seconds,
            idempotency_key_template,
            handler_key,
            handler_version,
            metadata
        )
        SELECT
            '99990000-0000-0000-0000-000000220002',
            dp.id,
            'dialog360_send_whatsapp_status_v1',
            'POST',
            dp.base_url || '/v1/messages',
            jsonb_build_object('content-type', 'application/json'),
            $$
            {
                "messaging_product": "whatsapp",
                "type": "template"
            }
            $$::jsonb,
            $$
            {
                "body": {
                    "to": "$.payload.recipient.phone",
                    "template": "$.payload.template",
                    "language": "$.payload.language",
                    "components": "$.payload.components"
                },
                "headers": {
                    "X-Client-Id": "$.context.client_id"
                }
            }
            $$::jsonb,
            (SELECT id FROM dialog_mapping),
            'comms_whatsapp',
            30,
            NULL,
            'outbound_http',
            'v1',
            jsonb_build_object(
                'auth',
                jsonb_build_object(
                    'mode', 'api_key_header',
                    'auth_type', 'api_key',
                    'header', 'D360-API-KEY',
                    'credential_key', 'api_key'
                )
            )
        FROM dialog_provider dp
        ON CONFLICT (provider_id, operation_name) DO UPDATE
            SET method = EXCLUDED.method,
                url_template = EXCLUDED.url_template,
                headers_template = EXCLUDED.headers_template,
                body_template = EXCLUDED.body_template,
                request_mappings = EXCLUDED.request_mappings,
                mapping_config_id = EXCLUDED.mapping_config_id,
                call_type = EXCLUDED.call_type,
                timeout_seconds = EXCLUDED.timeout_seconds,
                idempotency_key_template = EXCLUDED.idempotency_key_template,
                handler_key = EXCLUDED.handler_key,
                handler_version = EXCLUDED.handler_version,
                metadata = EXCLUDED.metadata,
                updated_at = now()
        RETURNING id
    ),
    upsert_logestechs_workflow AS (
        INSERT INTO workflow_templates (
            id,
            name,
            description,
            version,
            status,
            scope_type,
            scope_id,
            notes
        )
        VALUES (
            '99990000-0000-0000-0000-000000300001',
            'logestechs_shipment_ack_v1',
            'Create shipment via Logestechs and notify customer through WhatsApp (Plan.md Â§5.7.1).',
            1,
            'active',
            'global',
            NULL,
            'Canonical logestechs shipment acknowledgement workflow'
        )
        ON CONFLICT (name) DO UPDATE
            SET description = EXCLUDED.description,
                status = 'active',
                scope_type = EXCLUDED.scope_type,
                scope_id = EXCLUDED.scope_id,
                notes = EXCLUDED.notes
        RETURNING id
    ),
    upsert_async_workflow AS (
        INSERT INTO workflow_templates (
            id,
            name,
            description,
            version,
            status,
            scope_type,
            scope_id,
            notes
        )
        VALUES (
            '99990000-0000-0000-0000-000000300002',
            'async_provider_dispatch_v1',
            'Dispatch provider call asynchronously and register workflow audit (Plan.md Â§5.7.3).',
            1,
            'active',
            'global',
            NULL,
            'Canonical async provider workflow (single-step API call + audit)'
        )
        ON CONFLICT (name) DO UPDATE
            SET description = EXCLUDED.description,
                status = 'active',
                scope_type = EXCLUDED.scope_type,
                scope_id = EXCLUDED.scope_id,
                notes = EXCLUDED.notes
        RETURNING id
    ),
    logestechs_template AS (
        SELECT id FROM upsert_logestechs_workflow
        UNION ALL
        SELECT id FROM workflow_templates WHERE name = 'logestechs_shipment_ack_v1'
        LIMIT 1
    ),
    async_template AS (
        SELECT id FROM upsert_async_workflow
        UNION ALL
        SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1'
        LIMIT 1
    )
    INSERT INTO workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        condition_jsonlogic,
        next_operation_name,
        next_operation_priority,
        next_operation_delay_seconds,
        manual_action_required,
        metadata,
        handler_key,
        handler_version
    )
    VALUES
        (
            '99990000-0000-0000-0000-000000310001',
            (SELECT id FROM logestechs_template),
            1,
            'call_supplier_api',
            'operation_template',
            'success',
            NULL,
            'enqueue_notification',
            80,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM logestechs_operation),
                'operation_name', 'logestechs_create_shipment_v1',
                'payload_path', '$.transformed_payload',
                'expects_provider_defaults', TRUE,
                'priority', 80,
                'max_retries', 3
            ),
            'outbound_http',
            'v1'
        ),
        (
            '99990000-0000-0000-0000-000000310002',
            (SELECT id FROM logestechs_template),
            2,
            'enqueue_notification',
            'operation_template',
            'success',
            NULL,
            'record_workflow_completion',
            60,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM dialog_operation),
                'operation_name', 'dialog360_send_whatsapp_status_v1',
                'payload_path', '$.transformed_payload',
                'notification_template', 'shipment_created_notification',
                'priority', 60,
                'max_retries', 2
            ),
            'outbound_http',
            'v1'
        ),
        (
            '99990000-0000-0000-0000-000000310003',
            (SELECT id FROM logestechs_template),
            3,
            'record_workflow_completion',
            'workflow',
            'always',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object(
                'status', 'completed'
            ),
            'workflow_control',
            'v1'
        ),
        (
            '99990000-0000-0000-0000-000000310004',
            (SELECT id FROM async_template),
            1,
            'call_supplier_api',
            'operation_template',
            'always',
            NULL,
            'record_workflow_completion',
            70,
            NULL,
            FALSE,
            jsonb_build_object(
                'operation_template_id', (SELECT id FROM logestechs_operation),
                'operation_name', 'logestechs_create_shipment_v1',
                'payload_path', '$.transformed_payload',
                'expects_provider_defaults', TRUE,
                'disabled_reason', 'operation_template_unavailable',
                'requires_provider_operation', TRUE,
                'priority', 70,
                'max_retries', 3
            ),
            'outbound_http',
            'v1'
        ),
        (
            '99990000-0000-0000-0000-000000310005',
            (SELECT id FROM async_template),
            2,
            'record_workflow_completion',
            'workflow',
            'always',
            NULL,
            NULL,
            NULL,
            NULL,
            FALSE,
            jsonb_build_object(
                'status', 'completed'
            ),
            'workflow_control',
            'v1'
        )
    ON CONFLICT (id) DO UPDATE
        SET operation_name = EXCLUDED.operation_name,
            operation_settings_category = EXCLUDED.operation_settings_category,
            transition_condition = EXCLUDED.transition_condition,
            condition_jsonlogic = EXCLUDED.condition_jsonlogic,
            next_operation_name = EXCLUDED.next_operation_name,
            next_operation_priority = EXCLUDED.next_operation_priority,
            next_operation_delay_seconds = EXCLUDED.next_operation_delay_seconds,
            manual_action_required = EXCLUDED.manual_action_required,
            metadata = EXCLUDED.metadata,
            handler_key = EXCLUDED.handler_key,
            handler_version = EXCLUDED.handler_version,
            updated_at = now();

    WITH logestechs_template AS (
        SELECT id FROM workflow_templates WHERE name = 'logestechs_shipment_ack_v1' LIMIT 1
    ),
    async_template AS (
        SELECT id FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1
    ),
    checksums AS (
        SELECT
            workflow_template_id,
            md5(
                string_agg(
                    concat_ws(
                        '|',
                        sequence_order,
                        operation_name,
                        COALESCE(next_operation_name, ''),
                        COALESCE(operation_settings_category, ''),
                        COALESCE(transition_condition, ''),
                        COALESCE(metadata::text, '')
                    ),
                    '||' ORDER BY sequence_order
                )
            ) AS checksum
        FROM workflow_template_steps
        WHERE workflow_template_id IN (
            (SELECT id FROM logestechs_template),
            (SELECT id FROM async_template)
        )
        GROUP BY workflow_template_id
    )
    UPDATE workflow_templates wt
    SET steps_checksum = checksums.checksum,
        status = 'active',
        published_at = COALESCE(wt.published_at, now()),
        updated_at = now()
    FROM checksums
    WHERE wt.id = checksums.workflow_template_id;
  `;

  await client.query(workflowSeedSql);
  console.log('  - Workflow templates and steps seeded');
}

async function sanitizeSeededShipmentForeignKeys(client) {
  const { rows } = await client.query(`
    WITH repaired AS (
      UPDATE public.shipments s
      SET
        sender_id = CASE
          WHEN sender_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1
            FROM public.senders snd
            WHERE snd.id = s.sender_id
              AND snd.client_id = s.client_id
          ) THEN sender_id
          ELSE NULL
        END,
        recipient_id = CASE
          WHEN recipient_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1
            FROM public.recipients r
            WHERE r.id = s.recipient_id
              AND r.client_id = s.client_id
          ) THEN recipient_id
          ELSE NULL
        END,
        origin_address_id = CASE
          WHEN origin_address_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1
            FROM public.addresses a
            WHERE a.id = s.origin_address_id
              AND a.client_id = s.client_id
          ) THEN origin_address_id
          ELSE NULL
        END,
        destination_address_id = CASE
          WHEN destination_address_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1
            FROM public.addresses a
            WHERE a.id = s.destination_address_id
              AND a.client_id = s.client_id
          ) THEN destination_address_id
          ELSE NULL
        END,
        updated_at = now()
      WHERE
        (sender_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.senders snd WHERE snd.id = s.sender_id AND snd.client_id = s.client_id
        ))
        OR (recipient_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.recipients r WHERE r.id = s.recipient_id AND r.client_id = s.client_id
        ))
        OR (origin_address_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.addresses a WHERE a.id = s.origin_address_id AND a.client_id = s.client_id
        ))
        OR (destination_address_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.addresses a WHERE a.id = s.destination_address_id AND a.client_id = s.client_id
        ))
      RETURNING id
    )
    SELECT COUNT(*)::int AS repaired_count
    FROM repaired
  `);

  const repairedCount = rows[0]?.repaired_count || 0;
  if (repairedCount > 0) {
    console.log(`  - Shipment FK cleanup repaired ${repairedCount} rows`);
  }
}

async function sanitizeLegacyGeocodingPolicyEnabled(client) {
  const versions = await client.query(`
    UPDATE public.settings_versions
    SET value = value - 'enabled'
    WHERE category = 'geocoding_policy'
      AND effective_until IS NULL
      AND (value ? 'enabled')
    RETURNING id
  `);

  const settings = await client.query(`
    UPDATE public.settings
    SET cached_value = cached_value - 'enabled'
    WHERE category = 'geocoding_policy'
      AND (cached_value ? 'enabled')
    RETURNING id
  `);

  const cleanedCount = (versions.rowCount || 0) + (settings.rowCount || 0);
  if (cleanedCount > 0) {
    console.log(`  - Geocoding policy cleanup removed legacy enabled key from ${cleanedCount} rows`);
  }
}

/**
 * Main seed function
 */
async function main() {
  const volume = validateArgs();
  const startTime = Date.now();

  console.log('='.repeat(70));
  console.log('MASARX PLATFORM - SEED DATA GENERATOR');
  console.log('='.repeat(70));
  console.log(`Target Volume: ${volume.toLocaleString()} shipments`);
  console.log(`Locale Examples: en=${faker.location.city()} | ar=${fakerAr.location.city()}`);
  console.log(`Fixed Seed: 12345 (deterministic output)`);
  console.log(`Schema: Plan.md Section 4 (actual implementation)`);
  console.log('='.repeat(70));

  const client = await pool.connect();

  try {
    await ensurePublicSearchPath(client);
    await client.query('BEGIN');

    // Seed data in order (organizations â†’ clients â†’ senders â†’ shipments)
    const orgIds = await seedOrganizations(client);
    const clientIds = await seedClients(client, orgIds);
    const senderIds = await seedSenders(client, clientIds);
    await runSeedTenantOnboardingBootstrap(client, orgIds);
    const poolState = await seedRecipientAndAddressPools(client, clientIds, volume);
    const shipmentStatuses = await loadSeedShipmentStatuses(client);
    const serviceTypes = await loadSeedServiceTypes(client);
    await seedShipments(
      client,
      clientIds,
      senderIds,
      volume,
      poolState,
      shipmentStatuses,
      serviceTypes
    );

    const senderRow = await client.query(
      `
        SELECT s.id, s.client_id, c.organization_id
        FROM senders s
        JOIN clients c ON c.id = s.client_id
        ORDER BY s.created_at
        LIMIT 1
      `
    );

    let infraSeed;
    if (senderRow.rows.length > 0) {
      const { id: primarySenderId, client_id: primaryClientId, organization_id: primaryOrgId } =
        senderRow.rows[0];
      infraSeed = await seedWebhookInfrastructure(client, {
        organizationId: primaryOrgId,
        clientId: primaryClientId,
        senderId: primarySenderId
      });
    }

    const policyClientRows = await client.query(
      `
        SELECT id AS client_id, slug
        FROM clients
        WHERE slug LIKE 'seed-client-%'
        ORDER BY slug
        LIMIT 4
      `
    );

    if (infraSeed && policyClientRows.rows.length) {
      await seedClientWorkflowPolicies(client, infraSeed, policyClientRows.rows);
    }

    await seedWorkflowOrchestration(client);
    await sanitizeSeededShipmentForeignKeys(client);
    await sanitizeLegacyGeocodingPolicyEnabled(client);

    await client.query('COMMIT');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(70));
    console.log('SEED COMPLETED SUCCESSFULLY');
    console.log('='.repeat(70));
    console.log(`Total Records:`);
    console.log(`  - Organizations: ${orgIds.length}`);
    console.log(`  - Clients: ${clientIds.length}`);
    console.log(`  - Senders: ${senderIds.length}`);
    console.log(`  - Recipients: ${poolState?.totals?.recipients ?? 0}`);
    console.log(`  - Addresses: ${poolState?.totals?.addresses ?? 0}`);
    console.log(`  - Shipments: ${volume}`);
    console.log(`  - Shipment Boxes: ${volume}`);
    console.log(`\nTime Elapsed: ${elapsed}s`);
    console.log(`Performance: ${Math.round(volume / elapsed)} shipments/sec`);
    console.log('='.repeat(70));

    // Verify performance targets
    const targets = {
      100: 5,
      10000: 30,
      100000: 300
    };

    if (elapsed <= targets[volume]) {
      console.log(`âœ“ Performance Target MET: ${elapsed}s <= ${targets[volume]}s`);
    } else {
      console.log(`âš  Performance Target MISSED: ${elapsed}s > ${targets[volume]}s`);
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n' + '='.repeat(70));
    console.error('ERROR: Seed failed');
    console.error('='.repeat(70));
    console.error(error.message);
    console.error('\nStack trace:');
    console.error(error.stack);
    console.error('\n' + '='.repeat(70));
    console.error('TROUBLESHOOTING:');
    console.error('- Verify database is running: supabase status');
    console.error('- Check migrations applied: supabase db reset');
    console.error('- Verify schema matches Plan.md Section 4');
    console.error('- Check column names in shipments table: \\d shipments');
    console.error('='.repeat(70));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the seeder
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  ensurePublicSearchPath,
  SEED_DATA_ONBOARDING_SOURCE,
  SEED_DATA_POST_PROVISION_BOOTSTRAP_SOURCE,
  getOrganizationOnboardingSource,
  main,
  runSeedTenantOnboardingBootstrap,
  seedShipments,
  seedShipmentsLegacy,
  setOrganizationOnboardingSource,
  withOrganizationOnboardingSource,
};


