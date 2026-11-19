#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_POLICY_PATH = 'config/ops/pr-branch-triage-policy.json';
const DEFAULT_LEDGER_PATH = '.codex-local/masarx-os-v2/use-case-ledger.json';
const DEFAULT_CHANGED_FILE_LIMIT = 500;
const DEFAULT_ANALYSIS_LIMIT = 50;
const DEFAULT_PR_LIMIT = 200;

function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.replace(/^--/, '');
    if (key.includes('=')) {
      const [lhs, ...rhs] = key.split('=');
      args[lhs] = rhs.join('=');
      continue;
    }
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = '1';
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function norm(value) {
  return String(value || '').trim();
}

function toIsoOrBlank(value) {
  const text = norm(value);
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 30_000,
    shell: false,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${stderr || stdout}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
  };
}

function git(args, options = {}) {
  return run('git', args, options);
}

function ghJson(args, options = {}) {
  const result = run('gh', args, { ...options, allowFailure: true });
  if (!result.ok || !result.stdout) {
    ghJson.lastError = result.stderr || result.stdout || `gh exited with ${result.status}`;
    return null;
  }
  try {
    ghJson.lastError = '';
    return JSON.parse(result.stdout);
  } catch (error) {
    ghJson.lastError = error.message;
    return null;
  }
}

function getRepoRoot() {
  const result = git(['rev-parse', '--show-toplevel']);
  return result.stdout;
}

function getHead(ref) {
  if (!ref) return '';
  const result = git(['rev-parse', '--verify', ref], { allowFailure: true });
  return result.ok ? result.stdout : '';
}

function refExists(ref) {
  return Boolean(getHead(ref));
}

function parseForEachRef(scope, stdout) {
  return stdout.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [refname, shortName, objectName, committerDate, subject] = line.split('\t');
      return {
        refname,
        shortName,
        scope,
        head: objectName,
        date: toIsoOrBlank(committerDate),
        subject: subject || '',
      };
    })
    .filter((row) => row.head && row.shortName && row.shortName !== 'origin/HEAD');
}

function listBranches() {
  const format = '%(refname)%09%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)';
  const local = git(['for-each-ref', `--format=${format}`, 'refs/heads'], { allowFailure: true });
  const remote = git(['for-each-ref', `--format=${format}`, 'refs/remotes'], { allowFailure: true });
  return [
    ...parseForEachRef('local', local.stdout || ''),
    ...parseForEachRef('remote', remote.stdout || ''),
  ];
}

function normalizeBranchListName(value) {
  return String(value || '')
    .replace(/^\*\s*/, '')
    .trim()
    .replace(/^remotes\//, '');
}

function buildTargetAnalysis(targetRef) {
  const targetHead = getHead(targetRef);
  if (!targetRef || !targetHead) {
    return {
      target_ref: targetRef || '',
      target_head: '',
      merged: new Set(),
      contains: new Set(),
    };
  }
  const merged = git(['branch', '-a', '--merged', targetRef], { allowFailure: true }).stdout
    .split(/\r?\n/)
    .map(normalizeBranchListName)
    .filter(Boolean);
  const contains = git(['branch', '-a', '--contains', targetHead], { allowFailure: true }).stdout
    .split(/\r?\n/)
    .map(normalizeBranchListName)
    .filter(Boolean);
  return {
    target_ref: targetRef,
    target_head: targetHead,
    merged: new Set(merged),
    contains: new Set(contains),
  };
}

function parseWorktrees() {
  const result = git(['worktree', 'list', '--porcelain'], { allowFailure: true });
  const rows = [];
  let current = null;
  for (const rawLine of String(result.stdout || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) rows.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') current = { path: value, head: '', branch: '', dirty_state: 'unknown' };
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    if (key === 'detached') current.branch = '(detached)';
  }
  if (current) rows.push(current);

  return rows.map((row) => {
    const dirty = row.path && fs.existsSync(row.path)
      ? 'unknown_status_skipped'
      : 'unknown_path_missing';
    return { ...row, dirty_state: dirty };
  });
}

function listOpenPrs(options = {}) {
  const limit = String(Number(options['pr-limit'] || DEFAULT_PR_LIMIT));
  const fieldsWithChecks = [
    'number',
    'title',
    'state',
    'isDraft',
    'headRefName',
    'headRefOid',
    'baseRefName',
    'mergeStateStatus',
    'reviewDecision',
    'statusCheckRollup',
    'updatedAt',
    'url',
  ];
  const fieldsWithoutChecks = fieldsWithChecks.filter((field) => field !== 'statusCheckRollup');
  const data = ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    limit,
    '--json',
    fieldsWithChecks.join(','),
  ], { timeout: 20_000 });
  if (Array.isArray(data)) {
    return {
      items: data,
      collection: {
        ok: true,
        ci_included: true,
        source: 'gh pr list with statusCheckRollup',
        error: '',
      },
    };
  }
  const firstError = ghJson.lastError || '';
  const fallback = ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    limit,
    '--json',
    fieldsWithoutChecks.join(','),
  ], { timeout: 20_000 });
  if (Array.isArray(fallback)) {
    return {
      items: fallback,
      collection: {
        ok: true,
        ci_included: false,
        source: 'gh pr list without statusCheckRollup',
        error: firstError,
      },
    };
  }
  return {
    items: [],
    collection: {
      ok: false,
      ci_included: false,
      source: 'gh pr list',
      error: ghJson.lastError || firstError || 'unknown GitHub PR collection failure',
    },
  };
}

