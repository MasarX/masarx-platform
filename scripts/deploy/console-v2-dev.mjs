import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import securityHeaders from '../../apps/shared/security-headers.js';
import { retry } from '../ci-hosted/process.cjs';
import { RETRYABLE_NETWORK_ERROR_CODES } from '../ops/ci/github-api-retry.js';
import vercelValidation from '../ops/vercel/validate-build.js';
import preview from '../ops/workspace/preview-project.js';
import { ensureTenantRole } from './dev-sweep-role.cjs';
import { FixtureError, requireFixture, withDevFixture } from './dev-synthetic-fixture.cjs';

const env = process.env;
const assets = resolve('apps/console-v2/dist');
const worker = resolve('tooling/apps/console-v2-worker/index.mjs');
const wrangler = resolve('tooling/apps/deploy/node_modules/.bin/wrangler');
const sha = env.GITHUB_SHA;
const shaPattern = /^[a-f0-9]{40}$/;
const runNumberPattern = /^\d+$/;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const { buildStaticSecurityHeaders, normalizeTrustedOrigin } = securityHeaders;
const sweepRoles = JSON.parse(readFileSync(new URL('../../config/dev/sweep-roles.json', import.meta.url), 'utf8'));
const { additionalReadCapabilities } = JSON.parse(
  readFileSync(new URL('../../config/dev/console-v2-readout.json', import.meta.url), 'utf8'),
);
const dispatcherError = 'DEV_DISPATCHER_UNVERIFIED';
const dispatcherCleanupError = 'DEV_DISPATCHER_CLEANUP_FAILED';
const dispatcherCleanupExit = 22;
const dispatcherRole = 'dispatcher';
const { scope, required, optional } = sweepRoles[dispatcherRole];
const dispatcherRequired = [...required, ...additionalReadCapabilities];
const dispatcherFixtureExit = {
  configuration: dispatcherError,
  credentials: dispatcherError,
  database: dispatcherError,
  authCreate: dispatcherError,
  fixture: dispatcherError,
  signIn: dispatcherError,
  cleanupDatabase: dispatcherCleanupError,
  cleanupAuth: dispatcherCleanupError,
  cleanupVerify: dispatcherCleanupError,
};

class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

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
    execFileSync(wrangler, [...args, '--config', configPath()], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL',
    });
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
    && supabase === preview.buildSupabaseProjectUrl(env.SUPABASE_PROJECT_REF),
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

export function jsonRequest(url, options, operation, wait = delay) {
  return retry(operation, async () => {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (response.ok) return response.json();
    void response.body?.cancel().catch(() => {});
    throw Object.assign(new DeployError(`${operation} failed with HTTP ${response.status}.`), {
      status: response.status,
    });
  }, wait, {
    quiet: true,
    retryable: error => error.status === 429 || (error.status >= 500 && error.status < 600)
      || error.name === 'TimeoutError' || error.name === 'AbortError'
      || RETRYABLE_NETWORK_ERROR_CODES.has(error.cause?.code ?? error.code)
      || error.message === 'terminated' || error.message === 'socket hang up'
      || (error.message === 'fetch failed' && !error.cause),
  });
}

