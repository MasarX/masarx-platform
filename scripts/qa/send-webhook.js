#!/usr/bin/env node

/**
 * Replay a deterministic webhook payload against the local Supabase edge function.
 *
 * Usage:
 *   node scripts/qa/send-webhook.js basic
 *   node scripts/qa/send-webhook.js hmac --signature
 *   node scripts/qa/send-webhook.js async --id evt-async-demo
 *
 * Environment:
 *   SUPABASE_URL
 *   DATABASE_URL only required if you need to inspect results separately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL; if (!SUPABASE_URL) { throw new Error('[send-webhook] SUPABASE_URL is required.'); }

const PROFILE_CONFIG = {
  basic: {
    token: 'EXAMPLE_PASSWORD',
    fixture: 'basic_shipment_created.json',
    headers: () => ({})
  },
  hmac: {
    token: 'EXAMPLE_PASSWORD',
    fixture: 'hmac_shipment_created.json',
    headers: (payload) => {
      const signature = crypto
        .createHmac('sha256', 'EXAMPLE_PASSWORD')
        .update(JSON.stringify(payload))
        .digest('hex');
      return { 'x-signature': signature };
    }
  },
  async: {
    token: 'EXAMPLE_PASSWORD',
    fixture: 'async_shipment_created.json',
    headers: () => ({})
  }
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/qa/send-webhook.js <basic|hmac|async> [--id <override>] [--raw]');
  process.exit(1);
}

const profileKey = args[0];
const profile = PROFILE_CONFIG[profileKey];

if (!profile) {
  console.error(`Unknown profile "${profileKey}". Supported: ${Object.keys(PROFILE_CONFIG).join(', ')}`);
  process.exit(1);
}

let idOverride = null;
let printRawResponse = false;
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--id' || arg === '--idempotency') {
    const value = args[i + 1];
    if (!value) {
      console.error(`Missing value after ${arg}`);
      process.exit(1);
    }
    idOverride = value;
    i += 1;
  } else if (arg === '--raw') {
    printRawResponse = true;
  }
}

const fixturePath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'webhooks', profile.fixture);
const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

if (idOverride) {
  payload.event = payload.event || {};
  payload.event.id = idOverride;
}

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${profile.token}`,
  ...profile.headers(payload)
};

(async () => {
  console.log(`[send-webhook] Dispatching ${profileKey} payload to ${SUPABASE_URL}/functions/v1/webhook-receiver`);
  const response = await fetch(`${SUPABASE_URL}/functions/v1/webhook-receiver`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (_) {
    // keep raw text
  }

  console.log('[send-webhook] Status:', response.status);
  if (printRawResponse) {
    console.log('[send-webhook] Body:', body);
  } else {
    console.log('[send-webhook] Body:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
})();