function summarizeChecks(checks = []) {
  const states = {};
  for (const check of Array.isArray(checks) ? checks : []) {
    const conclusion = check.conclusion || check.status || 'UNKNOWN';
    states[conclusion] = (states[conclusion] || 0) + 1;
  }
  return states;
}

function branchNameWithoutRemote(shortName) {
  return shortName.replace(/^origin\//, '');
}

function matchOpenPr(branch, prs) {
  const name = branchNameWithoutRemote(branch.shortName);
  const match = prs.find((pr) => pr.headRefName === name || pr.headRefOid === branch.head);
  if (!match) return null;
  return {
    number: match.number,
    url: match.url,
    state: match.state,
    is_draft: Boolean(match.isDraft),
    base: match.baseRefName || '',
    head_ref: match.headRefName || '',
    head: match.headRefOid || '',
    merge_state: match.mergeStateStatus || '',
    review_decision: match.reviewDecision || '',
    updated_at: match.updatedAt || '',
    ci_summary: summarizeChecks(match.statusCheckRollup || []),
  };
}

function newestRefMatching(pattern) {
  const rows = listBranches()
    .filter((row) => row.shortName.startsWith(pattern))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows[0]?.shortName || '';
}

function resolveTargets(options = {}) {
  const dev = options.dev || (refExists('origin/dev') ? 'origin/dev' : 'dev');
  const integration = options['integration-baseline']
    || (refExists('origin/codex/integration-baseline-dev-c1e25fd-20260706') ? 'origin/codex/integration-baseline-dev-c1e25fd-20260706' : '')
    || newestRefMatching('origin/codex/integration-baseline-')
    || newestRefMatching('codex/integration-baseline-');
  const devReconciliation = options['dev-reconciliation']
    || (refExists('origin/codex/dev-reconciliation-integration-baseline-20260706') ? 'origin/codex/dev-reconciliation-integration-baseline-20260706' : '')
    || newestRefMatching('origin/codex/dev-reconciliation-')
    || newestRefMatching('codex/dev-reconciliation-');
  return {
    dev,
    integration_baseline: integration,
    dev_reconciliation: devReconciliation,
  };
}

function containmentFor(head, branchShortName, targetInfo, collectDetails) {
  if (!targetInfo?.target_ref) {
    return {
      target_ref: '',
      target_head: '',
      status: 'unknown_target_missing',
      merge_base: '',
      ahead: null,
      behind: null,
      detail_collection: 'target_missing',
    };
  }
  const targetHead = targetInfo.target_head;
  if (!targetHead) {
    return {
      target_ref: targetInfo.target_ref,
      target_head: '',
      status: 'unknown_target_unresolved',
      merge_base: '',
      ahead: null,
      behind: null,
      detail_collection: 'target_unresolved',
    };
  }
  const normalized = branchNameWithoutRemote(branchShortName);
  const names = new Set([branchShortName, normalized].filter(Boolean));
  const contained = [...names].some((name) => targetInfo.merged.has(name));
  const targetContained = [...names].some((name) => targetInfo.contains.has(name));
  let status = 'not_contained';
  if (contained) status = 'contained';
  else if (targetContained) status = 'contains_target';
  if (!collectDetails) {
    return {
      target_ref: targetInfo.target_ref,
      target_head: targetHead,
      status,
      merge_base: '',
      ahead: null,
      behind: null,
      detail_collection: 'skipped_by_analysis_limit',
    };
  }
  const mergeBase = git(['merge-base', head, targetHead], { allowFailure: true }).stdout || '';
  const counts = git(['rev-list', '--left-right', '--count', `${targetHead}...${head}`], { allowFailure: true }).stdout;
  const [behindRaw, aheadRaw] = String(counts || '').split(/\s+/);
  return {
    target_ref: targetInfo.target_ref,
    target_head: targetHead,
    status,
    merge_base: mergeBase,
    ahead: Number.isFinite(Number(aheadRaw)) ? Number(aheadRaw) : null,
    behind: Number.isFinite(Number(behindRaw)) ? Number(behindRaw) : null,
    detail_collection: 'bounded',
  };
}

function changedFilesFromTarget(head, targetInfo, changedFileLimit, collectDetails = true) {
  if (!collectDetails) {
    return {
      target_ref: targetInfo?.target_ref || '',
      merge_base: targetInfo?.merge_base || '',
      changed_files: [],
      changed_file_count: null,
      changed_files_truncated: false,
      collection: 'skipped_by_analysis_limit',
    };
  }
  if (!targetInfo?.target_head || changedFileLimit <= 0) {
    return {
      target_ref: targetInfo?.target_ref || '',
      merge_base: targetInfo?.merge_base || '',
      changed_files: [],
      changed_file_count: null,
      changed_files_truncated: false,
      collection: changedFileLimit <= 0 ? 'skipped_by_changed_file_limit' : 'target_unavailable',
    };
  }
  const diffBase = targetInfo.merge_base || targetInfo.target_head;
  const changed = git(['diff', '--name-only', `${diffBase}..${head}`], { allowFailure: true }).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    target_ref: targetInfo.target_ref,
    merge_base: targetInfo.merge_base || '',
    changed_files: changed.slice(0, changedFileLimit),
    changed_file_count: changed.length,
    changed_files_truncated: changed.length > changedFileLimit,
    collection: 'bounded',
  };
}