function providerRead(url, token, operation) {
  return jsonRequest(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, operation);
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
    const body = await providerRead(`https://api.cloudflare.com/client/v4/accounts/${account}/workers${path}`,
      env.CLOUDFLARE_API_TOKEN, operation);
    requireValue(body.success === true && body.result != null, `${operation} returned no result.`);
    return body.result;
  };
  const script = `/scripts/${encodeURIComponent(name)}`;
  const github = (path, operation) => providerRead(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`,
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

export async function verifyDispatcher(session, readPolicy, organizationId) {
  const token = session?.access_token;
  requireValue(typeof token === 'string' && token && session.user?.role === 'authenticated'
    && session.user.app_metadata?.dev_design_sweep === dispatcherRole, dispatcherError);

  const result = await readPolicy(token);
  const policy = result?.eval;
  const caps = policy?.granted_capabilities;
  requireValue(result?.ok === true && policy?.allowed === true && policy.scope_type === scope
    && typeof organizationId === 'string' && policy.scope_id === organizationId
    && Array.isArray(policy.role_keys) && policy.role_keys.length === 1 && policy.role_keys[0] === dispatcherRole
    && Array.isArray(caps) && dispatcherRequired.every(cap => caps.includes(cap))
    && caps.every(cap => dispatcherRequired.includes(cap) || optional.includes(cap)), dispatcherError);
}

async function seedDispatcher(db, { organizationId, email, tag }, userId) {
  const rows = await ensureTenantRole(async (sql, params) => (await db.query(sql, params)).rows,
    organizationId, dispatcherRole, dispatcherRequired);
  requireFixture(rows.length === 1, dispatcherError);
  await db.query(`INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES ($1, $2, $3, $4, $5, 'active', $6)`, [userId, organizationId, email, tag, dispatcherRole, scope]);
}

export async function runDispatcherReadout(environment, readShipment, runFixture = withDevFixture) {
  requireValue(scope === 'tenant' && [...dispatcherRequired, ...optional].every(cap => /^[a-z_]+\.read$/.test(cap))
    && ['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME)
    && normalizeTrustedOrigin(environment.VITE_SUPABASE_URL) === preview.buildSupabaseProjectUrl(environment.SUPABASE_PROJECT_REF),
  dispatcherError);
  const receipt = await runFixture(environment, {
    prefix: 'dev-console-v2-probe',
    marker: 'dev_console_v2_probe',
    appMetadata: { dev_design_sweep: dispatcherRole },
    exit: dispatcherFixtureExit,
    seedUser: seedDispatcher,
  }, readShipment).catch(error => {
    if (error instanceof FixtureError) throw new DeployError(dispatcherError);
    throw error;
  });
  if (receipt.cleanupErrors.length) {
    if (receipt.error) console.error(receipt.error instanceof DeployError ? receipt.error.message : dispatcherError);
    throw new DeployError(dispatcherCleanupError, dispatcherCleanupExit);
  }
  if (receipt.error instanceof DeployError) throw receipt.error;
  requireValue(!receipt.error && receipt.cleaned, dispatcherError);
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

  await runDispatcherReadout(env, fixture => readDispatcher(origin, fixture));
  appendFileSync(env.GITHUB_STEP_SUMMARY,
    '\nExact commit marker, security headers, live dispatcher shipment read, and fixture cleanup verified.\n');
}

async function readDispatcher(origin, { organizationId, projectUrl, credentials, signIn, tracking }) {
  const { chromium } = await import('@playwright/test');
  const { gotoSurface, waitForLiveResourceList, waitForLiveRpc } =
    await import('../../apps/console-v2/tests/e2e/fixtures.ts');
  const browserEnv = { ...env };
  delete browserEnv.SUPABASE_ACCESS_TOKEN;
  delete browserEnv.SUPABASE_DB_PASSWORD;
  const browser = await chromium.launch({ env: browserEnv });
  try {
    const page = await browser.newPage({ baseURL: origin });
    const dispatcher = Promise.withResolvers();
    // Verify the user and policy with the same session before the app can use it.
    await page.route(url => url.origin === projectUrl && url.pathname === '/auth/v1/token'
      && url.searchParams.get('grant_type') === 'password', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      try {
        const posted = route.request().postDataJSON();
        requireValue(posted?.email === credentials.email && posted?.password === credentials.password, dispatcherError);
        let response;
        const session = await signIn(async () => {
          response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
          requireValue(response.ok(), dispatcherError);
          return response.json();
        });
        await verifyDispatcher(session, token => jsonRequest(
          new URL('/rest/v1/rpc/user_capability_eval_v2', projectUrl), {
            method: 'POST',
            headers: {
              apikey: env.VITE_SUPABASE_ANON_KEY,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Profile': 'api',
            },
            body: JSON.stringify({ p_args: { capability_key: 'shipments.read' } }),
          }, dispatcherError,
        ), organizationId);
        await route.fulfill({ response });
        dispatcher.resolve();
      } catch {
        dispatcher.reject(new DeployError(dispatcherError));
        await route.abort().catch(() => {});
      }
    });
    await Promise.all([
      dispatcher.promise,
      waitForLiveRpc(page, 'ui_me_v1'),
      waitForLiveResourceList(page, 'shipments'),
      gotoSurface(page, '/operate/shipments', credentials),
    ]);
    await page.waitForURL(new URL('/operate/shipments', origin).href);
    await page.locator('.dt__table tbody tr').getByText(tracking, { exact: true }).waitFor();
    requireValue(await markerMatches(origin), 'The DEV commit marker changed during the dispatcher readout.');
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError('The DEV dispatcher did not render a shipment from the live API.');
  } finally {
    await browser.close();
  }
}

const commands = {
  build: prepare,
  bundle: () => workerCommand(['versions', 'upload', '--dry-run'], 'Wrangler could not bundle Console V2.'),
  deploy,
  readout,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  try {
    requireValue(Object.hasOwn(commands, command), 'Expected build, bundle, deploy, or readout.');
    await commands[command]();
  } catch (error) {
    // Provider and browser errors can contain private origins or request data.
    console.error(error instanceof DeployError ? error.message : `Console V2 ${command} failed.`);
    process.exitCode = error instanceof DeployError ? error.exitCode : 1;
  }
}
