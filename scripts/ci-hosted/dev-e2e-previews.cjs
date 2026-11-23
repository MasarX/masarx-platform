'use strict';

const { appendFileSync, readFileSync } = require('node:fs');

function isPreviewOrigin(value) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  // The deploy CLI returns the generated project-hash-scope URL on stdout.
  // Stable aliases and custom domains are ineligible for the report.
  return url.protocol === 'https:' && url.origin === value && !url.port &&
    /^(?=[a-z0-9-]{1,63}\.)[a-z0-9][a-z0-9-]*-[a-z0-9]{9}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/.test(url.hostname);
}

async function probePreview(origin, request) {
  const response = await request(origin, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  try {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location') ?? '', origin);
      if (target.origin === 'https://vercel.com' && /^\/login\/?$/.test(target.pathname)) return 'preview_protected';
      if (target.origin !== origin) return 'preview_unavailable';
    }
    if (response.status === 401 || response.status === 403) {
      const body = await response.text();
      if (/<title>\s*Authentication Required\s*<\/title>/i.test(body) &&
          (response.headers.get('server')?.toLowerCase() === 'vercel' ||
           /Vercel Authentication|https:\/\/vercel\.com\/sso-api\b/i.test(body))) return 'preview_protected';
    }
    return 'ready';
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

async function previewStatus(origins, request = fetch) {
  if (!origins.every(isPreviewOrigin)) return 'preview_unavailable';
  const statuses = await Promise.all(origins.map(origin => probePreview(origin, request).catch(() => 'preview_unreachable')));
  return ['preview_protected', 'preview_unavailable', 'preview_unreachable'].find(status => statuses.includes(status)) ?? 'ready';
}

if (require.main === module) {
  if (process.argv[2] === 'capture') {
    const origin = readFileSync(0, 'utf8');
    if (isPreviewOrigin(origin)) appendFileSync(process.env.GITHUB_OUTPUT, `preview_origin=${origin}\n`);
  } else {
    previewStatus([process.env.CONSOLE_BASE_URL, process.env.PORTAL_BASE_URL]).then(status => {
      if (status === 'ready') {
        appendFileSync(process.env.GITHUB_OUTPUT, 'ready=true\n');
      } else {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## DEV browser report\n\ne2e_report=${status}\n`);
        if (status === 'preview_unreachable') process.exitCode = 1;
      }
    });
  }
}

module.exports = { isPreviewOrigin, previewStatus };
