#!/usr/bin/env node
/*
  Provision a recipient + shipment so Dialog360 auto-replies (status/eta) can find data by sender phone number.

  Usage:
    ENV_FILE=path/to/cloud-config node scripts/qa/provision-reply-shipment.js --phone +9665XXXXXXX [--status in_transit] [--eta 2025-12-31]

  Defaults:
    - Resolves organization/client from webhook source `dialog360_reply` (override with --org-id/--org-slug/--client-id/--client-slug).
    - Generates a unique tracking number when --tracking is not provided.
*/
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

function getArg(name, def = '') {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx >= 0) return argv[idx + 1] || def;
  const pref = `${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length) || def;
  return def;
}

function requireArg(name) {
  const v = getArg(name, '');
  if (!v) {
    console.error(`[provision-reply-shipment] Missing required arg: ${name}`);
    process.exit(2);
  }
  return v;
}

function normalisePhone(input) {
  return String(input || '').trim().replace(/\D/g, '');
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[provision-reply-shipment] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function resolveOrganizationId(client) {
  const orgId = getArg('--org-id', '').trim();
  if (orgId) return orgId;

  const orgSlug = getArg('--org-slug', '').trim();
  if (orgSlug) {
    const { rows } = await client.query(
      'SELECT id FROM organizations WHERE slug = $1 LIMIT 1',
      [orgSlug]
    );
    if (!rows[0]?.id) throw new Error(`Organization not found for slug=${orgSlug}`);
    return rows[0].id;
  }

  const webhookSource = getArg('--webhook-source', 'dialog360_reply').trim();
  if (webhookSource) {
    const { rows } = await client.query(
      `SELECT organization_id
       FROM webhook_sources
       WHERE source_identifier = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [webhookSource]
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
  }

  const fallback = await client.query('SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1');
  if (!fallback.rows[0]?.id) throw new Error('No organizations found');
  return fallback.rows[0].id;
}

async function resolveClientId(client, organizationId) {
  const clientId = getArg('--client-id', '').trim();
  if (clientId) return clientId;

  const clientSlug = getArg('--client-slug', '').trim();
  if (clientSlug) {
    const { rows } = await client.query(
      'SELECT id FROM clients WHERE organization_id = $1 AND slug = $2 LIMIT 1',
      [organizationId, clientSlug]
    );
    if (!rows[0]?.id) throw new Error(`Client not found for slug=${clientSlug}`);
    return rows[0].id;
  }

  const { rows } = await client.query(
    'SELECT id FROM clients WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1',
    [organizationId]
  );
  if (!rows[0]?.id) throw new Error('No clients found for resolved organization');
  return rows[0].id;
}

async function resolveSenderId(client, organizationId, clientId) {
  const senderId = getArg('--sender-id', '').trim();
  if (senderId) return senderId;

  const senderSlug = getArg('--sender-slug', '').trim();
  if (senderSlug) {
    const { rows } = await client.query(
      'SELECT id FROM senders WHERE organization_id = $1 AND client_id = $2 AND slug = $3 LIMIT 1',
      [organizationId, clientId, senderSlug]
    );
    if (!rows[0]?.id) throw new Error(`Sender not found for slug=${senderSlug}`);
    return rows[0].id;
  }

  const webhookSource = getArg('--webhook-source', 'dialog360_reply').trim();
  if (webhookSource) {
    const { rows } = await client.query(
      `SELECT sender_id
       FROM webhook_sources
       WHERE organization_id = $1::uuid
         AND source_identifier = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId, webhookSource]
    );
    if (rows[0]?.sender_id) return rows[0].sender_id;
  }

  const { rows } = await client.query(
    'SELECT id FROM senders WHERE organization_id = $1 AND client_id = $2 ORDER BY created_at ASC LIMIT 1',
    [organizationId, clientId]
  );
  return rows[0]?.id || null;
}

async function upsertRecipient(client, organizationId, clientId, phoneNumber) {
  const existing = await client.query(
    `SELECT id
     FROM recipients
     WHERE organization_id = $1
       AND phone_number = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [organizationId, phoneNumber]
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const name = getArg('--recipient-name', `qa-recipient-${phoneNumber}`).trim();
  const inserted = await client.query(
    `INSERT INTO recipients (organization_id, client_id, name, phone_number, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     RETURNING id`,
    [organizationId, clientId, name, phoneNumber]
  );
  if (!inserted.rows[0]?.id) throw new Error('Failed to insert recipient');
  return inserted.rows[0].id;
}

function toIsoDate(dateLike) {
  const raw = String(dateLike || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function insertShipment(client, organizationId, clientId, recipientId, senderId) {
  const status = getArg('--status', 'in_transit').trim() || 'in_transit';
  const tracking = getArg('--tracking', '').trim() || `QA-${Date.now()}`;

  const etaIso = toIsoDate(getArg('--eta', ''));
  const promisedDeliveryDate = etaIso || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const serviceType = getArg('--service-type', 'delivery').trim() || 'delivery';
  const boxCount = parseInt(getArg('--box-count', '1'), 10) || 1;

  const { rows } = await client.query(
    `INSERT INTO shipments (
      organization_id,
      client_id,
      sender_id,
      recipient_id,
      service_type,
      tracking_number,
      box_count,
      status,
      status_updated_at,
      promised_delivery_date,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9::date, now(), now())
    RETURNING id, tracking_number, status, promised_delivery_date`,
    [organizationId, clientId, senderId || null, recipientId, serviceType, tracking, boxCount, status, promisedDeliveryDate]
  );
  if (!rows[0]?.id) throw new Error('Failed to insert shipment');
  return rows[0];
}

(async () => {
  const phone = normalisePhone(requireArg('--phone'));
  const client = await pool.connect();
  try {
    const organizationId = await resolveOrganizationId(client);
    const clientId = await resolveClientId(client, organizationId);
    const senderId = await resolveSenderId(client, organizationId, clientId);
    const recipientId = await upsertRecipient(client, organizationId, clientId, phone);
    const shipment = await insertShipment(client, organizationId, clientId, recipientId, senderId);
    console.log(
      JSON.stringify(
        {
          organization_id: organizationId,
          client_id: clientId,
          sender_id: senderId,
          recipient_id: recipientId,
          phone_number: phone,
          shipment,
        },
        null,
        2
      )
    );
    process.exit(0);
  } catch (err) {
    console.error('[provision-reply-shipment] error', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
