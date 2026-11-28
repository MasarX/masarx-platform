#!/usr/bin/env node
/**
 * Import provider webhook mappings and attach to a webhook source.
 *
 * Dynamic, row-driven provisioning that:
 *  - Upserts a sender for the client
 *  - Upserts mapping_configs for one or more intents from a JSON file
 *  - Upserts a webhook_sources row (optionally generating an auth token)
 *  - Points the source at a primary mapping (first intent or specified)
 *
 * Usage:
 *   ENV_FILE=path/to/cloud-config \
 *   node scripts/ops/import-provider-webhook-mappings.js \
 *     --client-slug test-client-2-1 \
 *     --source-identifier acme-provider \
 *     --source-name "ACME Provider" \
 *     --provider-type async_3pl \
 *     --mappings-file docs/providers/examples/acme/mappings.json \
 *     [--auth-token EXAMPLE_PASSWORD | --generate-auth-token] \
 *     [--primary-intent shipment.created] \
 *     [--sender-name "ACME Sender"] \
 *     [--rate-limit-per-hour 1000]
 *
 * mappings.json format:
 * {
 *   "intents": [
 *     { "intent": "shipment.created", "mapping_config": { ... } },
 *     { "intent": "shipment.updated", "mapping_config": { ... } }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const { loadEnv } = require('../utils/load-env');

loadEnv();

function argVal(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizePath(raw) {
  if (raw == null) return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('$')) return trimmed;
  if (trimmed.startsWith('/')) {
    const parts = trimmed
      .slice(1)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    return parts.filter(Boolean).join('.');
  }
  return trimmed;
}

function normalizeTransformSpec(spec) {
  if (typeof spec === 'string') return normalizePath(spec);
  if (Array.isArray(spec)) return spec.map((item) => normalizePath(item));
  return spec;
}

function normalizeInboundMappingConfig(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const config = { ...raw };

  if (config.external_id_path) {
    config.external_id_path = normalizePath(config.external_id_path);
  }
  if (config.event_type_path) {
    config.event_type_path = normalizePath(config.event_type_path);
  }
  if (config.transforms && typeof config.transforms === 'object' && !Array.isArray(config.transforms)) {
    const normalizedTransforms = {};
    for (const [target, spec] of Object.entries(config.transforms)) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        normalizedTransforms[target] = spec;
        continue;
      }
      const normalizedTarget = {};
      for (const [field, fieldSpec] of Object.entries(spec)) {
        normalizedTarget[field] = normalizeTransformSpec(fieldSpec);
      }
      normalizedTransforms[target] = normalizedTarget;
    }
    config.transforms = normalizedTransforms;
  }

  if (Array.isArray(config.fields)) {
    const fields = config.fields;
    delete config.fields;

    const findPointer = (alias) => {
      const hit = fields.find((f) => f && f.as === alias && f.pointer);
      return hit ? normalizePath(hit.pointer) : undefined;
    };

    if (!config.external_id_path) {
      config.external_id_path = findPointer('event_id') || 'event.id';
    }
    if (!config.event_type_path) {
      config.event_type_path = findPointer('event_type') || 'event.type';
    }
    if (!config.transforms) {
      const mapped = {};
      for (const field of fields) {
        if (!field || !field.as || !field.pointer) continue;
        mapped[field.as] = normalizePath(field.pointer);
      }
      if (Object.keys(mapped).length > 0) {
        config.transforms = { default: mapped };
      }
    }
  }

  const allowed = new Set(['description', 'external_id_path', 'event_type_path', 'transforms']);
  const unexpected = Object.keys(config).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    console.warn(`[import-provider] Ignoring unsupported mapping_config keys: ${unexpected.join(', ')}`);
    for (const key of unexpected) delete config[key];
  }

  return config;
}

async function main() {
  const clientSlug = argVal('client-slug');
  const sourceIdentifier = argVal('source-identifier');
  const providerType = argVal('provider-type') || 'async_3pl';
  const sourceName = argVal('source-name') || sourceIdentifier;
  const mappingsFile = argVal('mappings-file');
  const examplesFile = argVal('examples');
  const intentPointer = argVal('intent-pointer') || '/event/type';
  const idPointer = argVal('id-pointer') || '/event/id';
  const authToken = argVal('auth-token');
  const generateAuthToken = hasFlag('generate-auth-token');
  const printToken = hasFlag('print-token');
  const senderName = argVal('sender-name') || `${clientSlug} sender`;
  const rateLimitPerHour = Number(argVal('rate-limit-per-hour') || '1000');
  const primaryIntent = argVal('primary-intent');
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) throw new Error('DATABASE_URL is required (use ENV_FILE or export).');
  if (!clientSlug) throw new Error('--client-slug is required');
  if (!sourceIdentifier) throw new Error('--source-identifier is required');
  let intents = [];
  if (mappingsFile) {
    const mappingsPath = path.resolve(mappingsFile);
    if (!fs.existsSync(mappingsPath)) throw new Error(`mappings-file not found: ${mappingsPath}`);
    const mappingsDoc = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    intents = Array.isArray(mappingsDoc?.intents) ? mappingsDoc.intents : [];
    if (intents.length === 0) throw new Error('mappings-file must contain { intents: [ { intent, mapping_config }, ... ] }');
  } else if (examplesFile) {
    const exPath = path.resolve(examplesFile);
    if (!fs.existsSync(exPath)) throw new Error(`examples file not found: ${exPath}`);
    const sample = JSON.parse(fs.readFileSync(exPath, 'utf8'));
    // Minimal JSON pointer resolver
    const jp = (obj, ptr) => {
      try {
        if (!ptr || ptr === '/' || ptr === '') return obj;
        const parts = String(ptr).replace(/^\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
        let cur = obj;
        for (const key of parts) { if (cur == null) return undefined; cur = cur[key]; }
        return cur;
      } catch (_) { return undefined; }
    };
    const inferredIntent = String(jp(sample, intentPointer) || 'shipment.created');
    const normalizedIntentPath = normalizePath(intentPointer) || 'event.type';
    const normalizedIdPath = normalizePath(idPointer) || 'event.id';
    intents = [
      {
        intent: inferredIntent,
        mapping_config: {
          description: 'auto-generated from example',
          external_id_path: normalizedIdPath,
          event_type_path: normalizedIntentPath
        }
      }
    ];
  } else {
    throw new Error('either --mappings-file or --examples is required');
  }

  const token = authToken || (generateAuthToken ? `prov_${crypto.randomBytes(6).toString('hex')}_${Date.now()}` : undefined);

  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // 1) Resolve client + org
    const c = await db.query('SELECT id, organization_id FROM clients WHERE slug=$1 LIMIT 1', [clientSlug]);
    if (c.rowCount === 0) throw new Error(`Client not found: ${clientSlug}`);
    const clientId = c.rows[0].id;
    const orgId = c.rows[0].organization_id;

    // 2) Upsert sender
    const s = await db.query('SELECT id FROM senders WHERE client_id=$1 AND name=$2 LIMIT 1', [clientId, senderName]);
    let senderId;
    if (s.rowCount > 0) {
      senderId = s.rows[0].id;
    } else {
      const ins = await db.query(
        `INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status)
         VALUES ($1,$2,$3,true,true,'active') RETURNING id`,
        [clientId, senderName, senderName]
      );
      senderId = ins.rows[0].id;
    }

    // 3) Resolve a stable webhook_source_id so mapping_configs keys follow the
    // canonical pattern: webhook_source_id::event_type.
    const existingSource = await db.query(
      `
        SELECT id
        FROM webhook_sources
        WHERE organization_id = $1::uuid
          AND source_identifier = $2::text
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [orgId, sourceIdentifier],
    );
    const existingSourceId = existingSource.rows[0]?.id || null;
    const webhookSourceId = existingSourceId || crypto.randomUUID();

    if (!existingSourceId && !token) {
      throw new Error(
        'New webhook_sources rows require a token; pass --auth-token or --generate-auth-token.'
      );
    }

    // 4) Upsert mapping_configs for each intent
    const mappingIds = [];
    for (const entry of intents) {
      const intent = String(entry.intent || '').trim();
      const config = normalizeInboundMappingConfig(entry.mapping_config);       
      if (!intent || !config || typeof config !== 'object') {
        throw new Error(`Invalid intents entry; require { intent, mapping_config } for all items.`);
      }
      const mappingKey = `${webhookSourceId}::${intent}`;
      const up = await db.query(
        `INSERT INTO mapping_configs (mapping_type, mapping_key, mapping_config, mapping_version, notes)
         VALUES ('webhook_inbound', $1, $2::jsonb, 1, 'Imported provider mapping')
         ON CONFLICT (mapping_type, mapping_key)
         DO UPDATE SET mapping_config = EXCLUDED.mapping_config, notes = EXCLUDED.notes, updated_at = now()
         RETURNING id, mapping_key`,
        [mappingKey, JSON.stringify(config)]
      );
      mappingIds.push(up.rows[0]);
    }

    // Determine primary mapping (first or specified intent)
    let primaryMappingId = mappingIds[0].id;
    if (primaryIntent) {
      const found = mappingIds.find((m) => m.mapping_key.endsWith(`::${primaryIntent}`));
      if (found) primaryMappingId = found.id;
    }

    // 5) Upsert webhook source
    const ws = await db.query(
       `INSERT INTO webhook_sources (
         id, organization_id, source_identifier, name, provider_type, auth_token,
         mapping_config_id, sender_id, rate_limit_per_hour, enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (organization_id, source_identifier)
       DO UPDATE SET
         name=EXCLUDED.name,
         provider_type=EXCLUDED.provider_type,
         auth_token=EXCLUDED.auth_token,
         mapping_config_id=EXCLUDED.mapping_config_id,
         sender_id=EXCLUDED.sender_id,
         rate_limit_per_hour=EXCLUDED.rate_limit_per_hour,
         enabled=true,
         updated_at=now()
       RETURNING id`,
      [
        webhookSourceId,
        orgId,
        sourceIdentifier,
        sourceName,
        providerType,
        token || null,
        primaryMappingId,
        senderId,
        rateLimitPerHour,
      ]
    );

    await db.query('COMMIT');

    const result = {
      organization_id: orgId,
      client_id: clientId,
      sender_id: senderId,
      webhook_source_id: ws.rows[0].id,
      mapping_ids: mappingIds.map((m) => m.id),
      primary_mapping_id: primaryMappingId,
      token_generated: Boolean(!authToken && generateAuthToken),
      token_hint: token ? `${token.slice(0,6)}...` : null,
      token: printToken ? token : undefined
    };
    console.log('[import-provider] Success');
    console.log('JSON:' + JSON.stringify(result));
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error(`[import-provider] Failed: ${err.message}`);
    process.exit(1);
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[import-provider] Unhandled error:', e.message);
  process.exit(1);
});