function collectLedgerRefs(ledgerPath) {
  const refs = [];
  if (!fs.existsSync(ledgerPath)) return refs;
  const ledger = readJson(ledgerPath);
  const evidenceKeys = [
    'visible_proof',
    'backend_readback',
    'tests',
    'runtime_proof',
    'screenshots_or_traces',
    'handoff_packet',
    'pr_or_preserve_ref',
  ];
  for (const uc of Array.isArray(ledger.use_cases) ? ledger.use_cases : []) {
    const rows = [
      { kind: 'uc', row: uc, scenario_id: '' },
      ...(Array.isArray(uc.scenarios) ? uc.scenarios.map((scenario) => ({ kind: 'scenario', row: scenario, scenario_id: scenario.scenario_id || '' })) : []),
    ];
    for (const item of rows) {
      const evidence = item.row?.evidence || {};
      for (const key of evidenceKeys) {
        for (const ref of Array.isArray(evidence[key]) ? evidence[key] : []) {
          refs.push({
            uc_id: uc.uc_id || '',
            scenario_id: item.scenario_id,
            evidence_key: key,
            ref: String(ref),
          });
        }
      }
    }
  }
  return refs;
}

function ledgerMatchesForBranch(branch, ledgerRefs) {
  const names = new Set([
    branch.shortName,
    branchNameWithoutRemote(branch.shortName),
    branch.refname,
    branch.head,
  ].filter(Boolean));
  return ledgerRefs.filter((ref) => {
    const value = String(ref.ref || '');
    for (const name of names) {
      if (name && value.includes(name)) return true;
    }
    return false;
  });
}

