#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');

const MANIFEST_DIR_SEGMENT = `${path.sep}preview-manifests${path.sep}`;
const SHA_RE = /^[a-f0-9]{7,64}$/i;

function normalizeString(value) {
  return String(value || '').trim();
}

function isIgnoredJsonArtifact(filePath) {
  const baseName = path.basename(normalizeString(filePath)).toLowerCase();
  return baseName === 'preview-runtime-ready.json' || baseName.endsWith('preview-evidence.json');
}

function collectJsonFiles(rootDir) {
  const root = normalizeString(rootDir);
  if (!root || !fs.existsSync(root)) return [];

  const out = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push(fullPath);
      }
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function looksLikePreviewManifest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const topology = normalizeString(payload.topology).toLowerCase();
  if (!['pr', 'worktree'].includes(topology)) return false;
  const id = normalizeString(payload.id);
  if (!id) return false;
  const sha = normalizeString(payload.sha || payload.source_sha || payload.head_sha);
  if (!SHA_RE.test(sha)) return false;
  const surfaces = payload.surfaces;
  if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces)) return false;
  return true;
}

function scoreManifestCandidate(filePath, payload) {
  let score = 0;
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath.includes(MANIFEST_DIR_SEGMENT)) score += 100;
  if (normalizeString(payload.generated_at)) score += 10;
  if (normalizeString(payload.source_sha)) score += 5;
  if (normalizeString(payload.head_sha)) score += 5;
  return score;
}

function resolvePreviewArtifactManifestPath({ artifactDir, cwd = process.cwd() }) {
  const rawDir = normalizeString(artifactDir);
  if (!rawDir) {
    throw new Error('Missing --artifact-dir.');
  }

  const resolvedDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(cwd, rawDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Preview artifact directory not found: ${resolvedDir}`);
  }

  const candidates = [];
  for (const filePath of collectJsonFiles(resolvedDir)) {
    if (isIgnoredJsonArtifact(filePath)) continue;
    const payload = readJsonFile(filePath);
    if (!looksLikePreviewManifest(payload)) continue;
    candidates.push({
      filePath,
      score: scoreManifestCandidate(filePath, payload),
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No preview manifest JSON found under ${resolvedDir}`);
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.filePath.localeCompare(right.filePath);
  });
  return candidates[0].filePath;
}

function writeGithubOutput(payload) {
  const outputPath = normalizeString(process.env.GITHUB_OUTPUT);
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT is required for --format github-output.');
  }
  const lines = Object.entries(payload || {}).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const artifactDir = normalizeString(args['artifact-dir'] || args.artifactDir || args.dir);
  const manifestPath = resolvePreviewArtifactManifestPath({ artifactDir });
  const payload = { manifest_path: manifestPath };
  const format = normalizeString(args.format).toLowerCase();
  if (format === 'github-output') {
    writeGithubOutput(payload);
  } else if (format === 'text') {
    process.stdout.write(`${manifestPath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return payload;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`[resolve-preview-artifact-manifest] ${error?.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  collectJsonFiles,
  isIgnoredJsonArtifact,
  looksLikePreviewManifest,
  resolvePreviewArtifactManifestPath,
  runCli,
  scoreManifestCandidate,
};
