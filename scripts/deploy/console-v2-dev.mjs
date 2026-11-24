import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import securityHeaders from '../../apps/shared/security-headers.js';
import vercelValidation from '../ops/vercel/validate-build.js';

const env = process.env;
const assets = resolve('apps/console-v2/dist');
const worker = resolve('tooling/apps/console-v2-worker/index.mjs');
const wrangler = resolve('tooling/apps/deploy/node_modules/.bin/wrangler');
const sha = env.GITHUB_SHA;
const shaPattern = /^[a-f0-9]{40}$/;
const runNumberPattern = /^\d+$/;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const { buildStaticSecurityHeaders, normalizeTrustedOrigin } = securityHeaders;

class DeployError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new DeployError(message);
}

function targetOrigin() {
  const origin = normalizeTrustedOrigin(env.CONSOLE_V2_DEV_ORIGIN);
  requireValue(origin?.startsWith('https://') && origin === env.CONSOLE_V2_DEV_ORIGIN
    && !new URL(origin).port, 'Set CONSOLE_V2_DEV_ORIGIN to the verified HTTPS origin.');
  requireValue(env.CORS_ALLOW_ORIGIN?.split(',').map(normalizeTrustedOrigin).includes(origin),
    'The Console V2 origin is missing from the DEV web allowlist.');
  return origin;
}

function buildId() {
  requireValue(shaPattern.test(sha) && runNumberPattern.test(env.GITHUB_RUN_ID)
    && runNumberPattern.test(env.GITHUB_RUN_ATTEMPT), 'Invalid workflow commit or attempt identity.');
  return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
}

function markerPath() {
  return `/__deploy/dev-build-${buildId()}.txt`;
}

function configPath() {
  return join(env.RUNNER_TEMP, 'console-v2-wrangler.json');
}

