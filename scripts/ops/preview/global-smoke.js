#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../../utils/load-env');
const {
  die,
  evaluateManifestRuntimeReadiness,
  resolveTopologyIdentity,
  resolveManifestPath,
  readJsonFile,
  resolveSurfaceUrl,
  writeJsonFile,
  runNodeScript,
  printOutputs,
  parseCommonCli,
} = require('./shared');

async function fetchUrl(url, timeoutMs = 15000) {
  const target = String(url || '').trim();
  if (!target) throw new Error('Missing target URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body, contentType: String(res.headers.get('content-type') || '') };
  } finally {
    clearTimeout(timeout);
  }
}

async function runGlobalSmoke({ argv = process.argv.slice(2) } = {}) {
  loadEnv();
  const { args, format } = parseCommonCli(argv);
  const identity = resolveTopologyIdentity({ args });
  const manifestPath = resolveManifestPath({ args, identity });
  const manifest = readJsonFile(manifestPath);
  if (!manifest) throw new Error(`Manifest not found: ${manifestPath}`);

  const checks = [];
  const failures = [];
  const runtimeReadiness = evaluateManifestRuntimeReadiness({ manifest, cwd: process.cwd() });

  if (runtimeReadiness.env_file) {
    process.env.ENV_FILE = runtimeReadiness.env_file;
    process.env.ENV_FILE_OVERRIDE = '1';
    loadEnv();
  }

  checks.push({
    check: 'preview_runtime_precheck',
    ok: runtimeReadiness.ready,
    failure_class: String(runtimeReadiness.failure_class || '').trim(),
    env_file: String(runtimeReadiness.env_file || '').trim(),
    runtime_ready_at: String(runtimeReadiness.runtime_ready_at || '').trim(),
  });
  if (!runtimeReadiness.ready) {
    failures.push(String(runtimeReadiness.failure_class || 'preview_runtime_precheck').trim());
  }

  // DB intake smoke (only if DATABASE_URL is available in current runtime).
  const databaseUrl = String(process.env.PG_CONN_STRING || process.env.DATABASE_URL || '').trim();
  if (!runtimeReadiness.ready) {
    checks.push({
      check: 'workflow_intake_smoke',
      ok: true,
      skipped: true,
      reason: 'preview_runtime_unready',
      failure_class: String(runtimeReadiness.failure_class || '').trim(),
    });
  } else if (databaseUrl) {
    try {
      await runNodeScript({
        scriptPath: path.join(__dirname, '..', 'gates', 'workflow-intake-smoke.js'),
        label: 'workflow-intake-smoke',
      });
      checks.push({ check: 'workflow_intake_smoke', ok: true });
    } catch (err) {
      checks.push({ check: 'workflow_intake_smoke', ok: false, error: String(err.message || err) });
      failures.push('workflow_intake_smoke');
    }
  } else {
    checks.push({ check: 'workflow_intake_smoke', ok: true, skipped: true, reason: 'DATABASE_URL_missing' });
  }

  // Console + Portal hosted smoke.
  const consoleUrl = resolveSurfaceUrl({ manifest, surfaceId: 'console', envKey: 'CONSOLE_BASE_URL' });
  const portalUrl = resolveSurfaceUrl({ manifest, surfaceId: 'portal', envKey: 'PORTAL_BASE_URL' });
  if (consoleUrl && portalUrl) {
    try {
      await runNodeScript({
        scriptPath: path.join(__dirname, '..', 'gates', 'ui-surface-smoke.js'),
        scriptArgs: ['--urls', `${consoleUrl},${portalUrl}`],
        env: {
          ...process.env,
          CONSOLE_BASE_URL: consoleUrl,
          PORTAL_BASE_URL: portalUrl,
        },
        label: 'ui-surface-smoke',
      });
      checks.push({ check: 'ui_surface_smoke', ok: true, console_url: consoleUrl, portal_url: portalUrl });
    } catch (err) {
      checks.push({ check: 'ui_surface_smoke', ok: false, error: String(err.message || err) });
      failures.push('ui_surface_smoke');
    }
  } else {
    checks.push({ check: 'ui_surface_smoke', ok: true, skipped: true, reason: 'missing_console_or_portal_url' });
  }

  // Landing smoke.
  const landingUrl = resolveSurfaceUrl({ manifest, surfaceId: 'landing', envKey: 'LANDING_BASE_URL' });
  if (landingUrl) {
    try {
      const landing = await fetchUrl(landingUrl);
      const ok = landing.status >= 200 && landing.status < 400 && /html/i.test(landing.contentType || '');
      checks.push({ check: 'landing_smoke', ok, url: landingUrl, status: landing.status });
      if (!ok) failures.push('landing_smoke');
    } catch (err) {
      checks.push({ check: 'landing_smoke', ok: false, error: String(err.message || err) });
      failures.push('landing_smoke');
    }
  } else {
    checks.push({ check: 'landing_smoke', ok: true, skipped: true, reason: 'LANDING_BASE_URL_missing' });
  }

  // Docs smoke.
  const docsUrl = resolveSurfaceUrl({ manifest, surfaceId: 'docs', envKey: 'DOCS_BASE_URL' });
  if (docsUrl) {
    try {
      const root = await fetchUrl(docsUrl);
      const openapi = await fetchUrl(`${docsUrl.replace(/\/+$/, '')}/openapi.json`);
      const docsOk = root.status >= 200 && root.status < 400;
      const openapiOk = openapi.status >= 200 && openapi.status < 400 && /\"openapi\"/i.test(openapi.body || '');
      const ok = docsOk && openapiOk;
      checks.push({
        check: 'docs_smoke',
        ok,
        url: docsUrl,
        root_status: root.status,
        openapi_status: openapi.status,
      });
      if (!ok) failures.push('docs_smoke');
    } catch (err) {
      checks.push({ check: 'docs_smoke', ok: false, error: String(err.message || err) });
      failures.push('docs_smoke');
    }
  } else {
    checks.push({ check: 'docs_smoke', ok: true, skipped: true, reason: 'DOCS_BASE_URL_missing' });
  }

  // Mobile smoke is manifest-state-based in CI prewarm/deploy paths.
  const mobileState = String(manifest?.surfaces?.mobile_fieldops?.status || '').trim().toLowerCase();
  const mobileOk = !mobileState || mobileState === 'prewarmed' || mobileState === 'deployed' || mobileState === 'skipped';
  checks.push({ check: 'mobile_preview_state', ok: mobileOk, status: mobileState || '<unknown>' });
  if (!mobileOk) failures.push('mobile_preview_state');

  const report = {
    generated_at: new Date().toISOString(),
    topology: identity.topology,
    id: identity.id,
    sha: identity.sha,
    manifest_path: manifestPath,
    checks,
    failure_count: failures.length,
    failures,
  };

  const reportPath = path.resolve(process.cwd(), String(args.report || `${manifestPath}.global-smoke.json`));
  writeJsonFile(reportPath, report);

  printOutputs({
    ok: failures.length === 0 ? '1' : '0',
    mode: 'verify',
    manifest_path: manifestPath,
    report_path: reportPath,
    failure_count: String(failures.length),
  }, format);

  if (failures.length > 0) {
    throw new Error(`Global smoke failed: ${failures.join(', ')}`);
  }

  return { reportPath, report };
}

if (require.main === module) {
  runGlobalSmoke().catch((err) => die('preview-global-smoke', err && err.message ? err.message : String(err)));
}

module.exports = {
  runGlobalSmoke,
};
