#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EVIDENCE_PREFIX = 'docs/ops/evidence/';
const EXTERNAL_MANIFEST_NAME = 'external-artifacts.manifest.json';
const MANIFEST_SCHEMA_VERSION = 'evidence.external-artifacts.v1';
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.aab',
  '.apk',
  '.avi',
  '.bin',
  '.bmp',
  '.bz2',
  '.dmg',
  '.exe',
  '.gif',
  '.gz',
  '.ipa',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.tgz',
  '.tif',
  '.tiff',
  '.ttf',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
]);

function die(message) {
  console.error(`[evidence-externalization-lint] ${message}`);
  process.exit(1);
}

function parseNumber(value, fallback) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    format: '',
    baseRef: String(process.env.BASE_REF || process.env.GITHUB_BASE_REF || '').trim(),
    changedFilesJson: String(process.env.CHANGED_FILES_JSON || '').trim(),
    maxBytes: parseNumber(process.env.EVIDENCE_MAX_BYTES, DEFAULT_MAX_BYTES),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (!token) continue;
    if (token === '--format' && next) {
      out.format = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      out.format = token.split('=').slice(1).join('=').trim();
      continue;
    }
    if (token === '--base-ref' && next) {
      out.baseRef = next;
      i += 1;
      continue;
    }
    if (token.startsWith('--base-ref=')) {
      out.baseRef = token.split('=').slice(1).join('=').trim();
      continue;
    }
    if (token === '--max-bytes' && next) {
      out.maxBytes = parseNumber(next, out.maxBytes);
      i += 1;
      continue;
    }
    if (token.startsWith('--max-bytes=')) {
      out.maxBytes = parseNumber(token.split('=').slice(1).join('=').trim(), out.maxBytes);
    }
  }
  return out;
}

function parseChangedFilesJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid changed-files JSON (${error.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('changed-files JSON must decode to an array.');
  }
  return parsed
    .map((entry) => normalizeRelPath(entry))
    .filter(Boolean);
}

function findRepoRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function runGit(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(res.stderr || res.stdout || '').trim()}`);
  }
  return String(res.stdout || '');
}

function normalizeRelPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function listChangedEvidenceFiles({
  repoRoot,
  baseRef,
  changedFiles = [],
  changedFilesProvided = false,
}) {
  if (changedFilesProvided) {
    return changedFiles
      .map((line) => normalizeRelPath(line))
      .filter((line) => line.startsWith(EVIDENCE_PREFIX));
  }
  if (!baseRef) return [];
  const diffBase = String(baseRef).startsWith('origin/') ? String(baseRef) : `origin/${String(baseRef).trim()}`;
  const raw = runGit(
    ['diff', '--name-only', '--diff-filter=ACMR', `${diffBase}...HEAD`, '--', EVIDENCE_PREFIX],
    repoRoot,
  );
  return raw
    .split('\n')
    .map((line) => normalizeRelPath(line))
    .filter((line) => line.startsWith(EVIDENCE_PREFIX));
}

function isLikelyBinaryEvidencePath(relPath) {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  if (!ext) return false;
  return BINARY_EXTENSIONS.has(ext);
}

function looksLikeIsoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return false;
  return raw.includes('T');
}

function validateExternalManifest(manifest, relPath) {
  const errors = [];
  const prefix = `${relPath}:`;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(`${prefix} manifest must be a JSON object.`);
    return errors;
  }

  if (String(manifest.schema_version || '').trim() !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`${prefix} schema_version must be '${MANIFEST_SCHEMA_VERSION}'.`);
  }
  if (!looksLikeIsoTimestamp(manifest.generated_at)) {
    errors.push(`${prefix} generated_at must be an ISO-8601 timestamp.`);
  }

  const producer = manifest.producer;
  if (!producer || typeof producer !== 'object' || Array.isArray(producer)) {
    errors.push(`${prefix} producer must be an object.`);
  } else {
    if (!String(producer.workflow || '').trim()) {
      errors.push(`${prefix} producer.workflow is required.`);
    }
    if (!looksLikeIsoTimestamp(producer.generated_at || manifest.generated_at)) {
      errors.push(`${prefix} producer.generated_at (or generated_at) must be an ISO-8601 timestamp.`);
    }
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (!artifacts.length) {
    errors.push(`${prefix} artifacts must be a non-empty array.`);
    return errors;
  }

  const shaRe = /^[a-f0-9]{64}$/i;
  const uriRe = /^(https:\/\/|s3:\/\/|gs:\/\/)/i;
  artifacts.forEach((artifact, index) => {
    const key = `${prefix} artifacts[${index}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      errors.push(`${key} must be an object.`);
      return;
    }
    if (!String(artifact.logical_path || '').trim().startsWith(EVIDENCE_PREFIX)) {
      errors.push(`${key}.logical_path must start with '${EVIDENCE_PREFIX}'.`);
    }
    if (!String(artifact.uri || '').trim() || !uriRe.test(String(artifact.uri || '').trim())) {
      errors.push(`${key}.uri must use https://, s3://, or gs://.`);
    }
    if (!shaRe.test(String(artifact.sha256 || '').trim())) {
      errors.push(`${key}.sha256 must be a 64-char hex digest.`);
    }
    if (!Number.isFinite(Number(artifact.bytes)) || Number(artifact.bytes) <= 0) {
      errors.push(`${key}.bytes must be a positive integer.`);
    }
    if (!looksLikeIsoTimestamp(artifact.captured_at)) {
      errors.push(`${key}.captured_at must be an ISO-8601 timestamp.`);
    }
  });

  return errors;
}

