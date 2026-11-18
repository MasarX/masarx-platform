#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');
const zlib = require('zlib');

const EXPECTED = Object.freeze({
  packageName: 'xlsx',
  version: '0.20.3',
  url: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  integrity:
    'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==',
});

const EXPECTED_VENDOR_FILES = Object.freeze({
  'supabase/functions/resource-import-studio/vendor/sheetjs-xlsx-0.20.3/xlsx.mjs':
    {
      tarPath: 'package/xlsx.mjs',
      sha256: '1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db',
    },
  'supabase/functions/resource-import-studio/vendor/sheetjs-xlsx-0.20.3/cpexcel.full.mjs':
    {
      tarPath: 'package/dist/cpexcel.full.mjs',
      sha256: '7a7bba23b6b6f23b5c69fbb631f78d1d455f74b57e4aa54e9a2f81a8ab844964',
    },
  'supabase/functions/resource-import-studio/vendor/sheetjs-xlsx-0.20.3/package.json':
    {
      tarPath: 'package/package.json',
      sha256: 'bb9458277a69b41a304a89e45f19173ac0d23f2fc296091db49dba3c8b61c546',
    },
  'supabase/functions/resource-import-studio/vendor/sheetjs-xlsx-0.20.3/LICENSE':
    {
      tarPath: 'package/LICENSE',
      sha256: '4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64',
    },
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message, details = {}) {
  console.error(`[xlsx-tarball-verify] ${message}`);
  if (Object.keys(details).length > 0) {
    console.error(JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} returned ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function computeIntegrity(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readTarEntries(tgzBuffer, wantedNames) {
  const tarBuffer = zlib.gunzipSync(tgzBuffer);
  const wanted = new Set(wantedNames);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
    const sizeRaw = header.toString('utf8', 124, 136).replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeRaw || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${name || '(empty)'}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (wanted.has(name)) {
      entries.set(name, tarBuffer.subarray(contentStart, contentEnd));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarPackageJson(tarEntries) {
  const entry = tarEntries.get('package/package.json');
  if (!entry) throw new Error('package/package.json not found in tarball');
  return JSON.parse(entry.toString('utf8'));
}

async function verifyVendoredParser(repoRoot) {
  const XLSX = require('xlsx');
  const vendorRoot = path.join(
    repoRoot,
    'supabase',
    'functions',
    'resource-import-studio',
    'vendor',
    'sheetjs-xlsx-0.20.3',
  );
  const vendorXlsx = await import(pathToFileURL(path.join(vendorRoot, 'xlsx.mjs')).href);
  const vendorCpexcel = await import(pathToFileURL(path.join(vendorRoot, 'cpexcel.full.mjs')).href);
  if (typeof vendorXlsx.set_cptable === 'function') {
    vendorXlsx.set_cptable(vendorCpexcel);
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['tracking_number', 'recipient_name'],
      ['XLS-EDGE-1', 'Edge Legacy Receiver'],
    ]),
    'Shipments',
  );

  for (const bookType of ['xls', 'xlsx']) {
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType });
    const parsed = vendorXlsx.read(buffer, { type: 'array', raw: false, cellDates: true });
    const sheet = parsed.Sheets?.Shipments;
    const rows = vendorXlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (rows?.[0]?.tracking_number !== 'XLS-EDGE-1') {
      fail('Vendored SheetJS parser failed workbook roundtrip proof.', {
        bookType,
        rows,
      });
    }
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  const packageLock = readJson(path.join(repoRoot, 'package-lock.json'));
  const rootXlsx = packageJson.dependencies?.xlsx;
  const lockRootXlsx = packageLock.packages?.['']?.dependencies?.xlsx;
  const lockNode = packageLock.packages?.['node_modules/xlsx'];

  if (rootXlsx !== EXPECTED.url || lockRootXlsx !== EXPECTED.url) {
    fail('xlsx dependency must stay pinned to the exact official tarball URL.', {
      expected: EXPECTED.url,
      package_json: rootXlsx,
      package_lock_root: lockRootXlsx,
    });
  }

  if (
    lockNode?.version !== EXPECTED.version ||
    lockNode?.resolved !== EXPECTED.url ||
    lockNode?.integrity !== EXPECTED.integrity
  ) {
    fail('package-lock xlsx entry does not match the expected version/url/integrity.', {
      expected: EXPECTED,
      actual: lockNode || null,
    });
  }

  const tarball = await fetchBuffer(EXPECTED.url);
  const actualIntegrity = computeIntegrity(tarball);
  if (actualIntegrity !== EXPECTED.integrity) {
    fail('Downloaded xlsx tarball integrity does not match package-lock.', {
      expected: EXPECTED.integrity,
      actual: actualIntegrity,
    });
  }

  const tarEntries = readTarEntries(tarball, [
    'package/package.json',
    ...Object.values(EXPECTED_VENDOR_FILES).map((entry) => entry.tarPath),
  ]);
  const tarPackage = readTarPackageJson(tarEntries);
  if (tarPackage.name !== EXPECTED.packageName || tarPackage.version !== EXPECTED.version) {
    fail('Downloaded xlsx tarball package identity does not match expectation.', {
      expected: { name: EXPECTED.packageName, version: EXPECTED.version },
      actual: { name: tarPackage.name, version: tarPackage.version },
    });
  }

  for (const [relativePath, expected] of Object.entries(EXPECTED_VENDOR_FILES)) {
    const repoPath = path.join(repoRoot, ...relativePath.split('/'));
    if (!fs.existsSync(repoPath)) {
      fail('Expected vendored SheetJS edge file is missing.', { path: relativePath });
    }
    const actualBuffer = fs.readFileSync(repoPath);
    const actualSha256 = computeSha256(actualBuffer);
    if (actualSha256 !== expected.sha256) {
      fail('Vendored SheetJS edge file hash drifted.', {
        path: relativePath,
        expected: expected.sha256,
        actual: actualSha256,
      });
    }
    const tarBuffer = tarEntries.get(expected.tarPath);
    if (!tarBuffer) {
      fail('Expected file is missing from the pinned SheetJS tarball.', {
        tarPath: expected.tarPath,
      });
    }
    const tarSha256 = computeSha256(tarBuffer);
    if (tarSha256 !== actualSha256) {
      fail('Vendored SheetJS edge file does not match the pinned tarball content.', {
        path: relativePath,
        tarPath: expected.tarPath,
        vendorSha256: actualSha256,
        tarSha256,
      });
    }
  }

  const edgeSource = fs.readFileSync(
    path.join(repoRoot, 'supabase', 'functions', 'resource-import-studio', 'index.ts'),
    'utf8',
  );
  if (/cdn\.sheetjs\.com\/xlsx/i.test(edgeSource) || /npm:xlsx/i.test(edgeSource)) {
    fail('resource-import-studio must import SheetJS from the vendored local files, not a remote runtime URL.');
  }

  await verifyVendoredParser(repoRoot);

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: EXPECTED.packageName,
        version: EXPECTED.version,
        resolved: EXPECTED.url,
        integrity: actualIntegrity,
        license: tarPackage.license || lockNode.license || null,
        vendored_files: Object.keys(EXPECTED_VENDOR_FILES).length,
        parser_roundtrip: ['xls', 'xlsx'],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => fail(error?.message || String(error)));
