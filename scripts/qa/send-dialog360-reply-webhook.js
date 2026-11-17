#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const { loadEnv } = require('../utils/load-env');

loadEnv();

function getArg(flag, def) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return def;
  const value = process.argv[idx + 1];
  return value ?? def;
}

function die(message) {
  console.error(`[send-dialog360-reply-webhook] ${message}`);
  process.exit(1);
}

async function main() {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  if (!supabaseUrl) die('SUPABASE_URL is required');

  const token = (process.env.DIALOG360_REPLY_WEBHOOK_TOKEN || '').trim();
  if (!token) die('DIALOG360_REPLY_WEBHOOK_TOKEN is required');

  const from = (getArg('--from', process.env.TEST_WHATSAPP_FROM) || '').trim();
  if (!from) die('Provide --from <wa_id> or set TEST_WHATSAPP_FROM');

  const text = (getArg('--text', 'status') || '').trim();
  if (!text) die('Provide --text "<message>"');

  const messageId = (getArg('--message-id', '') || '').trim() || `wamid.TESTMSG.${Date.now()}`;
  const correlationId = (getArg('--correlation-id', '') || '').trim() || crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);

  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: from }],
              messages: [
                {
                  id: messageId,
                  from,
                  type: 'text',
                  timestamp: String(ts),
                  context: { id: correlationId },
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const url = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/webhook-receiver?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let body = bodyText;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // keep raw text
  }

  console.log('[send-dialog360-reply-webhook] status', res.status);
  console.log('[send-dialog360-reply-webhook] body', typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

main().catch((err) => die(err?.message || String(err)));