function listPreserveRefs() {
  const refs = git(['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/codex/preserve-*', 'refs/remotes/origin/codex/preserve-*'], { allowFailure: true }).stdout;
  return refs.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split('\t');
      return { name, head };
    });
}

function matchesPattern(branchName, pattern) {
  if (!pattern) return false;
  if (pattern.endsWith('/*')) {
    return branchName.startsWith(pattern.slice(0, -1));
  }
  return branchName === pattern || branchName.endsWith(`/${pattern}`);
}

function inferMapping(branch, ledgerMatches) {
  const name = branchNameWithoutRemote(branch.shortName).toLowerCase();
  if (ledgerMatches.length) {
    return {
      scope: 'product',
      mapping_status: 'mapped',
      uc_id: ledgerMatches[0].uc_id || '',
      scenario_ids: [...new Set(ledgerMatches.map((item) => item.scenario_id).filter(Boolean))],
      evidence_refs: [...new Set(ledgerMatches.map((item) => item.ref))],
      proposed_uc_id: '',
      proposed_scenario_ids: [],
      non_product_scope_reason: '',
    };
  }
  const productTerms = [
    'phase-landing',
    'landing-public',
    'tenant-',
    'client-api',
    'external-intake',
    'workflow-plugin',
    'workflow-',
    'plugin-',
    'label-designer',
    'shipment',
    'dispatch',
    'route',
    'fieldops',
    'mobile-v2',
    'maps',
    'geocod',
    'driver',
    'pickup',
    'delivery',
    'finance',
    'cod-',
    'cod_',
    'cash',
    'support',
  ];
  if (productTerms.some((term) => name.includes(term))) {
    return {
      scope: 'product',
      mapping_status: 'missing',
      uc_id: '',
      scenario_ids: [],
      evidence_refs: [],
      proposed_uc_id: '',
      proposed_scenario_ids: [],
      non_product_scope_reason: '',
    };
  }
  const governanceTerms = [
    'dependabot',
    'baseline',
    'visual',
    'lifecycle',
    'verify',
    'governance',
    'control',
    'ledger',
    'runtime',
    'ci',
    'deploy',
    'release',
    'branch',
    'pr-',
    'preserve',
    'pgtap',
    'local-admission',
    'dev-reconciliation',
  ];
  if (governanceTerms.some((term) => name.includes(term))) {
    return {
      scope: name.includes('runtime') ? 'runtime' : 'governance',
      mapping_status: 'non_product_scope',
      uc_id: '',
      scenario_ids: [],
      evidence_refs: [],
      proposed_uc_id: '',
      proposed_scenario_ids: [],
      non_product_scope_reason: 'branch name indicates governance/runtime/CI/release-train work; product ledger mapping not inferred',
    };
  }
  return {
    scope: 'unknown',
    mapping_status: 'missing',
    uc_id: '',
    scenario_ids: [],
    evidence_refs: [],
    proposed_uc_id: '',
    proposed_scenario_ids: [],
    non_product_scope_reason: '',
  };
}