function workerCommand(args, message) {
  try {
    execFileSync(wrangler, [...args, '--config', configPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new DeployError(message);
  }
}

function prepare() {
  const origin = targetOrigin();
  requireValue(/^[a-z][a-z0-9-]{0,62}$/.test(env.CLOUDFLARE_WORKER_CONSOLE_V2),
    'Set CLOUDFLARE_WORKER_CONSOLE_V2 to the approved Worker name.');
  const supabase = normalizeTrustedOrigin(env.VITE_SUPABASE_URL);
  requireValue(/^[a-z]{20}$/.test(env.SUPABASE_PROJECT_REF)
    && supabase === `https://${env.SUPABASE_PROJECT_REF}.supabase.co`,
    'Console V2 requires the configured DEV Supabase project origin.');
  requireValue(env.VITE_USE_SEED === 'false', 'Console V2 DEV must build with VITE_USE_SEED=false.');
  try {
    vercelValidation.validatePublicKey(env.VITE_SUPABASE_ANON_KEY);
  } catch (error) {
    throw new DeployError(error.message);
  }
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireValue(checkout === sha, 'Checkout does not match the workflow SHA.');
  const marker = markerPath();
  const placeholder = randomBytes(18).toString('hex');

  execFileSync('npm', ['run', 'build', '--workspace', '@masarx/console-v2'], {
    env: {
      ...env,
      CONSOLE_V2_CSP_NONCE_PLACEHOLDER: placeholder,
      VITE_AUTH_REDIRECT_URL: `${origin}/auth/callback`,
    },
    stdio: 'inherit',
  });
  execFileSync('npm', ['run', 'check:bundle-size', '--workspace', '@masarx/console-v2'], { stdio: 'inherit' });
  const shell = readFileSync(join(assets, 'index.html'), 'utf8');
  requireValue(shell.includes(`nonce="${placeholder}"`) && !globSync('**/*.map', { cwd: assets }).length,
    'The build must contain a CSP nonce placeholder and exclude source maps.');

  const links = [...shell.matchAll(/<link\s[^>]*>/g)].map(([link]) => link);
  const stylesheetOrigins = new Set(links.filter(link => /\brel="stylesheet"/.test(link))
    .map(link => link.match(/\bhref="(https:\/\/[^"/]+)[/"]/)?.[1]).filter(Boolean));
  const fontOrigins = new Set(links.filter(link => /\brel="preconnect"/.test(link) && /\bcrossorigin\b/.test(link))
    .map(link => link.match(/\bhref="(https:\/\/[^"/]+)[/"]/)?.[1]).filter(Boolean));
  mkdirSync(join(assets, '__deploy'), { recursive: true });
  writeFileSync(join(assets, marker), `${sha}\n`);
  writeFileSync(join(assets, '_headers'), `/*\n${buildStaticSecurityHeaders()
    .map(({ key, value }) => `  ${key}: ${value}`).join('\n')}\n`);

  writeFileSync(configPath(), JSON.stringify({
    name: env.CLOUDFLARE_WORKER_CONSOLE_V2,
    main: worker,
    compatibility_date: '2026-11-24',
    workers_dev: false,
    preview_urls: false,
    assets: {
      directory: assets,
      binding: 'ASSETS',
      html_handling: 'none',
      run_worker_first: ['/*', '!/assets/*', '!/__deploy/*'],
    },
    vars: {
      DEV_ORIGIN: origin,
      SUPABASE_URL: supabase,
      NONCE_PLACEHOLDER: placeholder,
      TRUSTED_EXTERNAL_DATA_ORIGINS: env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS ?? '',
      MAP_TILE_ORIGINS: env.NEXT_PUBLIC_UI_MAP_TILE_ORIGINS ?? '',
      FONT_STYLESHEET_ORIGINS: [...stylesheetOrigins].join(','),
      FONT_ASSET_ORIGINS: [...fontOrigins].join(','),
    },
  }));
}

async function jsonRequest(url, token, operation) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  requireValue(response.ok, `${operation} failed with HTTP ${response.status}.`);
  return response.json();
}

async function deploy() {
  const origin = targetOrigin();
  const name = env.CLOUDFLARE_WORKER_CONSOLE_V2;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  requireValue(env.DEPLOY_ENV === 'dev' && env.GITHUB_REF === 'refs/heads/main'
    && /^[a-f0-9]{32}$/.test(account) && env.CLOUDFLARE_API_TOKEN && env.GH_TOKEN,
  'The main-branch DEV deployment requires the approved account and deploy credentials.');
  const config = JSON.parse(readFileSync(configPath(), 'utf8'));
  requireValue(config.name === name && config.vars.DEV_ORIGIN === origin,
    'The prepared Worker does not match the configured DEV target.');

  const cf = async (path, operation) => {
    const body = await jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${account}/workers${path}`,
      env.CLOUDFLARE_API_TOKEN, operation);
    requireValue(body.success === true && body.result != null, `${operation} returned no result.`);
    return body.result;
  };
  const script = `/scripts/${encodeURIComponent(name)}`;
  const github = (path, operation) => jsonRequest(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`,
    env.GH_TOKEN, operation);
  const hostname = new URL(origin).hostname;
  const checkDomain = async () => {
    const domains = await cf(`/domains?hostname=${encodeURIComponent(hostname)}`, 'DEV custom-domain readback');
    requireValue(Array.isArray(domains) && domains.length === 1 && domains[0].hostname === hostname
      && domains[0].service === name && domains[0].enabled === true && domains[0].previews_enabled === false,
    'The approved custom domain must route to the DEV Worker with previews disabled.');
    const subdomain = await cf(`${script}/subdomain`, 'DEV Worker subdomain readback');
    requireValue(subdomain.enabled === false && subdomain.previews_enabled === false,
      'Disable the DEV Worker provider subdomain and preview URLs before deploying.');
  };
  const activeVersion = async () => {
    const { deployments } = await cf(`${script}/deployments`, 'DEV Worker deployment readback');
    requireValue(Array.isArray(deployments), 'Cloudflare did not return a deployment list.');
    if (deployments.length === 0) return null;
    const { versions } = deployments[0];
    requireValue(versions?.length === 1 && versions[0].percentage === 100
      && versionPattern.test(versions[0].version_id), 'DEV Worker must route all traffic to one known version.');
    const version = await cf(`${script}/versions/${versions[0].version_id}`, 'DEV Worker version readback');
    requireValue(version.id === versions[0].version_id, 'Cloudflare returned a different Worker version.');
    return version;
  };
  const deploymentAllowed = async () => {
    const current = await activeVersion();
    const currentTag = current?.annotations?.['workers/tag'];
    const deployedSha = /^(?<sha>[a-f0-9]{40})-\d+-\d+$/.exec(currentTag)?.groups.sha;
    if (!deployedSha) {
      const tip = (await github('/git/ref/heads/main', 'Main tip readback')).object?.sha;
      requireValue(shaPattern.test(tip), 'GitHub did not return the main tip SHA.');
      if (tip === sha) return true;
      const comparison = await github(`/compare/${sha}...${tip}`, 'Main ancestry readback');
      requireValue(comparison.status === 'ahead', 'The initial deployment must target a commit on main.');
      return false;
    }
    if (deployedSha === sha) return true;
    const comparison = await github(`/compare/${deployedSha}...${sha}`, 'DEV Worker ancestry readback');
    requireValue(['ahead', 'behind'].includes(comparison.status), 'DEV Worker commit ancestry is divergent.');
    return comparison.status === 'ahead';
  };
  const superseded = () => appendFileSync(env.GITHUB_OUTPUT, 'superseded=true\n');

  await checkDomain();
  if (!await deploymentAllowed()) return superseded();
  const digest = createHash('sha256');
  for (const file of globSync('**/*', { cwd: assets }).sort()) {
    const path = join(assets, file);
    if (statSync(path).isFile()) {
      digest.update(JSON.stringify([file, createHash('sha256').update(readFileSync(path)).digest('hex')]));
    }
  }
  const artifactDigest = digest.digest('hex');
  const tag = `${sha}-${buildId()}`;
  workerCommand(['versions', 'upload', '--tag', tag, '--message', artifactDigest],
    'Cloudflare rejected the Console V2 Worker version upload.');

  await checkDomain();
  if (!await deploymentAllowed()) return superseded();
  workerCommand(['versions', 'deploy', '--version-tag', `${tag}@100%`, '--yes'],
    'Cloudflare rejected the Console V2 Worker version deployment.');
  const uploaded = await activeVersion();
  requireValue(uploaded?.annotations?.['workers/tag'] === tag
    && uploaded.annotations['workers/message'] === artifactDigest,
  'Active Cloudflare version does not match this checkout and asset digest.');
  await checkDomain();
  appendFileSync(env.GITHUB_STEP_SUMMARY, `\nConsole V2 DEV · commit \`${sha}\` · assets SHA-256 \`${artifactDigest}\` · Worker version \`${uploaded.id}\`\n`);
}

function fetchAsset(origin, path, headers = {}) {
  return fetch(new URL(path, origin), {
    redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache', ...headers },
  });
}

async function markerMatches(origin) {
  const response = await fetchAsset(origin, markerPath());
  return response.status === 200 && response.headers.get('content-type')?.startsWith('text/plain')
    && await response.text() === `${sha}\n`;
}

async function readout() {
  const origin = targetOrigin();
  for (let attempt = 0; !await markerMatches(origin); attempt += 1) {
    requireValue(attempt < 2, 'The DEV custom domain did not serve the exact commit marker.');
    await delay(60_000);
  }

  const nonces = [];
  for (const route of ['/', '/auth/callback?code=synthetic', '/operate/shipments']) {
    const response = await fetchAsset(origin, route, { Accept: 'text/html' });
    const csp = response.headers.get('content-security-policy');
    const html = await response.text();
    const nonce = /(?:^|;\s*)script-src\s+[^;]*'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    requireValue(response.status === 200 && response.headers.get('content-type')?.startsWith('text/html')
      && response.headers.get('cache-control') === 'no-store' && csp?.includes("frame-ancestors 'none'")
      && nonce && !nonces.includes(nonce) && html.includes(`<meta property="csp-nonce" nonce="${nonce}"`)
      && buildStaticSecurityHeaders().every(({ key, value }) => response.headers.get(key) === value),
    'Console V2 HTML did not serve a fresh nonce and the shared security headers.');
    nonces.push(nonce);
    const script = /<script\b[^>]*\bsrc="(\/assets\/[\w.-]+\.js)"[^>]*>/.exec(html);
    requireValue(script?.[0].includes(`nonce="${nonce}"`), 'The hashed Console V2 entry script is missing its CSP nonce.');
    const entry = await fetchAsset(origin, script[1]);
    requireValue(entry.status === 200 && Buffer.from(await entry.arrayBuffer()).equals(readFileSync(join(assets, script[1]))),
      'The served entry script differs from the exact checkout build.');
  }
  const missing = await fetchAsset(origin, `/assets/missing-${buildId()}.js`, { Accept: 'text/html' });
  requireValue(missing.status === 404, 'A missing JavaScript asset must return 404.');

  const { chromium } = await import('@playwright/test');
  const { gotoSurface, waitForLiveResourceList, waitForLiveRpc } =
    await import('../../apps/console-v2/tests/e2e/fixtures.ts');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: origin });
    await Promise.all([
      waitForLiveRpc(page, 'ui_me_v1'),
      waitForLiveResourceList(page, 'shipments'),
      gotoSurface(page, '/operate/shipments'),
    ]);
    await page.waitForURL(new URL('/operate/shipments', origin).href);
    await page.locator('.dt__table tbody tr').first().waitFor();
    requireValue(await markerMatches(origin), 'The DEV commit marker changed during the dispatcher readout.');
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError('The DEV dispatcher did not render a shipment from the live API.');
  } finally {
    await browser.close();
  }
  appendFileSync(env.GITHUB_STEP_SUMMARY, '\nExact commit marker, security headers, and live dispatcher shipment read verified.\n');
}

const commands = {
  build: prepare,
  bundle: () => workerCommand(['versions', 'upload', '--dry-run'], 'Wrangler could not bundle Console V2.'),
  deploy,
  readout,
};

const command = process.argv[2];
try {
  requireValue(Object.hasOwn(commands, command), 'Expected build, bundle, deploy, or readout.');
  await commands[command]();
} catch (error) {
  // Provider and browser errors can contain private origins or request data.
  console.error(error instanceof DeployError ? error.message : `Console V2 ${command} failed.`);
  process.exitCode = 1;
}
