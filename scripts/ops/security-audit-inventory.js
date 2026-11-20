#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const PRIORITY_ORDER = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2,
});

const SEVERITY_ORDER = Object.freeze({
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  info: 4,
});

function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function formatDateYmd(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const options = {
    repoRoot,
    auditFile: null,
    lockFile: path.join(repoRoot, 'package-lock.json'),
    outputFile: null,
    matrixFile: null,
    generatedAt: new Date().toISOString(),
    signedOffBy: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    const next = String(argv[index + 1] || '').trim();
    if (!token) continue;
    if (token === '--repo-root' && next) {
      options.repoRoot = path.resolve(next);
      index += 1;
      continue;
    }
    if (token.startsWith('--repo-root=')) {
      options.repoRoot = path.resolve(token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--audit-file' && next) {
      options.auditFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--audit-file=')) {
      options.auditFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--lock-file' && next) {
      options.lockFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--lock-file=')) {
      options.lockFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--out' && next) {
      options.outputFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--out=')) {
      options.outputFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--matrix-out' && next) {
      options.matrixFile = path.resolve(options.repoRoot, next);
      index += 1;
      continue;
    }
    if (token.startsWith('--matrix-out=')) {
      options.matrixFile = path.resolve(options.repoRoot, token.split('=').slice(1).join('=').trim());
      continue;
    }
    if (token === '--generated-at' && next) {
      options.generatedAt = new Date(next).toISOString();
      index += 1;
      continue;
    }
    if (token.startsWith('--generated-at=')) {
      options.generatedAt = new Date(token.split('=').slice(1).join('=').trim()).toISOString();
      continue;
    }
    if (token === '--signed-off-by' && next) {
      options.signedOffBy = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--signed-off-by=')) {
      options.signedOffBy = token.split('=').slice(1).join('=').trim();
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.auditFile) {
    const evidenceDir = path.join(
      options.repoRoot,
      'docs',
      'ops',
      'evidence',
      formatDateYmd(options.generatedAt),
      'production-readiness',
    );
    options.auditFile = path.join(evidenceDir, 'npm-audit.json');
    options.outputFile = options.outputFile || path.join(evidenceDir, 'security-vulnerability-inventory.json');
    options.matrixFile = options.matrixFile || path.join(evidenceDir, 'security-priority-matrix.md');
  } else {
    const parent = path.dirname(options.auditFile);
    options.outputFile = options.outputFile || path.join(parent, 'security-vulnerability-inventory.json');
    options.matrixFile = options.matrixFile || path.join(parent, 'security-priority-matrix.md');
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateNpmAuditReport(report) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(report) || Object.prototype.hasOwnProperty.call(report, 'error')
    || report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)
    || !isRecord(report.metadata?.vulnerabilities)) {
    throw new Error('Invalid npm audit report');
  }
  const counts = Object.fromEntries(Object.keys(SEVERITY_ORDER).map(severity => [severity, 0]));
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!name || !isRecord(vulnerability)
      || !Object.prototype.hasOwnProperty.call(counts, vulnerability.severity)) {
      throw new Error('Invalid npm audit vulnerability severity');
    }
    if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
      throw new Error('Invalid npm audit vulnerability advisories');
    }
    for (const via of vulnerability.via) {
      if (typeof via === 'string' && via.trim()) continue;
      if (!isRecord(via) || !Object.prototype.hasOwnProperty.call(counts, via.severity)
        || !Number.isSafeInteger(via.source) || via.source <= 0
        || ['title', 'url', 'range'].some(field => typeof via[field] !== 'string' || !via[field].trim())) {
        throw new Error('Invalid npm audit advisory');
      }
    }
    counts[vulnerability.severity] += 1;
  }
  counts.total = Object.keys(report.vulnerabilities).length;
  for (const [severity, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(report.metadata.vulnerabilities[severity])
      || report.metadata.vulnerabilities[severity] !== count) {
      throw new Error('Invalid npm audit vulnerability counts');
    }
  }
  return report;
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function normalizeSeverity(rawSeverity) {
  const normalized = String(rawSeverity || '').trim().toLowerCase();
  if (SEVERITY_ORDER[normalized] !== undefined) return normalized;
  return 'info';
}

