#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureGhAuth,
  getRepoSlugFromGitRemote,
} = require('../../utils/gh-cli');

const DEFAULT_BUCKET = 'stg-go-live-security-review';
const FINDING_SEVERITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
  informational: 3,
};

function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function parseBool(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function formatUtcDate(value = new Date()) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureDir(fileOrDirPath) {
  const target = path.extname(fileOrDirPath)
    ? path.dirname(fileOrDirPath)
    : fileOrDirPath;
  fs.mkdirSync(target, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

function relativeUnix(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function listDirectoryNames(dirPath, { includeHidden = false, filter } = {}) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => (includeHidden ? true : !name.startsWith('.')))
    .filter((name) => (typeof filter === 'function' ? filter(name) : true))
    .sort((a, b) => a.localeCompare(b));
}

function listFiles(dirPath, predicate) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (typeof predicate === 'function' && !predicate(fullPath)) continue;
      out.push(fullPath);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function parseArgs(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const out = {
    repoRoot,
    configFile: path.join(repoRoot, 'config', 'ops', 'stg-go-live-security-review.json'),
    evidenceDate: '',
    evidenceDir: '',
    launchRef: '',
    workflowRef: '',
    liveMode: 'github',
    waitWorkflows: parseBool(process.env.STG_SECURITY_REVIEW_WAIT_WORKFLOWS, false),
    pollSeconds: 15,
    workflowRecentMinutes: 15,
    dispatchWorkflows: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    const next = String(argv[index + 1] || '').trim();
    if (!token) continue;

    if (token === '--config-file' && next) {
      out.configFile = path.resolve(repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--config-file=')) {
      out.configFile = path.resolve(repoRoot, token.slice('--config-file='.length).trim());
      continue;
    }
    if (token === '--evidence-date' && next) {
      out.evidenceDate = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--evidence-date=')) {
      out.evidenceDate = token.slice('--evidence-date='.length).trim();
      continue;
    }
    if (token === '--evidence-dir' && next) {
      out.evidenceDir = path.resolve(repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--evidence-dir=')) {
      out.evidenceDir = path.resolve(repoRoot, token.slice('--evidence-dir='.length).trim());
      continue;
    }
    if (token === '--launch-ref' && next) {
      out.launchRef = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--launch-ref=')) {
      out.launchRef = token.slice('--launch-ref='.length).trim();
      continue;
    }
    if (token === '--workflow-ref' && next) {
      out.workflowRef = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--workflow-ref=')) {
      out.workflowRef = token.slice('--workflow-ref='.length).trim();
      continue;
    }
    if (token === '--live-mode' && next) {
      out.liveMode = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--live-mode=')) {
      out.liveMode = token.slice('--live-mode='.length).trim();
      continue;
    }
    if (token === '--wait-workflows') {
      out.waitWorkflows = true;
      continue;
    }
    if (token === '--no-wait-workflows') {
      out.waitWorkflows = false;
      continue;
    }
    if (token === '--poll-seconds' && next) {
      out.pollSeconds = Math.max(5, parseInt(next, 10) || out.pollSeconds);
      index += 1;
      continue;
    }
    if (token.startsWith('--poll-seconds=')) {
      out.pollSeconds = Math.max(5, parseInt(token.slice('--poll-seconds='.length).trim(), 10) || out.pollSeconds);
      continue;
    }
    if (token === '--workflow-recent-minutes' && next) {
      out.workflowRecentMinutes = Math.max(1, parseInt(next, 10) || out.workflowRecentMinutes);
      index += 1;
      continue;
    }
    if (token.startsWith('--workflow-recent-minutes=')) {
      out.workflowRecentMinutes = Math.max(1, parseInt(token.slice('--workflow-recent-minutes='.length).trim(), 10) || out.workflowRecentMinutes);
      continue;
    }
    if (token === '--no-dispatch-workflows') {
      out.dispatchWorkflows = false;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function printHelp() {
  console.log([
    'Usage: node scripts/ops/audit/stg-go-live-security-review.js [options]',
    '',
    'Options:',
    '  --config-file <path>              Override config file.',
    '  --evidence-date YYYY-MM-DD        Force evidence bucket date (UTC bucket by default).',
    '  --evidence-dir <path>             Override evidence directory.',
    '  --launch-ref <ref>                Launch ref to evaluate (default from config, usually main).',
    '  --workflow-ref <ref>              Ref to dispatch workflow files from (default from config).',
    '  --live-mode github|none           Attempt GitHub workflow-backed checks or skip them.',
    '  --wait-workflows                  Wait for dispatched workflows to finish.',
    '  --no-wait-workflows               Do not wait for workflows (default).',
    '  --poll-seconds <n>                Poll interval when watching workflows.',
    '  --workflow-recent-minutes <n>     Window for matching recent workflow runs.',
    '  --no-dispatch-workflows           Skip workflow dispatch even when live-mode=github.',
  ].join('\n'));
}

function resolveEvidenceDir(options, config, generatedAt) {
  if (options.evidenceDir) return options.evidenceDir;
  const evidenceDate = String(options.evidenceDate || '').trim() || formatUtcDate(new Date(generatedAt));
  const bucket = String(config.bucket || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET;
  return path.join(options.repoRoot, 'docs', 'ops', 'evidence', evidenceDate, bucket);
}

function interpolate(value, context) {
  return String(value || '').replace(/\{([a-z_]+)\}/gi, (_, rawKey) => {
    const key = String(rawKey || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(context, key) ? String(context[key]) : `{${rawKey}}`;
  });
}

function readGitValue(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function countSecurityTests(repoRoot) {
  const integration = listFiles(path.join(repoRoot, 'tests', 'integration', 'security'), () => true);
  const e2e = listFiles(path.join(repoRoot, 'tests', 'e2e'), (filePath) =>
    /(security|auth|tenant|tracking|workflow|print|download)/i.test(path.basename(filePath)),
  );
  const unit = listFiles(path.join(repoRoot, 'tests', 'unit'), (filePath) =>
    /(security|auth|cloud-env|db-jwt|download|ui-event|redirect|attestation|operator|vault|scan)/i.test(filePath),
  );
  const pgtap = listFiles(path.join(repoRoot, 'supabase', 'tests', 'pgtap'), (filePath) =>
    /(rls|security|access|auth|anon|mobile_attestation|label_download|ui_execute_command|ui_security|logs_rls|partition_security|storage)/i.test(path.basename(filePath)),
  );

  return {
    integration_security_files: integration.map((filePath) => relativeUnix(repoRoot, filePath)),
    e2e_security_files: e2e.map((filePath) => relativeUnix(repoRoot, filePath)),
    unit_security_files: unit.map((filePath) => relativeUnix(repoRoot, filePath)),
    pgtap_security_files: pgtap.map((filePath) => relativeUnix(repoRoot, filePath)),
  };
}

function buildAttackSurfaceInventory({ repoRoot, config, generatedAt, evidenceDir, options }) {
  const appsDir = path.join(repoRoot, 'apps');
  const packagesDir = path.join(repoRoot, 'packages');
  const functionsDir = path.join(repoRoot, 'supabase', 'functions');
  const securityTests = countSecurityTests(repoRoot);

  return {
    generated_at: generatedAt,
    scope: config.scope || 'stg',
    evidence_dir: relativeUnix(repoRoot, evidenceDir),
    launch_ref: options.launchRef || config.launch_ref || 'main',
    workflow_ref: options.workflowRef || config.workflow_ref || options.launchRef || config.launch_ref || 'main',
    git: {
      branch: readGitValue(repoRoot, ['branch', '--show-current']) || 'HEAD',
      head_sha: readGitValue(repoRoot, ['rev-parse', 'HEAD']),
      head_short_sha: readGitValue(repoRoot, ['rev-parse', '--short', 'HEAD']),
    },
    canonical_hosts: config.canonical_hosts || {},
    standards: Array.isArray(config.standards) ? config.standards : [],
    apps: listDirectoryNames(appsDir),
    packages: listDirectoryNames(packagesDir),
    edge_functions: listDirectoryNames(functionsDir, {
      filter: (name) => name !== '_shared',
    }),
    workflow_checks: Array.isArray(config.workflow_checks)
      ? config.workflow_checks.map((entry) => ({
          id: entry.id,
          label: entry.label,
          workflow: entry.workflow,
          ref: entry.ref || options.workflowRef || config.workflow_ref || 'main',
          inputs: entry.inputs || {},
        }))
      : [],
    local_commands: Array.isArray(config.local_commands)
      ? config.local_commands.map((entry) => ({
          id: entry.id,
          label: entry.label,
          script: entry.script,
        }))
      : [],
    probes: Array.isArray(config.probe_matrix) ? config.probe_matrix : [],
    tests: {
      integration_security_count: securityTests.integration_security_files.length,
      e2e_security_count: securityTests.e2e_security_files.length,
      unit_security_count: securityTests.unit_security_files.length,
      pgtap_security_count: securityTests.pgtap_security_files.length,
      ...securityTests,
    },
  };
}

function renderAttackSurfaceMarkdown(inventory) {
  const lines = [];
  lines.push('# Stg Go-Live Security Review Attack Surface');
  lines.push('');
  lines.push(`Generated at: ${inventory.generated_at}`);
  lines.push(`Scope: ${inventory.scope}`);
  lines.push(`Launch ref: ${inventory.launch_ref}`);
  lines.push(`Workflow ref: ${inventory.workflow_ref}`);
  lines.push(`Evidence dir: ${inventory.evidence_dir}`);
  lines.push('');
  lines.push('## Git');
  lines.push(`- Branch: ${inventory.git.branch}`);
  lines.push(`- HEAD: ${inventory.git.head_sha}`);
  lines.push('');
  lines.push('## Canonical Hosts');
  for (const [surface, hosts] of Object.entries(inventory.canonical_hosts || {})) {
    lines.push(`- ${surface}: ${(hosts || []).join(', ')}`);
  }
  lines.push('');
  lines.push('## Standards');
  for (const standard of inventory.standards || []) {
    lines.push(`- ${standard.id}: ${standard.url}`);
  }
  lines.push('');
  lines.push(`## Apps (${inventory.apps.length})`);
  for (const app of inventory.apps) lines.push(`- ${app}`);
  lines.push('');
  lines.push(`## Packages (${inventory.packages.length})`);
  for (const pkg of inventory.packages) lines.push(`- ${pkg}`);
  lines.push('');
  lines.push(`## Edge Functions (${inventory.edge_functions.length})`);
  for (const fn of inventory.edge_functions) lines.push(`- ${fn}`);
  lines.push('');
  lines.push(`## Workflow Checks (${inventory.workflow_checks.length})`);
  for (const workflow of inventory.workflow_checks) {
    lines.push(`- ${workflow.label} (${workflow.workflow}) @ ${workflow.ref}`);
  }
  lines.push('');
  lines.push('## Security Test Coverage');
  lines.push(`- Integration: ${inventory.tests.integration_security_count}`);
  lines.push(`- E2E: ${inventory.tests.e2e_security_count}`);
  lines.push(`- Unit: ${inventory.tests.unit_security_count}`);
  lines.push(`- pgTAP: ${inventory.tests.pgtap_security_count}`);
  lines.push('');
  lines.push('## Probe Matrix');
  for (const probe of inventory.probes || []) {
    lines.push(`- ${probe.id} [${probe.surface}] - ${probe.focus}`);
  }
  lines.push('');
  return lines.join('\n');
}

function runNodeScript(repoRoot, scriptPath, args, logFilePath) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  writeText(
    logFilePath,
    [
      `$ ${process.execPath} ${[relativeUnix(repoRoot, scriptPath), ...args].join(' ')}`,
      '',
      '--- stdout ---',
      stdout.trimEnd(),
      '',
      '--- stderr ---',
      stderr.trimEnd(),
      '',
      `exit_code=${typeof result.status === 'number' ? result.status : 1}`,
    ].join('\n'),
  );
  return {
    ok: result.status === 0,
    exit_code: typeof result.status === 'number' ? result.status : 1,
    stdout,
    stderr,
  };
}

function buildCommandFailureFinding(repoRoot, command, result, evidenceDir) {
  const severity = command.id === 'security_scan_gate' ? 'P1' : 'P2';
  const summaryFile =
    command.id === 'security_scan_gate'
      ? path.join(evidenceDir, 'security-scan-summary.json')
      : '';
  let detail = `Command \`${command.label}\` exited with code ${result.exit_code}.`;
  const evidence = [
    `Command log: ${relativeUnix(repoRoot, path.join(evidenceDir, `command-${command.id}.log`))}`,
  ];
  if (summaryFile && fs.existsSync(summaryFile)) {
    try {
      const summary = readJson(summaryFile);
      detail =
        `Security scan gate reported ${summary?.counts?.unexpected_threshold_findings ?? 'unknown'} net-new high/critical findings ` +
        `relative to ${summary?.baseline_file || 'the configured baseline'}.`;
      for (const record of summary?.unexpected_signatures || []) {
        const signature = record.signature || `${record.package_name || 'unknown'}|${record.severity || 'unknown'}`;
        evidence.push(`Unexpected signature: ${signature}`);
      }
    } catch {
      detail = `Command \`${command.label}\` exited with code ${result.exit_code}.`;
    }
  }

  return {
    id: `local-${command.id}`,
    title: `${command.label} did not complete cleanly`,
    severity,
    status: 'confirmed',
    surface: command.id === 'security_scan_gate' ? 'supply_chain' : 'ops',
    exploit_path: detail,
    evidence,
    standards:
      command.id === 'security_scan_gate'
        ? [
            'OWASP ASVS 5.0.0 / dependency integrity',
            'NIST CSF 2.0 / supply chain risk management',
          ]
        : [
            'NIST CSF 2.0 / continuous assurance',
          ],
    affected_files: [],
    remediation:
      command.id === 'security_scan_gate'
        ? 'Remediate or explicitly re-baseline accepted dependency findings, then rerun the gate with evidence-safe output paths.'
        : 'Fix the command failure, rerun the command, and attach the updated evidence to the review pack.',
    retest_criteria: `Re-run ${command.label} and confirm exit code 0 with fresh evidence in ${relativeUnix(repoRoot, evidenceDir)}.`,
    launch_impact: 'The evidence pack is incomplete until this command succeeds or the failure is explicitly accepted.',
  };
}

function executeLocalCommands({ repoRoot, config, evidenceDir }) {
  const results = [];
  const findings = [];
  const context = {
    evidence_dir: evidenceDir,
  };

  for (const command of config.local_commands || []) {
    const scriptPath = path.join(repoRoot, command.script);
    const args = (command.args || []).map((value) => interpolate(value, context));
    const logFilePath = path.join(evidenceDir, `command-${command.id}.log`);
    const result = runNodeScript(repoRoot, scriptPath, args, logFilePath);
    results.push({
      id: command.id,
      label: command.label,
      script: relativeUnix(repoRoot, scriptPath),
      args,
      ok: result.ok,
      exit_code: result.exit_code,
      log_file: relativeUnix(repoRoot, logFilePath),
    });
    if (!result.ok) {
      findings.push(buildCommandFailureFinding(repoRoot, command, result, evidenceDir));
    }
  }

  return { results, findings };
}

function ghRun(args, repoRoot) {
  return spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeParseJson(rawText, fallback = null) {
  try {
    return JSON.parse(String(rawText || ''));
  } catch {
    return fallback;
  }
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function findRecentWorkflowRun({ repoRoot, repo, workflow, startedAtIso, recentMinutes }) {
  const listResult = ghRun(
    [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      workflow,
      '--limit',
      '20',
      '--json',
      'databaseId,name,displayTitle,headBranch,headSha,status,conclusion,url,createdAt,updatedAt',
    ],
    repoRoot,
  );
  if (listResult.status !== 0) {
    throw new Error(String(listResult.stderr || listResult.stdout || '').trim() || 'gh run list failed');
  }
  const items = safeParseJson(listResult.stdout, []);
  const startedAt = new Date(startedAtIso).getTime();
  const minCreatedAt = startedAt - recentMinutes * 60 * 1000;
  const candidates = Array.isArray(items) ? items : [];
  const matched = candidates
    .filter((entry) => {
      const createdAt = new Date(entry.createdAt || 0).getTime();
      return Number.isFinite(createdAt) && createdAt >= minCreatedAt;
    })
    .sort((left, right) => {
      const leftTime = new Date(left.createdAt || 0).getTime();
      const rightTime = new Date(right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });
  return matched[0] || null;
}

function viewWorkflowRun({ repoRoot, repo, runId }) {
  const result = ghRun(
    [
      'run',
      'view',
      String(runId),
      '--repo',
      repo,
      '--json',
      'databaseId,name,displayTitle,headBranch,headSha,status,conclusion,url,createdAt,updatedAt',
    ],
    repoRoot,
  );
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || 'gh run view failed');
  }
  return safeParseJson(result.stdout, null);
}

function viewWorkflowJobs({ repoRoot, repo, runId }) {
  const result = ghRun(
    [
      'run',
      'view',
      String(runId),
      '--repo',
      repo,
      '--json',
      'jobs',
    ],
    repoRoot,
  );
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '').trim() || 'gh run jobs failed');
  }
  const parsed = safeParseJson(result.stdout, {});
  return Array.isArray(parsed.jobs)
    ? parsed.jobs.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.url,
      }))
    : [];
}

function refreshWorkflowResults({ repoRoot, results }) {
  let repo = '';
  try {
    repo = getRepoSlugFromGitRemote();
    ensureGhAuth();
  } catch {
    return results;
  }

  return (results || []).map((entry) => {
    if (!entry.run_id) return entry;
    try {
      const run = viewWorkflowRun({ repoRoot, repo, runId: entry.run_id }) || {};
      const jobs = viewWorkflowJobs({ repoRoot, repo, runId: entry.run_id });
      return {
        ...entry,
        status: run.status || entry.status,
        conclusion:
          run.conclusion !== undefined && run.conclusion !== null && run.conclusion !== ''
            ? run.conclusion
            : entry.conclusion,
        created_at: toIsoDate(run.createdAt) || entry.created_at,
        updated_at: toIsoDate(run.updatedAt) || entry.updated_at,
        url: run.url || entry.url,
        jobs,
      };
    } catch (error) {
      return {
        ...entry,
        refresh_error: error.message,
      };
    }
  });
}

function dispatchWorkflowChecks({ repoRoot, config, options }) {
  const results = [];
  const findings = [];

  if (String(options.liveMode || '').trim().toLowerCase() === 'none' || !options.dispatchWorkflows) {
    for (const workflow of config.workflow_checks || []) {
      results.push({
        id: workflow.id,
        label: workflow.label,
        workflow: workflow.workflow,
        ref: workflow.ref || options.workflowRef || config.workflow_ref || 'main',
        status: 'skipped',
        conclusion: 'not_run',
        reason: 'workflow dispatch disabled',
      });
    }
    return { results, findings };
  }

  let repo = '';
  try {
    repo = getRepoSlugFromGitRemote();
    ensureGhAuth();
  } catch (error) {
    for (const workflow of config.workflow_checks || []) {
      results.push({
        id: workflow.id,
        label: workflow.label,
        workflow: workflow.workflow,
        ref: workflow.ref || options.workflowRef || config.workflow_ref || 'main',
        status: 'blocked',
        conclusion: 'blocked',
        reason: error.message,
      });
    }
    findings.push({
      id: 'workflow-github-auth',
      title: 'GitHub workflow-backed staging verification is blocked',
      severity: 'P0',
      status: 'confirmed',
      surface: 'ci_cd',
      exploit_path:
        'The required GitHub environment-backed workflow checks could not be dispatched from this audit run because GitHub CLI authentication is unavailable.',
      evidence: [
        `GitHub auth error: ${error.message}`,
      ],
      standards: [
        'NIST CSF 2.0 / continuous assurance',
      ],
      affected_files: [],
      remediation:
        'Authenticate GitHub CLI with access to the repository, then rerun the staging security review so the mandatory workflow-backed evidence can be collected.',
      retest_criteria:
        'Security Scan Gates, Secrets Check, Verify (DB + Tests), and Verify UI (Stg) are dispatched from this run and linked in the evidence pack.',
      launch_impact:
        'Fail-closed NO-GO until the mandatory GitHub environment-backed staging evidence exists for the launch ref.',
    });
    return { results, findings };
  }

  for (const workflow of config.workflow_checks || []) {
    const startedAtIso = new Date().toISOString();
    const ref = workflow.ref || options.workflowRef || config.workflow_ref || 'main';
    const inputs = workflow.inputs || {};
    const dispatchArgs = [
      'workflow',
      'run',
      workflow.workflow,
      '--repo',
      repo,
      '--ref',
      ref,
    ];
    for (const [key, value] of Object.entries(inputs)) {
      dispatchArgs.push('-f', `${key}=${value}`);
    }

    const dispatchResult = ghRun(dispatchArgs, repoRoot);
    if (dispatchResult.status !== 0) {
      results.push({
        id: workflow.id,
        label: workflow.label,
        workflow: workflow.workflow,
        ref,
        status: 'blocked',
        conclusion: 'blocked',
        reason: String(dispatchResult.stderr || dispatchResult.stdout || '').trim() || 'dispatch failed',
      });
      continue;
    }

    let runInfo = null;
    let reason = '';
    try {
      runInfo = findRecentWorkflowRun({
        repoRoot,
        repo,
        workflow: workflow.workflow,
        startedAtIso,
        recentMinutes: options.workflowRecentMinutes,
      });
    } catch (error) {
      reason = error.message;
    }

    if (!runInfo) {
      results.push({
        id: workflow.id,
        label: workflow.label,
        workflow: workflow.workflow,
        ref,
        status: 'dispatched',
        conclusion: 'pending',
        reason: reason || 'dispatched but no recent run was resolved',
      });
      continue;
    }

    if (options.waitWorkflows) {
      ghRun(
        [
          'run',
          'watch',
          String(runInfo.databaseId),
          '--repo',
          repo,
          '--interval',
          String(options.pollSeconds),
          '--exit-status',
        ],
        repoRoot,
      );
      try {
        runInfo = viewWorkflowRun({
          repoRoot,
          repo,
          runId: runInfo.databaseId,
        }) || runInfo;
      } catch (error) {
        reason = error.message;
      }
    }

    results.push({
      id: workflow.id,
      label: workflow.label,
      workflow: workflow.workflow,
      ref,
      run_id: runInfo.databaseId,
      url: runInfo.url,
      head_branch: runInfo.headBranch,
      head_sha: runInfo.headSha,
      status: runInfo.status,
      conclusion: runInfo.conclusion || (options.waitWorkflows ? 'unknown' : 'pending'),
      created_at: toIsoDate(runInfo.createdAt),
      updated_at: toIsoDate(runInfo.updatedAt),
      reason,
    });
  }

  return { results, findings };
}

function buildWorkflowBarrierFinding(workflowResults) {
  const blockers = (workflowResults || []).filter((entry) => entry.conclusion !== 'success');
  if (!blockers.length) return null;
  return {
    id: 'workflow-evidence-incomplete',
    title: 'Mandatory staging workflow evidence is incomplete',
    severity: 'P0',
    status: 'confirmed',
    surface: 'ci_cd',
    exploit_path:
      'The fail-closed launch gate requires fresh GitHub environment-backed results for Security Scan Gates, Secrets Check, Verify (DB + Tests), and Verify UI (Stg). This run does not have a clean set of mandatory workflow conclusions.',
    evidence: blockers.map((entry) => {
      const url = entry.url ? ` (${entry.url})` : '';
      const reason = entry.reason ? ` - ${entry.reason}` : '';
      const jobs = Array.isArray(entry.jobs) && entry.jobs.length
        ? ` [jobs: ${entry.jobs.map((job) => `${job.name}=${job.conclusion || job.status}`).join(', ')}]`
        : '';
      return `${entry.label}: ${entry.conclusion || entry.status}${reason}${url}${jobs}`;
    }),
    standards: [
      'NIST CSF 2.0 / continuous assurance',
      'OWASP ASVS 5.0.0 / verification and operations',
    ],
    affected_files: [],
    remediation:
      'Rerun the blocked or incomplete workflows on the launch ref and attach the resulting run URLs and artifacts to the evidence pack.',
    retest_criteria:
      'All four mandatory workflows finish with conclusion=success on the launch ref, with artifact links captured in the evidence pack.',
    launch_impact:
      'Automatic NO-GO until the mandatory staging verification workflows are green and fresh.',
  };
}

function buildFileRef(repoRoot, filePath, line) {
  return {
    path: relativeUnix(repoRoot, filePath),
    line,
  };
}

function lineNumber(content, matcher) {
  const text = String(content || '');
  let index = -1;
  if (typeof matcher === 'string') {
    index = text.indexOf(matcher);
  } else if (matcher instanceof RegExp) {
    const match = matcher.exec(text);
    index = match ? match.index : -1;
  }
  if (index < 0) return null;
  return text.slice(0, index).split('\n').length;
}

function buildStaticFindings({ repoRoot, fileMap }) {
  const findings = [];
  const headersFile = fileMap['apps/shared/security-headers.js'];
  if (
    headersFile &&
    headersFile.content.includes(`const scriptSources = ["'self'", "'unsafe-inline'"];`)
  ) {
    findings.push({
      id: 'web-csp-unsafe-inline',
      title: 'Production CSP still permits inline script execution',
      severity: 'P1',
      status: 'confirmed',
      surface: 'web',
      exploit_path:
        'The shared Next.js security header builder always includes `unsafe-inline` in `script-src`, so any HTML or DOM injection on console or portal can execute without a nonce or hash barrier.',
      evidence: [
        'The shared CSP builder initializes `script-src` with `unsafe-inline` before the production branch check.',
      ],
      standards: [
        'OWASP ASVS 5.0.0 / browser security',
        'NIST CSF 2.0 / protect application execution integrity',
      ],
      affected_files: [
        buildFileRef(
          repoRoot,
          headersFile.filePath,
          lineNumber(headersFile.content, `const scriptSources = ["'self'", "'unsafe-inline'"];`) || 43,
        ),
      ],
      remediation:
        'Remove `unsafe-inline` from production `script-src`, migrate inline bootstrapping to nonces or hashed snippets, and extend the security header tests to enforce the stricter header.',
      retest_criteria:
        'Console and portal responses no longer emit `unsafe-inline` in `script-src`, and the frontend security-header tests assert the production header contract.',
      launch_impact:
        'Operator-facing XSS impact remains unnecessarily high across both web surfaces until CSP is tightened.',
    });
  }

  const uiEventFile = fileMap['apps/shared/ui-event-route.ts'];
  if (
    uiEventFile &&
    uiEventFile.content.includes('createServerClient({ allowCookieSet: false })') &&
    uiEventFile.content.includes('const text = await request.text();') &&
    !uiEventFile.content.includes('validateTrustedBrowserRequest')
  ) {
    findings.push({
      id: 'web-ui-event-csrf',
      title: 'UI event logging route lacks browser-origin and content-type hardening',
      severity: 'P2',
      status: 'confirmed',
      surface: 'web',
      exploit_path:
        'The route authenticates from the browser session cookie, accepts any POST body via `request.text()`, and never validates `Origin` or an application/json content type. A cross-site simple request can therefore write attacker-supplied telemetry into the user event log.',
      evidence: [
        'The route reads the session via `createServerClient(...).auth.getSession()` and parses raw request text without an origin gate or content-type restriction.',
      ],
      standards: [
        'OWASP ASVS 5.0.0 / session management',
        'NIST CSF 2.0 / protect against unauthorized actions',
      ],
      affected_files: [
        buildFileRef(
          repoRoot,
          uiEventFile.filePath,
          lineNumber(uiEventFile.content, 'const supabase = createServerClient({ allowCookieSet: false });') || 201,
        ),
        buildFileRef(
          repoRoot,
          uiEventFile.filePath,
          lineNumber(uiEventFile.content, 'const text = await request.text();') || 214,
        ),
      ],
      remediation:
        'Reject requests without the expected `Origin` and `Content-Type: application/json`, or move the endpoint to bearer-token authentication so a browser cookie alone cannot authorize cross-site writes.',
      retest_criteria:
        'Cross-origin text/plain requests no longer succeed against the UI event route, and unit or integration coverage proves that only same-origin JSON posts are accepted.',
      launch_impact:
        'The audit trail can be polluted by cross-site traffic, which weakens trust in frontend telemetry and complicates incident analysis.',
    });
  }

  const serverSessionFiles = [
    fileMap['apps/shared/app-layout.tsx'],
    fileMap['packages/ui/src/dashboard-page.tsx'],
    fileMap['packages/ui/src/route-operations-workspace-page.tsx'],
    fileMap['packages/ui/src/tenant-signup-requests-page.tsx'],
    fileMap['apps/console/app/api/resource-download/route.ts'],
    fileMap['apps/portal/app/api/resource-download/route.ts'],
    fileMap['apps/shared/ui-event-route.ts'],
  ].filter(Boolean);
  if (
    serverSessionFiles.length >= 4 &&
    serverSessionFiles.every((entry) => entry.content.includes('auth.getSession('))
  ) {
    findings.push({
      id: 'server-auth-getsession',
      title: 'Server-side authorization paths trust Supabase getSession() results',
      severity: 'P1',
      status: 'confirmed',
      surface: 'web',
      exploit_path:
        'Multiple server-rendered pages and route handlers gate access or derive access tokens from `auth.getSession()` instead of server-side token validation. Supabase documents `getSession()` as insecure on the server because it reads directly from the request cookie storage.',
      evidence: [
        'Server-rendered app layout, dashboard, route-operations workspace, tenant-signup reviewer page, and both route handlers all use `auth.getSession()` in server-only contexts.',
      ],
      standards: [
        'OWASP ASVS 5.0.0 / authentication and session management',
        'OWASP API Security Top 10 2023 / broken authentication',
        'NIST CSF 2.0 / identity and access management',
      ],
      affected_files: [
        buildFileRef(repoRoot, serverSessionFiles[0].filePath, lineNumber(serverSessionFiles[0].content, 'auth.getSession(') || 236),
        buildFileRef(repoRoot, serverSessionFiles[1].filePath, lineNumber(serverSessionFiles[1].content, 'auth.getSession(') || 197),
        buildFileRef(repoRoot, serverSessionFiles[2].filePath, lineNumber(serverSessionFiles[2].content, 'auth.getSession(') || 689),
        buildFileRef(repoRoot, serverSessionFiles[3].filePath, lineNumber(serverSessionFiles[3].content, 'auth.getSession(') || 171),
        buildFileRef(repoRoot, serverSessionFiles[4].filePath, lineNumber(serverSessionFiles[4].content, 'auth.getSession(') || 34),
        buildFileRef(repoRoot, serverSessionFiles[5].filePath, lineNumber(serverSessionFiles[5].content, 'auth.getSession(') || 34),
        buildFileRef(repoRoot, serverSessionFiles[6].filePath, lineNumber(serverSessionFiles[6].content, 'auth.getSession(') || 202),
      ],
      remediation:
        'Replace server-side `auth.getSession()` authorization checks with `auth.getUser()` or an equivalent verified server-side token validation path, then update the SSR helpers and route handlers consistently.',
      retest_criteria:
        'Server-rendered auth gates and route handlers no longer authorize from `getSession()` in server-only code, and regression coverage proves unverified cookie state is rejected.',
      launch_impact:
        'The server trust boundary for authenticated operator flows is weaker than intended until session validation is moved to a verified server-side path.',
    });
  }

  const downloadFiles = [
    fileMap['apps/console/app/api/resource-download/route.ts'],
    fileMap['apps/portal/app/api/resource-download/route.ts'],
  ].filter(Boolean);
  if (
    downloadFiles.length === 2 &&
    downloadFiles.every((entry) =>
      entry.content.includes('export async function GET(request: NextRequest)') &&
      entry.content.includes('const supabase = createServerClient();') &&
      entry.content.includes('const { data, error } = await supabase.auth.getSession();') &&
      entry.content.includes('return redirectWithRequestId(result.url, requestId, 302);') &&
      !entry.content.includes('validateTrustedBrowserRequest'),
    )
  ) {
    findings.push({
      id: 'web-download-get-csrf',
      title: 'Signed download issuance remains a cookie-authenticated GET flow',
      severity: 'P2',
      status: 'confirmed',
      surface: 'web',
      exploit_path:
        'Both console and portal sign protected resource downloads from a GET endpoint using the browser session cookie, then redirect to the signed URL. Without an origin or intent check, an attacker can trigger cross-site download issuance for guessed resource identifiers.',
      evidence: [
        'Both app routes authorize from the session cookie and redirect to the signed URL without an origin check or CSRF control.',
      ],
      standards: [
        'OWASP ASVS 5.0.0 / session management',
        'NIST CSF 2.0 / protect against unauthorized actions',
      ],
      affected_files: downloadFiles.map((entry) =>
        buildFileRef(
          repoRoot,
          entry.filePath,
          lineNumber(entry.content, 'const supabase = createServerClient();') || 33,
        ),
      ),
      remediation:
        'Move download issuance to a same-origin POST with explicit intent validation, or require a per-request anti-CSRF token before minting signed URLs from a browser session.',
      retest_criteria:
        'Cross-site requests cannot trigger new signed download URLs, and the route requires a same-origin POST or equivalent anti-CSRF control before issuing a redirect.',
      launch_impact:
        'Protected downloads are more susceptible to drive-by issuance and identifier-guessing abuse than the rest of the authenticated surface.',
    });
  }

  // This is bounded source-call coverage, not runtime credential/schema proof.
  let ts;
  try { ts = require('typescript'); } catch { /* Report unavailable parser per endpoint below. */ }
  for (const [endpoint, mutation, read] of [
    ['marketing-lead-intake', 'marketing_lead_request_create_v1', 'marketing_landing_clients_list_v1'],
    ['tenant-signup-intake', 'tenant_signup_request_create_v1', null],
  ]) {
    const relativePath = `supabase/functions/${endpoint}/index.ts`;
    const entry = fileMap[relativePath];
    const violations = [];
    const unknown = [];
    const seen = new Set();
    const source = typeof entry?.content === 'string' ? entry.content : '';
    if (!source.trim()) unknown.push('Required endpoint source is missing or empty.');
    const tree = ts ? ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) : null;
    if (!tree) unknown.push('TypeScript parser is unavailable in this audit runtime.');
    else if (tree.parseDiagnostics.length) unknown.push('Endpoint source could not be parsed.');
    const literal = (node) => node && ts.isStringLiteralLike(node) ? node.text : null;
    const isName = (node, name) => node && ts.isIdentifier(node) && node.text === name;
    const property = (node, name) => {
      if (!node || !ts.isObjectLiteralExpression(node)) return null;
      if (node.properties.some((item) => !ts.isPropertyAssignment(item))) return null;
      const matches = node.properties.filter((item) => item.name.getText(tree) === name);
      return matches.length === 1 ? matches[0].initializer : null;
    };
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === 'invokeRpcWithAuthFallback') {
        const parent = node.parent;
        const declaration = ts.isVariableDeclaration(parent) && parent.name === node;
        const directCall = ts.isCallExpression(parent) && parent.expression === node;
        if (!declaration && !directCall) unknown.push('Unsupported alias/reference to marketing RPC helper.');
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const helperCall = endpoint === 'marketing-lead-intake' && isName(callee, 'invokeRpcWithAuthFallback');
        const rpcCall = ts.isPropertyAccessExpression(callee) && callee.name.text === 'rpc';
        const tableCall = ts.isPropertyAccessExpression(callee) && callee.name.text === 'from';
        if (tableCall) {
          if (isName(callee.expression, 'serviceClient'))
            violations.push('Generic service-client table access is outside the fixed public-intake RPC contract.');
          else if (!isName(callee.expression, 'Array'))
            unknown.push('Unrecognized from() receiver requires explicit DB-call review.');
        }
        if (ts.isElementAccessExpression(callee)) unknown.push('Computed call requires explicit endpoint review.');
        if (helperCall || rpcCall) {
          const rpc = literal(node.arguments[0]);
          if (!rpc) {
            unknown.push('Dynamic RPC target cannot be qualified by this bounded audit.');
          } else if (rpc !== mutation && rpc !== read) {
            violations.push(`RPC ${rpc} is outside the endpoint fixed-RPC contract.`);
          } else {
            seen.add(rpc);
            if (endpoint === 'marketing-lead-intake') {
              if (!helperCall) unknown.push('Marketing RPC bypasses its supported auth-selection helper.');
              else if (rpc === mutation) {
                const serviceOnly = property(node.arguments[2], 'serviceOnly');
                if (!serviceOnly) unknown.push('Marketing mutation auth mode is not statically explicit.');
                else if (serviceOnly.kind !== ts.SyntaxKind.TrueKeyword)
                  violations.push('Marketing mutation does not request service-only authentication.');
              } else if (node.arguments[2]) {
                unknown.push('Marketing read auth options require explicit review.');
              }
            } else if (!rpcCall || !isName(callee.expression, 'serviceClient')) {
              unknown.push('Tenant mutation does not use the supported service-client seam.');
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (tree && !tree.parseDiagnostics.length) visit(tree);
    if (!seen.has(mutation)) unknown.push('Required fixed mutation call is not established.');
    if (read && !seen.has(read)) unknown.push('Required narrow-read call is not established.');
    // Do not claim helper internals, resolved credentials/schema, grants, or deployment
    // are qualified here. Those remain separate source/native qualification gates.
    for (const [kind, reasons] of [['contract', violations], ['coverage', unknown]]) {
      if (!reasons.length) continue;
      findings.push({
        id: `public-intake-${endpoint}-${kind}`,
        title: `${endpoint}: ${kind === 'contract' ? 'fixed-RPC contract violation' : 'incomplete source-call coverage'}`,
        severity: 'P1',
        status: kind === 'contract' ? 'confirmed' : 'unverified',
        surface: 'api',
        exploit_path: kind === 'contract'
          ? 'The inspected endpoint call exceeds its current approved fixed-RPC boundary; live exploitability is not established.'
          : 'The bounded source audit cannot establish the endpoint call contract; this is missing evidence, not a proven vulnerability.',
        evidence: [...new Set(reasons)],
        standards: ['OWASP ASVS 5.0.0 / architecture and access control'],
        affected_files: [buildFileRef(repoRoot, entry?.filePath || path.join(repoRoot, relativePath), 1)],
        remediation: 'Preserve the current service-only fixed mutation and supported read contracts; resolve only the reported call or coverage gap. Do not restore obsolete Edge mutation grants.',
        retest_criteria: 'Qualify each endpoint independently, then verify auth helper, API schema, DB grants and runtime evidence separately.',
        launch_impact: 'An endpoint-specific contract or evidence gap remains; existing severity/decision policy is unchanged.',
      });
    }
  }

  const signOutFiles = [
    fileMap['apps/console/app/auth/sign-out/route.ts'],
    fileMap['apps/portal/app/auth/sign-out/route.ts'],
  ].filter(Boolean);
  const signOutHandlerFile = fileMap['packages/auth/src/next.ts'];
  if (
    signOutFiles.length === 2 &&
    signOutHandlerFile &&
    signOutFiles.every((entry) => entry.content.includes('export async function GET(request: Request)')) &&
    !signOutHandlerFile.content.includes('validateTrustedBrowserRequest')
  ) {
    findings.push({
      id: 'web-signout-get',
      title: 'Sign-out remains a state-changing GET route',
      severity: 'P2',
      status: 'confirmed',
      surface: 'web',
      exploit_path:
        'Both console and portal expose logout as a GET route. A cross-site navigation or embedded request can therefore terminate the user session without an explicit same-origin POST or CSRF control.',
      evidence: [
        'The sign-out routes export `GET` and forward directly to the shared sign-out handler.',
      ],
      standards: [
        'OWASP ASVS 5.0.0 / session management',
        'NIST CSF 2.0 / protect against unauthorized actions',
      ],
      affected_files: signOutFiles.map((entry) =>
        buildFileRef(
          repoRoot,
          entry.filePath,
          lineNumber(entry.content, 'export async function GET(request: Request)') || 3,
        ),
      ),
      remediation:
        'Change logout to a same-origin POST-only route or require an anti-CSRF token before invalidating the browser session.',
      retest_criteria:
        'Cross-site GET requests no longer terminate the session, and the sign-out route requires a same-origin POST or equivalent CSRF proof.',
      launch_impact:
        'Users can be logged out by cross-site traffic, which is low-severity but still a session-integrity regression.',
    });
  }

  return findings;
}

function readFileMap(repoRoot, filePaths) {
  const map = {};
  for (const relPath of filePaths) {
    const absolutePath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absolutePath)) continue;
    map[relPath] = {
      filePath: absolutePath,
      content: readText(absolutePath),
    };
  }
  return map;
}

function renderFindingsMarkdown({ findings }) {
  const lines = [];
  lines.push('# Stg Go-Live Security Review Findings');
  lines.push('');
  if (!findings.length) {
    lines.push('No findings recorded.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| ID | Severity | Status | Surface | Title |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const finding of findings) {
    lines.push(`| ${finding.id} | ${finding.severity} | ${finding.status} | ${finding.surface} | ${finding.title} |`);
  }
  lines.push('');

  for (const finding of findings) {
    lines.push(`## ${finding.id} - ${finding.title}`);
    lines.push('');
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Status: ${finding.status}`);
    lines.push(`- Surface: ${finding.surface}`);
    lines.push(`- Exploit path: ${finding.exploit_path}`);
    if (finding.affected_files && finding.affected_files.length) {
      lines.push('- Affected files:');
      for (const ref of finding.affected_files) {
        lines.push(`  - ${ref.path}:${ref.line}`);
      }
    }
    if (finding.evidence && finding.evidence.length) {
      lines.push('- Evidence:');
      for (const item of finding.evidence) {
        lines.push(`  - ${item}`);
      }
    }
    if (finding.standards && finding.standards.length) {
      lines.push('- Standards mapping:');
      for (const standard of finding.standards) {
        lines.push(`  - ${standard}`);
      }
    }
    lines.push(`- Remediation: ${finding.remediation}`);
    lines.push(`- Retest criteria: ${finding.retest_criteria}`);
    lines.push(`- Launch impact: ${finding.launch_impact}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderProbeMatrixMarkdown(probes) {
  const lines = [];
  lines.push('# Stg Go-Live Security Review Probe Matrix');
  lines.push('');
  if (!probes.length) {
    lines.push('No probes configured.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| Probe ID | Surface | Focus | Status |');
  lines.push('| --- | --- | --- | --- |');
  for (const probe of probes) {
    lines.push(`| ${probe.id} | ${probe.surface} | ${probe.focus} | pending_manual_execution |`);
  }
  lines.push('');
  lines.push('Mutation-capable staging probes are intentionally represented as pending until a credentialed operator run executes them against the dedicated staging assessment boundary.');
  lines.push('');
  return lines.join('\n');
}

function summarizeFindings(findings) {
  const counts = {
    P0: 0,
    P1: 0,
    P2: 0,
    informational: 0,
  };
  for (const finding of findings) {
    const severity = counts[finding.severity] !== undefined ? finding.severity : 'informational';
    counts[severity] += 1;
  }
  return counts;
}

function deriveDecision({ findings, workflowResults, commandResults }) {
  const counts = summarizeFindings(findings);
  const failedWorkflows = (workflowResults || []).filter((entry) => entry.conclusion !== 'success');
  const failedCommands = (commandResults || []).filter((entry) => entry.ok === false);
  const recommendation =
    counts.P0 > 0 || failedWorkflows.length > 0
      ? 'NO-GO'
      : counts.P1 > 0 || failedCommands.length > 0
        ? 'GO WITH EXCEPTIONS'
        : 'GO';

  const rationale = [];
  if (counts.P0 > 0) rationale.push(`P0 findings open: ${counts.P0}`);
  if (failedWorkflows.length > 0) rationale.push(`Mandatory workflows not successful: ${failedWorkflows.length}`);
  if (failedCommands.length > 0) rationale.push(`Local evidence commands failed: ${failedCommands.length}`);
  if (!rationale.length) rationale.push('No blocking findings recorded in this run.');

  return {
    recommendation,
    rationale,
    counts,
  };
}

function renderTechnicalReport({
  inventory,
  commandResults,
  workflowResults,
  findings,
  decision,
}) {
  const lines = [];
  lines.push('# Stg Go-Live Security Review Report');
  lines.push('');
  lines.push(`Generated at: ${inventory.generated_at}`);
  lines.push(`Decision: ${decision.recommendation}`);
  lines.push('');
  lines.push('## Summary');
  for (const item of decision.rationale) {
    lines.push(`- ${item}`);
  }
  lines.push(`- Findings: P0=${decision.counts.P0}, P1=${decision.counts.P1}, P2=${decision.counts.P2}, informational=${decision.counts.informational}`);
  lines.push('');
  lines.push('## Standards Baseline');
  for (const standard of inventory.standards || []) {
    lines.push(`- ${standard.id}: ${standard.url}`);
  }
  lines.push('');
  lines.push('## Local Evidence Commands');
  for (const entry of commandResults || []) {
    lines.push(`- ${entry.label}: ${entry.ok ? 'PASS' : 'FAIL'} (${entry.log_file})`);
  }
  lines.push('');
  lines.push('## Workflow Checks');
  for (const entry of workflowResults || []) {
    const url = entry.url ? ` ${entry.url}` : '';
    const reason = entry.reason ? ` - ${entry.reason}` : '';
    lines.push(`- ${entry.label}: ${entry.conclusion || entry.status}${reason}${url}`);
    if (entry.jobs && entry.jobs.length) {
      for (const job of entry.jobs) {
        const jobUrl = job.url ? ` ${job.url}` : '';
        lines.push(`  - job ${job.name}: ${job.conclusion || job.status}${jobUrl}`);
      }
    }
    if (entry.refresh_error) {
      lines.push(`  - refresh_error: ${entry.refresh_error}`);
    }
  }
  lines.push('');
  lines.push('## Findings');
  if (!(findings || []).length) {
    lines.push('- No findings recorded.');
  } else {
    for (const finding of findings) {
      lines.push(`- ${finding.id} [${finding.severity}] ${finding.title}`);
      if (finding.affected_files && finding.affected_files.length) {
        for (const ref of finding.affected_files) {
          lines.push(`  - ${ref.path}:${ref.line}`);
        }
      }
      if (finding.standards && finding.standards.length) {
        for (const standard of finding.standards) {
          lines.push(`  - standards: ${standard}`);
        }
      }
    }
  }
  lines.push('');
  lines.push('## Evidence Files');
  lines.push(`- Attack surface: ${inventory.evidence_dir}/attack-surface.md`);
  lines.push(`- Findings: ${inventory.evidence_dir}/findings.md`);
  lines.push(`- Probe matrix: ${inventory.evidence_dir}/probe-matrix.md`);
  lines.push(`- Summary JSON: ${inventory.evidence_dir}/summary.json`);
  lines.push(`- Workflow results JSON: ${inventory.evidence_dir}/workflow-runs.json`);
  lines.push('');
  return lines.join('\n');
}

function sortFindings(findings) {
  return Array.from(findings || []).sort((left, right) => {
    const leftRank = FINDING_SEVERITY_ORDER[left.severity] ?? 99;
    const rightRank = FINDING_SEVERITY_ORDER[right.severity] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left.id || '').localeCompare(String(right.id || ''));
  });
}

function runCli(rawOptions) {
  const options = rawOptions || parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return null;
  }

  const config = readJson(options.configFile);
  const generatedAt = new Date().toISOString();
  const evidenceDir = resolveEvidenceDir(options, config, generatedAt);
  ensureDir(evidenceDir);

  const inventory = buildAttackSurfaceInventory({
    repoRoot: options.repoRoot,
    config,
    generatedAt,
    evidenceDir,
    options,
  });
  writeJson(path.join(evidenceDir, 'attack-surface.json'), inventory);
  writeText(path.join(evidenceDir, 'attack-surface.md'), renderAttackSurfaceMarkdown(inventory));

  const commandExecution = executeLocalCommands({
    repoRoot: options.repoRoot,
    config,
    evidenceDir,
  });

  const workflowRunsFile = path.join(evidenceDir, 'workflow-runs.json');
  const workflowExecution =
    !options.dispatchWorkflows && fs.existsSync(workflowRunsFile)
      ? {
          results: refreshWorkflowResults({
            repoRoot: options.repoRoot,
            results: readJson(workflowRunsFile),
          }),
          findings: [],
        }
      : dispatchWorkflowChecks({
          repoRoot: options.repoRoot,
          config,
          options,
        });
  writeJson(workflowRunsFile, workflowExecution.results);

  const fileMap = readFileMap(options.repoRoot, [
    'apps/shared/security-headers.js',
    'apps/shared/app-layout.tsx',
    'apps/shared/ui-event-route.ts',
    'apps/console/app/auth/sign-out/route.ts',
    'apps/console/app/api/resource-download/route.ts',
    'apps/portal/app/auth/sign-out/route.ts',
    'apps/portal/app/api/resource-download/route.ts',
    'packages/auth/src/next.ts',
    'packages/ui/src/dashboard-page.tsx',
    'packages/ui/src/route-operations-workspace-page.tsx',
    'packages/ui/src/tenant-signup-requests-page.tsx',
    'supabase/functions/marketing-lead-intake/index.ts',
    'supabase/functions/tenant-signup-intake/index.ts',
  ]);
  const staticFindings = buildStaticFindings({
    repoRoot: options.repoRoot,
    fileMap,
  });

  const allFindings = [
    ...commandExecution.findings,
    ...workflowExecution.findings,
    ...staticFindings,
  ];
  const workflowBarrier = buildWorkflowBarrierFinding(workflowExecution.results);
  if (workflowBarrier) allFindings.push(workflowBarrier);
  const sortedFindings = sortFindings(allFindings);

  writeText(
    path.join(evidenceDir, 'probe-matrix.md'),
    renderProbeMatrixMarkdown(config.probe_matrix || []),
  );
  writeJson(path.join(evidenceDir, 'findings.json'), sortedFindings);
  writeText(
    path.join(evidenceDir, 'findings.md'),
    renderFindingsMarkdown({ findings: sortedFindings }),
  );

  const decision = deriveDecision({
    findings: sortedFindings,
    workflowResults: workflowExecution.results,
    commandResults: commandExecution.results,
  });
  const summary = {
    generated_at: generatedAt,
    evidence_dir: relativeUnix(options.repoRoot, evidenceDir),
    scope: inventory.scope,
    launch_ref: inventory.launch_ref,
    workflow_ref: inventory.workflow_ref,
    decision,
    local_commands: commandExecution.results,
    workflow_results: workflowExecution.results,
    finding_count: sortedFindings.length,
  };
  writeJson(path.join(evidenceDir, 'summary.json'), summary);
  writeText(
    path.join(evidenceDir, 'technical-report.md'),
    renderTechnicalReport({
      inventory,
      commandResults: commandExecution.results,
      workflowResults: workflowExecution.results,
      findings: sortedFindings,
      decision,
    }),
  );

  console.log(
    `[stg-go-live-security-review] decision=${decision.recommendation} findings=${sortedFindings.length} evidence=${relativeUnix(options.repoRoot, evidenceDir)}`,
  );
  return {
    inventory,
    commandExecution,
    workflowExecution,
    findings: sortedFindings,
    decision,
    evidenceDir,
  };
}

if (require.main === module) {
  try {
    runCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`stg-go-live-security-review: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildAttackSurfaceInventory,
  buildStaticFindings,
  buildWorkflowBarrierFinding,
  deriveDecision,
  formatUtcDate,
  parseArgs,
  renderAttackSurfaceMarkdown,
  renderFindingsMarkdown,
  renderProbeMatrixMarkdown,
  renderTechnicalReport,
  resolveEvidenceDir,
  runCli,
  summarizeFindings,
};
