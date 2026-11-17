#!/usr/bin/env node

/**
 * Provision or update client-scoped webhook policy and WhatsApp notification flow.
 * Replaces the archived migration 202510150201_seed_client2_whatsapp.sql with a
 * parameterised, environment-safe script.
 */

const { Pool } = require('pg');
const fs = require('fs');
const { loadEnv } = require('../utils/load-env');
const { upsertSettings } = require('../utils/settings-upsert');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[provision-client] DATABASE_URL is required. Set ENV_FILE or export DATABASE_URL.');
  process.exit(1);
}

function parseArgs(argv) {
  const defaults = {
    clientSlug: undefined,
    providerName: undefined,
    recipientPhone: undefined,
    recipientName: 'Automation QA Recipient',
    recipientLanguage: 'en',
    recipientChannel: 'whatsapp',
    mappingType: 'webhook_outbound',
    mappingKey: undefined,
    mappingConfig: '{}',
    mappingConfigFile: undefined,
    mappingNotes: 'Automated client provisioning payload',
    operationName: 'send_whatsapp_text',
    operationMethod: 'POST',
    urlTemplate: undefined,
    apiKeyHeader: 'D360-API-KEY',
    messageBody: 'Shipment update received',
    timeoutSeconds: 30,
    policyCategory: 'webhook_ingest_policy',
    idempotencyBodyPath: 'event.id',
    ackMode: 'synchronous_success',
    ackStatusCode: 200,
    changeReason: undefined,
    workflowTemplateId: undefined
  };

  const options = { ...defaults };
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    switch (key) {
      case 'client-slug':
        options.clientSlug = next;
        i += 1;
        break;
      case 'provider-name':
        options.providerName = next;
        i += 1;
        break;
      case 'recipient-phone':
        options.recipientPhone = next;
        i += 1;
        break;
      case 'recipient-name':
        options.recipientName = next;
        i += 1;
        break;
      case 'recipient-language':
        options.recipientLanguage = next;
        i += 1;
        break;
      case 'recipient-channel':
        options.recipientChannel = next;
        i += 1;
        break;
      case 'mapping-type':
        options.mappingType = next;
        i += 1;
        break;
      case 'mapping-key':
        options.mappingKey = next;
        i += 1;
        break;
      case 'mapping-config':
        options.mappingConfig = next;
        i += 1;
        break;
      case 'mapping-config-file':
        options.mappingConfigFile = next;
        i += 1;
        break;
      case 'mapping-notes':
        options.mappingNotes = next;
        i += 1;
        break;
      case 'operation-name':
        options.operationName = next;
        i += 1;
        break;
      case 'operation-method':
        options.operationMethod = next;
        i += 1;
        break;
      case 'url-template':
        options.urlTemplate = next;
        i += 1;
        break;
      case 'api-key-header':
        options.apiKeyHeader = next;
        i += 1;
        break;
      case 'message-body':
        options.messageBody = next;
        i += 1;
        break;
      case 'timeout-seconds':
        options.timeoutSeconds = Number(next);
        i += 1;
        break;
      case 'policy-category':
        options.policyCategory = next;
        i += 1;
        break;
      case 'idempotency-body-path':
        options.idempotencyBodyPath = next;
        i += 1;
        break;
      case 'ack-mode':
        options.ackMode = next;
        i += 1;
        break;
      case 'ack-status-code':
        options.ackStatusCode = Number(next);
        i += 1;
        break;
      case 'schema-version':
        options.schemaVersion = Number(next);
        i += 1;
        break;
      case 'change-reason':
        options.changeReason = next;
        i += 1;
        break;
      case 'workflow-template-id':
        options.workflowTemplateId = next;
        i += 1;
        break;
      default:
        console.warn(`[provision-client] Unrecognised flag --${key}`);
    }
  }

  if (!options.clientSlug) {
    throw new Error('Missing required flag: --client-slug');
  }
  if (!options.providerName) {
    throw new Error('Missing required flag: --provider-name');
  }
  if (!options.recipientPhone) {
    throw new Error('Missing required flag: --recipient-phone');
  }
  if (!options.mappingKey) {
    options.mappingKey = `${options.providerName}::${options.recipientChannel}::${options.clientSlug}`;
  }
  if (!options.changeReason) {
    options.changeReason = `Provision ${options.clientSlug} webhook ingest policy (${options.providerName})`;
  }

  if (options.schemaVersion != null && Number.isFinite(options.schemaVersion)) {
    console.warn(
      '[provision-client] --schema-version is deprecated and ignored; schema version is resolved from schema_registry (active contract).',
    );
  }

  try {
    JSON.parse(options.mappingConfig);
  } catch (error) {
    throw new Error(`Invalid JSON provided for --mapping-config: ${error.message}`);
  }

  if (options.mappingConfigFile) {
    try {
      const content = fs.readFileSync(options.mappingConfigFile, 'utf8');
      options.mappingConfig = content;
    } catch (err) {
      throw new Error(`Failed to read --mapping-config-file: ${err.message}`);
    }
  }

  return options;
}

