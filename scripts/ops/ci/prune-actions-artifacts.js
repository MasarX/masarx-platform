#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_PATH = path.join(
  process.cwd(),
  'config',
  'ci',
  'actions-artifact-retention-policy.json',
);

function die(message) {
  console.error(`[prune-actions-artifacts] ${message}`);
  process.exit(1);
}

function parsePositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackValue;
}

function normalizeRepo(repo) {
  const value = String(repo || '').trim();
  if (!value || !value.includes('/')) {
    return { owner: '', repo: '' };
  }
  const [owner = '', name = ''] = value.split('/');
  return { owner: owner.trim(), repo: name.trim() };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    repo: process.env.GITHUB_REPOSITORY || '',
    policyPath: DEFAULT_POLICY_PATH,
    dryRun: false,
    maxDeletes: '',
    jsonOut: '',
    pressureMaxTotalBytes: process.env.ACTIONS_ARTIFACT_PRESSURE_MAX_TOTAL_BYTES || '',
    pressureTargetTotalBytes: process.env.ACTIONS_ARTIFACT_PRESSURE_TARGET_TOTAL_BYTES || '',
    pressureMinAgeHours: process.env.ACTIONS_ARTIFACT_PRESSURE_MIN_AGE_HOURS || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--repo') out.repo = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--repo=')) out.repo = token.split('=').slice(1).join('=').trim();
    else if (token === '--policy') out.policyPath = path.resolve(String(argv[i + 1] || '').trim());
    else if (token.startsWith('--policy=')) out.policyPath = path.resolve(token.split('=').slice(1).join('=').trim());
    else if (token === '--dry-run') out.dryRun = true;
    else if (token === '--max-deletes') out.maxDeletes = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--max-deletes=')) out.maxDeletes = token.split('=').slice(1).join('=').trim();
    else if (token === '--pressure-max-total-bytes') out.pressureMaxTotalBytes = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--pressure-max-total-bytes=')) out.pressureMaxTotalBytes = token.split('=').slice(1).join('=').trim();
    else if (token === '--pressure-target-total-bytes') out.pressureTargetTotalBytes = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--pressure-target-total-bytes=')) out.pressureTargetTotalBytes = token.split('=').slice(1).join('=').trim();
    else if (token === '--pressure-min-age-hours') out.pressureMinAgeHours = String(argv[i + 1] || '').trim();
    else if (token.startsWith('--pressure-min-age-hours=')) out.pressureMinAgeHours = token.split('=').slice(1).join('=').trim();
    else if (token === '--json-out') out.jsonOut = path.resolve(String(argv[i + 1] || '').trim());
    else if (token.startsWith('--json-out=')) out.jsonOut = path.resolve(token.split('=').slice(1).join('=').trim());
  }

  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (!fs.existsSync(policyPath)) {
    throw new Error(`Policy file not found: ${policyPath}`);
  }
  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

function compilePolicy(rawPolicy) {
  const source = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const rules = Array.isArray(source.rules) ? source.rules : [];
  return {
    version: Number(source.version || 0),
    defaultRetentionHours: parsePositiveInt(source.default_retention_hours, 168),
    defaultDeleteBatchSize: parsePositiveInt(source.default_delete_batch_size, 500),
    rules: rules.map((rule, index) => {
      const name = String(rule?.name || `rule_${index + 1}`).trim();
      const pattern = String(rule?.pattern || '').trim();
      if (!pattern) {
        throw new Error(`Retention rule '${name}' is missing pattern.`);
      }
      return {
        name,
        pattern,
        regex: new RegExp(pattern),
        maxAgeHours: parsePositiveInt(rule?.max_age_hours, 168),
      };
    }),
  };
}

function resolveArtifactRule(name, compiledPolicy) {
  const artifactName = String(name || '').trim();
  for (const rule of compiledPolicy.rules) {
    if (rule.regex.test(artifactName)) {
      return rule;
    }
  }
  return {
    name: 'default',
    maxAgeHours: compiledPolicy.defaultRetentionHours,
  };
}

function buildDeletionPlan(artifacts, compiledPolicy, nowMs = Date.now()) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  return rows
    .filter((artifact) => artifact && !artifact.expired)
    .map((artifact) => {
      const createdMs = new Date(artifact.created_at || artifact.updated_at || 0).getTime();
      const rule = resolveArtifactRule(artifact.name, compiledPolicy);
      const ageHours = Number.isFinite(createdMs)
        ? Math.max(0, (nowMs - createdMs) / (60 * 60 * 1000))
        : 0;
      return {
        id: Number(artifact.id || 0),
        name: String(artifact.name || '').trim(),
        sizeInBytes: Number(artifact.size_in_bytes || 0),
        createdAt: String(artifact.created_at || '').trim(),
        expiresAt: String(artifact.expires_at || '').trim(),
        ageHours,
        maxAgeHours: rule.maxAgeHours,
        ruleName: rule.name,
        delete: Number.isFinite(createdMs) && ageHours >= rule.maxAgeHours,
      };
    })
    .filter((row) => row.id > 0 && row.name)
    .sort((a, b) => {
      const createdA = new Date(a.createdAt || 0).getTime();
      const createdB = new Date(b.createdAt || 0).getTime();
      if (createdA !== createdB) return createdA - createdB;
      return b.sizeInBytes - a.sizeInBytes;
    });
}

