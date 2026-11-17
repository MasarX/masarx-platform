#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  requestGithubJson,
  downloadGithubBinary,
} = require('./github-api-retry');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEntrySuffix(value) {
  return normalizeString(value).replace(/\\/g, '/').toLowerCase();
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

function resolvePythonExecutable({ platform = process.platform, execFileSyncFn = execFileSync } = {}) {
  const candidates = normalizeString(platform).toLowerCase() === 'win32'
    ? ['python', 'py']
    : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      execFileSyncFn(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch (error) {
      // Try the next candidate.
    }
  }
  throw new Error('Python executable not available for artifact ZIP parsing.');
}

function readJsonFromZip(
  zipPath,
  { entrySuffix = '', platform = process.platform, execFileSyncFn = execFileSync } = {},
) {
  const pythonBin = resolvePythonExecutable({ platform, execFileSyncFn });
  const raw = execFileSyncFn(
    pythonBin,
    [
      '-c',
      [
        'import sys',
        'import zipfile',
        'zip_path = sys.argv[1]',
        "entry_suffix = (sys.argv[2] if len(sys.argv) > 2 else '').strip().lower()",
        'with zipfile.ZipFile(zip_path) as archive:',
        "    entries = [name for name in archive.namelist() if name and not name.endswith('/')]",
        '    match = None',
        '    if entry_suffix:',
        '        for name in entries:',
        '            lowered = name.strip().lower()',
        "            if lowered == entry_suffix or lowered.endswith('/' + entry_suffix):",
        '                match = name',
        '                break',
        '    else:',
        '        for name in entries:',
        "            if name.strip().lower().endswith('.json'):",
        '                match = name',
        '                break',
        '    if not match:',
        "        raise SystemExit(f'Artifact {zip_path} does not contain {entry_suffix or \"a JSON file\"}.')",
        "    sys.stdout.write(archive.read(match).decode('utf-8-sig'))",
      ].join('\n'),
      zipPath,
      normalizeString(entrySuffix),
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
}

function readJsonEntriesFromZip(
  zipPath,
  { entrySuffixes = [], platform = process.platform, execFileSyncFn = execFileSync } = {},
) {
  const suffixes = [...new Set((Array.isArray(entrySuffixes) ? entrySuffixes : [entrySuffixes])
    .map((entrySuffix) => normalizeEntrySuffix(entrySuffix))
    .filter(Boolean))];
  if (!suffixes.length) return {};

  const pythonBin = resolvePythonExecutable({ platform, execFileSyncFn });
  const raw = execFileSyncFn(
    pythonBin,
    [
      '-c',
      [
        'import json',
        'import sys',
        'import zipfile',
        'zip_path = sys.argv[1]',
        'suffixes = json.loads(sys.argv[2])',
        'out = {}',
        'with zipfile.ZipFile(zip_path) as archive:',
        "    entries = [name for name in archive.namelist() if name and not name.endswith('/')]",
        '    lowered_entries = [(name, name.strip().lower().replace("\\\\", "/")) for name in entries]',
        '    for suffix in suffixes:',
        '        match = None',
        '        for name, lowered in lowered_entries:',
        "            if lowered == suffix or lowered.endswith('/' + suffix):",
        '                match = name',
        '                break',
        '        if match:',
        "            out[suffix] = json.loads(archive.read(match).decode('utf-8-sig'))",
        'sys.stdout.write(json.dumps(out))',
      ].join('\n'),
      zipPath,
      JSON.stringify(suffixes),
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(String(raw || '{}').replace(/^\uFEFF/, ''));
}

function listEntriesFromZip(
  zipPath,
  { platform = process.platform, execFileSyncFn = execFileSync } = {},
) {
  const pythonBin = resolvePythonExecutable({ platform, execFileSyncFn });
  const raw = execFileSyncFn(
    pythonBin,
    [
      '-c',
      [
        'import sys',
        'import zipfile',
        'zip_path = sys.argv[1]',
        'with zipfile.ZipFile(zip_path) as archive:',
        "    entries = [name for name in archive.namelist() if name and not name.endswith('/')]",
        "    sys.stdout.write('\\n'.join(entries))",
      ].join('\n'),
      zipPath,
    ],
    { encoding: 'utf8' },
  );
  return String(raw || '')
    .split(/\r?\n/)
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
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
  resolvePythonExecutable,
  readJsonFromZip,
  readJsonEntriesFromZip,
  listEntriesFromZip,
  fetchWorkflowArtifactBundleForRun,
  fetchWorkflowEvidenceForRun,
};
