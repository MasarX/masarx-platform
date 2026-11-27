#!/usr/bin/env node
/* eslint-disable no-console */
const { randomUUID } = require('crypto');
const { Client } = require('pg');
const { baseUrl: VENDOR_BASE_URL } = require('../../../../tests/fixtures/carrier/vendor-account.synthetic.json');
const { loadEnv } = require('../../../utils/load-env');
const {
  isRetryableDbConnectError,
  parsePositiveInt,
  resolveDatabaseUrlWithFallback,
} = require('../../../utils/resolve-db-url');
const { isTransientDbTerminationError } = require('../../../utils/pg-pool-guard');
const { withOrganizationOnboardingSource, flushOrganizationOnboarding } = require('../../../utils/organization-onboarding');
const {
  assertMutationAllowed,
  isProductionTarget,
} = require('../../../utils/production-mutation-guard');

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const GEOCODING_BASE_SOURCE_IDENTIFIER = 'geocoding-intake-test';
const GEOCODING_BASE_SOURCE_TOKEN = 'EXAMPLE_PASSWORD';
const DIALOG360_REPLY_SOURCE_IDENTIFIER = 'dialog360_reply';
const DIALOG360_REPLY_SOURCE_PROVIDER_TYPE = 'communications';
const FALLBACK_DIALOG360_REPLY_TOKEN = 'EXAMPLE_PASSWORD';

function normalizePrefix(value) {
  const raw = String(value || 'test').trim().toLowerCase();
  const sanitized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'test';
}

function buildFixtureProfile(env = process.env) {
  const prefix = normalizePrefix(env.INTEGRATION_FIXTURE_PREFIX || 'test');
  const mk = (suffix) => `${prefix}-${suffix}`;
  return {
    prefix,
    organizations: {
      alpha: { name: 'Test Organization Alpha', slug: mk('org-alpha') },
    },
    clients: {
      oneOne: { name: 'Test Client 1-1', slug: mk('client-1-1') },
      oneTwo: { name: 'Test Client 1-2', slug: mk('client-1-2') },
      oneThree: { name: 'Test Client 1-3', slug: mk('client-1-3') },
      twoOne: { name: 'Test Client 2-1', slug: mk('client-2-1') },
    },
    senders: {
      oneOne: { name: 'Test Client 1 Sender' },
      oneTwo: { name: 'Test Client 2 Sender' },
      oneThree: { name: 'Test Client 3 Sender' },
      twoOne: { name: 'Logestechs Client 2 Sender' },
    },
    webhook: {
      basic: {
        sourceIdentifier: 'test-basic-source',
        token: 'EXAMPLE_PASSWORD',
        mappingKey: `${prefix}::webhook::basic`,
      },
      hmac: {
        sourceIdentifier: 'test-hmac-source',
        token: 'EXAMPLE_PASSWORD',
        mappingKey: `${prefix}::webhook::hmac`,
      },
      async: {
        sourceIdentifier: 'test-async-source',
        token: 'EXAMPLE_PASSWORD',
        mappingKey: `${prefix}::webhook::async`,
      },
      clientAckA: {
        sourceIdentifier: 'test-client-a-ack',
        token: prefix === 'test' ? 'client-a-ack-token' : mk('client-a-ack-token'),
        mappingKey: `${prefix}::webhook::ack-a`,
      },
      clientAckB: {
        sourceIdentifier: 'test-client-b-ack',
        token: mk('client-b-ack-token'),
        mappingKey: `${prefix}::webhook::ack-b`,
      },
    },
  };
}

function resolveDatabaseUrl(env = process.env) {
  const dsn = String(env.DATABASE_URL || env.DATABASE_URL_DIRECT || env.DATABASE_URL_POOLER || '').trim();
  if (!dsn) {
    throw new Error('DATABASE_URL (or DATABASE_URL_DIRECT / DATABASE_URL_POOLER) is required.');
  }
  return dsn;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFixtureBootstrapRetryConfig(env = process.env) {
  return {
    maxWaitMs: parsePositiveInt(
      env.PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS
        || env.INTEGRATION_FIXTURE_BOOTSTRAP_MAX_WAIT_MS
        || env.DB_CONNECT_MAX_WAIT_MS,
      120000,
    ),
    retryDelayMs: parsePositiveInt(
      env.PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS
        || env.INTEGRATION_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS
        || env.DB_CONNECT_RETRY_DELAY_MS,
      2000,
    ),
    connectionTimeoutMs: parsePositiveInt(
      env.PGTAP_FIXTURE_BOOTSTRAP_CONNECT_TIMEOUT_MS
        || env.INTEGRATION_FIXTURE_BOOTSTRAP_CONNECT_TIMEOUT_MS
        || env.DB_CONNECT_TIMEOUT_MS,
      10000,
    ),
  };
}

function isRetryableFixtureBootstrapConcurrencyError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === '40P01' || code === '40001' || code === '55P03') return true;

  const message = String(error?.message || '').trim().toLowerCase();
  return (
    message.includes('deadlock detected')
    || message.includes('could not serialize access')
    || message.includes('lock not available')
  );
}

function isRetryableFixtureBootstrapError(error) {
  return (
    isRetryableDbConnectError(error)
    || isTransientDbTerminationError(error)
    || isRetryableFixtureBootstrapConcurrencyError(error)
  );
}

async function withFixtureBootstrapRetry(fn, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleep;
  const retry = resolveFixtureBootstrapRetryConfig(env);
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : retry.maxWaitMs;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : retry.retryDelayMs;
  const startedAt = now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await fn({ attempt, env, logger, retry });
    } catch (error) {
      const elapsed = now() - startedAt;
      if (!isRetryableFixtureBootstrapError(error) || elapsed >= maxWaitMs) {
        throw error;
      }
      const delayMs = Math.min(15000, retryDelayMs * attempt);
      const message = error && error.message ? error.message : String(error);
      logger.warn?.(
        `[fixture-bootstrap] transient DB/bootstrap error (${message}); retrying ${attempt} after ${delayMs}ms (elapsed ${elapsed}ms/${maxWaitMs}ms).`,
      );
      await sleepFn(delayMs);
    }
  }
}

function assertFixtureBootstrapAllowed(env = process.env) {
  const mode = String(env.TEST_FIXTURE_MUTATION_MODE || 'dedicated').trim().toLowerCase();
  const allowedModes = new Set(['dedicated', 'preview', 'local']);
  if (!allowedModes.has(mode)) {
    throw new Error(
      `[fixture-bootstrap] Unsupported TEST_FIXTURE_MUTATION_MODE=${mode}. Allowed: dedicated|preview|local.`,
    );
  }
  if (!isProductionTarget(env)) return;
  assertMutationAllowed({
    env,
    operation: 'fixture-bootstrap',
    allowProductionEnvVar: 'TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION',
  });
}

async function queryOne(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}