function applyStoragePressurePlan(
  plan,
  {
    maxTotalBytes = 0,
    targetTotalBytes = 0,
    minAgeHours = 0,
  } = {},
) {
  const rows = Array.isArray(plan) ? plan : [];
  const maxBytes = Number(maxTotalBytes || 0);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return rows;

  const totalBytes = rows.reduce((sum, row) => sum + row.sizeInBytes, 0);
  if (totalBytes <= maxBytes) return rows;

  const targetBytes = Number(targetTotalBytes || 0);
  const desiredTotal = Number.isFinite(targetBytes) && targetBytes > 0 && targetBytes < maxBytes
    ? targetBytes
    : Math.floor(maxBytes * 0.8);
  const minimumAge = Number(minAgeHours || 0);
  const selected = new Set(rows.filter((row) => row.delete).map((row) => row.id));
  let projectedTotal = rows
    .filter((row) => !selected.has(row.id))
    .reduce((sum, row) => sum + row.sizeInBytes, 0);

  const extraCandidates = rows
    .filter((row) => !selected.has(row.id) && row.ageHours >= minimumAge)
    .sort((a, b) => {
      if (b.ageHours !== a.ageHours) return b.ageHours - a.ageHours;
      return b.sizeInBytes - a.sizeInBytes;
    });

  for (const row of extraCandidates) {
    if (projectedTotal <= desiredTotal) break;
    row.delete = true;
    row.deleteReason = 'storage_pressure';
    selected.add(row.id);
    projectedTotal -= row.sizeInBytes;
  }

  return rows;
}

async function githubRequest({ url, token, method = 'GET' }) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'masarx-prune-actions-artifacts',
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${url} failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json();
}

function isArtifactsPageNotFound(error) {
  const message = String(error?.message || error || '');
  return message.includes('/actions/artifacts') && message.includes('failed (404)');
}

async function listArtifacts({ owner, repo, token, requestFn = githubRequest }) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts?per_page=100&page=${page}`;
    let payload;
    try {
      // eslint-disable-next-line no-await-in-loop
      payload = await requestFn({ url, token });
    } catch (error) {
      if (page > 1 && isArtifactsPageNotFound(error)) {
        break;
      }
      throw error;
    }
    const rows = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function deleteArtifact({ owner, repo, token, artifactId }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${encodeURIComponent(String(artifactId))}`;
  await githubRequest({ url, token, method: 'DELETE' });
}

function writeJsonReport(targetPath, payload) {
  if (!targetPath) return;
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs();
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    die('GITHUB_TOKEN is required.');
  }

  const { owner, repo } = normalizeRepo(args.repo);
  if (!owner || !repo) {
    die(`Invalid repo '${args.repo}'. Expected owner/repo.`);
  }

  const compiledPolicy = compilePolicy(loadPolicy(args.policyPath));
  const maxDeletes = parsePositiveInt(args.maxDeletes, compiledPolicy.defaultDeleteBatchSize);
  const artifacts = await listArtifacts({ owner, repo, token });
  const plan = applyStoragePressurePlan(buildDeletionPlan(artifacts, compiledPolicy), {
    maxTotalBytes: parsePositiveInt(args.pressureMaxTotalBytes, 0),
    targetTotalBytes: parsePositiveInt(args.pressureTargetTotalBytes, 0),
    minAgeHours: parsePositiveInt(args.pressureMinAgeHours, 0),
  });
  const deleteCandidates = plan.filter((row) => row.delete);
  const selected = deleteCandidates.slice(0, maxDeletes);

  const summary = {
    repo: `${owner}/${repo}`,
    dry_run: args.dryRun,
    total_artifacts: artifacts.length,
    delete_candidate_count: deleteCandidates.length,
    selected_delete_count: selected.length,
    selected_delete_bytes: selected.reduce((sum, row) => sum + row.sizeInBytes, 0),
    policy_path: args.policyPath,
    policy_version: compiledPolicy.version,
    generated_at: new Date().toISOString(),
    selected: selected.map((row) => ({
      id: row.id,
      name: row.name,
      size_in_bytes: row.sizeInBytes,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      age_hours: Number(row.ageHours.toFixed(2)),
      max_age_hours: row.maxAgeHours,
      rule_name: row.ruleName,
      delete_reason: row.deleteReason || 'retention_policy',
    })),
  };

  writeJsonReport(args.jsonOut, summary);

  if (!selected.length) {
    console.log('[prune-actions-artifacts] No artifacts matched the retention policy.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `[prune-actions-artifacts] ${args.dryRun ? 'Would delete' : 'Deleting'} ${selected.length} artifact(s) totalling ${summary.selected_delete_bytes} bytes.`,
  );

  for (const artifact of selected) {
    const line = `- ${artifact.name} (#${artifact.id}) age=${artifact.ageHours.toFixed(2)}h max=${artifact.maxAgeHours}h size=${artifact.sizeInBytes} reason=${artifact.deleteReason || 'retention_policy'}`;
    console.log(line);
    if (!args.dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await deleteArtifact({ owner, repo, token, artifactId: artifact.id });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => die(error?.stack || error?.message || String(error)));
}

module.exports = {
  compilePolicy,
  buildDeletionPlan,
  applyStoragePressurePlan,
  resolveArtifactRule,
  normalizeRepo,
  listArtifacts,
};