function inferDecision({ branch, policy, openPr, worktree, ledgerMatches, preserveRefs, containment, ledgerMapping }) {
  const shortName = branchNameWithoutRemote(branch.shortName);
  const protectedBranch = (policy.protected_branch_patterns || []).some((pattern) => matchesPattern(shortName, pattern));
  const containedInDev = containment.dev?.status === 'contained';
  const preserveRefExists = preserveRefs.some((ref) => ref.head === branch.head || ref.name.includes(shortName));

  if (ledgerMapping.scope === 'product' && ledgerMapping.mapping_status === 'missing') {
    return {
      decision_label: 'unknown_requires_owner',
      reason: 'Product-looking branch lacks a current UC/scenario, proposed UC25+, or evidence-ledger mapping.',
      next_owner: openPr ? 'PR/deploy + Ledger Registrar' : 'CoS/Ledger Registrar',
      next_action: openPr
        ? `Map PR #${openPr.number} branch to UC/scenario or explicit proposed UC before promotion.`
        : 'Investigate product value and attach an exact UC/scenario/proposed-UC mapping before promotion or cleanup.',
    };
  }
  if (ledgerMapping.scope === 'unknown') {
    return {
      decision_label: 'unknown_requires_owner',
      reason: 'Branch value or ownership is unclear and no explicit product/governance/runtime/CI/control-plane mapping was inferred.',
      next_owner: openPr ? 'PR/deploy' : 'CoS',
      next_action: openPr
        ? `Classify PR #${openPr.number} with ledger or governance scope before promotion.`
        : 'Identify owner/value or mark with an exact CoS disposition before any promotion or cleanup.',
    };
  }
  if (protectedBranch) {
    return {
      decision_label: 'preserve_evidence',
      reason: 'Protected branch pattern; never cleanup from branch triage.',
      next_owner: 'CoS',
      next_action: 'Preserve unless CoS creates a separate protected-branch disposition packet.',
    };
  }
  if (openPr && openPr.state !== 'MERGED' && openPr.state !== 'CLOSED') {
    return {
      decision_label: 'release_train_candidate',
      reason: `Open PR #${openPr.number} exists; keep PR/deploy as owner until PR is merged, closed, or superseded by CoS.`,
      next_owner: 'PR/deploy',
      next_action: `Continue PR #${openPr.number} governance/admission checks or classify as superseded in a CoS packet.`,
    };
  }
  if (ledgerMatches.length || preserveRefExists) {
    return {
      decision_label: containedInDev ? 'preserve_evidence' : 'release_train_candidate',
      reason: ledgerMatches.length
        ? 'Ledger/evidence references exist for this branch or head.'
        : 'Preserve ref relation exists for this branch or head.',
      next_owner: containedInDev ? 'CoS/Ledger Registrar' : 'PR/deploy',
      next_action: containedInDev
        ? 'Preserve evidence reference; cleanup only after ledger and CoS say it is superseded.'
        : 'Map to release-train packet before promotion.',
    };
  }
  if (containedInDev && !worktree) {
    return {
      decision_label: 'already_contained',
      reason: 'Branch head is contained in dev and no checked-out worktree was found.',
      next_owner: 'PR/deploy',
      next_action: 'Keep as contained until cleanup steward validates a future exact cleanup manifest.',
    };
  }
  if (ledgerMapping.scope !== 'unknown') {
    return {
      decision_label: 'release_train_candidate',
      reason: 'Non-product governance/runtime/CI branch requires release-train or explicit governance handling.',
      next_owner: 'PR/deploy',
      next_action: 'Include in governance/control-plane branch manifest if still relevant.',
    };
  }
  return {
    decision_label: 'unknown_requires_owner',
    reason: 'No ledger/evidence mapping, no open PR, and no safe containment decision could be inferred.',
    next_owner: 'CoS',
    next_action: 'Identify owner/value or mark with an exact CoS disposition before any promotion or cleanup.',
  };
}

function buildCleanupGuard({ branch, openPr, worktree, ledgerMatches, preserveRefs, decision, policy }) {
  const shortName = branchNameWithoutRemote(branch.shortName);
  const protectedBranch = (policy.protected_branch_patterns || []).some((pattern) => matchesPattern(shortName, pattern));
  const preserveRefExists = preserveRefs.some((ref) => ref.head === branch.head || ref.name.includes(shortName));
  const conditions = {
    open_pr_exists: Boolean(openPr && openPr.state !== 'MERGED' && openPr.state !== 'CLOSED'),
    checked_out_in_worktree: Boolean(worktree),
    worktree_dirty: Boolean(worktree && worktree.dirty_state === 'dirty'),
    ledger_or_evidence_reference_exists: ledgerMatches.length > 0,
    preserve_ref_exists: preserveRefExists,
    handoff_packet_reference_exists: ledgerMatches.some((item) => item.evidence_key === 'handoff_packet'),
    active_runtime_owner_branch: false,
    owner_or_value_unclear: decision.decision_label === 'unknown_requires_owner',
    no_exact_cos_cleanup_manifest_approval: true,
    protected_branch_pattern: protectedBranch,
  };
  return {
    cleanup_candidate: decision.decision_label === 'cleanup_candidate_after_cos_approval',
    delete_allowed: false,
    exact_manifest_required: true,
    guard_recompute_required: true,
    no_delete_conditions: conditions,
  };
}

