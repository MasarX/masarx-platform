#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FIELDOPS_WORKSPACE = '@masarx/fieldops';
const DEFAULT_CACHE_DIR = path.join('tmp', 'npm-cache-fieldops-runtime-support');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const npmCmd = process.platform.startsWith('win') ? 'npm.cmd' : 'npm';
const windowsNpmCliPath = path.resolve(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');

const REQUIRED_PACKAGE_FILES = [
  {
    id: 'typescript-cli',
    lockPath: 'node_modules/typescript',
    filePath: 'node_modules/typescript/lib/tsc.js',
    purpose: 'FieldOps typecheck',
  },
  {
    id: 'jest-cli',
    lockPath: 'node_modules/jest',
    filePath: 'node_modules/jest/bin/jest.js',
    purpose: 'focused FieldOps Jest runs',
  },
  {
    id: 'ts-jest',
    lockPath: 'node_modules/ts-jest',
    filePath: 'node_modules/ts-jest/dist/index.js',
    purpose: 'TypeScript Jest transforms',
  },
  {
    id: 'pg-types-text-parsers',
    lockPath: 'node_modules/pg-types',
    filePath: 'node_modules/pg-types/lib/textParsers.js',
    purpose: 'Jest/Postgres test dependency loading',
  },
  {
    id: 'exit-runtime',
    lockPath: 'node_modules/exit',
    filePath: 'node_modules/exit/lib/exit.js',
    purpose: 'Jest process shutdown dependency loading',
  },
  {
    id: 'bs-logger',
    lockPath: 'node_modules/bs-logger',
    filePath: 'node_modules/bs-logger/dist/logger/index.js',
    purpose: 'ts-jest logger dependency loading',
  },
  {
    id: 'source-map-support-source-map',
    lockPath: 'node_modules/source-map-support/node_modules/source-map',
    filePath: 'node_modules/source-map-support/node_modules/source-map/package.json',
    dependencyConsumer: 'node_modules/source-map-support',
    purpose: 'source-map-support dependency loading',
  },
  {
    id: 'ts-interface-checker-types',
    lockPath: 'node_modules/ts-interface-checker',
    filePath: 'node_modules/ts-interface-checker/dist/types.js',
    purpose: 'Metro/sucrase dependency loading',
  },
  {
    id: 'buffer-types',
    lockPath: 'node_modules/buffer',
    filePath: 'node_modules/buffer/index.d.ts',
    purpose: 'FieldOps TypeScript dependency types',
  },
  {
    id: 'metro-server',
    lockPath: 'node_modules/metro',
    filePath: 'node_modules/metro/src/Server.js',
    purpose: 'Metro runtime startup',
  },
  {
    id: 'expo-cli',
    lockPath: 'node_modules/@expo/cli',
    alternateLockPaths: [
      'node_modules/expo/node_modules/@expo/cli',
      'apps/fieldops/node_modules/expo/node_modules/@expo/cli',
    ],
    filePath: 'node_modules/@expo/cli/build/src/start/index.js',
    alternateFilePaths: [
      'node_modules/expo/node_modules/@expo/cli/build/src/start/index.js',
      'apps/fieldops/node_modules/expo/node_modules/@expo/cli/build/src/start/index.js',
    ],
    purpose: 'Expo Metro startup',
  },
];

function normalizePathForLock(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'package-lock.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve repo root from ${startDir}`);
    }
    current = parent;
  }
}

