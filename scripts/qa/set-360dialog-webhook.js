#!/usr/bin/env node
/*
  Registers the 360dialog inbound webhook to our edge function.

  Usage:
    ENV_FILE=config/env/.env.cloud node scripts/qa/set-360dialog-webhook.js [WEBHOOK_URL]
*/
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error('[set-360dialog-webhook] SUPABASE_URL is required');
  process.exit(2);
}

const buildDefaultTargetUrl = () => {
  const token = (process.env.DIALOG360_REPLY_WEBHOOK_TOKEN || '').trim();
  if (!token) return '';
  const base = String(SUPABASE_URL).replace(/\/+$/, '');
  return `${base}/functions/v1/webhook-receiver?token=${encodeURIComponent(token)}`;
};

const argv = process.argv.slice(2);

function getArg(name, fallback = '') {
  const needle = `--${name}`;
  const idx = argv.indexOf(needle);
  if (idx >= 0) return argv[idx + 1] || fallback;
  const pref = `${needle}=`;
  const hit = argv.find((a) => String(a || '').startsWith(pref));
  if (hit) return String(hit).slice(pref.length) || fallback;
  return fallback;
}

const urlArg = argv.find((arg) => arg && !String(arg).startsWith('--')) || '';
const TARGET_URL = urlArg || process.env.DIALOG360_WEBHOOK_URL || buildDefaultTargetUrl();
if (!TARGET_URL) {
  console.error('[set-360dialog-webhook] WEBHOOK_URL is required (arg or DIALOG360_WEBHOOK_URL).');
  if (!process.env.DIALOG360_REPLY_WEBHOOK_TOKEN) {
    console.error('[set-360dialog-webhook] Missing DIALOG360_REPLY_WEBHOOK_TOKEN (needed to auto-build callback URL).');
  }
  console.error(
    `[set-360dialog-webhook] Example: ${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/webhook-receiver?token=<your-token>`
  );
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[set-360dialog-webhook] DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function resolveOrganizationId(client) {
  const orgId = (getArg('org-id') || process.env.DIALOG360_ORG_ID || '').trim();
  if (orgId) return orgId;

  const orgSlug = (getArg('org-slug') || process.env.DIALOG360_ORG_SLUG || '').trim();
  if (orgSlug) {
    const { rows } = await client.query(
      'SELECT id FROM organizations WHERE slug = $1 LIMIT 1',
      [orgSlug]
    );
    if (!rows[0]?.id) {
      throw new Error(`Organization not found for slug=${orgSlug}`);
    }
    return rows[0].id;
  }

  const { rows } = await client.query(
    `SELECT organization_id
     FROM webhook_sources
     WHERE source_identifier = 'dialog360_reply'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!rows[0]?.organization_id) {
    throw new Error('Unable to resolve organization_id (use --org-id or --org-slug).');
  }
  return rows[0].organization_id;
}

async function getDialog360Config(client, organizationId) {
  const { rows } = await client.query(
    `SELECT pac.credentials, p.metadata
     FROM providers p
     JOIN provider_auth_configs pac ON pac.provider_id = p.id
     WHERE p.organization_id = $1::uuid
       AND p.name = 'dialog360_whatsapp'
     ORDER BY pac.created_at DESC
     LIMIT 1`,
    [organizationId]
  );

  const creds = rows[0]?.credentials || {};
  const apiKey = creds.api_key || creds.API_KEY || null;
  if (!apiKey) throw new Error('360dialog API key not found in provider_auth_configs');
  const metadata = rows[0]?.metadata || {};
  const baseUrl = metadata.base_url || metadata.baseUrl || null;
  if (!baseUrl) throw new Error('360dialog provider base_url missing in providers.metadata');
  return { apiKey, baseUrl };
}

function extractTokenFromUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return (url.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

async function syncDialog360ReplyWebhookToken(client, organizationId, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;

  const { rows } = await client.query(
    `UPDATE webhook_sources
        SET auth_token = $1::text,
            enabled = TRUE,
            updated_at = now()
      WHERE organization_id = $2::uuid
        AND source_identifier = 'dialog360_reply'
      RETURNING id, organization_id, enabled`,
    [token, organizationId]
  );
  if (!rows[0]?.id) {
    throw new Error('webhook_sources row not found for organization_id + source_identifier=dialog360_reply');
  }
  return rows[0];
}

function redactTokenInUrl(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '<redacted>');
    }
    return url.toString();
  } catch (_) {
    return value.replace(/([?&]token=)[^&\s"]+/gi, '$1<redacted>');
  }
}

function redactPossibleSecrets(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactTokenInUrl(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactPossibleSecrets);
  const out = { ...value };
  if (typeof out.url === 'string') out.url = redactTokenInUrl(out.url);
  return out;
}

(async () => {
  const client = await pool.connect();
  try {
    const organizationId = await resolveOrganizationId(client);
    const token = (process.env.DIALOG360_REPLY_WEBHOOK_TOKEN || '').trim() || extractTokenFromUrl(TARGET_URL);
    if (token) {
      await syncDialog360ReplyWebhookToken(client, organizationId, token);
    }

    const { apiKey, baseUrl } = await getDialog360Config(client, organizationId);
    const cfgUrl = `${String(baseUrl).replace(/\/+$/, '')}/v1/configs/webhook`;
    const res = await fetch(cfgUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'D360-API-KEY': apiKey,
      },
      body: JSON.stringify({ url: TARGET_URL })
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const safeText = typeof json === 'string' ? redactTokenInUrl(json) : JSON.stringify(redactPossibleSecrets(json));
      throw new Error(`[set-360dialog-webhook] ${res.status} ${res.statusText} ${safeText}`);
    }
    console.log('[set-360dialog-webhook] ok', JSON.stringify(redactPossibleSecrets(json)));
    process.exit(0);
  } catch (err) {
    console.error('[set-360dialog-webhook] error', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
