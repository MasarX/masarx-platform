#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  createFieldopsScenarioSet,
  formatDateYmd,
  parsePlatformList,
  SUPPORTED_PLATFORMS,
} = require('./fieldops-ui-screenshot-scenarios');

const REQUIRED_SELFTEST_CONTRACT_STEP_PREFIXES = Object.freeze([
  'OK - Header contract',
  'OK - Drawer contract',
]);
const CAPTURE_MODE = 'device_browser_prototype';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const DEFAULT_SOURCE_DIR = path.join('docs', 'product', 'examples', 'mobile-field-ops-ui');
// objectives:allow LOCALHOST Justification: native screenshot capture is a local-only harness; env/CLI can override the bind host while the safe default stays loopback.
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4179;
const DEFAULT_RENDER_WAIT_MS = 250;
const DEFAULT_LAUNCH_WAIT_MS = 2000;

function parseArgs(argv) {
  const out = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    const value = next && !String(next).startsWith('--') ? String(next) : '1';
    if (value !== '1') index += 1;
    out[key] = value;
  }
  return out;
}

function defaultOutputDir(date = new Date()) {
  return path.join(
    'docs',
    'ops',
    'evidence',
    formatDateYmd(date),
    'mobile-fieldops',
    'ui-screenshots-native-runtime',
  );
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function wait(ms) {
  const parsed = Number.parseInt(String(ms || '').trim(), 10);
  const delay = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function sendResponse(res, statusCode, body, type) {
  const payload = body == null ? '' : body;
  res.writeHead(statusCode, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(payload);
}

function createStaticServer({ rootDir, host, port }) {
  const normalizedRoot = path.normalize(rootDir);
  const server = http.createServer((req, res) => {
    try {
      const base = `http://${host}:${port}`;
      const url = new URL(req.url || '/', base);
      const relativePath = url.pathname === '/' ? 'version-c.html' : url.pathname.replace(/^\/+/g, '');
      const resolved = path.normalize(path.join(normalizedRoot, relativePath));
      const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
      if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
        sendResponse(res, 403, 'forbidden');
        return;
      }
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        sendResponse(res, 404, 'not found');
        return;
      }
      sendResponse(res, 200, fs.readFileSync(resolved), mimeTypeFor(resolved));
    } catch (error) {
      sendResponse(res, 500, `static server error: ${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.prototype.hasOwnProperty.call(options, 'encoding') ? options.encoding : 'utf8',
    stdio: options.stdio || 'pipe',
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
    detached: options.detached || false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(
      `[native-runtime-capture] ${command} ${args.join(' ')} failed with code ${result.status}` +
        (stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''),
    );
  }
  return result.stdout;
}

function normalizeAdbPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return Buffer.from(buffer || '');
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return buffer;
  }
  const marker = Buffer.from('\r\n', 'binary');
  if (!buffer.includes(marker)) return buffer;
  return Buffer.from(buffer.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

function readPngDimensions(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { width: 0, height: 0 };
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function resolveAndroidSerial(explicitSerial) {
  const provided = String(explicitSerial || '').trim();
  if (provided) return provided;

  const output = runCommand('adb', ['devices']);
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== 'list of devices attached');

  const deviceLine = lines.find((line) => /\sdevice$/.test(line));
  if (!deviceLine) {
    throw new Error('[native-runtime-capture] No Android device/emulator detected (adb devices).');
  }

  return deviceLine.split(/\s+/)[0];
}

function resolveBootedIosDevice(explicitUdid) {
  const provided = String(explicitUdid || '').trim();
  if (provided) return { udid: provided, name: provided };

  const output = runCommand('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  const parsed = JSON.parse(String(output || '{}'));
  const devicesByRuntime = parsed && typeof parsed === 'object' ? parsed.devices : null;
  if (!devicesByRuntime || typeof devicesByRuntime !== 'object') {
    throw new Error('[native-runtime-capture] Failed to parse xcrun simctl devices output.');
  }

  for (const runtimeDevices of Object.values(devicesByRuntime)) {
    if (!Array.isArray(runtimeDevices)) continue;
    const booted = runtimeDevices.find(
      (device) => String(device?.state || '').toLowerCase() === 'booted',
    );
    if (!booted) continue;
    const udid = String(booted.udid || '').trim();
    if (!udid) continue;
    return {
      udid,
      name: String(booted.name || udid),
    };
  }

  throw new Error('[native-runtime-capture] No booted iOS simulator detected (xcrun simctl).');
}

function openAndroidUrl({ serial, url }) {
  const parsed = new URL(url);
  if (parsed.hostname === DEFAULT_HOST || parsed.hostname === 'localhost') {
    const port = parsed.port || DEFAULT_PORT;
    runCommand('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }
  runCommand('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    url,
  ]);
}

function openIosUrl({ udid, url }) {
  runCommand('xcrun', ['simctl', 'openurl', udid, url]);
}

function captureAndroidScreenshot({ serial, filePath }) {
  const stdout = runCommand('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
    encoding: null,
    maxBuffer: 25 * 1024 * 1024,
  });
  const normalized = normalizeAdbPngBuffer(stdout);
  fs.writeFileSync(filePath, normalized);
}

function captureIosScreenshot({ udid, filePath }) {
  runCommand('xcrun', ['simctl', 'io', udid, 'screenshot', filePath]);
}

function buildSelftest(platform, scenarioCount, errors = [], url = '') {
  const steps = [
    `Captured ${scenarioCount} device-browser prototype screenshots`,
    'Native FieldOps application and Header/Drawer contracts were not verified',
  ];
  const status = errors.length === 0 ? 'pass' : 'fail';
  return {
    platform,
    status,
    url,
    steps,
    error: errors.length ? errors.join(' | ') : null,
  };
}

async function capturePlatformScenarios({
  platform,
  outputDir,
  baseUrl,
  launchWaitMs,
  renderWaitMs,
  androidSerial,
  iosUdid,
}) {
  const scenarios = createFieldopsScenarioSet(platform);
  const captured = [];
  const errors = [];

  const selftestUrl = new URL(
    `version-c.html?${new URLSearchParams({
      capture: 'true',
      role: 'driver',
      theme: 'light',
      platform,
      selftest: 'true',
      view: 'tasks',
    }).toString()}`,
    baseUrl,
  ).toString();

  try {
    if (platform === 'android') {
      openAndroidUrl({ serial: androidSerial, url: selftestUrl });
    } else {
      openIosUrl({ udid: iosUdid, url: selftestUrl });
    }
  } catch (error) {
    errors.push(`selftest-launch: ${error.message}`);
  }

  const launchWait = Number.parseInt(String(launchWaitMs || '').trim(), 10);
  await wait(Number.isFinite(launchWait) && launchWait > 0 ? launchWait : DEFAULT_LAUNCH_WAIT_MS);

  for (const scenario of scenarios) {
    const fileName = `${scenario.name}.png`;
    const filePath = path.join(outputDir, fileName);
    const scenarioUrl = new URL(
      `version-c.html?${new URLSearchParams({
        capture: 'true',
        role: 'driver',
        theme: scenario.query.theme || 'light',
        platform,
        ...scenario.query,
      }).toString()}`,
      baseUrl,
    ).toString();

    try {
      if (platform === 'android') {
        openAndroidUrl({ serial: androidSerial, url: scenarioUrl });
      } else {
        openIosUrl({ udid: iosUdid, url: scenarioUrl });
      }
      if (Number.isFinite(renderWaitMs) && renderWaitMs > 0) {
        await wait(renderWaitMs);
      }
      if (platform === 'android') {
        captureAndroidScreenshot({ serial: androidSerial, filePath });
      } else {
        captureIosScreenshot({ udid: iosUdid, filePath });
      }
      const dimensions = readPngDimensions(filePath);
      if (!dimensions.width || !dimensions.height) {
        throw new Error(`invalid PNG dimensions width=${dimensions.width} height=${dimensions.height}`);
      }
      captured.push({
        name: scenario.name,
        file: fileName,
        platform,
        capture_source: platform === 'android' ? 'adb' : 'simctl',
        captured_at: new Date().toISOString(),
        width: dimensions.width,
        height: dimensions.height,
        url: scenarioUrl,
      });
      console.log(`[native-runtime-capture] captured ${fileName}`);
    } catch (error) {
      errors.push(`${scenario.name}: ${error.message}`);
      console.error(`[native-runtime-capture] failed ${scenario.name}: ${error.message}`);
    }
  }

  return {
    scenarios: captured,
    selftest: buildSelftest(platform, captured.length, errors, selftestUrl),
    errors,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Object.prototype.hasOwnProperty.call(args, 'require-native-app')) {
    throw new Error('[native-runtime-capture] Actual FieldOps native-app capture is unavailable: this producer captures a browser prototype only.');
  }
  const requestedPlatforms =
    args.platforms ||
    process.env.FIELDOPS_NATIVE_SCREENSHOT_PLATFORMS ||
    process.env.FIELDOPS_UI_CAPTURE_PLATFORMS ||
    SUPPORTED_PLATFORMS.join(',');
  const platforms = parsePlatformList(requestedPlatforms);
  const sourceDir = path.resolve(
    String(args['source-dir'] || process.env.FIELDOPS_NATIVE_SCREENSHOT_SOURCE_DIR || DEFAULT_SOURCE_DIR),
  );
  const outputDir = path.resolve(String(args['output-dir'] || process.env.FIELDOPS_NATIVE_SCREENSHOT_OUTPUT_DIR || defaultOutputDir()));
  const host = String(args.host || process.env.FIELDOPS_NATIVE_SCREENSHOT_HOST || DEFAULT_HOST);
  const port = Number.parseInt(
    String(args.port || process.env.FIELDOPS_NATIVE_SCREENSHOT_PORT || DEFAULT_PORT),
    10,
  );
  const renderWaitMs = Number.parseInt(
    String(args['render-wait-ms'] || process.env.FIELDOPS_NATIVE_SCREENSHOT_RENDER_WAIT_MS || DEFAULT_RENDER_WAIT_MS),
    10,
  );
  const launchWaitMs = Number.parseInt(
    String(args['launch-wait-ms'] || process.env.FIELDOPS_NATIVE_SCREENSHOT_LAUNCH_WAIT_MS || DEFAULT_LAUNCH_WAIT_MS),
    10,
  );
  const explicitAndroidSerial = String(
    args['android-serial'] ||
      process.env.FIELDOPS_NATIVE_SCREENSHOT_ANDROID_SERIAL ||
      process.env.ANDROID_SERIAL ||
      '',
  ).trim();
  const explicitIosUdid = String(
    args['ios-udid'] ||
      process.env.FIELDOPS_NATIVE_SCREENSHOT_IOS_UDID ||
      process.env.IOS_SIMULATOR_UDID ||
      '',
  ).trim();

  if (!platforms.length) {
    throw new Error(
      `[native-runtime-capture] No valid platforms were provided. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
    );
  }
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`[native-runtime-capture] FieldOps sample source directory not found: ${sourceDir}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const baseUrl = `http://${host}:${port}`;
  console.log(`[native-runtime-capture] source=${sourceDir}`);
  console.log(`[native-runtime-capture] output=${outputDir}`);
  console.log(`[native-runtime-capture] serving ${baseUrl}`);
  console.log(`[native-runtime-capture] platforms=${platforms.join(',')}`);

  const server = await createStaticServer({
    rootDir: sourceDir,
    host,
    port,
  });

  let androidSerial = explicitAndroidSerial || null;
  let iosDevice = explicitIosUdid ? { udid: explicitIosUdid, name: explicitIosUdid } : null;

  try {
    if (platforms.includes('android') && !androidSerial) {
      androidSerial = resolveAndroidSerial(null);
      console.log(`[native-runtime-capture] android serial=${androidSerial}`);
    } else if (androidSerial) {
      console.log(`[native-runtime-capture] android serial=${androidSerial}`);
    }
    if (platforms.includes('ios') && !iosDevice) {
      iosDevice = resolveBootedIosDevice(null);
      console.log(`[native-runtime-capture] ios simulator=${iosDevice.name} (${iosDevice.udid})`);
    } else if (iosDevice) {
      console.log(`[native-runtime-capture] ios simulator=${iosDevice.name} (${iosDevice.udid})`);
    }

    const allScenarios = [];
    const selftests = [];
    const failures = [];

    for (const platform of platforms) {
      const result = await capturePlatformScenarios({
        platform,
        outputDir,
        baseUrl,
        launchWaitMs,
        renderWaitMs,
        androidSerial,
        iosUdid: iosDevice?.udid || null,
      });
      allScenarios.push(...result.scenarios);
      selftests.push(result.selftest);
      if (result.errors.length) failures.push(...result.errors);
    }

    const manifest = {
      captured_at: new Date().toISOString(),
      capture_mode: CAPTURE_MODE,
      source_dir: sourceDir,
      output_dir: outputDir,
      server_url: baseUrl,
      platforms,
      launch_wait_ms: Number.isFinite(launchWaitMs) ? launchWaitMs : DEFAULT_LAUNCH_WAIT_MS,
      render_wait_ms: Number.isFinite(renderWaitMs) ? renderWaitMs : DEFAULT_RENDER_WAIT_MS,
      devices: {
        android: androidSerial ? { serial: androidSerial } : null,
        ios: iosDevice ? { udid: iosDevice.udid, name: iosDevice.name } : null,
      },
      selftests,
      scenarios: allScenarios,
    };

    const manifestPath = path.join(outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`[native-runtime-capture] wrote ${manifestPath}`);

    if (failures.length) {
      throw new Error(`[native-runtime-capture] ${failures.length} capture(s) failed.`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  CAPTURE_MODE,
  DEFAULT_HOST,
  DEFAULT_LAUNCH_WAIT_MS,
  DEFAULT_PORT,
  DEFAULT_RENDER_WAIT_MS,
  DEFAULT_SOURCE_DIR,
  buildSelftest,
  capturePlatformScenarios,
  captureAndroidScreenshot,
  captureIosScreenshot,
  createStaticServer,
  defaultOutputDir,
  mimeTypeFor,
  normalizeAdbPngBuffer,
  openAndroidUrl,
  openIosUrl,
  parseArgs,
  readPngDimensions,
  resolveAndroidSerial,
  resolveBootedIosDevice,
  runCommand,
  sendResponse,
  wait,
  main,
};
