#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFlagArgs } = require('../../utils/cli-args');
const { loadEnv } = require('../../utils/load-env');

function die(msg) {
  console.error(`[mobile-preview-build] ${msg}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function resolvePreviewEasProfile({ appCwd, requestedProfile = '' }) {
  const easConfigPath = path.join(appCwd, 'eas.json');
  const easConfig = JSON.parse(fs.readFileSync(easConfigPath, 'utf8').replace(/^\uFEFF/, ''));
  const profile = String(requestedProfile || 'development').trim();
  if (profile !== 'development') {
    throw new Error(`FieldOps preview prewarm permits only the 'development' EAS profile; got '${profile || '<empty>'}'.`);
  }
  if (!profile || !easConfig?.build || !Object.prototype.hasOwnProperty.call(easConfig.build, profile)) {
    throw new Error(`Unknown FieldOps EAS build profile '${profile || '<empty>'}' in ${easConfigPath}.`);
  }
  return profile;
}

function readManifest(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeManifest(filePath, manifest) {
  if (!filePath || !manifest) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function runCommand({ cmd, args, cwd, env, label }) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (out) process.stdout.write(out);
  if (res.error) throw new Error(`${label} failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} failed with exit code ${res.status}`);
}

function setSurfaceState(manifest, payload) {
  if (!manifest) return;
  manifest.surfaces = manifest.surfaces || {};
  manifest.surfaces.mobile_fieldops = {
    ...(manifest.surfaces.mobile_fieldops || {}),
    ...payload,
  };
}

function main() {
  loadEnv();
  const args = parseFlagArgs(process.argv.slice(2));
  const action = String(args.action || 'deploy').trim().toLowerCase();
  if (!['deploy', 'cleanup'].includes(action)) {
    die(`Invalid --action ${action} (expected deploy|cleanup).`);
  }

  const manifestPathArg = String(args.manifest || '').trim();
  const manifestPath = manifestPathArg ? path.resolve(process.cwd(), manifestPathArg) : '';
  const manifest = manifestPath ? readManifest(manifestPath) : null;

  if (action === 'cleanup') {
    setSurfaceState(manifest, {
      status: 'removed',
      cleanup_at: new Date().toISOString(),
      provider: 'expo',
    });
    if (manifest) writeManifest(manifestPath, manifest);
    console.log(JSON.stringify({ ok: true, action, manifest_path: manifestPath || '' }, null, 2));
    return;
  }

  const appCwd = path.resolve(process.cwd(), 'apps/fieldops');
  const profile = resolvePreviewEasProfile({
    appCwd,
    requestedProfile: args.profile || process.env.PREVIEW_MOBILE_EAS_PROFILE,
  });
  const expoToken = String(process.env.EXPO_TOKEN || '').trim();
  if (!expoToken) {
    setSurfaceState(manifest, {
      status: 'skipped',
      reason: 'EXPO_TOKEN_missing',
      provider: 'expo',
    });
    if (manifest) writeManifest(manifestPath, manifest);
    console.log(JSON.stringify({
      ok: true,
      action,
      skipped: true,
      reason: 'EXPO_TOKEN_missing',
      manifest_path: manifestPath || '',
    }, null, 2));
    return;
  }

  const easPkg = `eas-cli@${String(process.env.EAS_CLI_VERSION || '18.0.1').trim()}`;
  const executeBuild = isTruthy(args['execute-build'] || process.env.PREVIEW_MOBILE_EXECUTE || '0');

  runCommand({
    cmd: 'npx',
    args: [easPkg, 'config', '--profile', profile, '--platform', 'android', '--non-interactive'],
    cwd: appCwd,
    env: process.env,
    label: 'eas config android',
  });
  runCommand({
    cmd: 'npx',
    args: [easPkg, 'config', '--profile', profile, '--platform', 'ios', '--non-interactive'],
    cwd: appCwd,
    env: process.env,
    label: 'eas config ios',
  });

  if (executeBuild) {
    runCommand({
      cmd: 'npx',
      args: [easPkg, 'build', '--profile', profile, '--platform', 'all', '--non-interactive'],
      cwd: appCwd,
      env: process.env,
      label: `eas build ${profile}`,
    });
  }

  setSurfaceState(manifest, {
    status: executeBuild ? 'deployed' : 'prewarmed',
    provider: 'expo',
    profile,
    execute_build: executeBuild,
    updated_at: new Date().toISOString(),
  });
  if (manifest) writeManifest(manifestPath, manifest);

  console.log(JSON.stringify({
    ok: true,
    action,
    profile,
    execute_build: executeBuild,
    manifest_path: manifestPath || '',
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
}

module.exports = {
  isTruthy,
  resolvePreviewEasProfile,
};

