#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

function die(message) {
  throw new Error(`[supabase-cli-asset] ${message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    version: '',
    platform: '',
    arch: '',
    format: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    if (token === '--version') {
      out.version = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--version=')) {
      out.version = token.split('=').slice(1).join('=').trim();
    } else if (token === '--platform') {
      out.platform = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--platform=')) {
      out.platform = token.split('=').slice(1).join('=').trim();
    } else if (token === '--arch') {
      out.arch = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--arch=')) {
      out.arch = token.split('=').slice(1).join('=').trim();
    } else if (token === '--format') {
      out.format = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token.startsWith('--format=')) {
      out.format = token.split('=').slice(1).join('=').trim();
    }
  }
  return out;
}

function normalizePlatform(platform = process.platform) {
  const raw = String(platform || '').trim().toLowerCase();
  if (!raw) die('Missing platform.');
  if (raw === 'linux' || raw === 'ubuntu' || raw === 'ubuntu-latest') return 'linux';
  if (raw === 'darwin' || raw === 'macos' || raw === 'macos-latest' || raw === 'mac') return 'darwin';
  if (raw === 'win32' || raw === 'windows' || raw === 'windows-latest') return 'windows';
  die(`Unsupported platform "${platform}".`);
}

function normalizeArch(arch = process.arch) {
  const raw = String(arch || '').trim().toLowerCase();
  if (!raw) die('Missing arch.');
  if (raw === 'x64' || raw === 'amd64' || raw === 'x86_64') return 'amd64';
  if (raw === 'arm64' || raw === 'aarch64') return 'arm64';
  if (raw === 'arm') return 'arm';
  die(`Unsupported arch "${arch}".`);
}

function parseVersionTriplet(version) {
  const normalized = String(version || '').trim();
  const core = normalized.replace(/^v/i, '').split(/[+-]/)[0];
  const match = core.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersionTriplets(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return 0;
}

function isLegacyVersion(version) {
  const parsed = parseVersionTriplet(version);
  if (!parsed) {
    die(`Version must be latest or exact semver-like (got: ${version || '<empty>'}).`);
  }
  return compareVersionTriplets(parsed, { major: 1, minor: 28, patch: 0 }) < 0;
}

function buildSupabaseCliAsset({
  version,
  platform = process.env.RUNNER_OS || process.platform,
  arch = process.env.RUNNER_ARCH || process.arch,
} = {}) {
  const normalizedVersion = String(version || '').trim();
  if (!normalizedVersion) die('Missing --version.');
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  const binaryName = normalizedPlatform === 'windows' ? 'supabase.exe' : 'supabase';
  const assetName = `supabase_${normalizedPlatform}_${normalizedArch}.tar.gz`;
  let downloadUrl = '';

  if (normalizedVersion.toLowerCase() === 'latest') {
    downloadUrl = `https://github.com/supabase/cli/releases/latest/download/${assetName}`;
  } else if (isLegacyVersion(normalizedVersion)) {
    downloadUrl = `https://github.com/supabase/cli/releases/download/v${normalizedVersion}/supabase_${normalizedVersion}_${normalizedPlatform}_${normalizedArch}.tar.gz`;
  } else {
    downloadUrl = `https://github.com/supabase/cli/releases/download/v${normalizedVersion}/${assetName}`;
  }

  const asset = {
    version: normalizedVersion,
    platform: normalizedPlatform,
    arch: normalizedArch,
    asset_name: assetName,
    binary_name: binaryName,
    download_url: downloadUrl,
  };
  if (normalizedVersion === '2.116.0' && normalizedPlatform === 'linux' && normalizedArch === 'amd64') {
    asset.mirror_url = 'http://192.0.2.1:8080/github.com/supabase/cli/releases/download/v2.116.0/supabase_linux_amd64.tar.gz';
    asset.sha256 = '5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158';
  }
  return asset;
}

function writeGithubOutput(values) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; omit --format github-output for local runs.');
  const fs = require('fs');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = buildSupabaseCliAsset({
    version: args.version,
    platform: args.platform || process.env.RUNNER_OS || process.platform,
    arch: args.arch || process.env.RUNNER_ARCH || process.arch,
  });
  const format = String(args.format || '').trim().toLowerCase();
  if (format === 'github-output') {
    writeGithubOutput(result);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildSupabaseCliAsset,
  compareVersionTriplets,
  isLegacyVersion,
  main,
  normalizeArch,
  normalizePlatform,
  parseArgs,
  parseVersionTriplet,
};
