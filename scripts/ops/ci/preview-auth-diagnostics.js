#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');

function normalizeString(value) {
  return String(value || '').trim();
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
}

function detectKeyKind(value) {
  const raw = normalizeString(value);
  if (!raw) return 'missing';
  if (raw.split('.').length === 3) return 'jwt';
  if (raw.startsWith('sb_')) return 'secret';
  return 'opaque';
}

function resolveEnvSource(candidates = [], env = process.env) {
  for (const candidate of candidates) {
    const value = normalizeString(env?.[candidate.name]);
    if (value) {
      return {
        source: candidate.source,
        value,
      };
    }
  }
  return {
    source: 'missing',
    value: '',
  };
}

function buildPreviewAuthDiagnostics(env = process.env) {
  const serviceKey = resolveEnvSource([
    { name: 'PREVIEW_SUPABASE_SERVICE_ROLE_KEY', source: 'preview_service_role_secret' },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', source: 'shared_service_role_env' },
    { name: 'SUPABASE_SECRET_KEY', source: 'shared_secret_key_env' },
  ], env);
  const anonKey = resolveEnvSource([
    { name: 'PREVIEW_SUPABASE_ANON_KEY', source: 'preview_anon_secret' },
    { name: 'SUPABASE_ANON_KEY', source: 'shared_anon_env' },
    { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', source: 'next_public_anon_env' },
  ], env);
  const jwtSecret = resolveEnvSource([
    { name: 'PREVIEW_SUPABASE_JWT_SECRET', source: 'preview_jwt_secret' },
    { name: 'SUPABASE_JWT_SECRET', source: 'shared_jwt_secret' },
  ], env);

  return {
    generated_at: new Date().toISOString(),
    env_file: normalizeString(env.ENV_FILE),
    manifest_path: normalizeString(env.PREVIEW_MANIFEST_PATH),
    project_ref: firstNonEmpty([
      env.PREVIEW_PROJECT_REF,
      env.SUPABASE_PROJECT_ID,
      env.SUPABASE_PROJECT_REF,
    ]),
    supabase_url: firstNonEmpty([
      env.PREVIEW_SUPABASE_URL,
      env.SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_URL,
    ]),
    readiness_failure_class: normalizeString(
      env.PREVIEW_RUNTIME_READY_FAILURE_CLASS || env.PREVIEW_READINESS_FAILURE_CLASS,
    ),
    runtime_ready: normalizeString(env.PREVIEW_RUNTIME_READY || ''),
    service_key_source: serviceKey.source,
    service_key_kind: detectKeyKind(serviceKey.value),
    service_key_present: serviceKey.value ? '1' : '0',
    anon_key_source: anonKey.source,
    anon_key_present: anonKey.value ? '1' : '0',
    jwt_secret_source: jwtSecret.source,
    jwt_secret_present: jwtSecret.value ? '1' : '0',
  };
}

function writeJson(outPath, payload) {
  const resolved = path.resolve(process.cwd(), normalizeString(outPath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function main(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const payload = buildPreviewAuthDiagnostics(process.env);
  const outPath = normalizeString(args.out);
  if (outPath) {
    const written = writeJson(outPath, payload);
    console.log(written);
    return payload;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPreviewAuthDiagnostics,
  detectKeyKind,
  firstNonEmpty,
  normalizeString,
  resolveEnvSource,
  writeJson,
};
