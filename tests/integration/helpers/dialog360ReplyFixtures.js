const { DIALOG360_FIXTURE_BASE_URL } = require('../../fixtures/builders/hosts');
const { randomUUID } = require('crypto');

const dialog360ReplyWebhookToken = (process.env.DIALOG360_REPLY_WEBHOOK_TOKEN || '').trim();
const {
  ensureIntegrationFixturesPresent,
  getIntegrationFixtureProfile,
} = require('./integration-fixtures');

const fixtureProfile = getIntegrationFixtureProfile();
const preferredFixtureOrgSlug = fixtureProfile.organizations.alpha.slug;

const resolveWebhookSourceWithSenderClient = async (
  client,
  { token, sourceIdentifier, requireSenderId = true, preferredOrgSlug = preferredFixtureOrgSlug } = {},
) => {
  const normalizedToken = (token || '').trim();
  const normalizedOrgSlug = String(preferredOrgSlug || '').trim();
  if (normalizedToken) {
    const { rows } = await client.query(
      `
        SELECT
          ws.id,
          ws.sender_id,
          ws.organization_id,
          s.client_id,
          o.slug AS organization_slug
        FROM public.get_webhook_source_by_token($1::text) ws
        JOIN public.organizations o ON o.id = ws.organization_id
        LEFT JOIN public.senders s ON s.id = ws.sender_id
        WHERE ($2::text = '' OR o.slug = $2::text)
        LIMIT 1
      `,
      [normalizedToken, normalizedOrgSlug],
    );

    if (rows[0]?.id) return rows[0];
  }

  const identifier = String(sourceIdentifier || '').trim();
  if (!identifier) return null;

  const { rows } = await client.query(
    `
      SELECT
        ws.id,
        ws.sender_id,
        ws.organization_id,
        s.client_id,
        o.slug AS organization_slug
      FROM public.webhook_sources ws
      JOIN public.organizations o ON o.id = ws.organization_id
      LEFT JOIN public.senders s ON s.id = ws.sender_id
      WHERE ws.source_identifier = $1::text
        AND ($2::boolean IS FALSE OR ws.sender_id IS NOT NULL)
      ORDER BY
        CASE WHEN $3::text <> '' AND o.slug = $3::text THEN 0 ELSE 1 END,
        ws.created_at DESC
      LIMIT 1
    `,
    [identifier, Boolean(requireSenderId), normalizedOrgSlug],
  );

  return rows[0] || null;
};

const ensureProvider = async (client, { organizationId, name, providerType } = {}) => {
  const { rows } = await client.query(
    `
      SELECT id
      FROM public.providers
      WHERE organization_id = $1::uuid
        AND name = $2::text
        AND provider_type = $3::text
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [organizationId, String(name || '').trim(), String(providerType || '').trim()],
  );

  const providerId = rows[0]?.id || null;
  if (providerId) return providerId;

  const { rows: createdRows } = await client.query(
    `
      INSERT INTO public.providers (organization_id, name, provider_type, enabled, metadata)
      VALUES ($1::uuid, $2::text, $3::text, TRUE, '{}'::jsonb)
      ON CONFLICT (organization_id, name, provider_type) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            updated_at = now()
      RETURNING id
    `,
    [organizationId, String(name || '').trim(), String(providerType || '').trim()],
  );

  return createdRows[0]?.id || null;
};

const resolveDialog360ReplyWebhookSource = async (client) =>
  (async () => {
    let row = await resolveWebhookSourceWithSenderClient(client, {
      token: dialog360ReplyWebhookToken,
      sourceIdentifier: 'dialog360_reply',
      requireSenderId: true,
    });
    if (row?.id) return row;

    await ensureIntegrationFixturesPresent();
    row = await resolveWebhookSourceWithSenderClient(client, {
      token: dialog360ReplyWebhookToken,
      sourceIdentifier: 'dialog360_reply',
      requireSenderId: true,
    });
    return row;
  })();

const ensureDialog360Provider = async (client, organizationId) =>
  ensureProvider(client, {
    organizationId,
    name: 'dialog360_whatsapp',
    providerType: 'comms',
  });

const upsertScopedSetting = async (
  client,
  { category, scopeType, scopeId = null, value, changeReason = 'integration test seed' },
) => {
  await client.query(
    `
      WITH expired AS (
        UPDATE public.settings_versions
           SET effective_until = now()
         WHERE category = $1::text
           AND scope_type = $2::text
           AND scope_id IS NOT DISTINCT FROM $3::uuid
           AND effective_until IS NULL
           AND approved_at IS NOT NULL
        RETURNING 1
      ),
      barrier AS (
        SELECT 1 AS ok FROM expired
        UNION ALL SELECT 1 AS ok
        LIMIT 1
      ),
      next_version AS (
        SELECT COALESCE(MAX(version), 0) + 1 AS v
        FROM public.settings_versions
        WHERE category = $1::text
          AND scope_type = $2::text
          AND scope_id IS NOT DISTINCT FROM $3::uuid
      ),
      inserted AS (
        INSERT INTO public.settings_versions (
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
        SELECT
          $1::text,
          $2::text,
          $3::uuid,
          next_version.v,
          $4::jsonb,
          1,
          $5::text,
          now(),
          now()
        FROM next_version, barrier
        RETURNING id, value
      )
      INSERT INTO public.settings (
        category,
        scope_type,
        scope_id,
        settings_version_id,
        cached_value,
        last_updated
      )
      SELECT
        $1::text,
        $2::text,
        $3::uuid,
        inserted.id,
        inserted.value,
        now()
      FROM inserted
      ON CONFLICT (category, scope_type, scope_hash)
      DO UPDATE SET
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated
    `,
    [category, scopeType, scopeId, JSON.stringify(value), changeReason],
  );
};

const ensureDialog360ProviderDefaults = async (
  client,
  providerId,
  { defaultRecipient = '+12025550123' } = {},
) => {
  if (!providerId) return null;

  await client.query(
    `
      UPDATE public.providers
      SET metadata = jsonb_strip_nulls(
            COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
              'channel', 'whatsapp',
              'base_url',
              COALESCE(
                NULLIF(metadata->>'base_url', ''),
                NULLIF(metadata->>'baseUrl', ''),
                $2::text
              )
            )
          ),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [providerId, DIALOG360_FIXTURE_BASE_URL],
  );

  const providerDefaults = {
    default_recipient: String(defaultRecipient || '').trim() || '+12025550123',
    messaging_product: 'whatsapp',
    whatsapp: {
      messages_path: '/v1/messages',
      api_key_header: 'D360-API-KEY',
      headers_template: {
        'content-type': 'application/json',
      },
      text_body_template: {
        to: '{{recipient}}',
        recipient_type: 'individual',
        type: 'text',
        messaging_product: '{{messaging_product}}',
        text: {
          body: '{{message_text}}',
        },
      },
    },
  };

  await upsertScopedSetting(client, {
    category: 'provider_defaults',
    scopeType: 'resource',
    scopeId: providerId,
    value: providerDefaults,
    changeReason: 'integration test seed: dialog360 provider defaults',
  });

  return providerDefaults;
};

