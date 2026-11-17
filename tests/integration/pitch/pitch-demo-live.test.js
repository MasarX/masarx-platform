// Plan: PLAN-202601-pitch-live-tests / Step: S01
// Live pitch demo integration tests (guarded).
// These intentionally exercise the real cloud edge pipeline; they are skipped unless enabled.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadEnv } = require('../../../scripts/utils/load-env');

loadEnv();

const liveEnabled = String(process.env.RUN_LIVE_PITCH_TESTS || '').trim().toLowerCase() === 'true';

function describeIf(cond) {
  return cond ? describe : describe.skip;
}

function safeReadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function requireNonEmpty(name, value) {
  const v = String(value || '').trim();
  if (!v) throw new Error(`[pitch-live] Missing required env: ${name}`);
  return v;
}

function resolveSecretsPath() {
  const fromEnv = String(process.env.MASARX_LIVE_DEMO_SECRETS_FILE || '').trim();
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), 'tmp', 'masarx-live-demo', 'secrets.json');
}

function safeReadJson(filePath) {
  try {
    const raw = safeReadFile(filePath);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveApiGatewayToken({ secretsPath } = {}) {
  const secrets = secretsPath ? safeReadJson(secretsPath) : null;
  const fromSecrets = String(secrets?.api_gateway?.token || '').trim();
  if (fromSecrets) return fromSecrets;

  const envToken = String(process.env.MASARX_API_GATEWAY_TOKEN || '').trim();
  if (envToken) return envToken;

  // Optional local helper: a developer may have provisioned a token file under tmp/
  // (this file is expected to be untracked and MUST NOT be committed).
  const tokenPath = path.resolve(process.cwd(), 'tmp', 'masarx-api-gateway-demo.token');
  const tokenFromFile = String(safeReadFile(tokenPath) || '').trim();
  return tokenFromFile || '';
}

function runProvisionScript({ secretsOut, rotateTokens = false, timeoutMs = 4 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const nodeExe = process.execPath;
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'demo', 'provision-masarx-live-demo.js');
    const args = [scriptPath, '--secrets-out', secretsOut];
    if (rotateTokens) args.push('--rotate-tokens');

    const child = spawn(nodeExe, args, {
      env: {
        ...process.env,
        ENV_FILE: process.env.ENV_FILE || path.resolve(process.cwd(), 'config', 'env', '.env.cloud'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`[pitch-live] provision timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      if (stdout.length > 120_000) stdout = stdout.slice(-120_000);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 120_000) stderr = stderr.slice(-120_000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = `${stdout}\n${stderr}`.slice(-6000);
        reject(new Error(`[pitch-live] provision failed (code=${code}). tail=\n${tail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureProvisionedSecrets(secretsPath) {
  const rotate = String(process.env.ROTATE_LIVE_DEMO_TOKENS || '').trim().toLowerCase() === 'true';
  const existing = safeReadJson(secretsPath);

  if (!existing || rotate) {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    await runProvisionScript({ secretsOut: secretsPath, rotateTokens: rotate });
  }

  const secrets = safeReadJson(secretsPath);
  if (!secrets) throw new Error(`[pitch-live] Failed to read secrets JSON: ${secretsPath}`);

  const token = String(secrets?.api_gateway?.token || '').trim();
  if (!token) throw new Error(`[pitch-live] Provisioned secrets missing api_gateway.token: ${secretsPath}`);

  const orgId = String(secrets?.organization_id || secrets?.organizationId || '').trim();
  const clientId = String(secrets?.client_id || secrets?.clientId || '').trim();
  if (!orgId || !clientId) {
    throw new Error(`[pitch-live] Provisioned secrets missing org/client ids: ${secretsPath}`);
  }

  return secrets;
}

function resolveLiveShortCode() {
  const envCode = String(process.env.LIVE_SA_SHORT_CODE || '').trim();
  if (envCode) return envCode;

  // Optional local helper: reuse the last short code from the live pitch menu state.
  // This file is expected to be untracked/local state.
  const menuPath = path.resolve(process.cwd(), 'tmp', 'live-pitch-demo', 'masarx-mkt', 'menu_state.json');
  try {
    if (!fs.existsSync(menuPath)) return '';
    const parsed = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
    const last = Array.isArray(parsed?.last_short_codes) ? parsed.last_short_codes[0] : '';
    return String(last || '').trim().toUpperCase();
  } catch {
    return '';
  }
}

function runDemoScript(args, { env = {}, timeoutMs = 12 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const nodeExe = process.execPath;
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'demo', 'masarx-live-e2e-demo.js');

    const child = spawn(nodeExe, [scriptPath, ...args], {
      env: {
        ...process.env,
        // Ensure demo script uses the cloud env file when launched from Jest.
        ENV_FILE: process.env.ENV_FILE || path.resolve(process.cwd(), 'config', 'env', '.env.cloud'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`[pitch-live] demo timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function shouldRotateTokensForRun({ out, stdout, stderr } = {}) {
  try {
    const failed = Array.isArray(out?.failed) ? out.failed : [];
    const hasAuthFailure = failed.some(
      (x) => Number(x?.http_status || 0) === 401 && String(x?.error || '').trim() === 'api_gateway_failed',
    );
    if (hasAuthFailure) return true;
  } catch {}

  const combined = `${String(stdout || '')}\n${String(stderr || '')}`;
  return combined.includes('api_gateway_failed') && combined.includes('http=401');
}

async function runDemoWithAutoRotate(
  args,
  {
    secretsPath,
    outPath,
    env = {},
    timeoutMs,
  } = {},
) {
  const first = await runDemoScript(
    [...args, '--out', outPath],
    { env, timeoutMs },
  );

  const firstOut = safeReadJson(outPath);
  if (shouldRotateTokensForRun({ out: firstOut, stdout: first.stdout, stderr: first.stderr })) {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    await runProvisionScript({ secretsOut: secretsPath, rotateTokens: true });
    return runDemoScript(
      [...args, '--out', outPath],
      { env, timeoutMs },
    );
  }

  return first;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function mkOutPath(suffix) {
  const dir = path.resolve(process.cwd(), 'tmp', 'live-pitch-demo');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `pitch-live-${suffix}-${ts}.json`);
}

jest.setTimeout(12 * 60 * 1000);

describeIf(liveEnabled)('Pitch demo (live) — Option 1 shipments + labels', () => {
  const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
  const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
  const secretsPath = resolveSecretsPath();
  let provisioned;

  beforeAll(async () => {
    requireNonEmpty('SUPABASE_URL', SUPABASE_URL);
    requireNonEmpty('SUPABASE_ANON_KEY', SUPABASE_ANON_KEY);
    requireNonEmpty('DATABASE_URL', DATABASE_URL);

    provisioned = await ensureProvisionedSecrets(secretsPath);

    const token = resolveApiGatewayToken({ secretsPath });
    requireNonEmpty('api_gateway token (from secrets/provisioning)', token);
  });

  test('short-code + labels: creates shipment, completes workflows, renders label', async () => {
    const token = resolveApiGatewayToken({ secretsPath });
    const shortCode = resolveLiveShortCode();
    if (!shortCode) {
      throw new Error(
        '[pitch-live] Missing LIVE_SA_SHORT_CODE and could not auto-resolve from tmp/live-pitch-demo/masarx-mkt/menu_state.json',
      );
    }

    const outPath = mkOutPath('short-code-labels');

    const { code, stdout, stderr } = await runDemoWithAutoRotate(
      [
        '--secrets',
        secretsPath,
        '--count',
        '1',
        '--concurrency',
        '1',
        '--ai-ratio',
        '0',
        '--long-line-ratio',
        '0',
        '--single-label-count',
        '1',
        '--workflow-timeout-ms',
        '240000',
        '--short-codes',
        shortCode,
      ],
      {
        secretsPath,
        outPath,
        env: {
          // Provided for debugging, but demo prefers the secrets file token when present.
          MASARX_API_GATEWAY_TOKEN: token,
          PITCH_LOG_JSON: '1',
        },
      },
    );

    if (code !== 0) {
      const tail = `${stdout}\n${stderr}`.slice(-8000);
      throw new Error(`[pitch-live] demo failed (code=${code}). tail=\n${tail}`);
    }

    const out = readJson(outPath);
    expect(Array.isArray(out.created)).toBe(true);
    expect(out.created.length).toBe(1);
    expect(Array.isArray(out.failed)).toBe(true);
    expect(out.failed.length).toBe(0);

    expect(out.labels_skipped).toBe(false);

    // Ensure we exercised the Saudi short code path.
    expect(out.decoded_summary).toBeTruthy();
    expect(Number(out.decoded_summary.short_code_present || 0)).toBeGreaterThanOrEqual(1);

    // Ensure workflow ran and did not leave pending steps.
    expect(out.workflow_step_timings).toBeTruthy();
    expect(Number(out.workflow_step_timings.workflow_run_count || 0)).toBeGreaterThanOrEqual(1);

    const issues = Array.isArray(out.workflow_issues) ? out.workflow_issues : [];
    expect(issues.some((x) => String(x).includes('workflow_runs_missing'))).toBe(false);
    expect(issues.some((x) => String(x).includes('workflow_pending_steps'))).toBe(false);

    // Label proof: at least one single label signed URL OR label job summary exists.
    const labels = Array.isArray(out.labels_single) ? out.labels_single : [];
    const hasSignedUrl = labels.some((l) => l && typeof l.signed_url === 'string' && l.signed_url.length > 0);
    expect(hasSignedUrl || out.label_job_summary).toBeTruthy();
  });

  test('no short-code + skip-labels: creates shipment, completes workflows, no label work', async () => {
    const token = resolveApiGatewayToken({ secretsPath });
    const outPath = mkOutPath('no-short-code-skip-labels');

    const { code, stdout, stderr } = await runDemoWithAutoRotate(
      [
        '--secrets',
        secretsPath,
        '--count',
        '1',
        '--concurrency',
        '1',
        '--ai-ratio',
        '0',
        '--long-line-ratio',
        '0',
        '--skip-labels',
        '--workflow-timeout-ms',
        '240000',
      ],
      {
        secretsPath,
        outPath,
        env: {
          MASARX_API_GATEWAY_TOKEN: token,
          PITCH_LOG_JSON: '1',
        },
      },
    );

    if (code !== 0) {
      const tail = `${stdout}\n${stderr}`.slice(-8000);
      throw new Error(`[pitch-live] demo failed (code=${code}). tail=\n${tail}`);
    }

    const out = readJson(outPath);
    expect(Array.isArray(out.created)).toBe(true);
    expect(out.created.length).toBe(1);
    expect(Array.isArray(out.failed)).toBe(true);
    expect(out.failed.length).toBe(0);

    expect(out.labels_skipped).toBe(true);

    expect(out.workflow_step_timings).toBeTruthy();
    expect(Number(out.workflow_step_timings.workflow_run_count || 0)).toBeGreaterThanOrEqual(1);

    const issues = Array.isArray(out.workflow_issues) ? out.workflow_issues : [];
    expect(issues.some((x) => String(x).includes('workflow_runs_missing'))).toBe(false);
  });

  test('progress UX: emits heartbeat/progress lines (never appears hung)', async () => {
    const token = resolveApiGatewayToken({ secretsPath });
    const outPath = mkOutPath('progress-ux');

    const { code, stdout, stderr } = await runDemoWithAutoRotate(
      [
        '--secrets',
        secretsPath,
        '--count',
        '1',
        '--concurrency',
        '1',
        '--ai-ratio',
        '0',
        '--long-line-ratio',
        '0',
        '--skip-labels',
        '--workflow-timeout-ms',
        '240000',
      ],
      {
        secretsPath,
        outPath,
        env: {
          MASARX_API_GATEWAY_TOKEN: token,
          // Ensure text logs (not JSON)
          PITCH_LOG_JSON: '0',
        },
      },
    );

    if (code !== 0) {
      const tail = `${stdout}\n${stderr}`.slice(-8000);
      throw new Error(`[pitch-live] demo failed (code=${code}). tail=\n${tail}`);
    }

    expect(stdout).toMatch(/Creating shipments \(live\)\.{3}/);
    expect(stdout).toMatch(/Shipments created:/);
    expect(stdout).toMatch(/Workflow wait:/);

    // Heartbeat lines include elapsed=...s
    expect(stdout).toMatch(/elapsed=\d+s/);
  });

  test('3PL webhook/correlation (optional): exercise logestechs sweep when enabled', async () => {
    const live3pl = String(process.env.RUN_LIVE_3PL_TESTS || '').trim().toLowerCase() === 'true';
    if (!live3pl) return;

    const token = resolveApiGatewayToken({ secretsPath });
    const outPath = mkOutPath('logestechs-sweep');

    const { code, stdout, stderr } = await runDemoWithAutoRotate(
      [
        '--secrets',
        secretsPath,
        '--count',
        '1',
        '--concurrency',
        '1',
        '--ai-ratio',
        '0',
        '--long-line-ratio',
        '0',
        '--skip-labels',
        '--workflow-timeout-ms',
        '240000',
        '--exercise-logestechs',
      ],
      {
        secretsPath,
        outPath,
        env: {
          MASARX_API_GATEWAY_TOKEN: token,
          PITCH_LOG_JSON: '1',
        },
        timeoutMs: 15 * 60 * 1000,
      },
    );

    if (code !== 0) {
      const tail = `${stdout}\n${stderr}`.slice(-8000);
      throw new Error(`[pitch-live] demo failed (code=${code}). tail=\n${tail}`);
    }

    const out = readJson(outPath);
    expect(out.logestechs_sweep).toBeTruthy();
    if (out.logestechs_sweep && out.logestechs_sweep.ok === false) {
      throw new Error(`[pitch-live] logestechs_sweep failed: ${out.logestechs_sweep.error || 'unknown'}`);
    }
    expect(typeof out.logestechs_sweep.count).toBe('number');
  });
});