async function queryMany(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

function cloneJson(value) {
  if (value === null || value === undefined) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function resolveSettingsValue(client, category, scopeType, scopeId) {
  const row = await queryOne(
    client,
    `
      SELECT public.resolve_settings($1::text, $2::text, $3::uuid) AS value
    `,
    [category, scopeType, scopeId || null],
  );
  return cloneJson(row?.value || {});
}

async function ensureProvider(client, params) {
  const row = await queryOne(
    client,
    `
      INSERT INTO public.providers (
        organization_id,
        name,
        provider_type,
        enabled,
        priority_rank,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        TRUE,
        $4::int,
        $5::jsonb
      )
      ON CONFLICT (organization_id, name)
      DO UPDATE SET
        provider_type = EXCLUDED.provider_type,
        enabled = TRUE,
        priority_rank = LEAST(public.providers.priority_rank, EXCLUDED.priority_rank),
        metadata = COALESCE(public.providers.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        updated_at = now()
      RETURNING id, name, provider_type
    `,
    [
      params.organizationId,
      params.name,
      params.providerType,
      Number.isFinite(params.priorityRank) ? params.priorityRank : 1,
      JSON.stringify(params.metadata || {}),
    ],
  );
  return row;
}

async function ensureProviderAuthConfig(client, params) {
  const existing = await queryOne(
    client,
    `
      SELECT id
      FROM public.provider_auth_configs
      WHERE provider_id = $1::uuid
        AND auth_type = $2::text
        AND NOT marketplace_explicit_only
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [params.providerId, params.authType],
  );
  if (existing?.id) return existing.id;

  const authConfigId = randomUUID();
  const credentials = params.credentials || {};
  const secretName = `provider_auth_configs/${authConfigId}`;
  const secretDescription = params.secretDescription || `integration fixture provider auth (${params.authType})`;

  let credentialsVaultId = null;
  try {
    const secret = await queryOne(
      client,
      `
        SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id
      `,
      [JSON.stringify(credentials), secretName, secretDescription],
    );
    credentialsVaultId = secret?.id || null;
  } catch {
    credentialsVaultId = null;
  }

  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.provider_auth_configs (
        id,
        provider_id,
        auth_type,
        credentials_vault_id,
        credentials,
        expires_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        $5::jsonb,
        NULL
      )
      RETURNING id
    `,
    [authConfigId, params.providerId, params.authType, credentialsVaultId, credentialsVaultId ? null : JSON.stringify(credentials)],
  );
  return inserted.id;
}

async function ensureCanonicalCity(client, params) {
  const existing = await queryOne(
    client,
    `
      SELECT id
      FROM public.canonical_cities
      WHERE organization_id = $1::uuid
        AND lower(name_canonical) = lower($2::text)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [params.organizationId, params.cityName],
  );
  if (existing?.id) {
    await client.query(
      `
        UPDATE public.canonical_cities
           SET name_arabic = COALESCE(NULLIF($2::text, ''), name_arabic),
               alternate_names = (
                 SELECT ARRAY(
                   SELECT DISTINCT name
                   FROM unnest(
                     COALESCE(alternate_names, ARRAY[]::text[])
                     || COALESCE($3::text[], ARRAY[]::text[])
                   ) AS candidate(name)
                   WHERE NULLIF(btrim(name), '') IS NOT NULL
                   ORDER BY name
                 )
               ),
               province = COALESCE(NULLIF($4::text, ''), province),
               country_code = COALESCE(NULLIF($5::text, ''), country_code),
               updated_at = now()
         WHERE id = $1::uuid
      `,
      [
        existing.id,
        params.cityArabic || null,
        params.alternateNames || null,
        params.province || null,
        params.countryCode || null,
      ],
    );
    return existing.id;
  }

  const seed = await queryOne(
    client,
    `
      SELECT
        name_arabic,
        alternate_names,
        province,
        country_code,
        centroid
      FROM public.canonical_cities
      WHERE lower(name_canonical) = lower($1::text)
        AND centroid IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [params.cityName],
  );

  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.canonical_cities (
        organization_id,
        name_canonical,
        name_arabic,
        alternate_names,
        province,
        country_code,
        source,
        metadata,
        is_active,
        centroid
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text[],
        $5::text,
        $6::text,
        'manual_seed',
        $7::jsonb,
        TRUE,
        $8::geography
      )
      RETURNING id
    `,
    [
      params.organizationId,
      params.cityName,
      params.cityArabic || seed?.name_arabic || null,
      params.alternateNames || seed?.alternate_names || [params.cityName],
      params.province || seed?.province || null,
      params.countryCode || seed?.country_code || 'SA',
      JSON.stringify({ source: 'integration_fixture_bootstrap' }),
      seed?.centroid || null,
    ],
  );
  return inserted.id;
}

async function ensureCanonicalDistrict(client, params) {
  const existing = await queryOne(
    client,
    `
      SELECT id
      FROM public.canonical_districts
      WHERE organization_id = $1::uuid
        AND city_id = $2::uuid
        AND lower(name_canonical) = lower($3::text)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [params.organizationId, params.cityId, params.districtName],
  );
  const seed = await queryOne(
    client,
    `
      SELECT
        d.name_arabic,
        d.alternate_names,
        d.centroid
      FROM public.canonical_districts d
      JOIN public.canonical_cities c ON c.id = d.city_id
      WHERE lower(c.name_canonical) = lower($1::text)
        AND lower(d.name_canonical) = lower($2::text)
        AND d.centroid IS NOT NULL
      ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC NULLS LAST
      LIMIT 1
    `,
    [params.cityName, params.districtName],
  );

  const alternateNames = params.alternateNames || seed?.alternate_names || [params.districtName];

  if (existing?.id) {
    await client.query(
      `
        UPDATE public.canonical_districts
           SET name_arabic = COALESCE(NULLIF($2::text, ''), name_arabic),
               alternate_names = (
                 SELECT ARRAY(
                   SELECT DISTINCT name
                   FROM unnest(
                     COALESCE(alternate_names, ARRAY[]::text[])
                     || COALESCE($3::text[], ARRAY[]::text[])
                   ) AS candidate(name)
                   WHERE NULLIF(btrim(name), '') IS NOT NULL
                   ORDER BY name
                 )
               ),
               centroid = COALESCE($4::geography, centroid),
               updated_at = now()
         WHERE id = $1::uuid
      `,
      [
        existing.id,
        params.districtArabic || seed?.name_arabic || null,
        alternateNames,
        seed?.centroid || null,
      ],
    );
    return existing.id;
  }

  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.canonical_districts (
        organization_id,
        city_id,
        name_canonical,
        name_arabic,
        alternate_names,
        source,
        metadata,
        is_active,
        centroid
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::text,
        $5::text[],
        'manual_seed',
        $6::jsonb,
        TRUE,
        $7::geography
      )
      RETURNING id
    `,
    [
      params.organizationId,
      params.cityId,
      params.districtName,
      params.districtArabic || seed?.name_arabic || null,
      alternateNames,
      JSON.stringify({ source: 'integration_fixture_bootstrap' }),
      seed?.centroid || null,
    ],
  );
  return inserted.id;
}

async function ensureManualReviewBaselineShipment(client, params) {
  const existing = await queryOne(
    client,
    `
      SELECT id
      FROM public.shipments
      WHERE organization_id = $1::uuid
        AND client_id = $2::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [params.organizationId, params.clientId],
  );
  if (existing?.id) return existing.id;

  const tracking = `SEED-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.shipments (
        organization_id,
        client_id,
        sender_id,
        service_type,
        tracking_number,
        box_count,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'delivery',
        $4::text,
        1,
        'pending',
        now(),
        now()
      )
      RETURNING id
    `,
    [params.organizationId, params.clientId, params.senderId || null, tracking],
  );
  return inserted.id;
}