function buildNpmCiArgs({ dryRun = false, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const args = [
    'ci',
    '--workspace',
    FIELDOPS_WORKSPACE,
    '--include-workspace-root=false',
  ];
  if (dryRun) args.push('--dry-run');
  args.push('--ignore-scripts', '--no-audit', '--no-fund', '--cache', cacheDir);
  return args;
}

function resolveNpmInvocation() {
  if (process.platform.startsWith('win') && fs.existsSync(windowsNpmCliPath)) {
    return {
      command: process.execPath,
      prefixArgs: [windowsNpmCliPath],
      displayCommand: `node ${windowsNpmCliPath}`,
    };
  }
  return {
    command: npmCmd,
    prefixArgs: [],
    displayCommand: npmCmd,
  };
}

function runNpmCi({ repoRoot, dryRun = false, cacheDir = DEFAULT_CACHE_DIR, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const args = buildNpmCiArgs({ dryRun, cacheDir });
  const invocation = resolveNpmInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    command: `${invocation.displayCommand} ${args.join(' ')}`,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

function sourceMapDependencyFinding({ repoRoot, item, packages, installed = false }) {
  const consumerPath = item.dependencyConsumer;
  const lockPaths = [item.lockPath, 'node_modules/source-map'];
  const dependencyPath = lockPaths.find((lockPath) => Boolean(packages[lockPath]));
  const consumer = packages[consumerPath];
  const dependency = packages[dependencyPath];
  const finding = (type, relativePath) => ({
    id: item.id,
    type,
    path: relativePath,
    purpose: item.purpose,
  });

  if (!consumer) return finding('missing-lock-entry', consumerPath);
  if (!dependency) return finding('missing-lock-entry', lockPaths.join(' or '));
  // The pinned source-map-support contract is ^0.6.0. Fail closed if it changes.
  if (consumer.dependencies?.['source-map'] !== '^0.6.0' || !/^0\.6\.(0|[1-9]\d*)$/.test(dependency.version || '')) {
    return finding('incompatible-lock-dependency', dependencyPath);
  }
  if (!installed) return null;

  const consumerFile = path.join(repoRoot, consumerPath, 'package.json');
  let installedConsumer;
  try {
    installedConsumer = readJsonFile(consumerFile);
  } catch {
    return finding('missing-installed-file', consumerPath + '/package.json');
  }
  // Re-read the nearest supported directory: npm ci can rehoist it in this process.
  const installedPath = lockPaths.find((lockPath) => fs.existsSync(path.join(repoRoot, lockPath)));
  if (!installedPath) {
    return finding('missing-installed-file', lockPaths.map((lockPath) => lockPath + '/package.json').join(' or '));
  }
  const resolvedFile = path.join(repoRoot, installedPath, 'package.json');
  let installedDependency;
  try {
    installedDependency = readJsonFile(resolvedFile);
  } catch {
    return finding('missing-installed-file', installedPath + '/package.json');
  }
  const realRoot = fs.realpathSync(repoRoot);
  const relativeConsumer = normalizePathForLock(path.relative(realRoot, fs.realpathSync(consumerFile)));
  const relativeDependency = normalizePathForLock(path.relative(realRoot, fs.realpathSync(resolvedFile)));
  if (
    relativeConsumer !== consumerPath + '/package.json' ||
    relativeDependency !== dependencyPath + '/package.json' ||
    installedConsumer.name !== 'source-map-support' ||
    installedConsumer.version !== consumer.version ||
    installedConsumer.dependencies?.['source-map'] !== consumer.dependencies['source-map'] ||
    installedDependency.name !== 'source-map' ||
    installedDependency.version !== dependency.version
  ) {
    return finding('installed-lock-mismatch', relativeDependency);
  }
  return null;
}

function collectLockFindings({ repoRoot, requiredPackageFiles = REQUIRED_PACKAGE_FILES } = {}) {
  const packageLockPath = path.join(repoRoot, 'package-lock.json');
  const packageLock = readJsonFile(packageLockPath);
  const packages = packageLock.packages || {};
  const findings = [];

  for (const item of requiredPackageFiles) {
    if (item.dependencyConsumer) {
      const finding = sourceMapDependencyFinding({ repoRoot, item, packages });
      if (finding) findings.push(finding);
      continue;
    }
    const lockPaths = [item.lockPath, ...(item.alternateLockPaths || [])].map(normalizePathForLock);
    const present = lockPaths.some((lockPath) => Boolean(packages[lockPath]));
    if (!present && !item.optionalLockPath) {
      findings.push({
        id: item.id,
        type: 'missing-lock-entry',
        path: lockPaths.join(' or '),
        purpose: item.purpose,
      });
    }
  }

  if (fs.existsSync(path.join(repoRoot, 'apps', 'fieldops', 'package-lock.json'))) {
    findings.push({
      id: 'fieldops-local-lockfile',
      type: 'unexpected-local-lockfile',
      path: 'apps/fieldops/package-lock.json',
      purpose: 'root npm workspace lockfile source of truth',
    });
  }

  return findings;
}

function collectInstalledFindings({ repoRoot, requiredPackageFiles = REQUIRED_PACKAGE_FILES } = {}) {
  const findings = [];
  const nodeModulesPath = path.join(repoRoot, 'node_modules');

  if (!fs.existsSync(nodeModulesPath)) {
    findings.push({
      id: 'root-node-modules',
      type: 'missing-node-modules',
      path: 'node_modules',
      purpose: 'FieldOps typecheck, Jest, and Metro dependency loading',
    });
  }

  for (const item of requiredPackageFiles) {
    if (item.dependencyConsumer) {
      const packages = readJsonFile(path.join(repoRoot, 'package-lock.json')).packages || {};
      const finding = sourceMapDependencyFinding({ repoRoot, item, packages, installed: true });
      if (finding) findings.push(finding);
      continue;
    }
    const relativePaths = [item.filePath, ...(item.alternateFilePaths || [])].map(normalizePathForLock);
    const present = relativePaths.some((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));
    if (!present && !item.optionalFile) {
      findings.push({
        id: item.id,
        type: 'missing-installed-file',
        path: relativePaths.join(' or '),
        purpose: item.purpose,
      });
    }
  }

  return findings;
}

function createSummary({
  repoRoot,
  mode = 'check',
  cacheDir = DEFAULT_CACHE_DIR,
  requiredPackageFiles = REQUIRED_PACKAGE_FILES,
  npmRunner = runNpmCi,
} = {}) {
  const resolvedRoot = repoRoot ? path.resolve(repoRoot) : resolveRepoRoot(process.cwd());
  const lockFindings = collectLockFindings({ repoRoot: resolvedRoot, requiredPackageFiles });
  const installedFindings =
    mode === 'dry-run'
      ? []
      : collectInstalledFindings({ repoRoot: resolvedRoot, requiredPackageFiles });

  let npmResult = null;
  if (mode === 'dry-run' || mode === 'materialize') {
    npmResult = npmRunner({
      repoRoot: resolvedRoot,
      dryRun: mode === 'dry-run',
      cacheDir,
    });
  }

  const postMaterializeFindings =
    mode === 'materialize' && npmResult && npmResult.status === 0
      ? collectInstalledFindings({ repoRoot: resolvedRoot, requiredPackageFiles })
      : [];
  const effectiveInstalledFindings =
    mode === 'materialize' && npmResult && npmResult.status === 0
      ? postMaterializeFindings
      : installedFindings;

  const npmOk = !npmResult || npmResult.status === 0;
  const ok = lockFindings.length === 0 && effectiveInstalledFindings.length === 0 && npmOk;

  return {
    ok,
    mode,
    repoRoot: resolvedRoot,
    workspace: FIELDOPS_WORKSPACE,
    cacheDir,
    lockFindings,
    installedFindings: effectiveInstalledFindings,
    npm: npmResult
      ? {
          command: npmResult.command,
          status: npmResult.status,
          signal: npmResult.signal || '',
          error: npmResult.error || '',
          stdoutTail: tailLines(npmResult.stdout, 20),
          stderrTail: tailLines(npmResult.stderr, 20),
        }
      : null,
    safestRepairPath: buildSafestRepairPath(cacheDir),
  };
}

function buildSafestRepairPath(cacheDir = DEFAULT_CACHE_DIR) {
  const args = buildNpmCiArgs({ dryRun: false, cacheDir });
  return [
    'From the target worktree, stop Metro/Jest/TypeScript processes that are using node_modules.',
    `Run: ${npmCmd} ${args.join(' ')}`,
    'Then rerun this checker in default check mode before starting Metro or native proof.',
    'Do not copy node_modules between worktrees.',
  ];
}

function tailLines(value, count) {
  const lines = String(value || '').trimEnd().split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - count));
}

function parseArgs(argv) {
  const args = {
    mode: 'check',
    json: false,
    cacheDir: DEFAULT_CACHE_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--dry-run') {
      args.mode = 'dry-run';
    } else if (arg === '--materialize') {
      args.mode = 'materialize';
    } else if (arg === '--check') {
      args.mode = 'check';
    } else if (arg === '--cache') {
      const next = argv[index + 1];
      if (!next) throw new Error('Missing value after --cache');
      args.cacheDir = next;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function formatHumanSummary(summary) {
  const lines = [];
  lines.push(`[fieldops-deps] status=${summary.ok ? 'ok' : 'failed'} mode=${summary.mode}`);
  lines.push(`[fieldops-deps] workspace=${summary.workspace}`);
  if (summary.lockFindings.length) {
    lines.push('[fieldops-deps] lock findings:');
    for (const finding of summary.lockFindings) {
      lines.push(`- ${finding.type}: ${finding.path} (${finding.purpose})`);
    }
  }
  if (summary.installedFindings.length) {
    lines.push('[fieldops-deps] installed tree findings:');
    for (const finding of summary.installedFindings) {
      lines.push(`- ${finding.type}: ${finding.path} (${finding.purpose})`);
    }
  }
  if (summary.npm) {
    lines.push(`[fieldops-deps] npm status=${summary.npm.status} command=${summary.npm.command}`);
    for (const line of summary.npm.stderrTail) lines.push(`[fieldops-deps] npm stderr: ${line}`);
  }
  if (!summary.ok) {
    lines.push('[fieldops-deps] safest repair path:');
    for (const step of summary.safestRepairPath) lines.push(`- ${step}`);
  }
  return lines.join('\n');
}

function printHelp() {
  console.log(`Usage: node scripts/ops/fieldops-dependency-runtime-check.js [--check|--dry-run|--materialize] [--json] [--cache <path>]

Modes:
  --check        Read-only installed dependency integrity check. Default.
  --dry-run      Run npm's FieldOps workspace ci plan without materializing node_modules.
  --materialize  Run the FieldOps workspace npm ci command, then verify required files.

This support helper does not modify product code and never copies node_modules between worktrees.`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const repoRoot = resolveRepoRoot(process.cwd());
  const summary = createSummary({
    repoRoot,
    mode: args.mode,
    cacheDir: args.cacheDir,
  });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(formatHumanSummary(summary));
  return summary.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[fieldops-deps] ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CACHE_DIR,
  FIELDOPS_WORKSPACE,
  REQUIRED_PACKAGE_FILES,
  buildNpmCiArgs,
  buildSafestRepairPath,
  collectInstalledFindings,
  collectLockFindings,
  createSummary,
  formatHumanSummary,
  parseArgs,
  resolveNpmInvocation,
  resolveRepoRoot,
  tailLines,
};