function normalisePhone(phone) {
  return phone.replace(/[\s-]+/g, '').replace(/^\+/, '');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[provision-client] ${error.message}`);
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

    const providerRes = await client.query(
      'SELECT id, metadata FROM providers WHERE organization_id = $1 AND name = $2 LIMIT 1',
      [clientRow.organization_id, options.providerName]
    );
    if (providerRes.rowCount === 0) {
      throw new Error(`Provider ${options.providerName} not found`);
    }
    const providerId = providerRes.rows[0].id;
    const providerMetadata = providerRes.rows[0].metadata || {};

    if (!options.urlTemplate) {
      const baseUrl = providerMetadata.base_url || providerMetadata.baseUrl || null;
      if (!baseUrl) {
        throw new Error(`[provision-client] Provider ${options.providerName} missing metadata.base_url; pass --url-template explicitly.`);
      }
      options.urlTemplate = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;
    }

    const providerAuthRes = await client.query(
      `SELECT credentials FROM provider_auth_configs
       WHERE provider_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [providerId]
    );
    const providerCredentials = providerAuthRes.rows[0]?.credentials || {};
    const providerApiKey = providerCredentials.api_key;

    const recipientPhone = normalisePhone(options.recipientPhone);
    const communicationPreferences = {
      [options.recipientChannel]: { enabled: true }
    };

    const recipientExisting = await client.query(
      'SELECT id FROM recipients WHERE client_id = $1 AND phone_number = $2 LIMIT 1',
      [clientRow.id, recipientPhone]
    );

    let recipientId;
    if (recipientExisting.rowCount > 0) {
      const updateRes = await client.query(
        `UPDATE recipients
         SET name = $1,
             preferred_language = $2,
             preferred_comm_channel = $3,
             communication_preferences = $4::jsonb,
             updated_at = now()
         WHERE id = $5
         RETURNING id`,
        [
          options.recipientName,
          options.recipientLanguage,
          options.recipientChannel,
          JSON.stringify(communicationPreferences),
          recipientExisting.rows[0].id
        ]
      );
      recipientId = updateRes.rows[0].id;
    } else {
      const insertRes = await client.query(
        `INSERT INTO recipients (
            organization_id,
            client_id,
            name,
            phone_number,
            preferred_language,
            preferred_comm_channel,
            communication_preferences
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          clientRow.organization_id,
          clientRow.id,
          options.recipientName,
          recipientPhone,
          options.recipientLanguage,
          options.recipientChannel,
          JSON.stringify(communicationPreferences)
        ]
      );
      recipientId = insertRes.rows[0].id;
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
          mapping_version = mapping_configs.mapping_version + 1,
          updated_at = now(),
          notes = EXCLUDED.notes
       RETURNING id`,
      [
        options.mappingType,
        options.mappingKey,
        options.mappingConfig,
        options.mappingNotes
      ]
    );
    const mappingConfigId = mappingRes.rows[0].id;

    const headersTemplate = {
      'content-type': 'application/json'
    };
    if (providerApiKey) {
      headersTemplate[options.apiKeyHeader] = providerApiKey;
    }

    const bodyTemplate = {
      messaging_product: options.recipientChannel,
      to: recipientPhone,
      type: 'text',
      text: { body: options.messageBody }
    };

    // Determine call_type from recipientChannel; default to provider_api
    const callType =
      options.recipientChannel === 'whatsapp' ? 'comms_whatsapp' :
      options.recipientChannel === 'sms' ? 'comms_sms' :
      options.recipientChannel === 'email' ? 'comms_email' :
      options.recipientChannel === 'voice' ? 'comms_voice' :
      'provider_api';

    const operationRes = await client.query(
      `INSERT INTO operation_templates (
          provider_id,
          operation_name,
          method,
          url_template,
          headers_template,
          body_template,
          request_mappings,
          mapping_config_id,
          timeout_seconds,
          handler_key,
          handler_version,
          call_type
       ) VALUES (
          $1, $2, $3, $4,
          $5::jsonb, $6::jsonb, $7::jsonb,
          $8, $9,
          'outbound_http', 'v1', $10
       )
       ON CONFLICT (provider_id, operation_name)
       DO UPDATE SET
          url_template = EXCLUDED.url_template,
          headers_template = EXCLUDED.headers_template,
          body_template = EXCLUDED.body_template,
          mapping_config_id = EXCLUDED.mapping_config_id,
          handler_key = EXCLUDED.handler_key,
          handler_version = EXCLUDED.handler_version,
          call_type = EXCLUDED.call_type,
          updated_at = now()
       RETURNING id`,
      [
        providerId,
        options.operationName,
        options.operationMethod,
        options.urlTemplate,
        JSON.stringify(headersTemplate),
        JSON.stringify(bodyTemplate),
        null,
        mappingConfigId,
        options.timeoutSeconds,
        callType
      ]
    );
    const operationTemplateId = operationRes.rows[0].id;

    const intakeTemplateRes = await client.query(
      `SELECT id
       FROM workflow_templates
       WHERE name = 'webhook_intake_v1'
         AND status = 'active'
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`
    );

    if (intakeTemplateRes.rowCount === 0 && options.workflowTemplateId) {
      throw new Error('webhook_intake_v1 workflow template must exist before provisioning follow-up policies.');
    }

    const workflowContextPatch = options.workflowTemplateId
      ? {
          operation_template_id: operationTemplateId,
          recipient_channel: options.recipientChannel,
          recipient_phone: options.recipientPhone,
          followup_template_id: options.workflowTemplateId
        }
      : {
          operation_template_id: operationTemplateId,
          recipient_channel: options.recipientChannel,
          recipient_phone: options.recipientPhone
        };

    const workflowConfig =
      options.workflowTemplateId && intakeTemplateRes.rowCount > 0
        ? {
            template_id: intakeTemplateRes.rows[0].id,
            launch_mode: 'in_background',
            context_patch: workflowContextPatch
          }
        : null;

    const policyValue = {
      version: 1,
      wait_for_ack: false,
      validation: {
        idempotency: {
          body_path: options.idempotencyBodyPath
        }
      },
      ack: {
        mode: options.ackMode,
        status_code: options.ackStatusCode,
        default_headers: {
          'content-type': 'application/json'
        }
      },
      workflow: workflowConfig,
      logging: {
        decision_point: 'webhook_ack',
        include_payload: true
      }
    };

    const settingsWrite = await upsertSettings({
      db: client,
      category: options.policyCategory,
      scopeType: 'client',
      scopeId: clientRow.id,
      value: policyValue,
      changeReason: options.changeReason,
    });
    const settingsVersionId = settingsWrite.settingsVersionId;

    await client.query('COMMIT');

    console.log('[provision-client] Success');
    console.log(JSON.stringify({
      client_id: clientRow.id,
      organization_id: clientRow.organization_id,
      recipient_id: recipientId,
      mapping_config_id: mappingConfigId,
      operation_template_id: operationTemplateId,
      settings_version_id: settingsVersionId
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[provision-client] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[provision-client] Unhandled error: ${error.message}`);
  process.exit(1);
});