async function ensureOrganization(client, org) {
  const row = await queryOne(
    client,
    `
      INSERT INTO public.organizations (name, slug, timezone, locale, billing_status, default_settings)
      VALUES ($1, $2, 'Asia/Riyadh', 'en-US', 'active', '{}'::jsonb)
      ON CONFLICT (slug)
      DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = now()
      RETURNING id, slug
    `,
    [org.name, org.slug],
  );
  return row;
}

async function ensureClient(client, organizationId, fixtureClient) {
  const row = await queryOne(
    client,
    `
      INSERT INTO public.clients (
        organization_id,
        name,
        slug,
        sla_tier,
        status,
        settings_override
      )
      VALUES ($1::uuid, $2, $3, 'standard', 'active', '{}'::jsonb)
      ON CONFLICT (organization_id, slug)
      DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = now()
      RETURNING id, slug
    `,
    [organizationId, fixtureClient.name, fixtureClient.slug],
  );
  return row;
}

async function ensureSender(client, clientId, senderName) {
  const existing = await queryOne(
    client,
    `
      SELECT id, name
      FROM public.senders
      WHERE client_id = $1::uuid
        AND name = $2
      ORDER BY created_at
      LIMIT 1
    `,
    [clientId, senderName],
  );
  if (existing) return existing;

  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status,
        settings_override
      )
      VALUES ($1::uuid, $2, $3, FALSE, TRUE, 'active', '{}'::jsonb)
      RETURNING id, name
    `,
    [clientId, senderName, senderName],
  );
  return inserted;
}

async function ensureMappingConfig(client, params) {
  const row = await queryOne(
    client,
    `
      INSERT INTO public.mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        mapping_version,
        notes,
        organization_id
      )
      VALUES ($1, $2, $3::jsonb, 1, $4, $5::uuid)
      ON CONFLICT (mapping_type, mapping_key)
      DO UPDATE SET
        mapping_config = EXCLUDED.mapping_config,
        organization_id = EXCLUDED.organization_id,
        notes = EXCLUDED.notes,
        mapping_version = public.mapping_configs.mapping_version + 1,
        updated_at = now()
      RETURNING id
    `,
    [
      params.mappingType,
      params.mappingKey,
      JSON.stringify(params.mappingConfig || {}),
      params.notes || null,
      params.organizationId || null,
    ],
  );
  return row.id;
}

async function ensureWebhookSource(client, params) {
  const row = await queryOne(
    client,
    `
      INSERT INTO public.webhook_sources (
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
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6::uuid,
        $7::uuid,
        2000,
        TRUE
      )
      ON CONFLICT (organization_id, source_identifier)
      DO UPDATE SET
        auth_token = EXCLUDED.auth_token,
        mapping_config_id = EXCLUDED.mapping_config_id,
        sender_id = EXCLUDED.sender_id,
        provider_type = EXCLUDED.provider_type,
        enabled = TRUE,
        updated_at = now()
      RETURNING id, source_identifier, auth_token, sender_id
    `,
    [
      params.organizationId,
      params.sourceIdentifier,
      params.name,
      params.providerType,
      params.authToken,
      params.mappingConfigId,
      params.senderId,
    ],
  );
  return row;
}

async function upsertSettingValue(client, params) {
  await client.query(
    `
      SELECT public.upsert_settings_value_v1(
        $1::text,
        $2::text,
        $3::uuid,
        $4::jsonb,
        $5::int,
        $6::text
      )
    `,
    [
      params.category,
      params.scopeType,
      params.scopeId || null,
      JSON.stringify(params.value || {}),
      Number.isFinite(params.schemaVersion) ? params.schemaVersion : 1,
      params.changeReason || 'integration fixture bootstrap',
    ],
  );

}

function buildWebhookInboundMapping(kind) {
  return {
    description: `Integration fixture mapping (${kind})`,
    external_id_path: 'event.id',
    event_type_path: 'event.type',
    transforms: {
      default: {
        event_id: 'event.id',
        event_type: 'event.type',
        tracking_number: 'shipment.tracking_number',
      },
      communication: {
        recipient: 'contacts.0.wa_id',
        correlation_id: 'messages.0.context.id',
        message_id: 'messages.0.id',
      },
    },
  };
}

function buildAckMapping(kind) {
  if (kind === 'A') {
    return {
      status_code: 202,
      headers: { 'content-type': 'application/json', 'x-client-ack': 'logestechs' },
      body: {
        status: 'accepted',
        resource_id: '{{ resource.id }}',
        tracking_number: '{{ resource.tracking_number }}',
        workflow_run_id: '{{ workflow_run_id }}',
      },
    };
  }
  return {
    status_code: 202,
    headers: { 'content-type': 'application/json', 'x-client-ack': 'jarad' },
    body: {
      status: 'accepted',
      correlation_id: '{{ webhook.correlation_id }}',
      tracking_summary: '{{ resource.tracking_number }}',
      ack_version: 'jarad.v1',
    },
  };
}

function buildGeocodingInboundMapping() {
  return {
    description: 'Integration geocoding webhook intake mapping',
    external_id_path: 'event.id',
    event_type_path: 'event.type',
    transforms: {
      address: {
        line1: 'address.line1|destinationAddress.addressLine1|originAddress.addressLine1|shipment.origin.address_line1',
        line2: 'address.line2|destinationAddress.addressLine2|originAddress.addressLine2',
        city: 'address.city|destinationAddress.city|originAddress.city|originAddress.arabicCityName',
        district:
          'address.district|destinationAddress.district|originAddress.village|originAddress.arabicVillageName',
        province: 'address.province|destinationAddress.province|originAddress.region|originAddress.regionPrefix',
        country: 'address.country|destinationAddress.country|originAddress.country|shipment.origin.country',
        postal_code: 'address.zip|address.postal_code|originAddress.zipCode',
        lat: 'address.latitude|destinationAddress.latitude|originAddress.latitude',
        lng: 'address.longitude|destinationAddress.longitude|originAddress.longitude',
      },
    },
  };
}

function buildGeocodingWebhookPolicy(params) {
  return {
    version: 1,
    ack: {
      mode: 'accepted_async',
      status_code: 202,
      default_headers: { 'content-type': 'application/json' },
    },
    validation: {
      idempotency: { body_path: 'event.id' },
    },
    workflow: {
      template_id: params.workflowTemplateId,
      intent: 'geocoding',
      context_patch: {
        mapping_config_id: params.mappingConfigId,
        source_identifier: GEOCODING_BASE_SOURCE_IDENTIFIER,
      },
    },
    logging: {
      decision_point: 'workflow_intake_ack',
      tags: ['geocoding', 'webhook'],
    },
  };
}

function buildDialogReplyWebhookPolicy(templateId) {
  return {
    version: 1,
    ack: {
      mode: 'synchronous_success',
      status_code: 200,
      default_headers: { 'content-type': 'application/json' },
    },
    validation: {
      idempotency: {
        body_path: 'entry.0.changes.0.value.messages.0.id',
        dedupe_window_seconds: 86400,
      },
    },
    workflow: {
      intent: 'comms_reply',
      template_id: templateId,
    },
    logging: {
      decision_point: 'workflow_intake_ack',
      include_payload: false,
    },
  };
}

function buildShipmentWebhookPolicy() {
  return {
    version: 3,
    ack: {
      mode: 'synchronous_success',
      status_code: 200,
      default_headers: { 'content-type': 'application/json' },
    },
    validation: {
      idempotency: { body_path: 'event.id', header: 'Idempotency-Key' },
    },
    workflow: {
      intent: 'shipment.create',
      templates_by_intent: {
        'shipment.create': { template_name: 'webhook_shipment_create_v1' },
        'shipment.delete': { template_name: 'shipment_delete_v1' },
        'shipment.reschedule': { template_name: 'shipment_reschedule_v1' },
      },
    },
  };
}

async function ensureProviderDefaultRecipient(client, params) {
  const base = await resolveSettingsValue(client, 'provider_defaults', 'resource', params.providerId);
  const next = {
    ...asObject(base),
    default_recipient: params.defaultRecipient,
  };
  await upsertSettingValue(client, {
    category: 'provider_defaults',
    scopeType: 'resource',
    scopeId: params.providerId,
    value: next,
    changeReason: params.changeReason,
  });
}

function buildDialog360OperationTemplateDefaults(baseUrl) {
  return {
    callType: 'comms_whatsapp',
    method: 'POST',
    urlTemplate: baseUrl || 'https://waba-sandbox.360dialog.io/v1/messages',
    headersTemplate: { 'content-type': 'application/json' },
    bodyTemplate: {
      messaging_product: 'whatsapp',
      to: '',
      type: 'text',
      text: { body: '' },
    },
    requestMappings: {
      headers: {
        'D360-API-KEY': '$.provider_auth.credentials.api_key',
      },
      body: {
        to: '$.payload.to',
        'text.body': '$.payload.message',
      },
    },
    timeoutSeconds: 30,
    handlerKey: 'outbound_http',
    handlerVersion: 'v1',
    idempotencyKeyTemplate: null,
  };
}

async function ensureOperationTemplateForProvider(client, params) {
  const source = await queryOne(
    client,
    `
      SELECT
        handler_key,
        handler_version,
        call_type,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template,
        metadata
      FROM public.operation_templates
      WHERE operation_name = $1::text
        AND provider_id <> $2::uuid
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [params.operationName, params.providerId],
  );

  const defaults = buildDialog360OperationTemplateDefaults(params.baseUrl);
  const jsonParam = (value) => (value == null ? null : JSON.stringify(value));
  const mappingConfigId = source?.mapping_config_id || params.fallbackMappingConfigId || null;
  if (!mappingConfigId) {
    throw new Error(
      `Missing mapping_config_id for operation template ${params.operationName}; source template and fallback mapping are both unavailable.`,
    );
  }

  const row = await queryOne(
    client,
    `
      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        handler_key,
        handler_version,
        call_type,
        method,
        url_template,
        headers_template,
        body_template,
        request_mappings,
        mapping_config_id,
        timeout_seconds,
        idempotency_key_template,
        metadata
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::text,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11::uuid,
        $12::int,
        $13::text,
        $14::jsonb
      )
      ON CONFLICT (provider_id, operation_name)
      DO UPDATE SET
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        call_type = EXCLUDED.call_type,
        method = EXCLUDED.method,
        url_template = EXCLUDED.url_template,
        headers_template = EXCLUDED.headers_template,
        body_template = EXCLUDED.body_template,
        request_mappings = EXCLUDED.request_mappings,
        mapping_config_id = EXCLUDED.mapping_config_id,
        timeout_seconds = EXCLUDED.timeout_seconds,
        idempotency_key_template = EXCLUDED.idempotency_key_template,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      params.providerId,
      params.operationName,
      source?.handler_key || defaults.handlerKey,
      source?.handler_version || defaults.handlerVersion,
      source?.call_type || defaults.callType,
      source?.method || defaults.method,
      source?.url_template || defaults.urlTemplate,
      jsonParam(source ? source.headers_template : defaults.headersTemplate),
      jsonParam(source ? source.body_template : defaults.bodyTemplate),
      jsonParam(source ? source.request_mappings : defaults.requestMappings),
      mappingConfigId,
      Number.isFinite(Number(source?.timeout_seconds)) ? Number(source.timeout_seconds) : defaults.timeoutSeconds,
      source?.idempotency_key_template || defaults.idempotencyKeyTemplate,
      JSON.stringify(source?.metadata || {}),
    ],
  );

  return row?.id || null;
}

async function ensureRecurringShipmentWorkflowTemplate(client, templateName = 'recurring_shipment_create_v1') {
  if (typeof templateName !== 'string' || templateName.trim() === '' || templateName !== templateName.trim()) {
    throw new Error('Recurring template name must be a nonblank unpadded string.');
  }
  const existing = await queryOne(
    client,
    `
      SELECT id
      FROM public.workflow_templates
      WHERE name = $1::text
      ORDER BY version DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `,
    [templateName],
  );

  let row = existing;

  if (row?.id) {
    await client.query(
      `
        UPDATE public.workflow_templates
        SET description = 'Recurring shipment create workflow backed by the canonical workflow-engine shipment create contract.',
            status = 'active',
            scope_type = 'global',
            scope_id = NULL,
            notes = 'Canonical recurring schedule bootstrap for shipment create.',
            published_at = COALESCE(published_at, now()),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [row.id],
    );
  } else {
    row = await queryOne(
      client,
      `
        INSERT INTO public.workflow_templates (
          name,
          description,
          version,
          status,
          scope_type,
          scope_id,
          notes,
          published_at,
          updated_at
        )
        VALUES (
          $1::text,
          'Recurring shipment create workflow backed by the canonical workflow-engine shipment create contract.',
          1,
          'active',
          'global',
          NULL,
          'Canonical recurring schedule bootstrap for shipment create.',
          now(),
          now()
        )
        RETURNING id
      `,
      [templateName],
    );
  }

  if (!row?.id) {
    throw new Error('recurring_shipment_create_v1 template bootstrap failed.');
  }

  const stepDefinitions = [
    {
      sequenceOrder: 0,
      operationName: 'reserve_shipment_identifiers',
      operationSettingsCategory: 'workflow',
      transitionCondition: 'always',
      nextOperationName: 'create_shipment',
      nextOperationPriority: 85,
      metadata: {
        handler_key: 'reserve_shipment_identifiers',
        template_name: templateName,
      },
      handlerKey: 'reserve_shipment_identifiers',
      handlerVersion: 'v1',
    },
    {
      id: randomUUID(),
      sequenceOrder: 1,
      operationName: 'create_shipment',
      operationSettingsCategory: 'workflow',
      transitionCondition: 'always',
      nextOperationName: null,
      nextOperationPriority: null,
      metadata: {
        handler_key: 'shipment_create',
        template_name: templateName,
      },
      handlerKey: 'shipment_create',
      handlerVersion: 'v1',
    },
  ];

  const existingSteps = await queryMany(
    client,
    `
      SELECT id, sequence_order
      FROM public.workflow_template_steps
      WHERE workflow_template_id = $1::uuid
      ORDER BY sequence_order ASC, created_at ASC, id ASC
    `,
    [row.id],
  );

  const chosenStepIds = new Map();

  for (const step of stepDefinitions) {
    const existingStep = existingSteps.find(
      (candidate) =>
        candidate.sequence_order === step.sequenceOrder
        && !chosenStepIds.has(candidate.sequence_order),
    );

    if (existingStep) {
      chosenStepIds.set(step.sequenceOrder, existingStep.id);
      await client.query(
        `
          UPDATE public.workflow_template_steps
          SET
            operation_name = $2::text,
            operation_settings_category = $3::text,
            transition_condition = $4::text,
            condition_jsonlogic = NULL,
            next_operation_name = $5::text,
            next_operation_priority = $6::int,
            next_operation_delay_seconds = NULL,
            manual_action_required = FALSE,
            metadata = $7::jsonb,
            enabled = TRUE,
            updated_at = now(),
            handler_key = $8::text,
            handler_version = $9::text
          WHERE id = $1::uuid
            AND ROW(operation_name,operation_settings_category,transition_condition,
              condition_jsonlogic,next_operation_name,next_operation_priority,next_operation_delay_seconds,
              manual_action_required,metadata,enabled,handler_key,handler_version)
              IS DISTINCT FROM ROW($2::text,$3::text,$4::text,NULL::jsonb,$5::text,$6::int,NULL::int,
                FALSE,$7::jsonb,TRUE,$8::text,$9::text)
        `,
        [
          existingStep.id,
          step.operationName,
          step.operationSettingsCategory,
          step.transitionCondition,
          step.nextOperationName,
          step.nextOperationPriority,
          JSON.stringify(step.metadata),
          step.handlerKey,
          step.handlerVersion,
        ],
      );
      continue;
    }

    const insertedStep = await queryOne(
      client,
      `
        INSERT INTO public.workflow_template_steps (
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
          enabled,
          created_at,
          updated_at,
          handler_key,
          handler_version
        )
        VALUES (
          $1::uuid,
          $2::int,
          $3::text,
          $4::text,
          $5::text,
          NULL,
          $6::text,
          $7::int,
          NULL,
          FALSE,
          $8::jsonb,
          TRUE,
          now(),
          now(),
          $9::text,
          $10::text
        )
        RETURNING id
      `,
      [
        row.id,
        step.sequenceOrder,
        step.operationName,
        step.operationSettingsCategory,
        step.transitionCondition,
        step.nextOperationName,
        step.nextOperationPriority,
        JSON.stringify(step.metadata),
        step.handlerKey,
        step.handlerVersion,
      ],
    );
    chosenStepIds.set(step.sequenceOrder, insertedStep.id);
  }

  for (const existingStep of existingSteps) {
    if (chosenStepIds.get(existingStep.sequence_order) === existingStep.id) {
      continue;
    }

    await client.query(
      `
        UPDATE public.workflow_template_steps
        SET enabled = FALSE,
            updated_at = now()
        WHERE id = $1::uuid
          AND enabled IS DISTINCT FROM FALSE
      `,
      [existingStep.id],
    );
  }

  await queryOne(
    client,
    `
      SELECT public.workflow_refresh_steps_checksum($1::uuid, FALSE) AS checksum
    `,
    [row.id],
  );

  return row.id;
}

