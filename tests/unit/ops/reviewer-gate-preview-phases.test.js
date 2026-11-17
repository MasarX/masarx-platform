const {
  parseArgs,
  splitCsv,
  resolveOutputs,
} = require('../../../scripts/ops/ci/reviewer-gate-preview-phases');

describe('reviewer-gate-preview-phases', () => {
  test('parseArgs accepts explicit surface ids and format', () => {
    expect(parseArgs([
      '--surface-ids',
      'console,portal',
      '--format',
      'github-output',
    ])).toEqual({
      format: 'github-output',
      surfaceIds: 'console,portal',
    });
  });

  test('splitCsv normalizes and deduplicates ids', () => {
    expect(splitCsv('portal,console,portal,db')).toEqual(['console', 'db', 'portal']);
  });

  test('resolveOutputs separates runtime and hosted provision surfaces', () => {
    expect(resolveOutputs(['console', 'portal'])).toEqual({
      runtime_preview_surface_ids: 'db',
      hosted_preview_surface_ids: 'console,portal',
      needs_hosted_preview_provision: '1',
    });

    expect(resolveOutputs(['db', 'api_ingress'])).toEqual({
      runtime_preview_surface_ids: 'api_ingress,db',
      hosted_preview_surface_ids: '',
      needs_hosted_preview_provision: '0',
    });
  });
});