const createDialog360AuthConfig = async (
  client,
  providerId,
  { apiKey = 'integration-EXAMPLE_PASSWORD', description = 'integration comms reply api_key' } = {},
) => {
  if (!providerId) return null;

  const authConfigId = randomUUID();
  const { rows: vaultRows } = await client.query(
    `SELECT vault.create_secret($1::text, $2::text, $3::text, NULL) AS id`,
    [JSON.stringify({ api_key: apiKey }), `provider_auth_configs/${authConfigId}`, description],
  );

  await client.query(
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
        'api_key',
        $3::uuid,
        $4::jsonb,
        NULL
      )
    `,
    [
      authConfigId,
      providerId,
      vaultRows[0].id,
      JSON.stringify({ api_key: apiKey }),
    ],
  );

  return authConfigId;
};

const DIALOG360_REPLY_CANONICAL_MAPPING = Object.freeze({
  description: 'Dialog360 WhatsApp reply mapping (FB webhook payload)',
  external_id_path: '$.entry[0].changes[0].value.messages[0].id',
  event_type_path: '$.entry[0].changes[0].value.messages[0].type',
  transforms: {
    communication: {
      recipient: '$.entry[0].changes[0].value.contacts[0].wa_id',
      correlation_id: '$.entry[0].changes[0].value.messages[0].context.id',
      message_id: '$.entry[0].changes[0].value.messages[0].id',
      reply_payload: '$.entry[0].changes[0].value.messages[0].button.payload',
      reply_text: '$.entry[0].changes[0].value.messages[0].text.body',
      timestamp: '$.entry[0].changes[0].value.messages[0].timestamp',
    },
  },
});

const ensureDialog360ReplyMappingConfig = async (client, webhookSourceId) => {
  if (!webhookSourceId) return null;

  const { rows: sourceRows } = await client.query(
    `
      SELECT mapping_config_id
      FROM public.webhook_sources
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [webhookSourceId],
  );
  if (!sourceRows.length) return null;

  let mappingConfigId = sourceRows[0]?.mapping_config_id || null;

  if (mappingConfigId) {
    await client.query(
      `
        UPDATE public.mapping_configs
        SET mapping_config = $2::jsonb,
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [mappingConfigId, JSON.stringify(DIALOG360_REPLY_CANONICAL_MAPPING)],
    );
    return mappingConfigId;
  }

  const mappingKey = `dialog360_reply::communication.reply::integration::${randomUUID()}`;
  const { rows: createdRows } = await client.query(
    `
      INSERT INTO public.mapping_configs (
        mapping_type,
        mapping_key,
        mapping_config,
        notes
      )
      VALUES (
        'webhook_inbound',
        $1::text,
        $2::jsonb,
        'Integration test seed: canonical dialog360 reply mapping'
      )
      RETURNING id
    `,
    [mappingKey, JSON.stringify(DIALOG360_REPLY_CANONICAL_MAPPING)],
  );
  mappingConfigId = createdRows[0]?.id || null;
  if (!mappingConfigId) return null;

  await client.query(
    `
      UPDATE public.webhook_sources
      SET mapping_config_id = $2::uuid,
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [webhookSourceId, mappingConfigId],
  );
  return mappingConfigId;
};

module.exports = {
  createDialog360AuthConfig,
  ensureDialog360ProviderDefaults,
  ensureDialog360ReplyMappingConfig,
  ensureDialog360Provider,
  ensureProvider,
  resolveDialog360ReplyWebhookSource,
  resolveWebhookSourceWithSenderClient,
};
