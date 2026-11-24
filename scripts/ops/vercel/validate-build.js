const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MARKER_PATTERN = /^_next\/static\/dev-build-\d+-\d+\.txt$/;

function validatePublicKey(key = '') {
  if (/^sb_publishable_.+$/.test(key)) return;
  try {
    const parts = key.split('.');
    if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (typeof header.alg === 'string' && header.alg && payload.role === 'anon') return;
    }
  } catch {}
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY must be an anon JWT or sb_publishable_ key');
}

function verifyPrebuilt(root = process.cwd()) {
  root = path.resolve(root);
  const functions = path.join(root, '.vercel/output/functions');
  if (!fs.existsSync(functions)) throw new Error('Prebuilt functions directory is missing');
  const configs = [];
  const visited = new Set();
  function walk(directory) {
    const real = fs.realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.name.endsWith('.func')) configs.push(path.join(file, '.vc-config.json'));
      else if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(file).isDirectory())) walk(file);
    }
  }
  walk(functions);
  if (!configs.length) throw new Error('No prebuilt function configs found');
  const sources = new Set();
  for (const file of configs) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const source of Object.values(config.filePathMap || {})) sources.add(source);
  }
  if (!sources.size) throw new Error('No prebuilt file maps found');
  const missing = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source) throw new Error('Invalid prebuilt file-map source');
    const file = path.join(root, source);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Prebuilt file map escapes the deployment root');
    if (!fs.existsSync(file)) {
      missing.push(source);
      if (missing.length === 5) break;
    }
  }
  if (missing.length) throw new Error('Missing prebuilt files (first 5):\n' + missing.join('\n'));
  return { functions: configs.length, files: sources.size };
}

function resolveDevAlias(surface, origins = '') {
  const aliases = new Set(origins.split(',').map(origin =>
    origin.trim().match(/^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/)?.[1],
  ).filter(host => host?.startsWith(`${surface}-dev.`)));
  if (!['console', 'portal'].includes(surface) || aliases.size !== 1) {
    throw new Error('Invalid DEV web alias configuration');
  }
  return [...aliases][0];
}

async function probeDevMarker(origin, marker, sha, request, timeout) {
  let status = 'none';
  try {
    const response = await request(new URL(`/${marker}`, origin), {
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeout),
    });
    status = response.status;
    if (status === 200) return { status, matches: await response.text() === `${sha}\n` };
    void response.body?.cancel().catch(() => {});
  } catch {
    // Request errors can contain the private address.
  }
  return { status, matches: false };
}

function readLightMuted(css, label) {
  const values = new Set();
  let hasDefault = false;
  try {
    require('postcss').parse(css).walkRules(rule => {
      if (!rule.selectors.includes(':root')) return;
      for (const declaration of rule.nodes) {
        if (declaration.type !== 'decl' || declaration.prop !== '--ui-muted') continue;
        values.add(declaration.value.trim().replace(/\s+/g, ' '));
        if (rule.parent.type === 'root') hasDefault = true;
      }
    });
  } catch {
    throw new Error(`Could not parse ${label} CSS`);
  }
  if (!hasDefault || values.has('') || values.size !== 1) {
    throw new Error(`${label} has missing or conflicting light --ui-muted declarations`);
  }
  return [...values][0];
}

