#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requestGithubJson,
  downloadGithubBinary,
} = require('./github-api-retry');
const { readZipArchiveFile } = require('./zip-archive');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEntrySuffix(value) {
  return normalizeString(value).replace(/\\/g, '/').toLowerCase();
}

function decodeUtf8(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function listWorkflowRunArtifacts({ owner, repo, token, runId, requestJson = requestGithubJson }) {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/runs/${encodeURIComponent(String(runId || ''))}/artifacts?per_page=100`;
  const data = await requestJson({
    token,
    url,
    userAgent: 'masarx-github-workflow-artifacts',
  });
  return Array.isArray(data?.artifacts) ? data.artifacts : [];
}

function findArtifactByName(artifacts, artifactName) {
  const expected = normalizeString(artifactName);
  if (!expected) return null;
  const rows = Array.isArray(artifacts) ? artifacts : [];
  return rows.find((entry) => normalizeString(entry?.name) === expected) || null;
}

function readJsonFromExtractedTree(baseDir, { entrySuffix = '' } = {}) {
  const normalizedSuffix = normalizeString(entrySuffix).toLowerCase();
  const queue = [baseDir];
  const files = [];
  while (queue.length) {
    const current = queue.shift();
    const entries = fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : [];
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  const target = normalizedSuffix
    ? files.find((filePath) => normalizeString(path.relative(baseDir, filePath)).toLowerCase().endsWith(normalizedSuffix))
    : files.find((filePath) => normalizeString(filePath).toLowerCase().endsWith('.json'));
  if (!target) {
    throw new Error(`Artifact extract tree ${baseDir} does not contain ${normalizedSuffix || 'a JSON file'}.`);
  }
  const raw = fs.readFileSync(target, 'utf8');
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function listEntriesFromZip(
  zipPath,
  { readZipArchiveFileFn = readZipArchiveFile } = {},
) {
  return readZipArchiveFileFn(zipPath, { errorPrefix: 'workflow_artifact_zip' })
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name);
}

function findZipEntry(entries, entrySuffix = '', { defaultToJson = false } = {}) {
  const suffix = normalizeEntrySuffix(entrySuffix);
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ entry, normalized: normalizeEntrySuffix(entry) }));
  if (suffix) {
    return rows.find(({ normalized }) =>
      normalized === suffix || normalized.endsWith(`/${suffix}`))?.entry || '';
  }
  return defaultToJson
    ? rows.find(({ normalized }) => normalized.endsWith('.json'))?.entry || ''
    : '';
}

function readZipEntry(zipPath, entry, { readZipArchiveFileFn = readZipArchiveFile } = {}) {
  const target = readZipArchiveFileFn(zipPath, { errorPrefix: 'workflow_artifact_zip' })
    .find((candidate) => !candidate.isDirectory && candidate.name === entry);
  if (!target) throw new Error(`Artifact ${zipPath} does not contain ${entry}.`);
  return decodeUtf8(target.data);
}

function readJsonFromZip(
  zipPath,
  { entrySuffix = '', readZipArchiveFileFn = readZipArchiveFile } = {},
) {
  const archive = readZipArchiveFileFn(zipPath, { errorPrefix: 'workflow_artifact_zip' })
    .filter((entry) => !entry.isDirectory);
  const entries = archive.map((entry) => entry.name);
  const target = findZipEntry(entries, entrySuffix, { defaultToJson: true });
  if (!target) {
    throw new Error(`Artifact ${zipPath} does not contain ${normalizeString(entrySuffix) || 'a JSON file'}.`);
  }
  const raw = decodeUtf8(archive.find((entry) => entry.name === target).data);
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function readJsonEntriesFromZip(
  zipPath,
  { entrySuffixes = [], readZipArchiveFileFn = readZipArchiveFile } = {},
) {
  const suffixes = [...new Set((Array.isArray(entrySuffixes) ? entrySuffixes : [entrySuffixes])
    .map((entrySuffix) => normalizeEntrySuffix(entrySuffix))
    .filter(Boolean))];
  if (!suffixes.length) return {};

  const archive = readZipArchiveFileFn(zipPath, { errorPrefix: 'workflow_artifact_zip' })
    .filter((entry) => !entry.isDirectory);
  const entries = archive.map((entry) => entry.name);
  const out = {};
  for (const suffix of suffixes) {
    const target = findZipEntry(entries, suffix);
    if (!target) continue;
    const raw = decodeUtf8(archive.find((entry) => entry.name === target).data);
    out[suffix] = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  }
  return out;
}

async function fetchWorkflowArtifactBundleForRun({
  owner,
  repo,
  token,
  runId,
  artifactName,
  jsonEntrySuffix = '',
  jsonEntrySuffixes = [],
  listArtifactsFn = listWorkflowRunArtifacts,
  downloadBinaryFn = downloadGithubBinary,
  readJsonFromZipFn = readJsonFromZip,
  readJsonEntriesFromZipFn = readJsonEntriesFromZip,
  listEntriesFromZipFn = listEntriesFromZip,
}) {
  const artifacts = await listArtifactsFn({ owner, repo, token, runId });
  const artifact = findArtifactByName(artifacts, artifactName);
  if (!artifact) {
    return { status: 'missing_artifact', manifest: null, entries: [] };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-workflow-evidence-'));
  const zipPath = path.join(tempDir, `${normalizeString(artifact.name) || 'artifact'}.zip`);
  try {
    await downloadBinaryFn({
      token,
      url: artifact.archive_download_url,
      targetPath: zipPath,
      userAgent: 'masarx-github-workflow-artifacts',
    });
    const manifest = readJsonFromZipFn(zipPath, { entrySuffix: jsonEntrySuffix });
    const requestedJsonEntrySuffixes = [...new Set(
      (Array.isArray(jsonEntrySuffixes) ? jsonEntrySuffixes : [jsonEntrySuffixes])
        .map((entrySuffix) => normalizeEntrySuffix(entrySuffix))
        .filter(Boolean),
    )];
    const jsonEntries = requestedJsonEntrySuffixes.length
      ? readJsonEntriesFromZipFn(zipPath, { entrySuffixes: requestedJsonEntrySuffixes })
      : {};
    const normalizedManifestSuffix = normalizeEntrySuffix(jsonEntrySuffix);
    if (normalizedManifestSuffix && !Object.prototype.hasOwnProperty.call(jsonEntries, normalizedManifestSuffix)) {
      jsonEntries[normalizedManifestSuffix] = manifest;
    }
    const entries = listEntriesFromZipFn(zipPath);
    return {
      status: 'ok',
      artifact_name: normalizeString(artifact.name),
      manifest,
      entries,
      json_entries: jsonEntries,
    };
  } catch (error) {
    return {
      status: 'artifact_error',
      artifact_name: normalizeString(artifact.name),
      manifest: null,
      entries: [],
      error: String(error?.message || error),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function fetchWorkflowEvidenceForRun({
  owner,
  repo,
  token,
  runId,
  artifactName,
  jsonEntrySuffix = '',
  listArtifactsFn = listWorkflowRunArtifacts,
  downloadBinaryFn = downloadGithubBinary,
  readJsonFromZipFn = readJsonFromZip,
  listEntriesFromZipFn = listEntriesFromZip,
}) {
  const bundle = await fetchWorkflowArtifactBundleForRun({
    owner,
    repo,
    token,
    runId,
    artifactName,
    jsonEntrySuffix,
    listArtifactsFn,
    downloadBinaryFn,
    readJsonFromZipFn,
    listEntriesFromZipFn,
  });
  const result = {
    status: bundle.status,
    manifest: bundle.manifest,
  };
  if (bundle.artifact_name) result.artifact_name = bundle.artifact_name;
  if (bundle.error) result.error = bundle.error;
  return result;
}

module.exports = {
  listWorkflowRunArtifacts,
  findArtifactByName,
  readJsonFromExtractedTree,
  findZipEntry,
  readZipEntry,
  readJsonFromZip,
  readJsonEntriesFromZip,
  listEntriesFromZip,
  fetchWorkflowArtifactBundleForRun,
  fetchWorkflowEvidenceForRun,
};
