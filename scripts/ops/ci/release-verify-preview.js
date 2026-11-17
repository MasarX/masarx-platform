#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');
const { resolveSurfaceUrl } = require('../preview/shared');
const {
  ensureVercelAutomationBypassSecret,
  upsertEnvFileVariable,
} = require('../workspace/with-full-preview-stack');

function die(message) {
  console.error(`[release-verify-preview] ${message}`);
  process.exit(1);
}

function readJsonFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || '').trim());
  if (!resolvedPath) {
    throw new Error('Missing file path.');
  }
  return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
}

function resolvePreviewIdentityIdFromEvent(event) {
  const mergeGroupPullRequests = Array.isArray(event?.merge_group?.pull_requests)
    ? event.merge_group.pull_requests
      .map((entry) => Number.parseInt(String(entry?.number || '').trim(), 10))
      .filter(Number.isFinite)
    : [];
  if (mergeGroupPullRequests.length === 1) {
    return String(mergeGroupPullRequests[0]).trim();
  }
  if (mergeGroupPullRequests.length > 1) {
    return '';
  }
  const mergeHeadRef = String(event?.merge_group?.head_ref || '').trim();
  const mergeMatch = mergeHeadRef.match(/pr-(\d+)-/i) || mergeHeadRef.match(/pr-(\d+)\b/i);
  return String(event?.pull_request?.number || event?.number || (mergeMatch && mergeMatch[1]) || '').trim();
}

function buildPreviewManifestShellExports(manifest) {
  const db = manifest?.surfaces?.db && typeof manifest.surfaces.db === 'object'
    ? manifest.surfaces.db
    : {};
  return {
    PREVIEW_ENV_FILE: String(db.env_file || manifest.env_file || ''),
    PREVIEW_PROJECT_REF: String(db.project_ref || manifest.project_ref || ''),
    PREVIEW_PROJECT_NAME: String(db.project_name || manifest.project_name || ''),
    PREVIEW_SUPABASE_URL: String(db.supabase_url || manifest.supabase_url || ''),
    PREVIEW_CONSOLE_URL: resolveSurfaceUrl({
      manifest,
      surfaceId: 'console',
      includeEnvFallback: false,
    }),
    PREVIEW_PORTAL_URL: resolveSurfaceUrl({
      manifest,
      surfaceId: 'portal',
      includeEnvFallback: false,
    }),
    PREVIEW_LANDING_URL: resolveSurfaceUrl({
      manifest,
      surfaceId: 'landing',
      includeEnvFallback: false,
    }),
    PREVIEW_DOCS_URL: resolveSurfaceUrl({
      manifest,
      surfaceId: 'docs',
      includeEnvFallback: false,
    }),
  };
}

function serializeShellExports(values) {
  return Object.entries(values || {})
    .map(([key, value]) => `${key}=${JSON.stringify(String(value || ''))}`)
    .join('\n');
}

function isProtectedPreviewHost(raw) {
  const value = String(raw || '').trim();
  if (!value) return false;
  try {
    return new URL(value).hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

async function ensureProtectedPreviewBypass({
  env = process.env,
  fetchImpl = globalThis.fetch,
  appendFileSync = fs.appendFileSync,
} = {}) {
  const previewUrls = [env.CONSOLE_URL, env.PORTAL_URL].filter(Boolean);
  if (!previewUrls.some(isProtectedPreviewHost)) {
    console.log('[release-verify] No protected Vercel preview hosts detected; skipping bypass setup.');
    return {
      configured: false,
      skipped: true,
      reason: 'no_protected_hosts',
    };
  }

  const result = await ensureVercelAutomationBypassSecret({ env, fetchImpl });
  const secret = String(
    env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    env.VERCEL_PROTECTION_BYPASS_SECRET ||
    '',
  ).trim();

  if (!secret) {
    const detail = Array.isArray(result?.failures) && result.failures.length > 0
      ? result.failures.map((entry) => `${entry.projectId}:${entry.step}:${entry.detail}`).join('; ')
      : String(result?.reason || 'missing_bypass_secret');
    throw new Error(
      `Protected Vercel preview hosts require automation bypass configuration before hosted UI gates can run (${detail}).`,
    );
  }

  const githubEnvPath = String(env.GITHUB_ENV || '').trim();
  if (githubEnvPath) {
    appendFileSync(githubEnvPath, `VERCEL_AUTOMATION_BYPASS_SECRET=${secret}\n`, 'utf8');
  }

  const previewEnvFile = String(env.PREVIEW_ENV_FILE || '').trim();
  if (previewEnvFile) {
    upsertEnvFileVariable({
      envPath: previewEnvFile,
      key: 'VERCEL_AUTOMATION_BYPASS_SECRET',
      value: secret,
    });
  }

  console.log(
    `[release-verify] Configured Vercel automation bypass for protected preview hosts (${result.source || 'generated'}).`,
  );
  return {
    configured: true,
    skipped: false,
    source: String(result.source || 'generated'),
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const mode = String(args.mode || '').trim();
  if (!mode) {
    throw new Error('Missing --mode.');
  }

  switch (mode) {
    case 'resolve-preview-id': {
      const eventPath = String(args['event-path'] || '').trim();
      if (!eventPath) {
        throw new Error('Missing --event-path.');
      }
      const event = readJsonFile(eventPath);
      const previewIdentityId = resolvePreviewIdentityIdFromEvent(event);
      process.stdout.write(previewIdentityId);
      return;
    }

    case 'export-manifest': {
      const manifestPath = String(args.manifest || '').trim();
      if (!manifestPath) {
        throw new Error('Missing --manifest.');
      }
      const manifest = readJsonFile(manifestPath);
      process.stdout.write(`${serializeShellExports(buildPreviewManifestShellExports(manifest))}\n`);
      return;
    }

    case 'ensure-vercel-bypass': {
      await ensureProtectedPreviewBypass();
      return;
    }

    default:
      throw new Error(`Unsupported --mode "${mode}".`);
  }
}

if (require.main === module) {
  // eslint-disable-next-line promise/prefer-await-to-then
  main().catch((error) => die(error && error.message ? error.message : String(error)));
}

module.exports = {
  buildPreviewManifestShellExports,
  ensureProtectedPreviewBypass,
  isProtectedPreviewHost,
  resolvePreviewIdentityIdFromEvent,
  serializeShellExports,
};
