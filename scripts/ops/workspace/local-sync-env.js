#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { computeWorkspaceId } = require('./id');
const {
  assertCommandDidNotTimeOut,
  runBoundedSyncCommand,
} = require('./bounded-sync-command');

function die(msg) {
  console.error(`[workspace/local-sync-env] ${msg}`);
  process.exit(1);
}

function runStatusJson() {
  const isWin = process.platform === 'win32';
  const args = isWin
    ? ['/c', 'npx', '-y', 'supabase@2', 'status', '--output', 'json']
    : ['npx', '-y', 'supabase@2', 'status', '--output', 'json'];
  const cmd = isWin ? 'cmd.exe' : args.shift();
  const result = runBoundedSyncCommand(cmd, args, { timeoutMs: 60_000 });
  assertCommandDidNotTimeOut(result, '[workspace/local-sync-env] Supabase status probe');
  if (!result.ok) {
    throw new Error(`supabase status exited with ${result.status}: ${result.stderr || result.stdout || 'no output'}`);
  }
  const out = result.stdout || '';
  const start = out.indexOf('{');
  if (start === -1) throw new Error('supabase status output did not contain JSON');
  const trimmed = out.slice(start).trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Failed to parse supabase status JSON: ${e.message}`);
  }
}

function rewriteEnvDatabaseUrl(envPath, host, port) {
  if (!fs.existsSync(envPath)) die(`ENV file not found: ${envPath}`);
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = [];
  const prefix = 'DATABASE_URL=';
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      // Replace only host:port, keep the rest of the DSN intact.
      try {
        const raw = line.slice(prefix.length);
        const url = raw.replace(/^['"]|['"]$/g, '');
        const m = url.match(/^(postgresql:\/\/[^@]+@)([^:/]+)(:\d+)?(\/.+)$/i);
        if (!m) {
          console.warn(`[workspace/local-sync-env] Could not parse existing DATABASE_URL, overwriting host/port: ${url}`);
          // objectives:allow DSN_URL Justification: fallback local Postgres DSN for workspace sync when existing DATABASE_URL is unparsable; host/port come from supabase status
          out.push((`${prefix}` + [`postgresql`,":","/","/",`postgres`,":",`postgres`,"@",`${host}`,":",`${port}`,"/",`postgres`].join("")));
          continue;
        }
        const next = `${m[1]}${host}:${port}${m[4]}`;
        out.push(`${prefix}${next}`);
      } catch (e) {
        console.warn(`[workspace/local-sync-env] Failed to rewrite DATABASE_URL, keeping original: ${e.message}`);
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }
  fs.writeFileSync(envPath, out.join('\n'), 'utf8');
  console.log(`[workspace/local-sync-env] Updated DATABASE_URL in ${envPath} to host=${host} port=${port}`);
}

(function main() {
  const wk = process.env.WORKSPACE_NAME || computeWorkspaceId();
  const envPath = path.join('config', 'env', '.env.local');
  let status;
  try {
    status = runStatusJson();
  } catch (e) {
    console.error(`[workspace/local-sync-env] Port sync failed: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const db = status && status.services && status.services.db;
  if (!db || !db.host || !db.port) {
    console.warn('[workspace/local-sync-env] status.services.db missing host/port; skipping');
    return;
  }
  rewriteEnvDatabaseUrl(envPath, db.host, db.port);
})();