function writeReport(repoRoot, report) {
  const rel = path.join('artifacts', 'ci', 'evidence-externalization-report.json');
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return normalizeRelPath(rel);
}

function writeGithubOutput(report) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; run with --format json locally.');
  const rows = [
    ['has_evidence_changes', report.changed_files.length > 0 ? '1' : '0'],
    ['oversized_binary_count', String(report.oversized_binary_files.length)],
    ['manifest_error_count', String(report.manifest_errors.length)],
    ['report_path', report.report_path],
  ];
  fs.appendFileSync(outPath, rows.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
}

function main() {
  const { format, baseRef, changedFilesJson, maxBytes } = parseArgs();
  const repoRoot = findRepoRoot(process.cwd());
  const changed = listChangedEvidenceFiles({
    repoRoot,
    baseRef,
    changedFiles: parseChangedFilesJson(changedFilesJson),
    changedFilesProvided: String(changedFilesJson || '').trim() !== '',
  });

  const oversized = [];
  const manifestErrors = [];
  const manifests = [];

  for (const rel of changed) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;

    if (isLikelyBinaryEvidencePath(rel) && stat.size > maxBytes) {
      oversized.push({
        path: rel,
        bytes: stat.size,
      });
    }

    if (path.basename(rel) === EXTERNAL_MANIFEST_NAME) {
      manifests.push(rel);
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch (error) {
        manifestErrors.push(`${rel}: invalid JSON (${error.message})`);
        continue;
      }
      manifestErrors.push(...validateExternalManifest(parsed, rel));
    }
  }

  const report = {
    base_ref: baseRef || '',
    max_bytes: maxBytes,
    changed_files: changed,
    oversized_binary_files: oversized,
    manifest_files: manifests,
    manifest_errors: manifestErrors,
  };
  report.report_path = writeReport(repoRoot, report);

  if (String(format || '').trim().toLowerCase() === 'github-output') {
    writeGithubOutput(report);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  if (oversized.length || manifestErrors.length) {
    const details = [
      oversized.length
        ? `oversized binaries: ${oversized.map((item) => `${item.path} (${item.bytes} bytes)`).join(', ')}`
        : '',
      manifestErrors.length ? `manifest errors: ${manifestErrors.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join(' ; ');
    die(`evidence externalization lint failed (${details}).`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  parseArgs,
  parseChangedFilesJson,
  normalizeRelPath,
  listChangedEvidenceFiles,
  isLikelyBinaryEvidencePath,
  looksLikeIsoTimestamp,
  validateExternalManifest,
};
