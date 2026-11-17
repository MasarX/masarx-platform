#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

// Keys to preserve when scrubbing project-specific data from .env.cloud
const keepPrefix = new Set([
  'SUPABASE_ORG_ID',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_REGION',
  'SUPABASE_DB_PASSWORD',
  'GITHUB_TOKEN',
  'RUN_LIVE_COMMS_TESTS',
  'RUN_LIVE_3PL_TESTS',
  'RUN_LOCAL_EDGE_TESTS',
  'RUN_EDGE_E2E',
  'RUN_LIVE_WEBHOOK_TESTS',
  'RUN_LIVE_GEOCODING_TESTS',
  'RUN_RLS_INTEGRATION_TESTS',
  'RUN_LABELS_WEBHOOK_TESTS',
]);

// Keys to drop when sanitizing a copied .env.cloud
const dropPrefix = new Set([
  'SUPABASE_PROJECT_ID',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'SUPABASE_POOLER_HOST',
  'SUPABASE_POOLER_PORT',
  'WEBHOOK_DB_JWT',
  'API_CALLER_DB_JWT',
  'API_GATEWAY_DB_JWT',
  'LABEL_RENDERER_DB_JWT',
  'EDGE_TASK_TOKEN',
  'EDGE_INTERNAL_CALLER_ROLES',
  'EDGE_REQUIRE_DB_JWT',
]);

function sanitizeEnvCloud(envPath) {
  const abs = path.resolve(envPath);
  if (!fs.existsSync(abs)) return false;

  const original = fs.readFileSync(abs, 'utf8');
  const lines = original.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const [key] = trimmed.split('=', 1);
    if (dropPrefix.has(key)) continue;
    out.push(line);
  }

  // Avoid rewriting if nothing changed
  const candidate = out.join('\n');
  const finalText = candidate.endsWith('\n') ? candidate : candidate + '\n';
  if (finalText === (original.endsWith('\n') ? original : `${original}\n`)) {
    return false;
  }

  fs.writeFileSync(abs, finalText, 'utf8');
  return true;
}

module.exports = {
  sanitizeEnvCloud,
  keepPrefix,
  dropPrefix,
};