function readSourceMuted(sha) {
  if (!SHA_PATTERN.test(sha)) throw new Error('Invalid DEV web deployment SHA');
  let css;
  try {
    css = execFileSync('git', ['show', `${sha}:packages/ui/src/styles.css`], {
      cwd: path.join(__dirname, '../../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch {
    throw new Error('Could not read shared DEV web token source at the deployment SHA');
  }
  return readLightMuted(css, 'Shared DEV web token source');
}

async function verifyDeployedMuted(surface, origin, expected, request) {
  async function read(url, resource) {
    try {
      const response = await request(url, {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 200) return await response.text();
      void response.body?.cancel().catch(() => {});
    } catch {
      // Never expose private addresses or response content.
    }
    throw new Error(`Could not read DEV ${surface} ${resource}`);
  }

  const page = new URL('/signin', origin);
  const html = (await read(page, 'sign-in page'))
    .replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const links = new Set();
  // shortcut: Next emits quoted link attributes, use an HTML parser if the page format changes.
  for (const [tag] of html.matchAll(/<link\s+(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map();
    for (const [, name, , value] of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes.set(name.toLowerCase(), value);
    }
    if (attributes.get('rel')?.toLowerCase() !== 'stylesheet') continue;
    const href = attributes.get('href');
    if (!href) continue;
    let url;
    try { url = new URL(href, page); } catch { throw new Error(`Invalid DEV ${surface} stylesheet link`); }
    if (url.protocol === 'https:' && url.origin === page.origin && !url.username && !url.password) links.add(url.href);
  }
  const css = await Promise.all([...links].map(url => read(new URL(url), 'linked stylesheet')));
  if (readLightMuted(css.join('\n'), `DEV ${surface} linked CSS`) !== expected) {
    throw new Error(`DEV ${surface} light --ui-muted does not match source at the deployment SHA`);
  }
}

async function verifyDevSweepTargets(sha, marker, origins, request = fetch) {
  if (!SHA_PATTERN.test(sha) || !MARKER_PATTERN.test(marker)) throw new Error('Invalid DEV sweep SHA or build marker');
  const targets = {
    console: `https://${resolveDevAlias('console', origins)}`,
    portal: `https://${resolveDevAlias('portal', origins)}`,
  };
  const expected = readSourceMuted(sha);
  await Promise.all(Object.entries(targets).map(async ([surface, origin]) => {
    if (!(await probeDevMarker(origin, marker, sha, request, 5_000)).matches) {
      throw new Error(`DEV ${surface} alias did not serve the expected build marker`);
    }
    await verifyDeployedMuted(surface, origin, expected, request);
  }));
  return { ...targets, sha };
}

async function assignAndVerifyDevAlias(surface, deploymentUrl, marker, env, request = fetch) {
  const { DEV_WEB_ORIGINS, VERCEL_ORG_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN,
    GITHUB_SHA, GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN } = env;
  const alias = resolveDevAlias(surface, DEV_WEB_ORIGINS);
  if (!VERCEL_ORG_ID || !VERCEL_PROJECT_ID || !VERCEL_TOKEN || !SHA_PATTERN.test(GITHUB_SHA) ||
      !GITHUB_API_URL || !GITHUB_REPOSITORY || !GH_TOKEN ||
      !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(deploymentUrl) ||
      !MARKER_PATTERN.test(marker)) {
    throw new Error('Invalid DEV web alias configuration');
  }
  const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(20_000) });
  async function vercel(endpoint, operation, body, allowMissing = false) {
    const url = new URL(endpoint, 'https://api.vercel.com');
    url.searchParams.set('teamId', VERCEL_ORG_ID);
    try {
      const response = await request(url, {
        ...options(),
        headers: { authorization: `Bearer ${VERCEL_TOKEN}`, 'content-type': 'application/json' },
        method: body ? 'POST' : 'GET',
        body: JSON.stringify(body),
      });
      if (response.ok) return await response.json();
      if (allowMissing && response.status === 404) return null;
    } catch {
      // Provider errors can contain private domain and deployment details.
    }
    throw new Error(`DEV web ${operation} failed`);
  }

  async function github(endpoint) {
    try {
      const response = await request(new URL(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${endpoint}`), {
        ...options(),
        headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json' },
      });
      if (response.ok) return await response.json();
    } catch {
      // A failed lookup must not allow an alias write.
    }
    throw new Error('Could not verify DEV web deployment commit order');
  }

  const domain = await vercel(`/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/domains/${alias}`, 'domain lookup');
  if (domain.name !== alias || domain.projectId !== VERCEL_PROJECT_ID || !domain.verified || domain.redirect) {
    throw new Error('DEV web domain binding failed');
  }
  const host = new URL(deploymentUrl).hostname;
  const deployment = await vercel(`/v13/deployments/${host}`, 'deployment lookup');
  if (deployment.url !== host || deployment.projectId !== VERCEL_PROJECT_ID ||
      deployment.readyState !== 'READY' || (deployment.target != null && deployment.target !== 'preview') ||
      !deployment.id || deployment.meta?.devCommitSha !== GITHUB_SHA) {
    throw new Error('DEV web deployment binding failed');
  }

  // The workflow serializes deployments for this alias. Its binding includes assignments whose probe failed.
  const current = await vercel(`/v4/aliases/${alias}`, 'current alias lookup', undefined, true);
  if (current && (current.alias !== alias || current.projectId !== VERCEL_PROJECT_ID)) {
    throw new Error('DEV web current alias binding failed');
  }
  const meta = current?.deployment?.meta;
  const deployedSha = meta?.devCommitSha ?? meta?.githubCommitSha ?? meta?.gitCommitSha;
  if (!SHA_PATTERN.test(deployedSha)) {
    // A new or legacy alias without commit metadata can be claimed only by the main tip.
    const tip = (await github('/git/ref/heads/main'))?.object?.sha;
    if (!SHA_PATTERN.test(tip)) throw new Error('Could not verify DEV web deployment commit order');
    if (GITHUB_SHA !== tip) {
      console.log('Skipped stable DEV alias assignment: current deployment has no commit metadata and this run is behind main');
      return false;
    }
  } else if (deployedSha !== GITHUB_SHA) {
    const comparison = await github(`/compare/${deployedSha}...${GITHUB_SHA}`);
    if (comparison?.status === 'behind') {
      console.log('Skipped stable DEV alias assignment: a newer commit is already deployed');
      return false;
    }
    if (comparison?.status !== 'ahead') throw new Error('Could not verify DEV web deployment commit order');
  }

  await vercel(`/v2/deployments/${encodeURIComponent(deployment.id)}/aliases`, 'alias assignment', { alias });

  const origin = `https://${alias}`;
  const deadline = performance.now() + 120_000;
  for (let attempt = 1; performance.now() < deadline; attempt++) {
    const { status, matches } = await probeDevMarker(origin, marker, GITHUB_SHA, request,
      Math.min(5_000, Math.ceil(deadline - performance.now())));
    console.log(`DEV web alias probe attempt=${attempt} status=${status}`);
    if (matches && performance.now() < deadline) return true;
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(5_000, remaining)));
  }
  throw new Error('DEV web alias did not serve the new build within 120 seconds');
}

async function main() {
  try {
    if (process.argv[2] === 'public-key') validatePublicKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    else if (process.argv[2] === 'prebuilt') {
      const result = verifyPrebuilt();
      console.log(`Verified ${result.files} mapped files across ${result.functions} prebuilt functions`);
    } else if (process.argv[2] === 'dev-alias') {
      const [surface, deploymentUrl, marker] = process.argv.slice(3, 6);
      if (await assignAndVerifyDevAlias(surface, deploymentUrl, marker, process.env)) {
        const origin = `https://${resolveDevAlias(surface, process.env.DEV_WEB_ORIGINS)}`;
        await verifyDeployedMuted(surface, origin, readSourceMuted(process.env.GITHUB_SHA), fetch);
        console.log('Verified stable DEV alias serves the new build and source light --ui-muted');
      }
    } else if (process.argv[2] === 'dev-sweep-targets') {
      const [sha, marker] = process.argv.slice(3, 5);
      console.log(JSON.stringify(await verifyDevSweepTargets(sha, marker, process.env.DEV_WEB_ORIGINS)));
    } else throw new Error('Usage: validate-build.js public-key | prebuilt | dev-alias <surface> <deployment-url> <build-marker> | dev-sweep-targets <sha> <build-marker>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { validatePublicKey, verifyPrebuilt, assignAndVerifyDevAlias, verifyDevSweepTargets };
