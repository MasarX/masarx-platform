const {
  parseChangedFilesJson,
  listChangedEvidenceFiles,
  isLikelyBinaryEvidencePath,
  looksLikeIsoTimestamp,
  validateExternalManifest,
} = require('../../../scripts/ops/ci/evidence-externalization-lint');

describe('evidence-externalization-lint', () => {
  describe('parseChangedFilesJson', () => {
    test('accepts an array payload from the workflow changed-files step', () => {
      expect(parseChangedFilesJson('["docs/ops/evidence/2026-03-03/report.md","README.md"]')).toEqual([
        'docs/ops/evidence/2026-03-03/report.md',
        'README.md',
      ]);
    });

    test('rejects invalid JSON payloads', () => {
      expect(() => parseChangedFilesJson('{bad json')).toThrow(/invalid changed-files json/i);
      expect(() => parseChangedFilesJson('{"path":"README.md"}')).toThrow(/must decode to an array/i);
    });
  });

  describe('listChangedEvidenceFiles', () => {
    test('prefers the workflow changed-files list over git diff', () => {
      expect(
        listChangedEvidenceFiles({
          repoRoot: process.cwd(),
          baseRef: 'dev',
          changedFiles: [
            'docs/ops/evidence/2026-03-03/report.md',
            'README.md',
            'docs/ops/evidence/2026-03-03/external-artifacts.manifest.json',
          ],
          changedFilesProvided: true,
        }),
      ).toEqual([
        'docs/ops/evidence/2026-03-03/report.md',
        'docs/ops/evidence/2026-03-03/external-artifacts.manifest.json',
      ]);
    });

    test('treats an empty workflow changed-files list as authoritative', () => {
      expect(
        listChangedEvidenceFiles({
          repoRoot: process.cwd(),
          baseRef: 'dev',
          changedFiles: [],
          changedFilesProvided: true,
        }),
      ).toEqual([]);
    });
  });

  describe('isLikelyBinaryEvidencePath', () => {
    test('returns true for binary evidence extensions', () => {
      expect(isLikelyBinaryEvidencePath('docs/ops/evidence/2026-03-03/ui/screenshot.png')).toBe(true);
      expect(isLikelyBinaryEvidencePath('docs/ops/evidence/2026-03-03/bundle.zip')).toBe(true);
    });

    test('returns false for text evidence files', () => {
      expect(isLikelyBinaryEvidencePath('docs/ops/evidence/2026-03-03/report.md')).toBe(false);
      expect(isLikelyBinaryEvidencePath('docs/ops/evidence/2026-03-03/external-artifacts.manifest.json')).toBe(false);
    });
  });

  describe('looksLikeIsoTimestamp', () => {
    test('accepts valid ISO-8601 values', () => {
      expect(looksLikeIsoTimestamp('2026-03-03T12:34:56.000Z')).toBe(true);
    });

    test('rejects malformed values', () => {
      expect(looksLikeIsoTimestamp('2026-03-03')).toBe(false);
      expect(looksLikeIsoTimestamp('not-a-date')).toBe(false);
    });
  });

  describe('validateExternalManifest', () => {
    test('accepts a valid v1 external artifacts manifest', () => {
      const manifest = {
        schema_version: 'evidence.external-artifacts.v1',
        generated_at: '2026-03-03T12:00:00.000Z',
        producer: {
          workflow: 'reviewer-gate-pr',
          generated_at: '2026-03-03T12:00:00.000Z',
        },
        artifacts: [
          {
            logical_path: 'docs/ops/evidence/2026-03-03/ui/screenshot.png',
            uri: 'https://example.invalid/evidence/screenshot.png',
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            bytes: 1024,
            captured_at: '2026-03-03T12:00:00.000Z',
          },
        ],
      };
      expect(validateExternalManifest(manifest, 'docs/ops/evidence/2026-03-03/external-artifacts.manifest.json')).toEqual([]);
    });

    test('reports schema violations', () => {
      const manifest = {
        schema_version: 'bad',
        generated_at: '2026-03-03',
        producer: {},
        artifacts: [
          {
            logical_path: 'tmp/file.bin',
            uri: 'ftp://example.invalid/file.bin',
            sha256: '123',
            bytes: 0,
            captured_at: 'invalid',
          },
        ],
      };
      const errors = validateExternalManifest(manifest, 'docs/ops/evidence/2026-03-03/external-artifacts.manifest.json');
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