async function resolveProviderIdMap(client, providerNames) {
  const rows = await queryMany(
    client,
    `
      SELECT id, name
      FROM public.providers
      WHERE name = ANY($1::text[])
    `,
    [providerNames],
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}

async function ensureIntegrationFixtures(options = {}) {
  const env = options.env || process.env;
  const profile = options.profile || buildFixtureProfile(env);
  const logger = options.logger || console;
  const dbUrl = options.databaseUrl
    || (
      await resolveDatabaseUrlWithFallback({
        env,
        logger,
        connectionTimeoutMs: options.connectionTimeoutMs,
        maxWaitMs: options.maxWaitMs,
        retryDelayMs: options.retryDelayMs,
        connectionTimeoutEnv: 'PGTAP_FIXTURE_BOOTSTRAP_CONNECT_TIMEOUT_MS',
        maxWaitEnv: 'PGTAP_FIXTURE_BOOTSTRAP_MAX_WAIT_MS',
        retryDelayEnv: 'PGTAP_FIXTURE_BOOTSTRAP_RETRY_DELAY_MS',
      })
    ).dsn
    || resolveDatabaseUrl(env);
  const changeReason = options.changeReason || 'integration fixture bootstrap';
  assertFixtureBootstrapAllowed(env);

  return withFixtureBootstrapRetry(async ({ retry }) => {
    const client = new Client({
      connectionString: dbUrl,
      connectionTimeoutMillis: retry.connectionTimeoutMs,
    });
    await client.connect();
    try {
      await client.query('BEGIN');

    const org = await withOrganizationOnboardingSource(client, () =>
      ensureOrganization(client, profile.organizations.alpha));
    const client11 = await ensureClient(client, org.id, profile.clients.oneOne);
    const client12 = await ensureClient(client, org.id, profile.clients.oneTwo);
    const client13 = await ensureClient(client, org.id, profile.clients.oneThree);
    const client21 = await ensureClient(client, org.id, profile.clients.twoOne);

    const sender11 = await ensureSender(client, client11.id, profile.senders.oneOne.name);
    const sender12 = await ensureSender(client, client12.id, profile.senders.oneTwo.name);
    const sender13 = await ensureSender(client, client13.id, profile.senders.oneThree.name);
    const sender21 = await ensureSender(client, client21.id, profile.senders.twoOne.name);

    await flushOrganizationOnboarding(client);

    const providerHere = await ensureProvider(client, {
      organizationId: org.id,
      name: 'here_geocoding',
      providerType: 'geocoding',
      priorityRank: 1,
      metadata: {
        base_url: 'https://geocode.search.hereapi.com/v1',
      },
    });
    await ensureProviderAuthConfig(client, {
      providerId: providerHere.id,
      authType: 'api_key',
      credentials: { api_key: 'EXAMPLE_PASSWORD' },
      secretDescription: 'integration fixture here api_key',
    });
    const providerGoogle = await ensureProvider(client, {
      organizationId: org.id,
      name: 'google_maps',
      providerType: 'geocoding',
      priorityRank: 1,
      metadata: {
        base_url: 'https://maps.googleapis.com/maps/api/geocode/json',
      },
    });
    const providerDialog = await ensureProvider(client, {
      organizationId: org.id,
      name: 'dialog360_whatsapp',
      providerType: 'comms',
      priorityRank: 1,
      metadata: {
        base_url: 'https://waba-v2.360dialog.io/messages',
      },
    });
    const providerLogestechs = await ensureProvider(client, {
      organizationId: org.id,
      name: 'logestechs_3pl',
      providerType: '3pl',
      priorityRank: 1,
      metadata: {
        base_url: VENDOR_BASE_URL,
      },
    });
    await ensureProvider(client, {
      organizationId: org.id,
      name: 'twilio_sms',
      providerType: 'sms',
      priorityRank: 1,
      metadata: {
        base_url: 'https://api.twilio.com',
      },
    });

    await ensureProviderDefaultRecipient(client, {
      providerId: providerDialog.id,
      defaultRecipient: '+12025550123',
      changeReason,
    });

    const riyadhCityId = await ensureCanonicalCity(client, {
      organizationId: org.id,
      cityName: 'Riyadh',
      cityArabic: '\u0627\u0644\u0631\u064a\u0627\u0636',
      province: 'Riyadh',
      countryCode: 'SA',
      alternateNames: ['Riyadh', 'Ryadh', '\u0627\u0644\u0631\u064a\u0627\u0636'],
    });
    await ensureCanonicalCity(client, {
      organizationId: org.id,
      cityName: 'Jeddah',
      cityArabic: '\u062c\u062f\u0629',
      province: 'Makkah',
      countryCode: 'SA',
      alternateNames: ['Jeddah', 'Jeddah City', '\u062c\u062f\u0629'],
    });

    const districtDefaults = {
      'Al Olaya': {
        districtArabic: '\u0627\u0644\u0639\u0644\u064a\u0627',
        alternateNames: [
          'Al Olaya',
          'Al-Olaya',
          'Olaya',
          '\u0627\u0644\u0639\u0644\u064a\u0627',
          '\u062d\u064a \u0627\u0644\u0639\u0644\u064a\u0627',
        ],
      },
    };

    for (const districtName of [
      'Al Olaya',
      'Al Amal Dist.',
      'King Fahd',
      'Tuwaiq Dist',
      'Tuwaiq Dist.',
      'West Suwaidi Dist.',
    ]) {
      await ensureCanonicalDistrict(client, {
        organizationId: org.id,
        cityId: riyadhCityId,
        cityName: 'Riyadh',
        districtName,
        ...(districtDefaults[districtName] || {}),
      });
    }

    const mappingBasic = await ensureMappingConfig(client, {
      mappingType: 'webhook_inbound',
      mappingKey: profile.webhook.basic.mappingKey,
      mappingConfig: buildWebhookInboundMapping('basic'),
      notes: 'Integration fixture basic webhook mapping',
      organizationId: org.id,
    });
    const mappingHmac = await ensureMappingConfig(client, {
      mappingType: 'webhook_inbound',
      mappingKey: profile.webhook.hmac.mappingKey,
      mappingConfig: buildWebhookInboundMapping('hmac'),
      notes: 'Integration fixture hmac webhook mapping',
      organizationId: org.id,
    });
    const mappingAsync = await ensureMappingConfig(client, {
      mappingType: 'webhook_inbound',
      mappingKey: profile.webhook.async.mappingKey,
      mappingConfig: buildWebhookInboundMapping('async'),
      notes: 'Integration fixture async webhook mapping',
      organizationId: org.id,
    });

    const mappingAckA = await ensureMappingConfig(client, {
      mappingType: 'webhook_response',
      mappingKey: profile.webhook.clientAckA.mappingKey,
      mappingConfig: buildAckMapping('A'),
      notes: 'Integration fixture ACK mapping A',
      organizationId: org.id,
    });
    const mappingAckB = await ensureMappingConfig(client, {
      mappingType: 'webhook_response',
      mappingKey: profile.webhook.clientAckB.mappingKey,
      mappingConfig: buildAckMapping('B'),
      notes: 'Integration fixture ACK mapping B',
      organizationId: org.id,
    });
    const mappingGeocodingIntake = await ensureMappingConfig(client, {
      mappingType: 'webhook_inbound',
      mappingKey: `${GEOCODING_BASE_SOURCE_IDENTIFIER}::address.intake_v1`,
      mappingConfig: buildGeocodingInboundMapping(),
      notes: 'Integration fixture geocoding webhook intake mapping',
      organizationId: org.id,
    });
    const mappingDialogReply = await ensureMappingConfig(client, {
      mappingType: 'webhook_inbound',
      mappingKey: 'dialog360_reply::communication.reply',
      mappingConfig: buildWebhookInboundMapping('dialog360_reply'),
      notes: 'Integration fixture Dialog360 reply mapping',
      organizationId: org.id,
    });

    await ensureOperationTemplateForProvider(client, {
      providerId: providerHere.id,
      operationName: 'geocoding_here_forward_v1',
      fallbackMappingConfigId: mappingGeocodingIntake,
    });
    await ensureOperationTemplateForProvider(client, {
      providerId: providerHere.id,
      operationName: 'geocoding_here_reverse_v1',
      fallbackMappingConfigId: mappingGeocodingIntake,
    });
    await ensureOperationTemplateForProvider(client, {
      providerId: providerGoogle.id,
      operationName: 'geocoding_google_forward_v1',
      fallbackMappingConfigId: mappingGeocodingIntake,
    });

    await ensureOperationTemplateForProvider(client, {
      providerId: providerDialog.id,
      operationName: 'dialog360_send_whatsapp_status_v1',
      baseUrl: 'https://waba-v2.360dialog.io/messages',
      fallbackMappingConfigId: mappingDialogReply,
    });
    await ensureOperationTemplateForProvider(client, {
      providerId: providerDialog.id,
      operationName: 'ops_oncall_whatsapp_alert_v1',
      baseUrl: 'https://waba-v2.360dialog.io/messages',
      fallbackMappingConfigId: mappingDialogReply,
    });

    const sourceBasic = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: profile.webhook.basic.sourceIdentifier,
      name: 'Integration Basic Source',
      providerType: 'provider',
      authToken: profile.webhook.basic.token,
      mappingConfigId: mappingBasic,
      senderId: sender11.id,
    });
    const sourceHmac = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: profile.webhook.hmac.sourceIdentifier,
      name: 'Integration HMAC Source',
      providerType: 'provider',
      authToken: profile.webhook.hmac.token,
      mappingConfigId: mappingHmac,
      senderId: sender11.id,
    });
    const sourceAsync = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: profile.webhook.async.sourceIdentifier,
      name: 'Integration Async Source',
      providerType: 'provider',
      authToken: profile.webhook.async.token,
      mappingConfigId: mappingAsync,
      senderId: sender21.id,
    });

    const sourceAckA = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: profile.webhook.clientAckA.sourceIdentifier,
      name: 'Integration ACK Source A',
      providerType: 'client',
      authToken: profile.webhook.clientAckA.token,
      mappingConfigId: mappingAckA,
      senderId: sender11.id,
    });
    const sourceAckB = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: profile.webhook.clientAckB.sourceIdentifier,
      name: 'Integration ACK Source B',
      providerType: 'client',
      authToken: profile.webhook.clientAckB.token,
      mappingConfigId: mappingAckB,
      senderId: sender12.id,
    });
    const sourceGeocodingIntake = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: GEOCODING_BASE_SOURCE_IDENTIFIER,
      name: 'Integration Geocoding Intake Source',
      providerType: 'logestechs_3pl',
      authToken: GEOCODING_BASE_SOURCE_TOKEN,
      mappingConfigId: mappingGeocodingIntake,
      senderId: sender11.id,
    });
    const sourceDialogReply = await ensureWebhookSource(client, {
      organizationId: org.id,
      sourceIdentifier: DIALOG360_REPLY_SOURCE_IDENTIFIER,
      name: 'Integration Dialog360 Reply Source',
      providerType: DIALOG360_REPLY_SOURCE_PROVIDER_TYPE,
      authToken:
        String(env.DIALOG360_REPLY_WEBHOOK_TOKEN || FALLBACK_DIALOG360_REPLY_TOKEN).trim() ||
        FALLBACK_DIALOG360_REPLY_TOKEN,
      mappingConfigId: mappingDialogReply,
      senderId: sender11.id,
    });

    const geocodingTemplate = await queryOne(
      client,
      `
        SELECT id
        FROM public.workflow_templates
        WHERE name = 'workflow_geocoding_standard'
        ORDER BY version DESC NULLS LAST
        LIMIT 1
      `,
    );
    const dialogReplyTemplate = await queryOne(
      client,
      `
        SELECT id
        FROM public.workflow_templates
        WHERE name = 'dialog360_reply_handler_v1'
        ORDER BY version DESC NULLS LAST
        LIMIT 1
      `,
    );
    if (!geocodingTemplate?.id) {
      throw new Error('workflow_geocoding_standard template is required for integration fixture bootstrap.');
    }
    if (!dialogReplyTemplate?.id) {
      throw new Error('dialog360_reply_handler_v1 template is required for integration fixture bootstrap.');
    }

    await ensureRecurringShipmentWorkflowTemplate(client);

    const sourcePolicy = buildShipmentWebhookPolicy();
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceBasic.id,
      value: sourcePolicy,
      schemaVersion: 3,
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceHmac.id,
      value: sourcePolicy,
      schemaVersion: 3,
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceAsync.id,
      value: {
        ...sourcePolicy,
        ack: { ...sourcePolicy.ack, mode: 'accepted_async', status_code: 202 },
      },
      schemaVersion: 3,
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceAckA.id,
      value: {
        ...buildShipmentWebhookPolicy(),
        ack: {
          mode: 'accepted_async',
          status_code: 202,
          response_mapping_id: mappingAckA,
        },
      },
      schemaVersion: 3,
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceAckB.id,
      value: {
        ...buildShipmentWebhookPolicy(),
        ack: {
          mode: 'accepted_async',
          status_code: 202,
          response_mapping_id: mappingAckB,
        },
      },
      schemaVersion: 3,
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceGeocodingIntake.id,
      value: buildGeocodingWebhookPolicy({
        workflowTemplateId: geocodingTemplate.id,
        mappingConfigId: mappingGeocodingIntake,
      }),
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'source',
      scopeId: sourceDialogReply.id,
      value: buildDialogReplyWebhookPolicy(dialogReplyTemplate.id),
      changeReason,
    });

    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'client',
      scopeId: client11.id,
      value: {
        ...buildShipmentWebhookPolicy(),
        ack: {
          mode: 'accepted_async',
          status_code: 202,
          response_mapping_id: mappingAckA,
        },
      },
      schemaVersion: 3,
      changeReason,
    });

    await upsertSettingValue(client, {
      category: 'webhook_ingest_policy',
      scopeType: 'client',
      scopeId: client12.id,
      value: {
        ...buildShipmentWebhookPolicy(),
        ack: {
          mode: 'accepted_async',
          status_code: 202,
          response_mapping_id: mappingAckB,
        },
      },
      schemaVersion: 3,
      changeReason,
    });

    const providerIdMap = await resolveProviderIdMap(client, [
      'here_geocoding',
      'dialog360_whatsapp',
      'logestechs_3pl',
      'twilio_sms',
    ]);
    const policyProviderHereId = providerIdMap.here_geocoding || providerHere.id;
    const policyProviderDialogId = providerIdMap.dialog360_whatsapp || providerDialog.id;
    const policyProviderLogestechsId = providerIdMap.logestechs_3pl || providerLogestechs.id;

    const client11GeoBase = asObject(await resolveSettingsValue(client, 'geocoding_policy', 'client', client11.id));
    const client13GeoBase = asObject(await resolveSettingsValue(client, 'geocoding_policy', 'client', client13.id));
    const client12GeoBase = asObject(await resolveSettingsValue(client, 'geocoding_policy', 'client', client12.id));
    const client21GeoBase = asObject(await resolveSettingsValue(client, 'geocoding_policy', 'client', client21.id));

    const makeGeoEnabled = (base) => {
      const next = {
        ...base,
        version: Number.isFinite(Number(base.version)) ? Number(base.version) : 1,
        provider_priority: ['here_geocoding'],
        metadata: {
          ...asObject(base.metadata),
          policy_profile: 'cache_first',
          primary_provider_id: policyProviderHereId,
        },
      };
      delete next.enabled;
      return next;
    };

    const makeGeoDisabled = (base) => {
      const next = {
        ...base,
        version: Number.isFinite(Number(base.version)) ? Number(base.version) : 1,
        provider_priority: [],
        metadata: {
          ...asObject(base.metadata),
          policy_profile: 'disabled',
        },
      };
      delete next.enabled;
      return next;
    };

    await upsertSettingValue(client, {
      category: 'geocoding_policy',
      scopeType: 'client',
      scopeId: client11.id,
      value: makeGeoEnabled(client11GeoBase),
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'geocoding_policy',
      scopeType: 'client',
      scopeId: client12.id,
      value: makeGeoDisabled(client12GeoBase),
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'geocoding_policy',
      scopeType: 'client',
      scopeId: client13.id,
      value: makeGeoEnabled(client13GeoBase),
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'geocoding_policy',
      scopeType: 'client',
      scopeId: client21.id,
      value: makeGeoDisabled(client21GeoBase),
      changeReason,
    });

    const client11CommsBase = asObject(await resolveSettingsValue(client, 'communications_policy', 'client', client11.id));
    const client12CommsBase = asObject(await resolveSettingsValue(client, 'communications_policy', 'client', client12.id));
    const client13CommsBase = asObject(await resolveSettingsValue(client, 'communications_policy', 'client', client13.id));
    const client21CommsBase = asObject(await resolveSettingsValue(client, 'communications_policy', 'client', client21.id));

    await upsertSettingValue(client, {
      category: 'communications_policy',
      scopeType: 'client',
      scopeId: client11.id,
      value: {
        ...client11CommsBase,
        enabled: true,
        channels: [
          {
            provider_id: policyProviderDialogId,
            channel: 'whatsapp',
          },
        ],
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'communications_policy',
      scopeType: 'client',
      scopeId: client12.id,
      value: {
        ...client12CommsBase,
        enabled: true,
        channels: [
          {
            provider_id: policyProviderDialogId,
            channel: 'whatsapp',
          },
        ],
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'communications_policy',
      scopeType: 'client',
      scopeId: client13.id,
      value: {
        ...client13CommsBase,
        enabled: false,
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'communications_policy',
      scopeType: 'client',
      scopeId: client21.id,
      value: {
        ...client21CommsBase,
        enabled: false,
      },
      changeReason,
    });

    const client11CallbackBase = asObject(
      await resolveSettingsValue(client, 'provider_callback_policy', 'client', client11.id),
    );
    const client12CallbackBase = asObject(
      await resolveSettingsValue(client, 'provider_callback_policy', 'client', client12.id),
    );
    const client13CallbackBase = asObject(
      await resolveSettingsValue(client, 'provider_callback_policy', 'client', client13.id),
    );
    const client21CallbackBase = asObject(
      await resolveSettingsValue(client, 'provider_callback_policy', 'client', client21.id),
    );

    await upsertSettingValue(client, {
      category: 'provider_callback_policy',
      scopeType: 'client',
      scopeId: client11.id,
      value: {
        ...client11CallbackBase,
        enabled: true,
        callback_url: 'https://callbacks.test-client-1-1.local/webhook',
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'provider_callback_policy',
      scopeType: 'client',
      scopeId: client12.id,
      value: {
        ...client12CallbackBase,
        enabled: false,
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'provider_callback_policy',
      scopeType: 'client',
      scopeId: client13.id,
      value: {
        ...client13CallbackBase,
        enabled: true,
        callback_url: 'https://callbacks.test-client-1-3.local/webhook',
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'provider_callback_policy',
      scopeType: 'client',
      scopeId: client21.id,
      value: {
        ...client21CallbackBase,
        enabled: false,
      },
      changeReason,
    });

    const client11DeliveryBase = asObject(
      await resolveSettingsValue(client, 'delivery_routing_policy', 'client', client11.id),
    );
    const client12DeliveryBase = asObject(
      await resolveSettingsValue(client, 'delivery_routing_policy', 'client', client12.id),
    );
    const client13DeliveryBase = asObject(
      await resolveSettingsValue(client, 'delivery_routing_policy', 'client', client13.id),
    );
    const client21DeliveryBase = asObject(
      await resolveSettingsValue(client, 'delivery_routing_policy', 'client', client21.id),
    );

    await upsertSettingValue(client, {
      category: 'delivery_routing_policy',
      scopeType: 'client',
      scopeId: client11.id,
      value: {
        ...client11DeliveryBase,
        enabled: true,
        provider_id: policyProviderLogestechsId,
        retry: {
          ...asObject(client11DeliveryBase.retry),
          max_attempts: 3,
          backoff_seconds: [300, 900, 1800],
        },
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'delivery_routing_policy',
      scopeType: 'client',
      scopeId: client12.id,
      value: {
        ...client12DeliveryBase,
        enabled: false,
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'delivery_routing_policy',
      scopeType: 'client',
      scopeId: client13.id,
      value: {
        ...client13DeliveryBase,
        enabled: false,
      },
      changeReason,
    });
    await upsertSettingValue(client, {
      category: 'delivery_routing_policy',
      scopeType: 'client',
      scopeId: client21.id,
      value: {
        ...client21DeliveryBase,
        enabled: false,
      },
      changeReason,
    });

    await ensureManualReviewBaselineShipment(client, {
      organizationId: org.id,
      clientId: client11.id,
      senderId: sender11.id,
    });

      await client.query('COMMIT');

      return {
        profile: profile.prefix,
        organization: { id: org.id, slug: org.slug },
        clients: {
          oneOne: { id: client11.id, slug: client11.slug },
          oneTwo: { id: client12.id, slug: client12.slug },
          oneThree: { id: client13.id, slug: client13.slug },
          twoOne: { id: client21.id, slug: client21.slug },
        },
        senders: {
          oneOne: { id: sender11.id },
          oneTwo: { id: sender12.id },
          oneThree: { id: sender13.id },
          twoOne: { id: sender21.id },
        },
        webhookSources: {
          basic: sourceBasic,
          hmac: sourceHmac,
          async: sourceAsync,
          clientAckA: sourceAckA,
          clientAckB: sourceAckB,
          geocodingIntake: sourceGeocodingIntake,
          dialogReply: sourceDialogReply,
        },
        zeroUuid: ZERO_UUID,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback cleanup failure
      }
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }, {
    env,
    logger,
    maxWaitMs: options.maxWaitMs,
    retryDelayMs: options.retryDelayMs,
  });
}

function printFixtureSummary(summary) {
  console.log('[fixture-bootstrap] Seeded integration fixtures.');
  console.log(`- profile: ${summary.profile}`);
  console.log(`- organization: ${summary.organization.slug} (${summary.organization.id})`);
  console.log(`- clients: ${Object.values(summary.clients).map((entry) => entry.slug).join(', ')}`);
  console.log(
    `- webhook tokens: ${summary.webhookSources.basic.auth_token}, ${summary.webhookSources.hmac.auth_token}, ${summary.webhookSources.async.auth_token}, ${summary.webhookSources.clientAckA.auth_token}, ${summary.webhookSources.clientAckB.auth_token}`,
  );
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = { asJson: false };
  for (const token of argv) {
    const v = String(token || '').trim();
    if (!v) continue;
    if (v === '--json') out.asJson = true;
  }
  return out;
}

async function runCli(options = {}) {
  loadEnv();
  const args = parseCliArgs(options.argv || process.argv.slice(2));
  const summary = await ensureIntegrationFixtures({ env: options.env || process.env });
  if (args.asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printFixtureSummary(summary);
}

module.exports = {
  buildFixtureProfile,
  buildShipmentWebhookPolicy,
  ensureIntegrationFixtures,
  ensureRecurringShipmentWorkflowTemplate,
  isRetryableFixtureBootstrapConcurrencyError,
  isRetryableFixtureBootstrapError,
  parseCliArgs,
  printFixtureSummary,
  resolveDatabaseUrl,
  resolveFixtureBootstrapRetryConfig,
  runCli,
  withFixtureBootstrapRetry,
  upsertSettingValue,
};
