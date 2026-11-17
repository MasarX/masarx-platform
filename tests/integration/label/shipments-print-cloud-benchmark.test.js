/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getJwtRole } = require('../../../scripts/utils/jwt');
const { getApiKeys, getProjectJwtSecret } = require('../../../scripts/ops/workspace/supabase-api');
const {
  buildEdgeDbJwtBundle,
  resolveJwtIssuer,
  resolveJwtSigningSecret,
} = require('../../../scripts/ops/workspace/edge-db-jwt');

const shouldRunBenchmark = process.env.RUN_SHIPMENTS_PRINT_BENCHMARK_TEST === 'true';
const benchmarkTest = shouldRunBenchmark ? test : test.skip;

function resolveBenchmarkScenarios(tmpDir) {
  const profile = String(process.env.SHIPMENTS_PRINT_BENCHMARK_PROFILE || 'quick').trim().toLowerCase();

  if (profile === 'final') {
    return [
      { label: 'single-optimize', boxes: 1, iterations: 5, out: path.join(tmpDir, 'single-optimize-5.json') },
      { label: 'multi-optimize', boxes: 5, iterations: 5, out: path.join(tmpDir, 'multi-optimize-5.json') },
      { label: 'single-candidate', boxes: 1, iterations: 10, out: path.join(tmpDir, 'single-candidate-10.json') },
      { label: 'multi-candidate', boxes: 5, iterations: 10, out: path.join(tmpDir, 'multi-candidate-10.json') },
      { label: 'single-final', boxes: 1, iterations: 20, out: path.join(tmpDir, 'single-final-20.json') },
      { label: 'multi-final', boxes: 5, iterations: 20, out: path.join(tmpDir, 'multi-final-20.json') },
    ];
  }

  if (profile === 'candidate') {
    return [
      { label: 'single-optimize', boxes: 1, iterations: 5, out: path.join(tmpDir, 'single-optimize-5.json') },
      { label: 'multi-optimize', boxes: 5, iterations: 5, out: path.join(tmpDir, 'multi-optimize-5.json') },
      { label: 'single-candidate', boxes: 1, iterations: 10, out: path.join(tmpDir, 'single-candidate-10.json') },
      { label: 'multi-candidate', boxes: 5, iterations: 10, out: path.join(tmpDir, 'multi-candidate-10.json') },
    ];
  }

  return [
    { label: 'single-optimize', boxes: 1, iterations: 5, out: path.join(tmpDir, 'single-optimize-5.json') },
    { label: 'multi-optimize', boxes: 5, iterations: 5, out: path.join(tmpDir, 'multi-optimize-5.json') },
  ];
}

function runCommand(command, args, { env = process.env, label }) {
  const result = spawnSync(command, args, {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    const details = [stderr, stdout].filter(Boolean).join('\n');
    throw new Error(`${label} failed (${command} ${args.join(' ')}):\n${details}`);
  }
  return result;
}

function firstNonEmpty(values) {
  for (const value of values || []) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function isCompactJwt(value) {
  const token = String(value || '').trim();
  if (!token) return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function inferProjectRefFromSupabaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    return match?.[1] ? String(match[1]).toLowerCase() : '';
  } catch {
    return '';
  }
}

async function probeRoleDbJwt({ token, env }) {
  const jwt = String(token || '').trim();
  if (!jwt) return false;
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !anonKey) return false;

  const requestUrl = `${supabaseUrl}/rest/v1/rpc/resolve_settings_merged`;
  const payload = {
    p_category: 'label_print_policy',
    p_scope_type: 'global',
    p_scope_id: null,
  };

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    if (response.ok) return true;
    const message = String(raw || '').toLowerCase();
    const authFailure = /invalid jwt|signature verification failed|no suitable key|wrong key type|invalid compact jws|jwt malformed|jwserror|token contains an invalid number of segments/.test(
      message,
    );
    if (authFailure) return false;
    if (!message && response.status === 401) return false;
    return true;
  } catch {
    return false;
  }
}