function severityRank(severity) {
  const normalized = normalizeSeverity(severity);
  return SEVERITY_ORDER[normalized] ?? 99;
}

function priorityRank(priority) {
  return PRIORITY_ORDER[String(priority || '').trim()] ?? 99;
}

function normalizeLockNodePath(nodePath) {
  const value = String(nodePath || '').trim();
  if (!value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return '';
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  return normalized;
}

function extractPackageNameFromNodePath(nodePath) {
  const normalized = normalizeLockNodePath(nodePath);
  if (!normalized) return '';
  // Resolve the package after the last node_modules boundary so nested copies
  // are attributed to themselves, including scoped packages.
  const rooted = `/${normalized}`;
  const marker = '/node_modules/';
  const idx = rooted.lastIndexOf(marker);
  if (idx < 0) return '';
  const suffix = rooted.slice(idx + marker.length);
  if (!suffix) return '';
  const parts = suffix.split('/');
  if (!parts.length) return '';
  if (parts[0].startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function buildLockIndex(lockData) {
  const index = new Map();
  const packages = lockData && typeof lockData === 'object' ? lockData.packages || {} : {};
  for (const [rawNodePath, entry] of Object.entries(packages)) {
    const nodePath = normalizeLockNodePath(rawNodePath);
    if (!nodePath) continue;
    const name = String(entry?.name || extractPackageNameFromNodePath(nodePath)).trim();
    if (!name) continue;
    const hasOptionalFlag = entry && Object.prototype.hasOwnProperty.call(entry, 'optional');
    const list = index.get(name) || [];
    list.push({
      nodePath,
      version: entry?.version ? String(entry.version) : null,
      dev: entry?.dev === true,
      optional: hasOptionalFlag ? entry?.optional === true : undefined,
    });
    index.set(name, list);
  }
  return index;
}

function inferSurfaceFromManifest(relativePath) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  if (normalized === 'package.json') return 'tooling';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 3 && parts[0] === 'apps' && parts[2] === 'package.json') {
    return `app:${parts[1]}`;
  }
  if (parts.length === 3 && parts[0] === 'packages' && parts[2] === 'package.json') {
    return `package:${parts[1]}`;
  }
  return 'tooling';
}

function discoverWorkspaceManifestPaths(repoRoot) {
  const paths = [path.join(repoRoot, 'package.json')];
  for (const topLevel of ['apps', 'packages']) {
    const baseDir = path.join(repoRoot, topLevel);
    if (!fs.existsSync(baseDir)) continue;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(baseDir, entry.name, 'package.json');
      if (fs.existsSync(manifestPath)) paths.push(manifestPath);
    }
  }
  return paths;
}

function addSetValue(map, key, value) {
  if (!key || !value) return;
  const existing = map.get(key) || new Set();
  existing.add(value);
  map.set(key, existing);
}

function buildSurfaceCatalog(repoRoot) {
  const manifestPaths = discoverWorkspaceManifestPaths(repoRoot);
  const dependencySurfaces = new Map();
  const manifests = [];

  for (const manifestPath of manifestPaths) {
    const relativePath = path.relative(repoRoot, manifestPath) || 'package.json';
    const surface = inferSurfaceFromManifest(relativePath);
    const manifest = readJson(manifestPath);
    manifests.push({
      path: relativePath.split(path.sep).join('/'),
      surface,
      name: String(manifest.name || ''),
    });

    const bucketNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    for (const bucketName of bucketNames) {
      const deps = manifest && typeof manifest === 'object' ? manifest[bucketName] || {} : {};
      for (const dependencyName of Object.keys(deps)) {
        addSetValue(dependencySurfaces, dependencyName, surface);
      }
    }
  }

  manifests.sort((left, right) => left.path.localeCompare(right.path));

  return {
    manifests,
    dependencySurfaces,
  };
}

