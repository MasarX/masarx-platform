const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_MANAGERS = new Set([
  'npm',
  'npm-cli',
  'npm-cli.js',
  'pnpm',
  'yarn',
  'bun',
  'corepack',
  'npx',
]);

const MUTATING_COMMANDS = new Set([
  'ci',
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'upgrade',
  'dedupe',
  'import',
]);

const PRESSURE_COMMANDS = new Set([
  'build',
  'test',
  'dev',
  'serve',
  'start',
  'watch',
  'typecheck',
  'lint',
]);

const PRESSURE_TOOLS = new Set([
  'vite',
  'vitest',
  'esbuild',
  'rollup',
  'webpack',
  'jest',
  'playwright',
  'storybook',
  'next',
  'tsc',
  'tsx',
  'expo',
  'metro',
]);

function redactCommandLine(value) {
  return String(value || '')
    .replace(/(token|secret|password|key)=("[^"]+"|'[^']+'|\S+)/gi, '$1=<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1<redacted>');
}

function tokenizeCommandLine(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || ''))) !== null) {
    tokens.push(match[1] || match[2] || match[3] || '');
  }
  return tokens.filter(Boolean);
}

function normalizeToken(token) {
  const trimmed = String(token || '').trim().replace(/^["']|["']$/g, '');
  const base = path.basename(trimmed).toLowerCase();
  return base.replace(/\.(cmd|exe|ps1|js)$/u, '');
}

function normalizedTokens(command) {
  return tokenizeCommandLine(command).map((token) => ({
    raw: token,
    normalized: normalizeToken(token),
    value: String(token || '').toLowerCase(),
  }));
}

function firstCommandAfter(tokens, startIndex) {
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index].normalized;
    if (!token || token === '--') continue;
    if (token.startsWith('-')) continue;
    return { token, index };
  }
  return { token: '', index: -1 };
}

function hasDependencyMaterializeScript(tokens) {
  const text = tokens.map((token) => token.value).join(' ');
  if (/dependency-readiness\.js\b/.test(text) && /\s--materialize\b/.test(` ${text}`)) return true;
  return /\b(local:deps:materialize|fieldops:deps:materialize)\b/.test(text);
}

function optionValue(tokens, optionName) {
  const dashed = `--${optionName}`;
  const underscored = dashed.replace(/-/g, '_');
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = String(tokens[index].raw || '');
    if (raw === dashed || raw === underscored) {
      return String(tokens[index + 1]?.raw || '').trim();
    }
    if (raw.startsWith(`${dashed}=`) || raw.startsWith(`${underscored}=`)) {
      return raw.slice(raw.indexOf('=') + 1).trim();
    }
  }
  const rawText = tokens.map((token) => String(token.raw || '')).join(' ');
  const optionPattern = new RegExp(
    `(?:^|\\s)(?:${dashed}|${underscored})(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`,
    'i',
  );
  const match = rawText.match(optionPattern);
  if (match) return String(match[1] || match[2] || match[3] || '').trim();
  return '';
}

function packageManagerIndex(tokens) {
  return tokens.findIndex((token) => PACKAGE_MANAGERS.has(token.normalized));
}

