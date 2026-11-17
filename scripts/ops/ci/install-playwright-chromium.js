#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUNNER_IMAGE_CONTRACT_PATH = path.join(
  repoRoot,
  'config',
  'ci',
  'runner-image-contract.json',
);

function isTruthy(value) {
  return /^(1|true|yes|on|enabled|with-deps)$/i.test(String(value || '').trim());
}

function isFalsy(value) {
  return /^(0|false|no|off|disabled|plain)$/i.test(String(value || '').trim());
}

function shouldUseWithDeps({
  platform = process.platform,
  sourceEnv = process.env,
} = {}) {
  const mode = String(
    sourceEnv.PLAYWRIGHT_INSTALL_WITH_DEPS ??
      sourceEnv.PLAYWRIGHT_CHROMIUM_INSTALL_MODE ??
      'auto',
  ).trim();
  if (isTruthy(mode)) return true;
  if (isFalsy(mode)) return false;
  const runnerEnvironment = String(sourceEnv.RUNNER_ENVIRONMENT || '').trim().toLowerCase();
  if (runnerEnvironment === 'self-hosted') {
    return false;
  }
  return platform === 'linux';
}

function buildInstallArgs(options = {}) {
  const args = ['--no-install', 'playwright', 'install'];
  if (shouldUseWithDeps(options)) {
    args.push('--with-deps');
  }
  args.push('chromium');
  return args;
}

function resolveBundledWindowsNpxCli(processExecPath = process.execPath) {
  const normalizedExecPath = String(processExecPath || '').trim().replace(/^"+|"+$/g, '');
  if (!normalizedExecPath) return '';
  const windowsNodeModulesDir = path.win32.join(
    path.win32.dirname(normalizedExecPath),
    'node_modules',
    'npm',
    'bin',
  );
  return path.win32.join(windowsNodeModulesDir, 'npx-cli.js');
}