async function resolveBenchmarkEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const serviceRoleKey = firstNonEmpty([
    env.SUPABASE_SECRET_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SERVICE_ROLE_KEY,
    env.SUPABASE_SERVICE_KEY,
  ]);
  const anonKey = firstNonEmpty([env.SUPABASE_ANON_KEY]);
  const explicitLabelRendererDbJwt = firstNonEmpty([
    env.LABEL_RENDERER_DB_JWT,
    env.LABEL_RENDERER_TOKEN,
  ]);
  const jwtSecretRaw = firstNonEmpty([env.SUPABASE_JWT_SECRET, env.PREVIEW_SUPABASE_JWT_SECRET]);
  const accessToken = firstNonEmpty([
    env.SUPABASE_ACCESS_TOKEN,
    env.PREVIEW_SUPABASE_ACCESS_TOKEN,
  ]);
  const projectRef = firstNonEmpty([
    env.SUPABASE_PROJECT_ID,
    env.PREVIEW_SUPABASE_PROJECT_ID,
    inferProjectRefFromSupabaseUrl(env.SUPABASE_URL),
  ]);

  const candidates = [];
  if (jwtSecretRaw) {
    const signingSecret = resolveJwtSigningSecret({
      secret: jwtSecretRaw,
      serviceKey: serviceRoleKey,
      anonKey,
    });
    const issuer = resolveJwtIssuer({
      serviceKey: serviceRoleKey,
      anonKey,
    });
    const minted = buildEdgeDbJwtBundle({
      secret: signingSecret,
      issuer,
    })?.label_renderer_db_jwt;
    if (minted) {
      candidates.push({
        source: 'minted_from_supabase_jwt_secret',
        token: minted,
      });
    }
  }
  if (explicitLabelRendererDbJwt) {
    candidates.push({
      source: 'existing_label_renderer_db_jwt',
      token: explicitLabelRendererDbJwt,
    });
  }
  if (accessToken && projectRef) {
    try {
      const managedJwtSecret = String(await getProjectJwtSecret(projectRef, accessToken) || '').trim();
      if (managedJwtSecret) {
        const signingSecret = resolveJwtSigningSecret({
          secret: managedJwtSecret,
          serviceKey: serviceRoleKey,
          anonKey,
        });
        const issuer = resolveJwtIssuer({
          serviceKey: serviceRoleKey,
          anonKey,
        });
        const managedMinted = buildEdgeDbJwtBundle({
          secret: signingSecret,
          issuer,
        })?.label_renderer_db_jwt;
        if (managedMinted) {
          candidates.push({
            source: 'minted_from_management_jwt_secret',
            token: managedMinted,
          });
        }
      }
    } catch (err) {
      console.warn(
        `[shipments-print-cloud-benchmark] unable to fetch management jwt secret: ${err?.message || err}`,
      );
    }
    try {
      const keys = await getApiKeys(projectRef, accessToken);
      const legacyServiceJwt = String(keys?.legacyService || '').trim();
      if (isCompactJwt(legacyServiceJwt) && getJwtRole(legacyServiceJwt).toLowerCase() === 'service_role') {
        candidates.push({
          source: 'management_legacy_service_key',
          token: legacyServiceJwt,
        });
      }
    } catch (err) {
      console.warn(
        `[shipments-print-cloud-benchmark] unable to fetch management api keys: ${err?.message || err}`,
      );
    }
  }
  const serviceRoleJwtCandidates = [
    { source: 'supabase_service_role_key', token: env.SUPABASE_SERVICE_ROLE_KEY },
    { source: 'service_role_key', token: env.SERVICE_ROLE_KEY },
    { source: 'supabase_service_key', token: env.SUPABASE_SERVICE_KEY },
    { source: 'supabase_secret_key', token: env.SUPABASE_SECRET_KEY },
  ];
  for (const candidate of serviceRoleJwtCandidates) {
    if (!isCompactJwt(candidate.token)) continue;
    if (getJwtRole(candidate.token).toLowerCase() !== 'service_role') continue;
    candidates.push({
      source: candidate.source,
      token: String(candidate.token).trim(),
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      'Unable to resolve LABEL_RENDERER_DB_JWT candidate (need SUPABASE_JWT_SECRET or LABEL_RENDERER_DB_JWT).',
    );
  }

  for (const candidate of candidates) {
    const role = getJwtRole(candidate.token).toLowerCase();
    if (role !== 'edge_label_renderer_role' && role !== 'service_role') {
      continue;
    }
    const accepted = await probeRoleDbJwt({ token: candidate.token, env });
    if (!accepted) {
      console.warn(`[shipments-print-cloud-benchmark] rejected db jwt candidate: ${candidate.source}`);
      continue;
    }
    env.EDGE_REQUIRE_DB_JWT = role === 'edge_label_renderer_role' ? '1' : '0';
    env.LABEL_RENDERER_DB_JWT = candidate.token;
    env.LABEL_RENDERER_TOKEN = candidate.token;
    env.EDGE_DB_JWT = candidate.token;
    env.LABEL_RENDERER_BENCHMARK_AUTH_JWT = candidate.token;
    env.LABEL_PROVIDER_INVOKE_SECRET = candidate.token;
    if (serviceRoleKey) {
      env.LABEL_RENDERER_STORAGE_TOKEN = serviceRoleKey;
    }
    console.log(`[shipments-print-cloud-benchmark] using db jwt candidate: ${candidate.source}`);
    return env;
  }

  throw new Error(
    `No valid JWT auth candidate passed role+probe checks (candidates=${candidates
      .map((entry) => entry.source)
      .join(', ')}).`,
  );
}