function buildSurfaceCatalogFromLockData(lockData) {
  const dependencySurfaces = new Map();
  const manifests = [];
  const packages = lockData && typeof lockData === 'object' && lockData.packages
    && typeof lockData.packages === 'object'
    ? lockData.packages
    : {};

  const workspaceEntries = Object.entries(packages)
    .filter(([packagePath]) => packagePath === '' || /^(apps|packages)\/[^/]+$/.test(packagePath))
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [packagePath, manifest] of workspaceEntries) {
    const relativePath = packagePath ? `${packagePath}/package.json` : 'package.json';
    const surface = inferSurfaceFromManifest(relativePath);
    manifests.push({
      path: relativePath,
      surface,
      name: String(manifest?.name || ''),
    });

    const bucketNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    for (const bucketName of bucketNames) {
      const deps = manifest && typeof manifest === 'object' ? manifest[bucketName] || {} : {};
      for (const dependencyName of Object.keys(deps)) {
        addSetValue(dependencySurfaces, dependencyName, surface);
      }
    }
  }

  if (!manifests.some((manifest) => manifest.path === 'package.json')) {
    throw new Error('package-lock.json is missing its root workspace manifest entry');
  }

  manifests.sort((left, right) => left.path.localeCompare(right.path));

  return {
    manifests,
    dependencySurfaces,
  };
}

function setToSortedArray(value) {
  return [...(value || new Set())].sort();
}

function classifyRuntimeExposure(lockStats) {
  const runtime = Number(lockStats?.runtime_count || 0);
  const development = Number(lockStats?.development_count || 0);
  const unknown = Number(lockStats?.unknown_count || 0);
  if (runtime > 0 && development > 0) return 'mixed';
  if (runtime > 0) return 'runtime';
  if (development > 0) return 'development_only';
  if (unknown > 0) return 'mixed';
  return 'unknown';
}

function inferRuntimeExposureFromGroups(packageGroups) {
  const groups = Array.isArray(packageGroups) ? packageGroups : [];
  if (groups.length === 0) return 'unknown';
  const hasAppOrPackageSurface = groups.some(
    (group) => String(group).startsWith('app:') || String(group).startsWith('package:'),
  );
  const hasToolingSurface = groups.includes('tooling');
  if (hasAppOrPackageSurface && hasToolingSurface) return 'mixed';
  if (hasAppOrPackageSurface) return 'runtime';
  if (hasToolingSurface) return 'development_only';
  return 'unknown';
}

function normalizeFixAvailability(fixAvailable) {
  if (!fixAvailable) {
    return {
      kind: 'no_fix',
      package: null,
      version: null,
      is_semver_major: null,
    };
  }
  if (fixAvailable === true) {
    return {
      kind: 'available_unspecified',
      package: null,
      version: null,
      is_semver_major: null,
    };
  }
  if (typeof fixAvailable === 'object') {
    const isMajor = fixAvailable?.isSemVerMajor === true;
    return {
      kind: isMajor ? 'semver_major' : 'minor_or_patch',
      package: fixAvailable?.name ? String(fixAvailable.name) : null,
      version: fixAvailable?.version ? String(fixAvailable.version) : null,
      is_semver_major: isMajor,
    };
  }
  return {
    kind: 'available_unspecified',
    package: null,
    version: null,
    is_semver_major: null,
  };
}

function classifyComplexity({ fixKind, isDirect, viaCount, runtimeExposure }) {
  if (fixKind === 'no_fix') return 'high';
  if (fixKind === 'semver_major') return 'high';
  if (fixKind === 'available_unspecified') return 'medium';
  if (runtimeExposure === 'runtime' && (isDirect || viaCount >= 4)) return 'medium';
  if (runtimeExposure === 'mixed' && viaCount >= 3) return 'medium';
  if (isDirect && viaCount >= 2) return 'medium';
  return 'low';
}

function classifyPriority({ severity, runtimeExposure, fixKind }) {
  const normalizedSeverity = normalizeSeverity(severity);
  if (normalizedSeverity === 'critical') return 'P0';
  if (normalizedSeverity === 'high') {
    if (runtimeExposure === 'runtime' || runtimeExposure === 'mixed') {
      if (fixKind === 'no_fix' || fixKind === 'semver_major' || fixKind === 'available_unspecified') {
        return 'P0';
      }
      return 'P1';
    }
    return 'P1';
  }
  if (normalizedSeverity === 'moderate') {
    if (runtimeExposure === 'runtime' || runtimeExposure === 'mixed') return 'P1';
    return 'P2';
  }
  return 'P2';
}

