const { randomUUID } = require('crypto');
const { applyGeocodingPolicy } = require('./geocodingPolicy');
const { upsertSettings } = require('../../utils/policies');
const { getIntegrationFixtureProfile } = require('./integration-fixtures');

const BASE_SOURCE_IDENTIFIER = 'geocoding-intake-test';
const BASE_SOURCE_TOKEN = 'EXAMPLE_PASSWORD';
const INGEST_POLICY_CATEGORY = 'webhook_ingest_policy';
const fixtureProfile = getIntegrationFixtureProfile();
const preferredFixtureOrgSlug = fixtureProfile.organizations.alpha.slug;

function cloneJson(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeNamespace(value) {
  const raw = String(value || '').trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return safe.slice(0, 32) || 'local';
}

function getTestNamespace(suffix) {
  const base = normalizeNamespace(process.env.TEST_NAMESPACE || process.env.GITHUB_RUN_ID || 'local');
  const extra = normalizeNamespace(suffix);
  return extra ? `${base}-${extra}` : base;
}

function makeTestIdentifiers(suffix) {
  const namespace = getTestNamespace(suffix);
  return {
    namespace,
    sourceIdentifier: `${BASE_SOURCE_IDENTIFIER}-${namespace}`,
    token: `${BASE_SOURCE_TOKEN}-${namespace}`,
  };
}

async function ensureHereGeocodingAuthContract(client, organizationId) {
  const { rows: providerRows } = await client.query(
    `
      SELECT id
      FROM public.providers
      WHERE name = 'here_geocoding'
        AND (
          $1::uuid IS NULL
          OR organization_id = $1::uuid
          OR EXISTS (
            SELECT 1
            FROM public.operation_templates ot
            WHERE ot.provider_id = providers.id
              AND (
                ot.operation_name LIKE 'geocoding_here_%'
                OR COALESCE(ot.metadata->>'operation_role', '') IN ('geocoding_forward', 'geocoding_reverse')
              )
          )
        )
      ORDER BY
        CASE WHEN organization_id = $1::uuid THEN 0 ELSE 1 END,
        priority_rank ASC NULLS LAST,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST
    `,
    [organizationId],
  );
  if (!providerRows.length) return;

  const authMetadata = {
    mode: 'api_key_query',
    auth_type: 'api_key',
    query_param: 'apiKey',
    credential_key: 'api_key',
  };

  const fallbackQueryMappingByRole = {
    geocoding_forward: [
      { param: 'q', value_path: '$.address.text' },
      { param: 'lang', value_path: '$.address.lang' },
      { param: 'limit', value_path: '$.address.limit' },
    ],
    geocoding_reverse: [
      { param: 'at', value_path: '$.coordinates' },
      { param: 'lang', value_path: '$.address.lang' },
      { param: 'limit', value_path: '$.address.limit' },
    ],
  };

  for (const provider of providerRows) {
    const providerId = provider.id;
    if (!providerId) continue;

    let authConfigId = null;
    const { rows: authRows } = await client.query(
      `
        SELECT id
        FROM public.provider_auth_configs
        WHERE provider_id = $1::uuid
          AND auth_type = 'api_key'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [providerId],
    );
    authConfigId = authRows[0]?.id || null;

    if (!authRows.length) {
      const { rows: insertedAuthRows } = await client.query(
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
            gen_random_uuid(),
            $1::uuid,
            'api_key',
            NULL,
            $2::jsonb,
            NULL
          )
          RETURNING id
        `,
        [providerId, JSON.stringify({ api_key: 'EXAMPLE_PASSWORD' })],
      );
      authConfigId = insertedAuthRows[0]?.id || null;
    }

    const authMetadataWithConfigId = authConfigId
      ? { ...authMetadata, auth_config_id: authConfigId }
      : authMetadata;

    const { rows: templateRows } = await client.query(
      `
        SELECT
          id,
          operation_name,
          COALESCE(metadata->>'operation_role', '') AS operation_role
        FROM public.operation_templates
        WHERE provider_id = $1::uuid
          AND (
            operation_name LIKE 'geocoding_here_%'
            OR COALESCE(metadata->>'operation_role', '') IN ('geocoding_forward', 'geocoding_reverse')
          )
      `,
      [providerId],
    );

    for (const template of templateRows) {
      const inferredRole =
        template.operation_role ||
        (template.operation_name.includes('reverse') ? 'geocoding_reverse' : 'geocoding_forward');
      const operationRole =
        inferredRole === 'geocoding_reverse' ? 'geocoding_reverse' : 'geocoding_forward';
      const fallbackQueryMapping = fallbackQueryMappingByRole[operationRole];

      await client.query(
        `
          UPDATE public.operation_templates
          SET metadata = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    COALESCE(metadata, '{}'::jsonb),
                    '{operation_role}',
                    to_jsonb($2::text),
                    TRUE
                  ),
                  '{auth}',
                  (
                    COALESCE(COALESCE(metadata, '{}'::jsonb)->'auth', '{}'::jsonb)
                    || $3::jsonb
                  ),
                  TRUE
                ),
                '{url_query_mapping}',
                CASE
                  WHEN jsonb_typeof(COALESCE(metadata, '{}'::jsonb)->'url_query_mapping') = 'array'
                    AND jsonb_array_length(COALESCE(metadata, '{}'::jsonb)->'url_query_mapping') > 0
                  THEN (COALESCE(metadata, '{}'::jsonb)->'url_query_mapping')
                  ELSE $4::jsonb
                END,
                TRUE
              ),
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [
          template.id,
          operationRole,
          JSON.stringify(authMetadataWithConfigId),
          JSON.stringify(fallbackQueryMapping),
        ],
      );
    }
  }
}

function getNamespaceFromSourceIdentifier(sourceIdentifier) {
  const prefix = `${BASE_SOURCE_IDENTIFIER}-`;
  if (sourceIdentifier?.startsWith(prefix)) {
    return sourceIdentifier.slice(prefix.length);
  }
  return sourceIdentifier;
}

async function ensureWebhookSourcePolicy(client, sourceId, basePolicy) {
  await upsertSettings(
    INGEST_POLICY_CATEGORY,
    'source',
    sourceId,
    basePolicy,
    'integration geocoding webhook policy seed',
    client,
  );
}

async function lookupWebhookSource(client, sourceIdentifier, options = {}) {
  const token = (options.token || '').trim();
  const orgSlug = String(options.preferredOrgSlug || preferredFixtureOrgSlug).trim();
  if (token) {
    const { rows: tokenRows } = await client.query(
      `
        SELECT
          ws.id,
          ws.source_identifier,
          ws.organization_id,
          ws.sender_id,
          ws.provider_type,
          ws.mapping_config_id,
          s.client_id,
          o.slug AS organization_slug
        FROM public.get_webhook_source_by_token($1) ws
        JOIN public.organizations o ON o.id = ws.organization_id
        LEFT JOIN public.senders s ON s.id = ws.sender_id
        WHERE ($2::text = '' OR o.slug = $2::text)
      `,
      [token, orgSlug],
    );
    if (tokenRows.length) {
      const resolved = tokenRows[0];
      if (resolved.source_identifier !== sourceIdentifier) {
        throw new Error(
          `Token resolved to source_identifier=${resolved.source_identifier}; expected=${sourceIdentifier}`,
        );
      }
      return resolved;
    }
  }

  const { rows } = await client.query(
    `
      SELECT
        ws.id,
        ws.organization_id,
        ws.sender_id,
        ws.provider_type,
        ws.mapping_config_id,
        s.client_id,
        o.slug AS organization_slug
      FROM webhook_sources ws
      JOIN public.organizations o ON o.id = ws.organization_id
      LEFT JOIN senders s ON s.id = ws.sender_id
      WHERE ws.source_identifier = $1
      ORDER BY
        CASE WHEN $2::text <> '' AND o.slug = $2::text THEN 0 ELSE 1 END,
        ws.created_at DESC
      LIMIT 1
    `,
    [sourceIdentifier, orgSlug],
  );

  return rows[0] || null;
}

async function fetchSource(client, sourceIdentifier = BASE_SOURCE_IDENTIFIER, options = {}) {
  const orgSlug = String(options.preferredOrgSlug || preferredFixtureOrgSlug).trim();
  const existing = await lookupWebhookSource(client, sourceIdentifier, options);

  if (existing) {
    if (options.token) {
      await client.query(
        `
          UPDATE webhook_sources
          SET sender_id = $1::uuid,
              mapping_config_id = $2::uuid,
              enabled = true,
              auth_token = $3::text,
              updated_at = now()
          WHERE id = $4::uuid
        `,
        [existing.sender_id, existing.mapping_config_id, options.token, existing.id],
      );
    }

    try {
      await fetchWebhookPolicy(client, existing.id);
    } catch (err) {
      if (sourceIdentifier === BASE_SOURCE_IDENTIFIER) {
        throw err;
      }

      const baseRow = await lookupWebhookSource(client, BASE_SOURCE_IDENTIFIER, {
        preferredOrgSlug: orgSlug,
      });

      if (!baseRow?.id) {
        throw new Error(
          `${BASE_SOURCE_IDENTIFIER} webhook source not found; cannot recover missing webhook_ingest_policy for ${sourceIdentifier}`,
        );
      }

      const basePolicy = await fetchWebhookPolicy(client, baseRow.id);
      await ensureWebhookSourcePolicy(client, existing.id, basePolicy);
    }

    await ensureHereGeocodingAuthContract(client, existing.organization_id);
    return existing;
  }

  if (sourceIdentifier === BASE_SOURCE_IDENTIFIER) {
    throw new Error(`${sourceIdentifier} webhook source not found; ensure migrations seeded it`);
  }

  const base = await lookupWebhookSource(client, BASE_SOURCE_IDENTIFIER, {
    preferredOrgSlug: orgSlug,
  });

  if (!base) {
    throw new Error(`${BASE_SOURCE_IDENTIFIER} webhook source not found; cannot create isolated geocoding fixture`);
  }

  const token = options.token;
  if (!token) {
    throw new Error(`fetchSource(${sourceIdentifier}) requires options.token for isolated fixture creation`);
  }

  const namespaceForSlug = getNamespaceFromSourceIdentifier(sourceIdentifier);
  const clientSlug = `geo-ci-${normalizeNamespace(namespaceForSlug)}`.slice(0, 48);

  const { rows: clientRows } = await client.query(
    `
      INSERT INTO clients (id, organization_id, name, slug, status)
      VALUES (gen_random_uuid(), $1::uuid, $2::text, $3::text, 'active')
      ON CONFLICT (organization_id, slug) DO UPDATE
      SET updated_at = now()
      RETURNING id
    `,
    [base.organization_id, `Geocoding CI Client ${clientSlug}`, clientSlug],
  );
  const clientId = clientRows[0].id;

  const senderName = `Geocoding CI Sender ${clientSlug}`.slice(0, 120);
  let senderId;
  const { rows: senderRows } = await client.query(
    `
      SELECT id
      FROM senders
      WHERE client_id = $1::uuid
        AND name = $2::text
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [clientId, senderName],
  );
  if (senderRows.length) {
    senderId = senderRows[0].id;
  } else {
    const { rows: senderIns } = await client.query(
      `
        INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
        VALUES (gen_random_uuid(), $1::uuid, $2::text, 'Geocoding CI', true, 'active')
        RETURNING id
      `,
      [clientId, senderName],
    );
    senderId = senderIns[0].id;
  }

  const { rows: sourceIns } = await client.query(
    `
      INSERT INTO webhook_sources (
        id,
        organization_id,
        sender_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        enabled
      )
      VALUES (
        gen_random_uuid(),
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::uuid,
        true
      )
      RETURNING id
    `,
    [
      base.organization_id,
      senderId,
      sourceIdentifier,
      `Geocoding CI Source ${clientSlug}`,
      base.provider_type,
      token,
      base.mapping_config_id,
    ],
  );

  const basePolicy = await fetchWebhookPolicy(client, base.id);
  await ensureWebhookSourcePolicy(client, sourceIns[0].id, basePolicy);
  await ensureHereGeocodingAuthContract(client, base.organization_id);

  return fetchSource(client, sourceIdentifier);
}

async function fetchWebhookPolicy(client, sourceId) {
  const { rows } = await client.query(
    `
      SELECT cached_value
      FROM settings
      WHERE category = $1
        AND scope_type = 'source'
        AND scope_id = $2::uuid
      ORDER BY last_updated DESC
      LIMIT 1
    `,
    [INGEST_POLICY_CATEGORY, sourceId],
  );

  if (!rows.length) {
    throw new Error(`webhook_ingest_policy not found for webhook_source_id=${sourceId}`);
  }

  return cloneJson(rows[0].cached_value);
}

async function overrideWebhookMapping(client, sourceId, mappingConfigId) {
  const policy = await fetchWebhookPolicy(client, sourceId);
  const nextPolicy = {
    ...policy,
    workflow: {
      ...(policy.workflow || {}),
      context_patch: {
        ...(policy.workflow?.context_patch || {}),
        mapping_config_id: mappingConfigId,
      },
    },
  };

  await upsertSettings(
    INGEST_POLICY_CATEGORY,
    'source',
    sourceId,
    nextPolicy,
    'integration geocoding webhook mapping override',
    client,
  );
}

async function seedMappingConfig(client, mappingKey, addressPaths) {
  const mappingId = randomUUID();
  const mappingConfig = {
    description: 'Integration test mapping override for geocoding webhook',
    external_id_path: 'event.id',
    transforms: {
      address: {
        line1: addressPaths.line1,
        line2: addressPaths.line2,
        city: addressPaths.city,
        district: addressPaths.district,
        province: addressPaths.province,
        country: addressPaths.country,
        postal_code: addressPaths.postal_code,
        lat: addressPaths.lat,
        lng: addressPaths.lng,
      },
    },
  };

  await client.query(
    `
      INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
      VALUES ($1, 'webhook_inbound', $2, $3::jsonb, 1, 'integration geocoding webhook mapping override')
    `,
    [mappingId, mappingKey, mappingConfig],
  );

  return mappingId;
}

async function configureGeocodingPolicy(client, scopeType, scopeId, policy) {
  await applyGeocodingPolicy(
    client,
    scopeType,
    scopeId,
    policy,
    null,
    'integration geocoding webhook policy',
  );
}

async function executeWebhookRpc(client, payload, token = BASE_SOURCE_TOKEN) {
  const headers = { 'content-type': 'application/json' };
  const rawBody = JSON.stringify(payload);
  const { rows } = await client.query(
    `
      SELECT workflow_intake_webhook($1::text, $2::jsonb, $3::text, $4::jsonb) AS response
    `,
    [token, JSON.stringify(headers), rawBody, payload],
  );
  return rows[0].response;
}

async function executeWebhookEdge(payload, options = {}) {
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const token = options.token || BASE_SOURCE_TOKEN;
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL must be set to run webhook-receiver edge E2E');
  }

  const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/webhook-receiver`;
  const headers = {
    'content-type': 'application/json',
    'x-webhook-token': token,
    ...(payload?.event?.id ? { 'Idempotency-Key': payload.event.id } : {}),
    ...(options.headers || {}),
  };

  const timeoutMs = Number(options.timeoutMs ?? process.env.WEBHOOK_EDGE_TIMEOUT_MS ?? 12000);
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body = { error: message, status: 'fetch_error' };
    return {
      response: new Response(JSON.stringify(body), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
      body,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }

  if (response.status >= 500) {
    // eslint-disable-next-line no-console
    console.warn(
      '[webhook-receiver-edge] intake failed',
      response.status,
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }

  return { response, body };
}

async function fetchRun(client, runId) {
  const { rows } = await client.query(
    `SELECT workflow_status, context FROM workflow_runs WHERE id = $1::uuid`,
    [runId],
  );
  return rows[0];
}

async function progressRun(client, runId, maxIterations = 10) {
  for (let i = 0; i < maxIterations; i += 1) {
    await client.query('SELECT progress_workflow_run($1::uuid)', [runId]);
    const run = await fetchRun(client, runId);
    if (run.workflow_status !== 'in_progress') {
      return run;
    }
  }
  return fetchRun(client, runId);
}

async function fetchOutboundByRun(client, runId, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? Math.max(1, Math.trunc(options.attempts)) : 1;
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.trunc(options.delayMs)) : 0;
  const progress = options.progress === true;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { rows } = await client.query(
      `
        SELECT oc.*
        FROM outbound_calls oc
        JOIN workflow_run_steps wrs ON wrs.id = oc.workflow_run_step_id
        WHERE wrs.workflow_run_id = $1::uuid
        ORDER BY oc.created_at DESC
        LIMIT 1
      `,
      [runId],
    );
    if (rows[0]) {
      return rows[0];
    }

    if (progress && attempt < attempts - 1) {
      await client.query('SELECT progress_workflow_run($1::uuid)', [runId]);
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return null;
}

async function resetWebhookRunsForSource(client, sourceIdentifier = BASE_SOURCE_IDENTIFIER, options = {}) {
  const src = await lookupWebhookSource(client, sourceIdentifier, options);
  if (!src?.id) return;

  await client.query(
    `
      DELETE FROM outbound_calls
      WHERE workflow_run_step_id IN (
        SELECT id
        FROM workflow_run_steps
        WHERE workflow_run_id IN (
          SELECT workflow_run_id
          FROM webhook_inbox
          WHERE webhook_source_id = $1::uuid
            AND workflow_run_id IS NOT NULL
        )
      )
    `,
    [src.id],
  );

  await client.query(
    `
      DELETE FROM workflow_run_steps
      WHERE workflow_run_id IN (
        SELECT workflow_run_id
        FROM webhook_inbox
        WHERE webhook_source_id = $1::uuid
          AND workflow_run_id IS NOT NULL
      )
    `,
    [src.id],
  );

  await client.query(
    `
      DELETE FROM workflow_runs
      WHERE id IN (
        SELECT workflow_run_id
        FROM webhook_inbox
        WHERE webhook_source_id = $1::uuid
          AND workflow_run_id IS NOT NULL
      )
    `,
    [src.id],
  );

  await client.query(
    `
      DELETE FROM webhook_inbox
      WHERE webhook_source_id = $1::uuid
    `,
    [src.id],
  );
}

async function cleanupGeocodingTestFixture(client, sourceIdentifier, options = {}) {    
  if (!sourceIdentifier || sourceIdentifier === BASE_SOURCE_IDENTIFIER) return;

  const src = await lookupWebhookSource(client, sourceIdentifier, options);
  if (!src?.id) return;

  await resetWebhookRunsForSource(client, sourceIdentifier, options);

  await client.query(
    `
      DELETE FROM settings
      WHERE category = $1
        AND scope_type = 'source'
        AND scope_id = $2::uuid
    `,
    [INGEST_POLICY_CATEGORY, src.id],
  );

  await client.query(
    `
      DELETE FROM settings_versions
      WHERE category = $1
        AND scope_type = 'source'
        AND scope_id = $2::uuid
    `,
    [INGEST_POLICY_CATEGORY, src.id],
  );

  await client.query(`DELETE FROM webhook_sources WHERE id = $1::uuid`, [src.id]);

  // Cleanup geocoding attempt ledger rows before removing the sender/client to
  // avoid FK violations (geocoding_attempts.sender_id -> senders.id).
  if (src.sender_id || src.client_id) {
    await client.query(
      `
        DELETE FROM geocoding_attempts
        WHERE sender_id IS NOT DISTINCT FROM $1::uuid
           OR client_id IS NOT DISTINCT FROM $2::uuid
      `,
      [src.sender_id, src.client_id],
    );
  }

  // Cleanup geocode cache rows; avoid deleting addresses or parent rows.
  if (src.client_id) {
    await client.query(`DELETE FROM geocodes WHERE client_id = $1::uuid`, [src.client_id]);
  }

  // Keep sender/client rows to avoid cascades into address_versions.
}

module.exports = {
  BASE_SOURCE_IDENTIFIER,
  BASE_SOURCE_TOKEN,
  INGEST_POLICY_CATEGORY,
  cloneJson,
  makeTestIdentifiers,
  fetchSource,
  fetchWebhookPolicy,
  overrideWebhookMapping,
  seedMappingConfig,
  configureGeocodingPolicy,
  executeWebhookRpc,
  executeWebhookEdge,
  progressRun,
  fetchOutboundByRun,
  resetWebhookRunsForSource,
  cleanupGeocodingTestFixture,
};
