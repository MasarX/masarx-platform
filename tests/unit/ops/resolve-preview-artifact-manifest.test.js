const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectJsonFiles,
  isIgnoredJsonArtifact,
  looksLikePreviewManifest,
  resolvePreviewArtifactManifestPath,
} = require('../../../scripts/ops/ci/resolve-preview-artifact-manifest');

describe('resolve-preview-artifact-manifest', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-artifact-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('recognizes canonical preview manifest shape and rejects helper evidence payloads', () => {
    expect(looksLikePreviewManifest({
      topology: 'pr',
      id: '2286',
      sha: '061a5bc12e8f446cd5d1c76b86b7297cedb7b181',
      surfaces: {},
    })).toBe(true);

    expect(looksLikePreviewManifest({
      generated_at: '2026-03-20T00:00:00.000Z',
      ready: true,
      identity: {
        topology: 'pr',
        id: '2286',
      },
    })).toBe(false);
  });

  test('ignores runtime and preview evidence helper JSON files by filename', () => {
    expect(isIgnoredJsonArtifact('/tmp/reviewer-gate-preview-evidence.json')).toBe(true);
    expect(isIgnoredJsonArtifact('/tmp/release-preview-evidence.json')).toBe(true);
    expect(isIgnoredJsonArtifact('/tmp/preview-runtime-ready.json')).toBe(true);
    expect(isIgnoredJsonArtifact('/tmp/preview-manifests/pr-123.json')).toBe(false);
  });

  test('prefers the canonical preview-manifests json over sibling evidence files', () => {
    const manifestDir = path.join(tmpRoot, 'preview-manifests');
    fs.mkdirSync(manifestDir, { recursive: true });

    fs.writeFileSync(path.join(tmpRoot, 'reviewer-gate-preview-evidence.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'preview-runtime-ready.json'), '{}\n', 'utf8');

    const manifestPath = path.join(
      manifestDir,
      'pr-2286-061a5bc12e8f446cd5d1c76b86b7297cedb7b181.json',
    );
    fs.writeFileSync(manifestPath, JSON.stringify({
      topology: 'pr',
      id: '2286',
      sha: '061a5bc12e8f446cd5d1c76b86b7297cedb7b181',
      source_sha: '061a5bc12e8f446cd5d1c76b86b7297cedb7b181',
      generated_at: '2026-03-20T00:00:00.000Z',
      surfaces: {
        db: {
          status: 'prewarmed',
        },
      },
    }, null, 2), 'utf8');

    expect(resolvePreviewArtifactManifestPath({ artifactDir: tmpRoot })).toBe(manifestPath);
  });

  test('collectJsonFiles returns deterministic sorted JSON paths', () => {
    const nested = path.join(tmpRoot, 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'z.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'a.json'), '{}\n', 'utf8');

    expect(collectJsonFiles(tmpRoot)).toEqual([
      path.join(tmpRoot, 'b', 'c', 'a.json'),
      path.join(tmpRoot, 'z.json'),
    ]);
  });

  test('fails closed when the artifact contains no manifest-shaped json', () => {
    fs.writeFileSync(path.join(tmpRoot, 'preview-runtime-ready.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'release-preview-evidence.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'preview.json'), JSON.stringify({ not: 'a manifest' }), 'utf8');

    expect(() => resolvePreviewArtifactManifestPath({ artifactDir: tmpRoot }))
      .toThrow(/No preview manifest JSON found/);
  });
});
