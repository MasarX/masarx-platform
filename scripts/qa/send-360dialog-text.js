#!/usr/bin/env node
/*
  Sends a WhatsApp text message via 360dialog using sandbox live mode.
  Builds a simple message from the latest shipment in the database.

  Usage:
    ENV_FILE=config/env/.env.cloud node scripts/qa/send-360dialog-text.js <E164_PHONE>

  Notes:
  - Free-form text requires an active 24-hour session in WhatsApp; otherwise 360dialog will reject.
  - For guaranteed delivery outside the session, use a pre-approved template instead.
*/
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const toNumber = process.argv[2] || process.env.TEST_WHATSAPP_TO || null;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[send-360dialog-text] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function fetchLatestShipment() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT s.id, s.tracking_number, s.status, COALESCE(c.name, 'Sender') AS sender_name
         FROM shipments s
         LEFT JOIN clients c ON c.id = s.client_id
        ORDER BY s.created_at DESC
        LIMIT 1`
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

(async () => {
  try {
    const latest = await fetchLatestShipment();
    const tracking = latest?.tracking_number || 'TRACK-NA';
    const sender = latest?.sender_name || 'Sender';
    const status = latest?.status || 'created';
    const body = `MasarX: Shipment ${tracking} from ${sender}. Status ${status}. Thank you.`;

    const { dialog360 } = require('../clients');
    const cfg = await dialog360.getConfig();
    if (!cfg || !cfg.apiKey) {
      throw new Error('[send-360dialog-text] 360dialog API key missing in provider_auth_configs');
    }

    const res = await dialog360.sendTextMessage({ to: toNumber || undefined, body });
    // Print the response for evidence
    console.log('[send-360dialog-text] response', JSON.stringify(res));
    process.exit(0);
  } catch (err) {
    console.error('[send-360dialog-text] error', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