function advisoryFromVia(viaItem) {
  if (!viaItem || typeof viaItem !== 'object') return null;
  return {
    source: viaItem.source ?? null,
    dependency: viaItem.dependency ? String(viaItem.dependency) : null,
    title: viaItem.title ? String(viaItem.title) : null,
    url: viaItem.url ? String(viaItem.url) : null,
    severity: normalizeSeverity(viaItem.severity || ''),
    cwe: Array.isArray(viaItem.cwe) ? viaItem.cwe.map((entry) => String(entry)) : [],
    cvss: {
      score: Number.isFinite(Number(viaItem?.cvss?.score)) ? Number(viaItem.cvss.score) : null,
      vector: viaItem?.cvss?.vectorString ? String(viaItem.cvss.vectorString) : null,
    },
    range: viaItem.range ? String(viaItem.range) : null,
  };
}

function derivePackageGroups({ packageName, vulnerability, dependencySurfaces }) {
  const groups = new Set();
  for (const value of dependencySurfaces.get(packageName) || []) groups.add(value);

  const viaItems = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
  const effects = Array.isArray(vulnerability?.effects) ? vulnerability.effects : [];
  for (const effectName of effects) {
    for (const value of dependencySurfaces.get(String(effectName)) || []) groups.add(value);
  }
  for (const via of viaItems) {
    if (typeof via === 'string') {
      for (const value of dependencySurfaces.get(via) || []) groups.add(value);
      continue;
    }
    const dependencyName = String(via?.dependency || via?.name || '').trim();
    if (!dependencyName) continue;
    for (const value of dependencySurfaces.get(dependencyName) || []) groups.add(value);
  }

  if (groups.size === 0) groups.add('tooling');
  return setToSortedArray(groups);
}

