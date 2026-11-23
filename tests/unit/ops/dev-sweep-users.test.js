const { spawnSync } = require('node:child_process');
const { randomBytes, X509Certificate } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { buildSupabaseProjectUrl } = require('../../../scripts/ops/workspace/preview-project');

const root = resolve(__dirname, '../../..');
const workflowPath = '.github/workflows/dev-sweep-users.yml';
const scriptPath = 'scripts/deploy/dev-sweep-users.mjs';
const helperPath = 'scripts/dev/fetch-sweep-credentials.mjs';
const read = path => readFileSync(join(root, path), 'utf8');
const workflow = parse(read(workflowPath));
const job = workflow.jobs.provision;
const pin = job.steps.find(step => step.run).env.SWEEP_RECIPIENT_SHA256;
const roles = JSON.parse(read('config/dev/sweep-roles.json'));
const certificate = read('config/dev/sweep-recipient.crt');
const dispatch = {
  GITHUB_ACTIONS: 'true', DEPLOY_ENV: 'dev', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'MasarX/masarx-platform',
};

test('sweep provisioning has one canonical DEV main dispatch job and only uploads an encrypted artifact', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.environment.options).toEqual(['dev']);
  expect(Object.keys(workflow.jobs)).toEqual(['provision']);
  expect(job.environment).toBe('dev');
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.environment == 'dev' && github.ref == 'refs/heads/main' && github.repository == 'MasarX/masarx-platform'");
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
  const database = parse(read('.github/workflows/deploy.yml')).jobs.database;
  expect(job.concurrency).toEqual(database.concurrency);
  expect(job.steps[0].uses).toBe(database.steps.find(step => step.uses?.startsWith('actions/checkout')).uses);
  expect(job.steps[0].with['persist-credentials']).toBe(false);
  expect(job.steps[1].uses).toBe(database.steps.find(step => step.uses?.startsWith('actions/setup-node')).uses);
  expect(job.steps.filter(step => step.uses).every(step => /@[0-9a-f]{40}$/.test(step.uses))).toBe(true);
  expect(job.steps.at(-1).with).toEqual({
    name: 'dev-sweep-credentials', path: '${{ runner.temp }}/dev-sweep-credentials.cms',
    'if-no-files-found': 'error', 'retention-days': 1,
  });
  for (const path of readdirSync(join(root, '.github/workflows')).filter(path => path !== 'dev-sweep-users.yml')) {
    expect(read(`.github/workflows/${path}`)).not.toMatch(/dev-sweep-users\.(?:yml|mjs)|dev-sweep-credentials/);
  }
});

test.each([
  ['stg', { DEPLOY_ENV: 'stg' }],
  ['prod', { DEPLOY_ENV: 'prod' }],
  ['unset', { DEPLOY_ENV: undefined }],
  ['push', { GITHUB_EVENT_NAME: 'push' }],
  ['branch', { GITHUB_REF: 'refs/heads/dev' }],
  ['local', { GITHUB_ACTIONS: '' }],
])('sweep provisioning rejects the %s dispatch context before configuration or credentials', (_, env) => {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root, env: { ...process.env, ...dispatch, ...env }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('sweep_error=dispatch_guard');
});

