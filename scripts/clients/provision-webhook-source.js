#!/usr/bin/env node

/**
 * Provision or update a webhook source (inbound) for a client, including sender and mapping.
 * Replaces archived migrations 202510150203_seed_client2_webhook_source.sql and
 * 202510150205_seed_client2_webhook_source_fix.sql.
 */

const { Pool } = require('pg');
const fs = require('fs');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[provision-webhook-source] DATABASE_URL is required.');
  process.exit(1);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const defaults = {
    clientSlug: undefined,
    sourceIdentifier: undefined,
    providerType: 'async_3pl',
    sourceName: undefined,
    authToken: undefined,
    senderName: undefined,
    senderBrand: undefined,
    senderStatus: 'active',
    senderAutoProvisioned: true,
    senderAutoRecreate: true,
    mappingType: 'webhook_inbound',
    mappingKey: undefined,
    mappingConfig: '{}',
    mappingNotes: 'Client-specific webhook inbound mapping',
    rateLimitPerHour: 1000,
    enabled: true,
    mappingConfigFile: undefined
  };

  const options = { ...defaults };
  const args = [...argv];
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    if (!token.startsWith('--')) {
      if (token) positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const [key, inlineValue] = raw.split('=');
    const next = inlineValue === undefined ? args[i + 1] : inlineValue;
    switch (key) {
      case 'client-slug':
        options.clientSlug = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'source-identifier':
        options.sourceIdentifier = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'provider-type':
        options.providerType = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'source-name':
        options.sourceName = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'auth-token':
        options.authToken = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'sender-name':
        options.senderName = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'sender-brand':
        options.senderBrand = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'sender-status':
        options.senderStatus = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'sender-auto-provisioned':
        options.senderAutoProvisioned = next !== 'false';
        if (inlineValue === undefined) i += 1;
        break;
      case 'sender-auto-recreate':
        options.senderAutoRecreate = next !== 'false';
        if (inlineValue === undefined) i += 1;
        break;
      case 'mapping-type':
        options.mappingType = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'mapping-key':
        options.mappingKey = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'mapping-config':
        options.mappingConfig = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'mapping-config-file':
        options.mappingConfigFile = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'mapping-notes':
        options.mappingNotes = next;
        if (inlineValue === undefined) i += 1;
        break;
      case 'rate-limit-per-hour':
        options.rateLimitPerHour = Number(next);
        if (inlineValue === undefined) i += 1;
        break;
      case 'enabled':
        options.enabled = next !== 'false';
        if (inlineValue === undefined) i += 1;
        break;
      default:
        console.warn(`[provision-webhook-source] Unknown flag --${key}`);
    }
  }

  // npm@11+ can strip unknown `--flags` even after `--`, leaving only values as positionals.
  // Support a positional fallback to preserve script usability:
  //   provision-webhook-source <client-slug> <source-identifier> <provider-type> <auth-token> <mapping-key>
  if (
    (!options.clientSlug || !options.sourceIdentifier || !options.mappingKey || !options.authToken)
    && Array.isArray(positionals)
    && positionals.length >= 5
  ) {
    if (!options.clientSlug) options.clientSlug = positionals[0];
    if (!options.sourceIdentifier) options.sourceIdentifier = positionals[1];
    if (options.providerType === defaults.providerType) options.providerType = positionals[2];
    if (!options.authToken) options.authToken = positionals[3];
    if (!options.mappingKey) options.mappingKey = positionals[4];
  }

  if (options.mappingConfigFile) {
    const content = fs.readFileSync(options.mappingConfigFile, 'utf8');
    options.mappingConfig = content;
  }

  if (!options.clientSlug) {
    throw new Error('Missing required flag: --client-slug');
  }
  if (!options.sourceIdentifier) {
    throw new Error('Missing required flag: --source-identifier');
  }
  if (!options.mappingKey) {
    throw new Error('Missing required flag: --mapping-key');
  }
  if (!options.authToken) {
    throw new Error('Missing required flag: --auth-token');
  }

  parseJson(options.mappingConfig, '--mapping-config');

  if (!options.senderName) {
    options.senderName = `${options.clientSlug} sender`;
  }
  if (!options.senderBrand) {
    options.senderBrand = options.senderName;
  }
  if (!options.sourceName) {
    options.sourceName = options.sourceIdentifier;
  }

  return options;
}