function summarizeBy(items, fieldName) {
  const out = {};
  for (const item of items) {
    const key = String(item[fieldName] || 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function fixTargetLabel(fix) {
  if (!fix) return 'No fix available';
  if (fix.kind === 'no_fix') return 'No fix available';
  if (fix.kind === 'available_unspecified') return 'Fix available (unspecified target)';
  if (fix.package && fix.version) return `${fix.package}@${fix.version}`;
  if (fix.version) return `target ${fix.version}`;
  if (fix.package) return fix.package;
  return fix.kind;
}

function recommendedAction({ fix, complexity }) {
  if (!fix || fix.kind === 'no_fix') {
    return 'Track upstream advisory, evaluate package replacement, and add temporary containment controls.';
  }
  if (fix.kind === 'semver_major') {
    return `Plan controlled major upgrade to ${fixTargetLabel(fix)} with compatibility tests before rollout.`;
  }
  if (complexity === 'medium') {
    return `Schedule staged patch upgrade to ${fixTargetLabel(fix)} and validate affected workflows.`;
  }
  return `Apply patch/minor upgrade to ${fixTargetLabel(fix)} in the next maintenance window.`;
}

function collectLockStats(lockEntries) {
  const entries = Array.isArray(lockEntries) ? lockEntries : [];
  let runtimeCount = 0;
  let developmentCount = 0;
  let unknownCount = 0;
  let optionalCount = 0;
  for (const entry of entries) {
    if (entry?.dev === true) developmentCount += 1;
    else if (entry?.dev === false) runtimeCount += 1;
    else unknownCount += 1;
    if (entry?.optional) optionalCount += 1;
  }
  return {
    total_nodes: entries.length,
    runtime_count: runtimeCount,
    development_count: developmentCount,
    unknown_count: unknownCount,
    optional_count: optionalCount,
  };
}

function buildInventory({
  auditReport,
  lockData,
  repoRoot,
  generatedAt = new Date().toISOString(),
  auditFile = '',
  lockFile = '',
  signedOffBy = '',
}) {
  validateNpmAuditReport(auditReport);
  const lockIndex = buildLockIndex(lockData || {});
  const surfaceCatalog = buildSurfaceCatalogFromLockData(lockData || {});
  const vulnerabilities = auditReport && typeof auditReport === 'object' ? auditReport.vulnerabilities || {} : {};

  const findings = Object.entries(vulnerabilities).map(([packageName, vulnerability]) => {
    const indexedLockEntries = lockIndex.get(packageName) || [];
    const hasAuthoritativeNodes = Array.isArray(vulnerability?.nodes);
    const authoritativeNodes = new Set(
      hasAuthoritativeNodes
        ? vulnerability.nodes.map((nodePath) => normalizeLockNodePath(nodePath)).filter(Boolean)
        : [],
    );
    const lockEntries = hasAuthoritativeNodes
      ? indexedLockEntries.filter((entry) => authoritativeNodes.has(entry.nodePath))
      : indexedLockEntries;
    if (hasAuthoritativeNodes && (!authoritativeNodes.size
      || vulnerability.nodes.some(nodePath => !normalizeLockNodePath(nodePath))
      || lockEntries.length !== authoritativeNodes.size)) {
      throw new Error(`Unresolved npm audit installed paths: ${packageName}`);
    }
    const lockStats = collectLockStats(lockEntries);
    const severity = normalizeSeverity(vulnerability?.severity);
    const fix = normalizeFixAvailability(vulnerability?.fixAvailable);
    const viaItems = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
    const advisories = viaItems
      .map((via) => advisoryFromVia(via))
      .filter((value) => Boolean(value));
    const viaDependencies = viaItems
      .filter((via) => typeof via === 'string')
      .map((via) => String(via))
      .sort();
    const packageGroups = derivePackageGroups({
      packageName,
      vulnerability,
      dependencySurfaces: surfaceCatalog.dependencySurfaces,
    });
    let runtimeExposure = classifyRuntimeExposure(lockStats);
    if (runtimeExposure === 'unknown') {
      runtimeExposure = inferRuntimeExposureFromGroups(packageGroups);
    }
    const viaCount = viaItems.length;
    const complexity = classifyComplexity({
      fixKind: fix.kind,
      isDirect: vulnerability?.isDirect === true,
      viaCount,
      runtimeExposure,
    });
    const priority = classifyPriority({
      severity,
      runtimeExposure,
      fixKind: fix.kind,
    });

    return {
      package_name: packageName,
      severity,
      priority,
      runtime_exposure: runtimeExposure,
      package_groups: packageGroups,
      is_direct: vulnerability?.isDirect === true,
      effects: Array.isArray(vulnerability?.effects) ? vulnerability.effects.map((value) => String(value)).sort() : [],
      advisory_dependencies: viaDependencies,
      advisories,
      vulnerable_range: vulnerability?.range ? String(vulnerability.range) : null,
      upgrade_path: fix.kind,
      fix,
      break_fix_complexity: complexity,
      lock_stats: lockStats,
      via_count: viaCount,
      recommended_action: recommendedAction({ fix, complexity }),
      nodes: lockEntries.map((entry) => ({
        path: String(entry.nodePath || ''),
        version: entry.version,
        dev: Boolean(entry.dev),
        optional: Boolean(entry.optional),
      })),
    };
  });

  findings.sort((left, right) => {
    const priorityDiff = priorityRank(left.priority) - priorityRank(right.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const severityDiff = severityRank(left.severity) - severityRank(right.severity);
    if (severityDiff !== 0) return severityDiff;
    return left.package_name.localeCompare(right.package_name);
  });

  const summary = {
    vulnerabilities_total: findings.length,
    metadata_vulnerabilities: auditReport?.metadata?.vulnerabilities || {},
    by_priority: summarizeBy(findings, 'priority'),
    by_severity: summarizeBy(findings, 'severity'),
    by_runtime_exposure: summarizeBy(findings, 'runtime_exposure'),
    by_complexity: summarizeBy(findings, 'break_fix_complexity'),
  };

  return {
    generated_at: generatedAt,
    signed_off_by: signedOffBy || null,
    methodology: {
      references: [
        'https://docs.npmjs.com/cli/v11/commands/npm-audit',
        'https://docs.npmjs.com/about-audit-reports',
        'https://docs.github.com/code-security/security-advisories',
      ],
      priority_model: 'P0=critical or high runtime/mixed with major/no-fix; P1=remaining high and moderate runtime/mixed; P2=moderate/low development-only.',
    },
    source: {
      audit_file: auditFile ? path.relative(repoRoot, auditFile).split(path.sep).join('/') : null,
      lock_file: lockFile ? path.relative(repoRoot, lockFile).split(path.sep).join('/') : null,
      audit_report_version: auditReport?.auditReportVersion ?? null,
      manifests: surfaceCatalog.manifests,
    },
    summary,
    findings,
  };
}

function markdownEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function findingsByPriority(findings) {
  const buckets = {
    P0: [],
    P1: [],
    P2: [],
  };
  for (const finding of findings || []) {
    const bucket = buckets[finding.priority];
    if (bucket) bucket.push(finding);
  }
  return buckets;
}

function renderPriorityMatrix(inventory) {
  const findings = Array.isArray(inventory?.findings) ? inventory.findings : [];
  const summary = inventory?.summary || {};
  const byPriority = findingsByPriority(findings);
  const lines = [];
  lines.push('# Security Vulnerability Priority Matrix');
  lines.push('');
  lines.push(`Generated at: ${inventory?.generated_at || new Date().toISOString()}`);
  if (inventory?.signed_off_by) {
    lines.push(`Signed-off-by: ${inventory.signed_off_by}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Total vulnerable packages | ${Number(summary.vulnerabilities_total || 0)} |`);
  lines.push(`| P0 | ${Number(summary?.by_priority?.P0 || 0)} |`);
  lines.push(`| P1 | ${Number(summary?.by_priority?.P1 || 0)} |`);
  lines.push(`| P2 | ${Number(summary?.by_priority?.P2 || 0)} |`);
  lines.push(`| Runtime exposure | ${Number(summary?.by_runtime_exposure?.runtime || 0)} |`);
  lines.push(`| Development-only exposure | ${Number(summary?.by_runtime_exposure?.development_only || 0)} |`);
  lines.push(`| Mixed exposure | ${Number(summary?.by_runtime_exposure?.mixed || 0)} |`);
  lines.push('');
  lines.push('## Method Standards');
  lines.push('');
  lines.push('- npm CLI audit command contract: https://docs.npmjs.com/cli/v11/commands/npm-audit');
  lines.push('- npm audit report format: https://docs.npmjs.com/about-audit-reports');
  lines.push('- GitHub Advisory source taxonomy: https://docs.github.com/code-security/security-advisories');
  lines.push('');

  for (const priority of ['P0', 'P1', 'P2']) {
    const bucket = byPriority[priority] || [];
    lines.push(`## ${priority}`);
    lines.push('');
    if (bucket.length === 0) {
      lines.push('_None_');
      lines.push('');
      continue;
    }
    lines.push('| Package | Severity | Exposure | Groups | Upgrade Path | Complexity | Recommended Action |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const finding of bucket) {
      lines.push(
        `| ${markdownEscape(finding.package_name)} | ${markdownEscape(finding.severity)} | ${markdownEscape(finding.runtime_exposure)} | ${markdownEscape((finding.package_groups || []).join(', '))} | ${markdownEscape(fixTargetLabel(finding.fix))} | ${markdownEscape(finding.break_fix_complexity)} | ${markdownEscape(finding.recommended_action)} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function runCli(options = parseArgs()) {
  const auditReport = readJson(options.auditFile);
  const lockData = readJson(options.lockFile);
  const inventory = buildInventory({
    auditReport,
    lockData,
    repoRoot: options.repoRoot,
    generatedAt: options.generatedAt,
    auditFile: options.auditFile,
    lockFile: options.lockFile,
    signedOffBy: options.signedOffBy,
  });

  const matrix = renderPriorityMatrix(inventory);
  writeText(options.outputFile, `${JSON.stringify(inventory, null, 2)}\n`);
  writeText(options.matrixFile, matrix);

  const summary = inventory.summary || {};
  console.log(
    JSON.stringify(
      {
        output_file: path.relative(options.repoRoot, options.outputFile).split(path.sep).join('/'),
        matrix_file: path.relative(options.repoRoot, options.matrixFile).split(path.sep).join('/'),
        total: summary.vulnerabilities_total || 0,
        by_priority: summary.by_priority || {},
      },
      null,
      2,
    ),
  );

  return inventory;
}

module.exports = {
  buildInventory,
  buildLockIndex,
  buildSurfaceCatalog,
  buildSurfaceCatalogFromLockData,
  classifyComplexity,
  classifyPriority,
  classifyRuntimeExposure,
  normalizeFixAvailability,
  parseArgs,
  renderPriorityMatrix,
  runCli,
  validateNpmAuditReport,
};

if (require.main === module) {
  try {
    runCli(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`security-audit-inventory: ${error.message}`);
    process.exit(1);
  }
}