function resolveInstallCommand({
  platform = process.platform,
  processExecPath = process.execPath,
  sourceEnv = process.env,
  existsSyncFn = fs.existsSync,
} = {}) {
  const args = buildInstallArgs({ platform, sourceEnv });
  const bundledWindowsNpxCli = resolveBundledWindowsNpxCli(processExecPath);
  if (platform === 'win32' && existsSyncFn(bundledWindowsNpxCli)) {
    return {
      cmd: processExecPath,
      args: [bundledWindowsNpxCli, ...args],
      shell: false,
    };
  }
  return {
    cmd: platform === 'win32' ? 'npx.cmd' : 'npx',
    args,
    shell: false,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function loadRunnerImageContract(contractPath = DEFAULT_RUNNER_IMAGE_CONTRACT_PATH) {
  const targetPath = path.isAbsolute(contractPath)
    ? contractPath
    : path.join(repoRoot, contractPath);
  return readJson(targetPath);
}

function isHostedRunner(sourceEnv = process.env) {
  return String(sourceEnv.RUNNER_ENVIRONMENT || '').trim().toLowerCase() === 'github-hosted';
}

function isSelfHostedRunner(sourceEnv = process.env) {
  return String(sourceEnv.RUNNER_ENVIRONMENT || '').trim().toLowerCase() === 'self-hosted';
}

function resolveExpectedBrowsersPath({
  sourceEnv = process.env,
  contract = null,
} = {}) {
  const explicit = String(sourceEnv.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (explicit) return explicit;
  const payload = contract || loadRunnerImageContract();
  return String(
    payload?.profiles?.browser?.playwright_browsers_path
      || payload?.profiles?.privileged?.playwright_browsers_path
      || '',
  ).trim();
}

function primePlaywrightBrowsersPath({
  sourceEnv = process.env,
  contract = null,
} = {}) {
  const explicit = String(sourceEnv.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (explicit) return explicit;
  if (!isSelfHostedRunner(sourceEnv)) return '';
  const expected = resolveExpectedBrowsersPath({ sourceEnv, contract });
  if (!expected) return '';
  sourceEnv.PLAYWRIGHT_BROWSERS_PATH = expected;
  return expected;
}

function resolveChromiumExecutablePath({ requireFn = require } = {}) {
  let playwright;
  try {
    playwright = requireFn('playwright');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      return '';
    }
    throw error;
  }
  return String(playwright?.chromium?.executablePath?.() || '').trim();
}

function detectChromiumAvailability({
  sourceEnv = process.env,
  contract = null,
  requireFn = require,
  existsSyncFn = fs.existsSync,
} = {}) {
  primePlaywrightBrowsersPath({ sourceEnv, contract });
  const expectedBrowsersPath = resolveExpectedBrowsersPath({ sourceEnv, contract });
  const executablePath = resolveChromiumExecutablePath({ requireFn });
  const moduleAvailable = Boolean(executablePath);
  const executableExists = Boolean(executablePath) && existsSyncFn(executablePath);
  const normalizedExecutablePath = executablePath.replace(/\\/g, '/');
  const normalizedBrowsersPath = expectedBrowsersPath.replace(/\\/g, '/');
  return {
    available: executableExists,
    moduleAvailable,
    executablePath,
    expectedBrowsersPath,
    usesConfiguredBrowsersPath: normalizedBrowsersPath
      ? normalizedExecutablePath.startsWith(normalizedBrowsersPath)
      : false,
  };
}

function detectChromiumLaunchability({
  sourceEnv = process.env,
  processExecPath = process.execPath,
  spawnSyncFn = spawnSync,
  timeoutMs = 20000,
} = {}) {
  const launchScript = [
    "const { chromium } = require('playwright');",
    '(async () => {',
    '  const browser = await chromium.launch({ headless: true });',
    '  await browser.close();',
    '})().catch((error) => {',
    "  console.error(error && error.stack ? error.stack : String(error || 'unknown launch failure'));",
    '  process.exit(1);',
    '});',
  ].join('\n');
  const result = spawnSyncFn(processExecPath, ['-e', launchScript], {
    encoding: 'utf8',
    env: { ...process.env, ...sourceEnv },
    shell: false,
    timeout: timeoutMs,
  });
  if (result.error) {
    return {
      launchable: false,
      error: result.error,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  }
  return {
    launchable: result.status === 0,
    error: null,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function formatLaunchFailure(launchStatus = null) {
  if (!launchStatus || launchStatus.launchable) return '';
  if (launchStatus.error) {
    return `launch_error=${launchStatus.error.message || String(launchStatus.error)}`;
  }
  const details = [
    launchStatus.stderr ? `stderr=${launchStatus.stderr.trim()}` : '',
    launchStatus.stdout ? `stdout=${launchStatus.stdout.trim()}` : '',
    launchStatus.signal ? `signal=${launchStatus.signal}` : '',
    launchStatus.status !== null && launchStatus.status !== undefined
      ? `status=${launchStatus.status}`
      : '',
  ].filter(Boolean);
  return details.join(' ');
}

function classifyInstallMode({
  sourceEnv = process.env,
  browserStatus = detectChromiumAvailability({ sourceEnv }),
  launchStatus = null,
} = {}) {
  if (browserStatus.moduleAvailable === false) {
    return 'playwright-module-missing';
  }
  if (browserStatus.available) {
    return 'already-available';
  }
  if (browserStatus.available && launchStatus && !launchStatus.launchable) {
    return isHostedRunner(sourceEnv) ? 'runtime-install' : 'browser-image-drift';
  }
  return isHostedRunner(sourceEnv) ? 'runtime-install' : 'browser-image-drift';
}

function shouldRepairBrowserImageDrift({
  sourceEnv = process.env,
} = {}) {
  const mode = String(
    sourceEnv.PLAYWRIGHT_REPAIR_BROWSER_IMAGE_DRIFT ??
      sourceEnv.PLAYWRIGHT_ALLOW_BROWSER_IMAGE_DRIFT_REPAIR ??
      'auto',
  ).trim();
  if (isTruthy(mode)) return true;
  if (isFalsy(mode)) return false;
  return isSelfHostedRunner(sourceEnv);
}

function resolveFallbackBrowsersPath({
  sourceEnv = process.env,
  repoRootPath = repoRoot,
} = {}) {
  const explicit = String(
    sourceEnv.PLAYWRIGHT_FALLBACK_BROWSERS_PATH ??
      sourceEnv.PLAYWRIGHT_RUNTIME_BROWSERS_PATH ??
      '',
  ).trim();
  if (explicit) return explicit;
  const runnerTemp = String(
    sourceEnv.RUNNER_TEMP ??
      sourceEnv.TMPDIR ??
      sourceEnv.TEMP ??
      sourceEnv.TMP ??
      '',
  ).trim();
  if (runnerTemp) {
    return path.join(runnerTemp, 'playwright-browsers');
  }
  return path.join(repoRootPath, 'tmp', 'playwright-browsers');
}

function prepareBrowserInstallEnvironment({
  sourceEnv = process.env,
  browserStatus = detectChromiumAvailability({ sourceEnv }),
  repoRootPath = repoRoot,
  mkdirSyncFn = fs.mkdirSync,
} = {}) {
  const installMode = classifyInstallMode({ sourceEnv, browserStatus });
  if (installMode !== 'browser-image-drift' || !shouldRepairBrowserImageDrift({ sourceEnv })) {
    return {
      installMode,
      repairedBrowserDrift: false,
      fallbackBrowsersPath: '',
    };
  }

  const fallbackBrowsersPath = resolveFallbackBrowsersPath({ sourceEnv, repoRootPath });
  mkdirSyncFn(fallbackBrowsersPath, { recursive: true });
  sourceEnv.PLAYWRIGHT_BROWSERS_PATH = fallbackBrowsersPath;
  return {
    installMode: 'runtime-install',
    repairedBrowserDrift: true,
    fallbackBrowsersPath,
  };
}

function buildBrowserImageDriftMessage(browserStatus = {}) {
  return [
    '[install-playwright-chromium] Self-hosted browser runner is missing the Playwright Chromium revision',
    'required by the repo contract.',
    browserStatus.expectedBrowsersPath
      ? `PLAYWRIGHT_BROWSERS_PATH=${browserStatus.expectedBrowsersPath}`
      : '',
    browserStatus.executablePath
      ? `expected_executable=${browserStatus.executablePath}`
      : '',
  ].filter(Boolean).join(' ');
}

function buildPlaywrightModuleMissingMessage() {
  return [
    '[install-playwright-chromium] Playwright is not available in node_modules,',
    'so browser readiness cannot be verified.',
    'Run dependency installation before invoking the browser installer.',
  ].join(' ');
}

function exportPlaywrightBrowsersPathToGithubEnv({
  sourceEnv = process.env,
  existsSyncFn = fs.existsSync,
  appendFileSyncFn = fs.appendFileSync,
  githubEnvPath = String(sourceEnv.GITHUB_ENV || '').trim(),
} = {}) {
  const browsersPath = String(sourceEnv.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  if (!browsersPath || !githubEnvPath || !existsSyncFn(browsersPath)) {
    return false;
  }
  appendFileSyncFn(githubEnvPath, `PLAYWRIGHT_BROWSERS_PATH=${browsersPath}\n`, 'utf8');
  return true;
}

function ensurePlaywrightChromium({
  sourceEnv = process.env,
  contract = null,
  requireFn = require,
  existsSyncFn = fs.existsSync,
  mkdirSyncFn = fs.mkdirSync,
  spawnSyncFn = spawnSync,
  repoRootPath = repoRoot,
  platform = process.platform,
  processExecPath = process.execPath,
  logger = console,
  appendFileSyncFn = fs.appendFileSync,
  githubEnvPath = String(sourceEnv.GITHUB_ENV || '').trim(),
} = {}) {
  primePlaywrightBrowsersPath({ sourceEnv, contract });
  const browserStatus = detectChromiumAvailability({
    sourceEnv,
    contract,
    requireFn,
    existsSyncFn,
  });
  const installContext = prepareBrowserInstallEnvironment({
    sourceEnv,
    browserStatus,
    repoRootPath,
    mkdirSyncFn,
  });
  const installMode = installContext.installMode;

  if (installMode === 'already-available') {
    logger.log?.(
      `[install-playwright-chromium] Chromium already available at ${browserStatus.executablePath}`,
    );
    return {
      installMode,
      repairedBrowserDrift: false,
      fallbackBrowsersPath: '',
      browsersPath: String(sourceEnv.PLAYWRIGHT_BROWSERS_PATH || '').trim(),
      exportedToGithubEnv: exportPlaywrightBrowsersPathToGithubEnv({
        sourceEnv,
        existsSyncFn,
        appendFileSyncFn,
        githubEnvPath,
      }),
      browserStatus,
    };
  }

  if (installContext.repairedBrowserDrift) {
    logger.warn?.(
      [
        '[install-playwright-chromium] Self-hosted browser image drift detected;',
        `installing Chromium into fallback path ${installContext.fallbackBrowsersPath}.`,
      ].join(' '),
    );
  }

  if (installMode === 'browser-image-drift') {
    const message = buildBrowserImageDriftMessage(browserStatus);
    logger.error?.('failure_class=browser-image-drift');
    logger.error?.(message);
    const error = new Error(message);
    error.failureClass = 'browser-image-drift';
    error.installMode = installMode;
    error.browserStatus = browserStatus;
    throw error;
  }

  if (installMode === 'playwright-module-missing') {
    const message = buildPlaywrightModuleMissingMessage();
    logger.error?.('failure_class=playwright-module-missing');
    logger.error?.(message);
    const error = new Error(message);
    error.failureClass = 'playwright-module-missing';
    error.installMode = installMode;
    error.browserStatus = browserStatus;
    throw error;
  }

  const installCommand = resolveInstallCommand({
    platform,
    processExecPath,
    sourceEnv,
    existsSyncFn,
  });
  const result = spawnSyncFn(installCommand.cmd, installCommand.args, {
    stdio: 'inherit',
    shell: installCommand.shell,
    env: sourceEnv,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `[install-playwright-chromium] playwright install failed with exit code ${result.status || 1}`,
    );
    error.installMode = installMode;
    throw error;
  }

  return {
    installMode,
    repairedBrowserDrift: installContext.repairedBrowserDrift,
    fallbackBrowsersPath: installContext.fallbackBrowsersPath,
    browsersPath: String(sourceEnv.PLAYWRIGHT_BROWSERS_PATH || '').trim(),
    exportedToGithubEnv: exportPlaywrightBrowsersPathToGithubEnv({
      sourceEnv,
      existsSyncFn,
      appendFileSyncFn,
      githubEnvPath,
    }),
    browserStatus,
  };
}

function main() {
  ensurePlaywrightChromium();
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInstallArgs,
  resolveInstallCommand,
  shouldUseWithDeps,
  loadRunnerImageContract,
  isHostedRunner,
  isSelfHostedRunner,
  resolveExpectedBrowsersPath,
  primePlaywrightBrowsersPath,
  resolveChromiumExecutablePath,
  detectChromiumAvailability,
  detectChromiumLaunchability,
  formatLaunchFailure,
  classifyInstallMode,
  shouldRepairBrowserImageDrift,
  resolveFallbackBrowsersPath,
  prepareBrowserInstallEnvironment,
  buildBrowserImageDriftMessage,
  buildPlaywrightModuleMissingMessage,
  exportPlaywrightBrowsersPathToGithubEnv,
  ensurePlaywrightChromium,
  resolveBundledWindowsNpxCli,
};
