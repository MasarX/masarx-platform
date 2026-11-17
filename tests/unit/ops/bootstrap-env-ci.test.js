const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getJwtRole } = require('../../../scripts/utils/jwt');
const { isLikelyJwtToken } = require('../../../scripts/ops/workspace/supabase-admin-keys');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'bootstrap-env-ci.js');

function baseEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '',
    TMP: process.env.TMP || '',
    TEMP: process.env.TEMP || '',
    SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_ANON_KEY: 'anon-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
    SUPABASE_DB_PASSWORD: 'password123',
    EDGE_REQUIRE_DB_JWT: '0',
    ...overrides,
  };
}

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwtWithIssuer(issuer, extraPayload = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { role: 'service_role', iss: issuer, ...extraPayload };
  return `${encodeBase64UrlJson(header)}.${encodeBase64UrlJson(payload)}.signature`;
}

function makeUnsignedRoleJwt(role, extraPayload = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role,
    iss: 'supabase',
    sub: 'edge-function',
    aud: 'authenticated',
    iat: 1_700_000_000,
    exp: 2_000_000_000,
    ...extraPayload,
  };
  return `${encodeBase64UrlJson(header)}.${encodeBase64UrlJson(payload)}.signature`;
}

function signJwtWithSecret(secret, payload) {
  const headerPart = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerPart}.${payloadPart}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${signature}`;
}

function makeSignedSupabaseApiKey({ secret, role, projectRef = 'abcdefghijklmnopqrst' }) {
  return signJwtWithSecret(secret, {
    role,
    iss: 'supabase',
    ref: projectRef,
    iat: 1_700_000_000,
    exp: 2_000_000_000,
  });
}

function getOutputVar(stdout, name) {
  const line = String(stdout || '')
    .split('\n')
    .find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : '';
}

function runScript({ cwd, env, args = ['--target', 'stdout'] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function startMgmtServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('bootstrap-env-ci', () => {
  test('writes file-mode credentials only to the explicit temporary path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-explicit-file-'));
    const runnerTemp = path.join(tmp, 'runner-temp');
    const outputPath = path.join(runnerTemp, 'mobile-backend.env');
    fs.mkdirSync(runnerTemp, { recursive: true });

    try {
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({ RUNNER_TEMP: runnerTemp }),
        args: ['--target', 'file', '--file-path', outputPath],
      });

      expect(res.status).toBe(0);
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf8')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
      expect(fs.existsSync(path.join(tmp, 'config', 'env', '.env.cloud'))).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects explicit credential files outside RUNNER_TEMP', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-outside-temp-'));
    const runnerTemp = path.join(tmp, 'runner-temp');
    fs.mkdirSync(runnerTemp, { recursive: true });
    try {
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({ RUNNER_TEMP: runnerTemp }),
        args: ['--target', 'file', '--file-path', path.join(tmp, 'outside.env')],
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toContain('direct child of RUNNER_TEMP');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing explicit credential file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-existing-file-'));
    const runnerTemp = path.join(tmp, 'runner-temp');
    const outputPath = path.join(runnerTemp, 'mobile-backend.env');
    fs.mkdirSync(runnerTemp, { recursive: true });
    fs.writeFileSync(outputPath, 'sentinel=keep\n', 'utf8');
    try {
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({ RUNNER_TEMP: runnerTemp }),
        args: ['--target', 'file', '--file-path', outputPath],
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toContain('must not already exist');
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('sentinel=keep\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.each([
    ['separate option', ['--target', 'file', '--file-path']],
    ['equals option', ['--target', 'file', '--file-path=']],
  ])('rejects an empty explicit credential path: %s', async (_label, args) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-empty-file-'));
    try {
      const res = await runScript({ cwd: tmp, env: baseEnv(), args });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toContain('--file-path requires a non-empty path');
      expect(fs.existsSync(path.join(tmp, 'config', 'env', '.env.cloud'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('rejects an explicit file path for non-file output modes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-invalid-file-'));
    try {
      const res = await runScript({
        cwd: tmp,
        env: baseEnv(),
        args: ['--target', 'stdout', '--file-path', path.join(tmp, 'unexpected.env')],
      });
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toContain('--file-path is valid only with --target file');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });


  // This file spawns subprocesses and temporary HTTP servers; the default Jest
  // timeout is too tight for full-suite CI contention on self-hosted runners.
  jest.setTimeout(30_000);

  test('supports stdout target without writing .env.cloud', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-stdout-'));
    const res = await runScript({
      cwd: tmp,
      env: baseEnv(),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
    expect(String(res.stdout || '')).toContain('DATABASE_URL=');
    expect(fs.existsSync(path.join(tmp, 'config', 'env', '.env.cloud'))).toBe(false);
  });

  test('supports github-env target by appending computed vars to GITHUB_ENV', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-ghenv-'));
    const githubEnvPath = path.join(tmp, 'github-env.txt');
    const res = await runScript({
      cwd: tmp,
      env: baseEnv({ GITHUB_ENV: githubEnvPath }),
      args: ['--target', 'github-env'],
    });

    expect(res.status).toBe(0);
    expect(fs.existsSync(githubEnvPath)).toBe(true);
    const body = fs.readFileSync(githubEnvPath, 'utf8');
    expect(body).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
    expect(body).toContain('DATABASE_URL=');
    expect(fs.existsSync(path.join(tmp, 'config', 'env', '.env.cloud'))).toBe(false);
  });

  test('resolves project ref from DATABASE_URL_DIRECT when SUPABASE_PROJECT_ID and SUPABASE_URL are missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dsn-ref-'));
    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        SUPABASE_PROJECT_ID: '',
        SUPABASE_URL: '',
        DATABASE_URL_DIRECT:
          (['postgresql',":","/","/",'postgres',":",'ixunzlzxsuhznqivpsshzgrw',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
    expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
  });

  test('resolves project ref from service-role JWT issuer when explicit project vars are missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-jwt-ref-'));
    const serviceRoleJwt = makeJwtWithIssuer('https://abcdefghijklmnopqrst.supabase.co/auth/v1');
    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        SUPABASE_PROJECT_ID: '',
        SUPABASE_URL: '',
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt,
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
    expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
  });

  test('resolves SUPABASE_ANON_KEY from management API when not provided', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && String(req.url || '').startsWith('/v1/projects/abcdefghijklmnopqrst/api-keys')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', api_key: 'anon-from-api' },
            { name: 'service_role', api_key: 'service-from-api' },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-anon-api-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_ANON_KEY: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_ANON_KEY=anon-from-api');
    } finally {
      await closeServer(server);
    }
  });

  test('preserves explicit valid service-role JWT while still refreshing anon from Management API', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects/abcdefghijklmnopqrst/api-keys') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', api_key: 'anon-from-api' },
            { name: 'service_role', api_key: 'service-from-api' },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-service-api-'));
      const explicitServiceRoleJwt = makeJwtWithIssuer(
        'https://abcdefghijklmnopqrst.supabase.co/auth/v1',
        { ref: 'abcdefghijklmnopqrst' },
      );
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_ANON_KEY: 'anon-from-env',
          SUPABASE_SERVICE_ROLE_KEY: explicitServiceRoleJwt,
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_ANON_KEY=anon-from-api');
      expect(String(res.stdout || '')).toContain(
        `SUPABASE_SERVICE_ROLE_KEY=${explicitServiceRoleJwt}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  test('keeps legacy service_role key in SUPABASE_SERVICE_ROLE_KEY and maps modern key to SUPABASE_SECRET_KEY', async () => {
    const legacyServiceRoleJwt = makeJwtWithIssuer(
      'https://abcdefghijklmnopqrst.supabase.co/auth/v1',
      { ref: 'abcdefghijklmnopqrst' },
    );
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects/abcdefghijklmnopqrst/api-keys') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', type: 'publishable', api_key: 'sb_publishable_from_api' },
            { name: 'service_role', type: 'legacy', api_key: legacyServiceRoleJwt },
            { name: 'secret', type: 'secret', api_key: 'sb_secret_from_api' },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-key-split-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_ANON_KEY: 'anon-from-env',
          SUPABASE_SERVICE_ROLE_KEY: 'service-from-env',
          SUPABASE_SECRET_KEY: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_ANON_KEY=sb_publishable_from_api');
      expect(String(res.stdout || '')).toContain(
        `SUPABASE_SERVICE_ROLE_KEY=${legacyServiceRoleJwt}`,
      );
      expect(String(res.stdout || '')).toContain('SUPABASE_SECRET_KEY=sb_secret_from_api');
    } finally {
      await closeServer(server);
    }
  });

  test('preserves explicit modern secret key over Management API secret-key override', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects/abcdefghijklmnopqrst/api-keys') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', type: 'publishable', api_key: 'sb_publishable_from_api' },
            { name: 'secret', type: 'secret', api_key: 'sb_secret_from_api' },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-secret-preserve-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_SECRET_KEY: 'sb_secret_explicit',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_explicit',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_SECRET_KEY=sb_secret_explicit');
    } finally {
      await closeServer(server);
    }
  });

  test('resolves project ref from management API project listing when direct hints are missing', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects?organization_id=org-test') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { ref: 'abcdefghijklmnopqrst' },
            { ref: 'mnopqrstabcdefghijk' },
          ]),
        );
        return;
      }
      if (req.method === 'GET' && String(req.url || '').startsWith('/v1/projects/abcdefghijklmnopqrst/api-keys')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', api_key: 'anon-first-project' },
            { name: 'service_role', api_key: 'service-role-other' },
          ]),
        );
        return;
      }
      if (req.method === 'GET' && String(req.url || '').startsWith('/v1/projects/mnopqrstabcdefghijk/api-keys')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            { name: 'anon', api_key: 'anon-second-project' },
            { name: 'service_role', api_key: 'service-role-match' },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ee405d3f-82ff-4e1e-95dd-8b92ecc60669-list-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_PROJECT_ID: '',
          SUPABASE_URL: '',
          DATABASE_URL: '',
          DATABASE_URL_DIRECT: '',
          SUPABASE_ORG_ID: 'org-test',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-match',
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=mnopqrstabcdefghijk');
      expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://mnopqrstabcdefghijk.supabase.co');
    } finally {
      await closeServer(server);
    }
  });

  test('falls back to organization-scoped project discovery when /v1/projects returns empty', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/organizations') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ id: 'org-abc' }]));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/projects?organization_id=org-abc') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ ref: 'abcdefghijklmnopqrst' }]));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-org-fallback-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_PROJECT_ID: '',
          SUPABASE_URL: '',
          DATABASE_URL: '',
          DATABASE_URL_DIRECT: '',
          SUPABASE_ORG_ID: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-unmatched',
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
      expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
    } finally {
      await closeServer(server);
    }
  });

  test('resolves project ref from management project database host when ref field is absent', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              id: 'project-record-id',
              name: 'workspace-project',
              database: { host: 'db.abcdefghijklmnopqrst.supabase.co' },
            },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ee405d3f-82ff-4e1e-95dd-8b92ecc60669-shape-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_PROJECT_ID: '',
          SUPABASE_URL: '',
          DATABASE_URL: '',
          DATABASE_URL_DIRECT: '',
          SUPABASE_ORG_ID: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-unmatched',
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
      expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
    } finally {
      await closeServer(server);
    }
  });

  test('supports wrapped management payloads (data/items style) for project discovery', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/organizations') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'org-data' }] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/projects?organization_id=org-data') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: [
              {
                project: {
                  database: { host: 'db.abcdefghijklmnopqrst.supabase.co' },
                },
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ee405d3f-82ff-4e1e-95dd-8b92ecc60669-data-shape-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_PROJECT_ID: '',
          SUPABASE_URL: '',
          DATABASE_URL: '',
          DATABASE_URL_DIRECT: '',
          SUPABASE_ORG_ID: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-unmatched',
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
      expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
    } finally {
      await closeServer(server);
    }
  });

  test('resolves project ref from opaque service key candidate validated via project lookup', async () => {
    const { server, url } = await startMgmtServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/projects/abcdefghijklmnopqrst') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ref: 'abcdefghijklmnopqrst' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/projects') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([]));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/organizations') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([]));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'not found' }));
    });

    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-opaque-key-'));
      const res = await runScript({
        cwd: tmp,
        env: baseEnv({
          SUPABASE_PROJECT_ID: '',
          SUPABASE_URL: '',
          DATABASE_URL: '',
          DATABASE_URL_DIRECT: '',
          SUPABASE_ORG_ID: '',
          SUPABASE_ACCESS_TOKEN: 'supabase-access-token',
          SUPABASE_MGMT_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_aaa_abcdefghijklmnopqrst_bbb',
        }),
        args: ['--target', 'stdout'],
      });

      expect(res.status).toBe(0);
      expect(String(res.stdout || '')).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
      expect(String(res.stdout || '')).toContain('SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
    } finally {
      await closeServer(server);
    }
  });

  test('does not treat EDGE_INTERNAL_CALLER_ROLES as permission to substitute service_role', async () => {
    const serviceRoleFallbackKey = makeUnsignedRoleJwt('service_role');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dbjwt-fallback-'));
    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        SUPABASE_JWT_SECRET: '',
        EDGE_INTERNAL_CALLER_ROLES: 'edge_api_gateway_role,edge_webhook_role,service_role',
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleFallbackKey,
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).not.toBe(0);
    const output = `${String(res.stdout || '')}\n${String(res.stderr || '')}`;
    expect(output).toContain('Missing or untrusted SUPABASE_JWT_SECRET; cannot mint DB JWTs');
    expect(output).not.toContain(`WEBHOOK_DB_JWT=${serviceRoleFallbackKey}`);
  });

  test('keeps fail-closed behavior when service_role fallback is not allowed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dbjwt-fail-closed-'));
    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        SUPABASE_JWT_SECRET: '',
        EDGE_INTERNAL_CALLER_ROLES: 'edge_api_gateway_role,edge_webhook_role,edge_api_caller_role',
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).not.toBe(0);
    const output = `${String(res.stdout || '')}\n${String(res.stderr || '')}`;
    expect(output).toContain('Missing or untrusted SUPABASE_JWT_SECRET; cannot mint DB JWTs');
  });

  test('treats malformed provided DB JWT inputs as missing and remints role-scoped tokens', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dbjwt-remint-'));
    const jwtSecret = 'test-jwt-secret-remint';
    const serviceRoleKey = makeSignedSupabaseApiKey({ secret: jwtSecret, role: 'service_role' });
    const anonKey = makeSignedSupabaseApiKey({ secret: jwtSecret, role: 'anon' });

    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_ANON_KEY: anonKey,
        API_GATEWAY_DB_JWT: 'not-a-jwt',
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    const output = `${String(res.stdout || '')}\n${String(res.stderr || '')}`;
    expect(output).toContain('Invalid DB JWT input(s) detected (API_GATEWAY_DB_JWT)');

    const apiGatewayJwt = getOutputVar(res.stdout, 'API_GATEWAY_DB_JWT');
    expect(apiGatewayJwt).toBeTruthy();
    expect(apiGatewayJwt).not.toBe('not-a-jwt');
    expect(apiGatewayJwt.split('.')).toHaveLength(3);
    expect(getJwtRole(apiGatewayJwt)).toBe('edge_api_gateway_role');
  });

  test('treats stale-signature DB JWT inputs as missing and remints with current JWT secret', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dbjwt-stale-signature-'));
    const currentJwtSecret = 'jwt-secret-current';
    const staleJwtSecret = 'jwt-secret-stale';
    const serviceRoleKey = makeSignedSupabaseApiKey({ secret: currentJwtSecret, role: 'service_role' });
    const anonKey = makeSignedSupabaseApiKey({ secret: currentJwtSecret, role: 'anon' });
    const staleApiGatewayJwt = signJwtWithSecret(staleJwtSecret, {
      role: 'edge_api_gateway_role',
      iss: 'supabase',
      sub: 'edge-function',
      aud: 'authenticated',
      iat: 1_700_000_000,
      exp: 2_000_000_000,
    });

    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        EDGE_REQUIRE_DB_JWT: '1',
        SUPABASE_JWT_SECRET: currentJwtSecret,
        SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        SUPABASE_ANON_KEY: anonKey,
        API_GATEWAY_DB_JWT: staleApiGatewayJwt,
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    const output = `${String(res.stdout || '')}\n${String(res.stderr || '')}`;
    expect(output).toContain('Invalid DB JWT input(s) detected (API_GATEWAY_DB_JWT)');

    const apiGatewayJwt = getOutputVar(res.stdout, 'API_GATEWAY_DB_JWT');
    expect(apiGatewayJwt).toBeTruthy();
    expect(apiGatewayJwt).not.toBe(staleApiGatewayJwt);
    expect(getJwtRole(apiGatewayJwt)).toBe('edge_api_gateway_role');
  });

  test('rejects claims-shaped DB JWTs when neither signature nor hosted auth is trusted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-dbjwt-untrusted-'));
    const provided = {
      WEBHOOK_DB_JWT: makeUnsignedRoleJwt('edge_webhook_role'),
      API_CALLER_DB_JWT: makeUnsignedRoleJwt('edge_api_caller_role'),
      API_GATEWAY_DB_JWT: makeUnsignedRoleJwt('edge_api_gateway_role'),
      LABEL_RENDERER_DB_JWT: makeUnsignedRoleJwt('edge_label_renderer_role'),
    };
    const res = await runScript({ cwd: tmp, env: baseEnv({
      EDGE_REQUIRE_DB_JWT: '1', SUPABASE_JWT_SECRET: '',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_modern_non_jwt_key',
      SUPABASE_ANON_KEY: 'sb_publishable_modern_non_jwt_key', ...provided,
      EDGE_DB_JWT_VALIDATION_TIMEOUT_MS: '50', EDGE_DB_JWT_VALIDATION_ATTEMPTS: '1',
    }), args: ['--target', 'stdout'] });
    expect(res.status).not.toBe(0);
    const output = `${res.stdout}\n${res.stderr}`;
    expect(output).toMatch(/claim validation failed|Missing or untrusted/);
    expect(output).not.toContain(`WEBHOOK_DB_JWT=${provided.WEBHOOK_DB_JWT}`);
  });

  test('rebuilds service-role JWT from a verified project JWT secret while preserving modern secret key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-env-ci-rebuild-service-role-'));
    const jwtSecret = 'verified-project-jwt-secret';
    const anonJwt = makeSignedSupabaseApiKey({
      secret: jwtSecret,
      role: 'anon',
    });

    const res = await runScript({
      cwd: tmp,
      env: baseEnv({
        SUPABASE_ANON_KEY: anonJwt,
        SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_runtime_admin',
        SUPABASE_SECRET_KEY: 'sb_secret_runtime_admin',
        SUPABASE_JWT_SECRET: jwtSecret,
      }),
      args: ['--target', 'stdout'],
    });

    expect(res.status).toBe(0);
    const rebuiltServiceRole = getOutputVar(res.stdout, 'SUPABASE_SERVICE_ROLE_KEY');
    expect(isLikelyJwtToken(rebuiltServiceRole)).toBe(true);
    expect(getJwtRole(rebuiltServiceRole)).toBe('service_role');
    expect(getOutputVar(res.stdout, 'SUPABASE_SECRET_KEY')).toBe('sb_secret_runtime_admin');
  });
});

test.each(['optional-marketing-read-jwt', ''])(
  'bootstrap passes optional marketing read JWT without requiring or replacing it: %s',
  async (token) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-marketing-'));
    try {
      const result = await runScript({
        cwd: tmp,
        env: baseEnv({ MARKETING_DB_JWT: token }),
      });
      expect(result.status).toBe(0);
      if (token) expect(getOutputVar(result.stdout, 'MARKETING_DB_JWT')).toBe(token);
      else expect(result.stdout).not.toContain('MARKETING_DB_JWT=');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);