function parseBenchmarkSummary(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    file: filePath,
    boxes: parsed?.config?.boxes ?? null,
    iterations: parsed?.config?.iterations ?? null,
    target_download_ms: parsed?.config?.target_download_ms ?? null,
    first_request: parsed?.metrics?.first_request ?? null,
    second_request: parsed?.metrics?.second_request ?? null,
  };
}

benchmarkTest('shipments print download latency benchmark (cloud, fresh-only)', async () => {
  jest.setTimeout(1000 * 60 * 120);

  const root = path.resolve(process.cwd());
  const tmpDir = path.join(root, 'tmp', 'shipments-print-cloud-benchmark');
  fs.mkdirSync(tmpDir, { recursive: true });

  const benchmarkScript = path.join(root, 'scripts', 'ops', 'labels-print-download-latency-benchmark.js');

  // Optimize-first default profile keeps cloud iteration loops short; candidate/final are opt-in by env.
  const scenarios = resolveBenchmarkScenarios(tmpDir);

  const benchmarkEnv = await resolveBenchmarkEnv(process.env);

  runCommand('npm', ['run', 'db:push'], { env: benchmarkEnv, label: 'db push' });
  runCommand('npm', ['run', 'deploy:edge'], {
    env: { ...benchmarkEnv, EDGE_SKIP_SMOKE: '1' },
    label: 'edge deploy',
  });

  const summaries = [];
  for (const scenario of scenarios) {
    runCommand(
      'node',
      [
        benchmarkScript,
        '--iterations',
        String(scenario.iterations),
        '--boxes',
        String(scenario.boxes),
        '--target-download-ms',
        '100',
        '--expires-seconds',
        '900',
        '--out',
        scenario.out,
      ],
      {
        env: benchmarkEnv,
        label: `benchmark ${scenario.label}`,
      },
    );

    const summary = {
      scenario: scenario.label,
      ...parseBenchmarkSummary(scenario.out),
    };
    summaries.push(summary);
    console.log(`[shipments-print-cloud-benchmark] ${JSON.stringify(summary)}`);
  }

  const aggregatePath = path.join(tmpDir, 'aggregate.json');
  fs.writeFileSync(
    aggregatePath,
    `${JSON.stringify({ generated_at: new Date().toISOString(), summaries }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[shipments-print-cloud-benchmark] aggregate=${aggregatePath}`);
});