async function preflightEnabledSource(client, webhookSourceId) {
  const res = await client.query(
    `SELECT settings_id
       FROM public.resolve_webhook_ingest_policy($1::uuid)
       LIMIT 1`,
    [webhookSourceId],
  );
  if (res.rowCount === 0 || !res.rows[0].settings_id) {
    throw new Error(
      `Preflight failed: webhook_ingest_policy did not resolve for source_id=${webhookSourceId}`,
    );
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[provision-webhook-source] ${error.message}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const clientRowRes = await client.query(
      'SELECT id, organization_id FROM clients WHERE slug = $1 LIMIT 1',
      [options.clientSlug]
    );
    if (clientRowRes.rowCount === 0) {
      throw new Error(`Client with slug ${options.clientSlug} not found`);
    }
    const clientRow = clientRowRes.rows[0];

    const senderRes = await client.query(
      `SELECT id
       FROM senders
       WHERE client_id = $1 AND name = $2
       LIMIT 1`,
      [clientRow.id, options.senderName]
    );

    let senderId;
    if (senderRes.rowCount > 0) {
      senderId = senderRes.rows[0].id;
    } else {
      const insertSender = await client.query(
        `INSERT INTO senders (
            client_id,
            name,
            brand_name,
            auto_provisioned,
            auto_recreate,
            status
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          clientRow.id,
          options.senderName,
          options.senderBrand,
          options.senderAutoProvisioned,
          options.senderAutoRecreate,
          options.senderStatus
        ]
      );
      senderId = insertSender.rows[0].id;
    }

    const mappingRes = await client.query(
      `INSERT INTO mapping_configs (
          mapping_type,
          mapping_key,
          mapping_config,
          mapping_version,
          notes
       ) VALUES ($1, $2, $3::jsonb, 1, $4)
       ON CONFLICT (mapping_type, mapping_key)
       DO UPDATE SET
          mapping_config = EXCLUDED.mapping_config,
          notes = EXCLUDED.notes,
          updated_at = now()
       RETURNING id`,
      [
        options.mappingType,
        options.mappingKey,
        options.mappingConfig,
        options.mappingNotes
      ]
    );
    const mappingConfigId = mappingRes.rows[0].id;

    const upsertSource = await client.query(
      `INSERT INTO webhook_sources (
          organization_id,
          source_identifier,
          name,
          provider_type,
          auth_token,
          mapping_config_id,
          sender_id,
          rate_limit_per_hour,
          enabled
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, source_identifier)
       DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          auth_token = EXCLUDED.auth_token,
          mapping_config_id = EXCLUDED.mapping_config_id,
          sender_id = EXCLUDED.sender_id,
          rate_limit_per_hour = EXCLUDED.rate_limit_per_hour,
          enabled = EXCLUDED.enabled,
          updated_at = now()
       RETURNING id`,
       [
        clientRow.organization_id,
        options.sourceIdentifier,
        options.sourceName,
        options.providerType,
        options.authToken,
        mappingConfigId,
        senderId,
        options.rateLimitPerHour,
        options.enabled
      ]
    );

    if (options.enabled) {
      await preflightEnabledSource(client, upsertSource.rows[0].id);
    }

    await client.query('COMMIT');

    console.log('[provision-webhook-source] Success');
    console.log(JSON.stringify({
      client_id: clientRow.id,
      organization_id: clientRow.organization_id,
      sender_id: senderId,
      mapping_config_id: mappingConfigId,
      webhook_source_id: upsertSource.rows[0].id
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[provision-webhook-source] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[provision-webhook-source] Unhandled error: ${error.message}`);
  process.exit(1);
});
