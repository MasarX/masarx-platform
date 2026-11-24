const fs = require('node:fs');
const path = require('node:path');

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

async function assignAndVerifyDevAlias(surface, deploymentUrl, marker, env, request = fetch) {
  const { DEV_WEB_ORIGINS = '', VERCEL_ORG_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN,
    GITHUB_SHA, GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN } = env;
  const shaPattern = /^[a-f0-9]{40}$/;
  const aliases = new Set(DEV_WEB_ORIGINS.split(',').map(origin =>
    origin.trim().match(/^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/)?.[1],
  ).filter(host => host?.startsWith(`${surface}-dev.`)));
  if (!['console', 'portal'].includes(surface) || aliases.size !== 1 ||
      !VERCEL_ORG_ID || !VERCEL_PROJECT_ID || !VERCEL_TOKEN || !shaPattern.test(GITHUB_SHA) ||
      !GITHUB_API_URL || !GITHUB_REPOSITORY || !GH_TOKEN ||
      !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(deploymentUrl) ||
      !/^_next\/static\/dev-build-\d+-\d+\.txt$/.test(marker)) {
    throw new Error('Invalid DEV web alias configuration');
  }
  const [alias] = aliases;
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
  if (!shaPattern.test(deployedSha)) {
    // A new or legacy alias without commit metadata can be claimed only by the main tip.
    const tip = (await github('/git/ref/heads/main'))?.object?.sha;
    if (!shaPattern.test(tip)) throw new Error('Could not verify DEV web deployment commit order');
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

  const markerUrl = new URL(`/${marker}`, `https://${alias}`);
  const deadline = performance.now() + 120_000;
  for (let attempt = 1; performance.now() < deadline; attempt++) {
    let status = 'none';
    let matches = false;
    try {
      const response = await request(markerUrl, {
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(5_000, Math.ceil(deadline - performance.now()))),
      });
      status = response.status;
      if (status === 200) matches = await response.text() === `${GITHUB_SHA}\n`;
      else void response.body?.cancel().catch(() => {});
    } catch {
      // Request errors can contain the private address.
    }
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
      if (await assignAndVerifyDevAlias(...process.argv.slice(3, 6), process.env)) {
        console.log('Verified stable DEV alias serves the new build');
      }
    } else throw new Error('Usage: validate-build.js public-key|prebuilt|dev-alias <surface> <deployment-url> <build-marker>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { validatePublicKey, verifyPrebuilt, assignAndVerifyDevAlias };