function buildBranchRecord({
  branch,
  branchIndex,
  policy,
  prs,
  worktrees,
  targetInfo,
  ledgerRefs,
  preserveRefs,
  changedFileLimit,
  analysisLimit,
}) {
  const shortName = branchNameWithoutRemote(branch.shortName);
  const openPr = matchOpenPr(branch, prs);
  const worktree = worktrees.find((row) => row.branch === shortName || row.head === branch.head) || null;
  const containment = {};
  const collectDetails = analysisLimit > 0 && branchIndex < analysisLimit;
  for (const [key, info] of Object.entries(targetInfo)) {
    containment[key] = containmentFor(branch.head, branch.shortName, info, collectDetails);
  }
  const ledgerMatches = ledgerMatchesForBranch(branch, ledgerRefs);
  const ledgerMapping = inferMapping(branch, ledgerMatches);
  const decision = inferDecision({ branch, policy, openPr, worktree, ledgerMatches, preserveRefs, containment, ledgerMapping });
  const cleanupGuard = buildCleanupGuard({ branch, openPr, worktree, ledgerMatches, preserveRefs, decision, policy });
  return {
    branch: branch.shortName,
    scope: branch.scope,
    refname: branch.refname,
    head: branch.head,
    date: branch.date,
    subject: branch.subject,
    open_pr: openPr,
    checked_out_worktree: worktree?.path || '',
    dirty_state: worktree?.dirty_state || 'not_checked',
    containment,
    changed_files: changedFilesFromTarget(branch.head, containment.dev, changedFileLimit, collectDetails),
    ledger_mapping: ledgerMapping,
    evidence_refs: [...new Set(ledgerMatches.map((item) => item.ref))],
    preserve_refs: preserveRefs.filter((ref) => ref.head === branch.head || ref.name.includes(shortName)),
    decision_label: decision.decision_label,
    reason: decision.reason,
    next_owner: decision.next_owner,
    next_action: decision.next_action,
    cleanup_guard: cleanupGuard,
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || '(blank)';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildInventory(options = {}) {
  const repoRoot = getRepoRoot();
  const policyPath = options.policy || DEFAULT_POLICY_PATH;
  const ledgerPath = options.ledger || DEFAULT_LEDGER_PATH;
  const policy = readJson(path.resolve(repoRoot, policyPath));
  const changedFileLimit = Number(options['changed-file-limit'] || DEFAULT_CHANGED_FILE_LIMIT);
  const analysisLimit = Number(options['analysis-limit'] ?? DEFAULT_ANALYSIS_LIMIT);
  const branches = listBranches();
  const prResult = listOpenPrs(options);
  const prs = prResult.items;
  const worktrees = parseWorktrees();
  const targets = resolveTargets(options);
  const targetInfo = Object.fromEntries(Object.entries(targets).map(([key, ref]) => [key, buildTargetAnalysis(ref)]));
  const ledgerRefs = collectLedgerRefs(path.resolve(repoRoot, ledgerPath));
  const preserveRefs = listPreserveRefs();
  const sortedBranches = [...branches].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const records = sortedBranches.map((branch, branchIndex) => buildBranchRecord({
    branch,
    branchIndex,
    policy,
    prs,
    worktrees,
    targetInfo,
    ledgerRefs,
    preserveRefs,
    changedFileLimit,
    analysisLimit,
  }));
  const manifest = {
    schema_version: '1.0',
    kind: 'masarx-pr-branch-inventory',
    generated_at: new Date().toISOString(),
    generated_by: 'scripts/ops/pr-branch.js inventory',
    read_only: true,
    policy_path: policyPath,
    ledger_path: ledgerPath,
    repo: {
      root: repoRoot,
      current_branch: git(['branch', '--show-current'], { allowFailure: true }).stdout || '',
      current_head: git(['rev-parse', 'HEAD'], { allowFailure: true }).stdout || '',
      targets,
    },
    github_pr_collection: prResult.collection,
    counts: {
      branches: records.length,
      by_scope: countBy(records, 'scope'),
      by_decision_label: countBy(records, 'decision_label'),
    },
    branches: records,
  };
  return manifest;
}

function hasText(value) {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
}

function validateManifestObject(manifest, options = {}) {
  const policyPath = options.policy || manifest.policy_path || DEFAULT_POLICY_PATH;
  const policy = options.policyObject || readJson(policyPath);
  const errors = [];
  const warnings = [];
  const labels = new Set(policy.decision_labels || []);
  const mappingScopes = new Set(policy.ledger_mapping_scopes || []);
  const requiredFields = policy.required_branch_decision_fields || [];
  const requiredTargets = policy.required_containment_targets || [];
  const noDeleteKeys = policy.no_delete_if || [];
  const branches = Array.isArray(manifest.branches) ? manifest.branches : [];

  if (manifest.schema_version !== '1.0') errors.push(`unsupported_manifest_schema:${manifest.schema_version || '(blank)'}`);
  if (manifest.read_only !== true) errors.push('manifest_not_marked_read_only');
  if (!branches.length) errors.push('manifest_has_no_branches');
  if (!manifest.github_pr_collection || manifest.github_pr_collection.ok !== true) {
    errors.push(`github_pr_collection_unavailable:${manifest.github_pr_collection?.error || 'missing'}`);
  } else if (manifest.github_pr_collection.ci_included !== true) {
    warnings.push(`github_pr_collection_ci_unavailable:${manifest.github_pr_collection.error || 'statusCheckRollup omitted'}`);
  }

  branches.forEach((branch, index) => {
    const id = branch.branch || `index:${index}`;
    const nullableRequiredFields = new Set(['open_pr', 'checked_out_worktree']);
    for (const field of requiredFields) {
      if (nullableRequiredFields.has(field)) {
        if (branch[field] === undefined) errors.push(`branch_missing_required_field:${id}:${field}`);
        continue;
      }
      if (branch[field] === undefined || branch[field] === null || (typeof branch[field] === 'string' && !branch[field].trim())) {
        errors.push(`branch_missing_required_field:${id}:${field}`);
      }
    }
    if (!labels.has(branch.decision_label)) errors.push(`branch_bad_decision_label:${id}:${branch.decision_label || '(blank)'}`);
    if (!hasText(branch.next_owner)) errors.push(`branch_missing_next_owner:${id}`);
    if (!hasText(branch.next_action)) errors.push(`branch_missing_next_action:${id}`);

    const containment = branch.containment || {};
    for (const target of requiredTargets) {
      if (!containment[target]) errors.push(`branch_missing_containment_target:${id}:${target}`);
    }

    const mapping = branch.ledger_mapping || {};
    if (!mappingScopes.has(mapping.scope)) errors.push(`branch_bad_ledger_mapping_scope:${id}:${mapping.scope || '(blank)'}`);
    if (mapping.scope === 'unknown') errors.push(`branch_ledger_mapping_unknown:${id}`);
    if (mapping.scope === 'product') {
      const hasExisting = hasText(mapping.uc_id) || (Array.isArray(mapping.scenario_ids) && mapping.scenario_ids.length > 0);
      const hasProposed = hasText(mapping.proposed_uc_id) || (Array.isArray(mapping.proposed_scenario_ids) && mapping.proposed_scenario_ids.length > 0);
      if (!hasExisting && !hasProposed) errors.push(`product_branch_missing_uc_or_scenario_mapping:${id}`);
    }
    if (['governance', 'runtime', 'ci', 'control_plane'].includes(mapping.scope) && !hasText(mapping.non_product_scope_reason)) {
      errors.push(`non_product_branch_missing_scope_reason:${id}:${mapping.scope}`);
    }

    const cleanupGuard = branch.cleanup_guard || {};
    if (branch.decision_label === 'cleanup_candidate_after_cos_approval') {
      if (cleanupGuard.exact_manifest_required !== true) errors.push(`cleanup_candidate_missing_exact_manifest_guard:${id}`);
      if (cleanupGuard.guard_recompute_required !== true) errors.push(`cleanup_candidate_missing_recompute_guard:${id}`);
      if (cleanupGuard.delete_allowed !== false) errors.push(`cleanup_candidate_must_not_be_delete_allowed:${id}`);
      const conditions = cleanupGuard.no_delete_conditions || {};
      for (const key of noDeleteKeys) {
        if (typeof conditions[key] !== 'boolean') errors.push(`cleanup_candidate_missing_no_delete_guard:${id}:${key}`);
      }
      for (const [key, value] of Object.entries(conditions)) {
        if (key !== 'no_exact_cos_cleanup_manifest_approval' && value === true) {
          errors.push(`cleanup_candidate_guard_still_blocks:${id}:${key}`);
        }
      }
    }

    if (branch.decision_label !== 'unknown_requires_owner' && mapping.scope === 'unknown') {
      errors.push(`non_unknown_decision_with_unknown_mapping:${id}:${branch.decision_label}`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      branches: branches.length,
      by_decision_label: countBy(branches, 'decision_label'),
      by_scope: countBy(branches, 'scope'),
      by_mapping_scope: countBy(branches.map((branch) => branch.ledger_mapping || {}), 'scope'),
    },
  };
}

function validateManifest(options = {}) {
  const manifestPath = options.manifest || options.input || options._?.[1];
  if (!manifestPath) {
    return { ok: false, errors: ['manifest_path_required'], warnings: [], counts: {} };
  }
  const manifest = readJson(manifestPath);
  return {
    manifest_path: manifestPath,
    ...validateManifestObject(manifest, options),
  };
}

function renderSnapshot(manifest, validation = null) {
  const lines = [];
  lines.push('# PR/Branch Inventory Snapshot');
  lines.push('');
  lines.push(`Generated: ${manifest.generated_at || ''}`);
  lines.push(`Read only: ${manifest.read_only === true ? 'yes' : 'no'}`);
  lines.push(`Policy: ${manifest.policy_path || ''}`);
  lines.push(`Ledger: ${manifest.ledger_path || ''}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  for (const [label, count] of Object.entries(manifest.counts?.by_decision_label || {})) {
    lines.push(`- ${label}: ${count}`);
  }
  if (validation) {
    lines.push('');
    lines.push('## Validation');
    lines.push('');
    lines.push(`- ok: ${validation.ok}`);
    lines.push(`- errors: ${validation.errors.length}`);
    lines.push(`- warnings: ${validation.warnings.length}`);
  }
  lines.push('');
  lines.push('## Branches');
  lines.push('');
  lines.push('| Branch | Scope | Head | Decision | Mapping | Next Owner |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const branch of manifest.branches || []) {
    lines.push(`| ${branch.branch || ''} | ${branch.scope || ''} | ${String(branch.head || '').slice(0, 12)} | ${branch.decision_label || ''} | ${branch.ledger_mapping?.scope || ''}:${branch.ledger_mapping?.mapping_status || ''} | ${branch.next_owner || ''} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeSnapshot(options = {}) {
  const manifestPath = options.manifest || options.input || options._?.[1];
  if (!manifestPath) {
    return { ok: false, errors: ['manifest_path_required'], warnings: [], outPath: null };
  }
  const manifest = readJson(manifestPath);
  const validation = validateManifestObject(manifest, options);
  const markdown = renderSnapshot(manifest, validation);
  const outPath = options.out || '';
  if (outPath) writeText(outPath, markdown);
  return {
    ok: true,
    outPath: outPath || null,
    markdown: outPath ? undefined : markdown,
    validation,
  };
}

function printResult(result, options = {}) {
  if (options.markdown && result.markdown) {
    console.log(result.markdown);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'inventory';
  if (command === 'inventory') {
    const manifest = buildInventory(args);
    if (args.out) writeText(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
    printResult(args.out ? { ok: true, outPath: args.out, counts: manifest.counts } : manifest);
    return manifest;
  }
  if (command === 'validate-manifest') {
    const result = validateManifest(args);
    printResult(result);
    process.exitCode = result.ok ? 0 : 1;
    return result;
  }
  if (command === 'snapshot') {
    const result = writeSnapshot(args);
    printResult(result, { markdown: !args.out });
    process.exitCode = result.ok ? 0 : 1;
    return result;
  }
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node scripts/ops/pr-branch.js inventory|validate-manifest|snapshot [--out path] [--manifest path] [--policy path] [--ledger path]');
  process.exitCode = 1;
  return null;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInventory,
  renderSnapshot,
  validateManifestObject,
  writeSnapshot,
};