function classifyDependencyProcess(entry = {}) {
  const pid = Number(entry.pid || entry.ProcessId || 0);
  const command = redactCommandLine(entry.command || entry.CommandLine || '');
  const tokens = normalizedTokens(command);
  const tokenValues = new Set(tokens.map((token) => token.normalized));
  const pmIndex = packageManagerIndex(tokens);
  const materializeScript = hasDependencyMaterializeScript(tokens);
  const packageManager = pmIndex >= 0 ? tokens[pmIndex].normalized : '';
  const subcommand = pmIndex >= 0 ? firstCommandAfter(tokens, pmIndex).token : '';
  const mutatesDependencies = Boolean(materializeScript ||
    (packageManager && MUTATING_COMMANDS.has(subcommand)));
  const pressureByCommand = pmIndex >= 0 && (
    PRESSURE_COMMANDS.has(subcommand) ||
    (subcommand === 'run' && tokens.slice(pmIndex + 1).some((token) => PRESSURE_COMMANDS.has(token.normalized)))
  );
  const pressureByTool = [...PRESSURE_TOOLS].some((tool) => tokenValues.has(tool));
  const category = mutatesDependencies
    ? 'dependency_mutation'
    : (pressureByCommand || pressureByTool ? 'build_test_runtime' : 'other_dependency_related');
  const owner = optionValue(tokens, 'owner');
  const cwd = optionValue(tokens, 'cwd') || optionValue(tokens, 'prefix');
  return {
    pid,
    command,
    category,
    dependency_mutation: mutatesDependencies,
    host_pressure_signal: !mutatesDependencies && category !== 'other_dependency_related',
    dependency_owner: owner || '',
    dependency_cwd: cwd || '',
    evidence_source: 'process_scan',
    package_manager: packageManager,
    subcommand,
  };
}

function summarizeProcessPressure(processes = []) {
  const classified = processes.map((entry) => (
    entry && entry.category ? entry : classifyDependencyProcess(entry)
  ));
  const dependencyMutations = classified.filter((entry) => entry.dependency_mutation);
  const hostPressureProcesses = classified.filter((entry) => entry.host_pressure_signal);
  return {
    dependency_mutation_count: dependencyMutations.length,
    host_pressure_process_count: hostPressureProcesses.length,
    dependency_mutations: dependencyMutations,
    host_pressure_processes: hostPressureProcesses,
  };
}

function parsePowerShellJson(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function scanWindowsDependencyProcessRows(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const script = [
    '$own = $PID;',
    'Get-CimInstance Win32_Process',
    "| Where-Object { $_.ProcessId -ne $own -and $_.CommandLine -and $_.CommandLine -match '(?i)\\b(npm|npm.cmd|pnpm|pnpm.cmd|yarn|yarn.cmd|bun|bun.exe|corepack|npx|node|node.exe|vite|vitest|esbuild|jest|playwright|storybook|next|tsc|expo|metro|webpack|rollup)\\b' }",
    '| Select-Object @{Name="pid";Expression={$_.ProcessId}}, @{Name="command";Expression={$_.CommandLine}}',
    '|',
    'ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `powershell exited ${result.status}`).trim());
  }
  return parsePowerShellJson(result.stdout);
}

function scanPosixDependencyProcessRows(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `ps exited ${result.status}`).trim());
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(Boolean)
    .filter((entry) => entry.pid !== process.pid)
    .filter((entry) => /\b(npm|pnpm|yarn|bun|corepack|npx|node|vite|vitest|esbuild|jest|playwright|storybook|next|tsc|expo|metro|webpack|rollup)\b/i.test(entry.command));
}

function findDependencyProcesses(options = {}) {
  if (Array.isArray(options.dependencyProcesses)) {
    return options.dependencyProcesses.map((entry) => classifyDependencyProcess(entry));
  }
  if (Array.isArray(options.activeInstallProcesses)) {
    return options.activeInstallProcesses.map((entry) => ({
      ...classifyDependencyProcess(entry),
      category: 'dependency_mutation',
      dependency_mutation: true,
      host_pressure_signal: false,
    }));
  }
  if (options.skipProcessScan) return [];
  const platform = options.platform || process.platform;
  const rows = platform === 'win32'
    ? scanWindowsDependencyProcessRows(options)
    : scanPosixDependencyProcessRows(options);
  return rows
    .map((entry) => classifyDependencyProcess(entry))
    .filter((entry) => entry.category !== 'other_dependency_related');
}

module.exports = {
  classifyDependencyProcess,
  findDependencyProcesses,
  redactCommandLine,
  scanPosixDependencyProcessRows,
  scanWindowsDependencyProcessRows,
  summarizeProcessPressure,
  tokenizeCommandLine,
};