test('sweep delivery source contains no literal account address, hostname or credential', () => {
  const source = [scriptPath, helperPath, workflowPath, 'config/dev/sweep-roles.json'].map(read).join('\n');
  expect(source).not.toMatch(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i);
  expect(source).not.toMatch(/(?:https?:\/\/|\b)(?:[a-z0-9-]+\.)+(?:com|co|org|net|io|app|dev|invalid)\b/i);
  expect(source).not.toMatch(/['"`](?:sbp_|sb_secret_|eyJ)[\w.-]{16,}['"`]|-----BEGIN .*PRIVATE KEY-----/);
});

test('sweep role configuration only grants reviewed read capabilities to nonprivileged personas', () => {
  expect(Object.keys(roles)).toEqual(['finance_viewer', 'sender_user']);
  for (const [key, role] of Object.entries(roles)) {
    expect(key).not.toMatch(/admin|owner|service|platform/);
    expect(['tenant', 'sender']).toContain(role.scope);
    expect([...role.required, ...role.optional].every(cap => /^[a-z_]+\.read$|^labels\.download$/.test(cap))).toBe(true);
  }
});

test('sweep recipient certificate is public and matches the workflow fingerprint pin', () => {
  expect(certificate.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
  expect(certificate).not.toContain('PRIVATE KEY');
  expect(new X509Certificate(certificate).fingerprint256).toBe(pin);
});

test('sweep fetch helper refuses a repository output before invoking the caller GitHub CLI', () => {
  const result = spawnSync(process.execPath, [helperPath, '--run', '1', '--key', 'unused', '--out', 'config/dev/output.json'], {
    cwd: root, env: { ...process.env, GH_CLI: 'unavailable' }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('Choose an output path outside the repository.');
  expect(existsSync(join(root, 'config/dev/output.json'))).toBe(false);
});

test('sweep fetch helper accepts a new output path outside the checkout across volumes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'masarx-sweep-fetch-test-'));
  const output = join(directory, 'credentials.json');
  try {
    const result = spawnSync(process.execPath, [helperPath, '--run', '1', '--key', 'unused', '--out', output], {
      cwd: root, env: { ...process.env, GH_CLI: join(directory, 'unavailable') }, encoding: 'utf8', windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Could not download the encrypted sweep artifact.');
    expect(existsSync(output)).toBe(false);
  } finally {
    rmdirSync(directory);
  }
});

test('sweep provisioner masks generated passwords before use and emits fixed labels after CMS encryption', async () => {
  const { provisionSweep } = await import('../../../scripts/deploy/dev-sweep-users.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'masarx-sweep-test-'));
  const projectRef = 'a'.repeat(20);
  const projectUrl = buildSupabaseProjectUrl(projectRef);
  const token = randomBytes(24).toString('hex');
  const orgId = '10000000-0000-4000-8000-000000000000';
  const senderId = '20000000-0000-4000-8000-000000000000';
  const serviceKey = ['synthetic', Buffer.from(JSON.stringify({ role: 'service_role', ref: projectRef })).toString('base64url'), 'synthetic'].join('.');
  const masked = new Set();
  const labels = [];
  const users = new Map();
  const profiles = new Set();
  const passwords = [];
  let emailEnabled = false;
  let unexpectedCapability = false;
  const log = jest.spyOn(console, 'log').mockImplementation(line => {
    if (line.startsWith('::add-mask::')) masked.add(line.slice('::add-mask::'.length));
    else labels.push(line);
  });
  const response = payload => ({ ok: true, json: async () => payload });
  const request = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    const providerPath = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    const authorized = options.headers.authorization.split(' ')[1];
    if (!masked.has(authorized)) throw new Error('unmasked authorization');
    if (providerPath.endsWith('/config/auth')) return response({ external_email_enabled: emailEnabled });
    if (providerPath.endsWith('/api-keys')) return response([{ name: 'service_role', api_key: serviceKey }]);
    if (providerPath.endsWith('/database/query')) {
      const { query, parameters, read_only: readOnly } = body;
      if (query.includes('FROM auth.users') && readOnly) {
        const user = users.get(parameters[0]);
        return response(user ? [{ id: user.id, role: user.role, sweep: user.app_metadata.dev_design_sweep }] : []);
      }
      if (query.includes('INSERT INTO public.organizations') && !readOnly) {
        return response([{ organization_id: orgId, sender_id: senderId }]);
      }
      if (query.includes('resolve_access_control_policy_v1') && readOnly) {
        const key = parameters[3];
        const capabilities = [...roles[key].required, ...(unexpectedCapability ? ['system.write'] : [])];
        return response([{ roles: [key], capabilities }]);
      }
      if (query.includes('INSERT INTO public.users') && !readOnly) {
        const [id, organizationId, email, , role, scope, scopeId] = parameters;
        if (organizationId !== orgId || role !== users.get(email)?.app_metadata.dev_design_sweep ||
            scope !== roles[role].scope || scopeId !== (scope === 'sender' ? senderId : null)) {
          throw new Error('incorrect synthetic scope');
        }
        profiles.add(id);
        return response([{ id }]);
      }
    }
    if (!masked.has(body?.password) || body.password.length < 24) throw new Error('unsafe simulated password');
    passwords.push(body.password);
    if (providerPath.endsWith('/admin/users') && options.method === 'POST') {
      if (!masked.has(body.email) || body.email_confirm !== true) throw new Error('unsafe simulated account');
      const user = {
        id: `30000000-0000-4000-8000-00000000000${users.size}`,
        email: body.email, role: 'authenticated', app_metadata: body.app_metadata,
      };
      users.set(body.email, user);
      return response(user);
    }
    if (options.method === 'PUT') {
      const id = providerPath.split('/').at(-1);
      return response({ user: [...users.values()].find(user => user.id === id && profiles.has(id)) });
    }
    throw new Error('unexpected simulated request');
  });
  try {
    const env = {
      ...dispatch, SUPABASE_PROJECT_REF: projectRef, NEXT_PUBLIC_SUPABASE_URL: projectUrl,
      SUPABASE_ACCESS_TOKEN: token, SWEEP_RECIPIENT_SHA256: pin, RUNNER_TEMP: directory,
    };
    const artifact = join(directory, 'dev-sweep-credentials.cms');
    await expect(provisionSweep(env)).rejects.toBeDefined();
    expect(labels.splice(0)).toEqual(['password_sign_in=disabled']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory)).toEqual([]);

    emailEnabled = true;
    for (const _run of [1, 2]) {
      await provisionSweep(env);
      expect(labels.splice(0)).toEqual(['password_sign_in=enabled', 'users_ready=2', 'roles=finance_viewer,sender_user']);
      expect(readdirSync(directory)).toEqual(['dev-sweep-credentials.cms']);
      expect(spawnSync('openssl', ['cms', '-cmsout', '-inform', 'DER', '-in', artifact], {
        stdio: 'ignore', windowsHide: true,
      }).status).toBe(0);
      rmSync(artifact);
    }
    expect(users.size).toBe(2);
    expect(profiles.size).toBe(2);
    expect(new Set(passwords).size).toBe(4);

    unexpectedCapability = true;
    await expect(provisionSweep(env)).rejects.toBeDefined();
    expect(labels.splice(0)).toEqual(['password_sign_in=enabled']);
    expect(passwords).toHaveLength(4);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    request.mockRestore();
    log.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
