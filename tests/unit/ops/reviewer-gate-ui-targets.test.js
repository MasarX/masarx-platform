const {
  formatOutputs,
  parseCsv,
  resolveReviewerGateUiTargets,
} = require('../../../scripts/ops/ci/reviewer-gate-ui-targets');

describe('reviewer-gate-ui-targets', () => {
  test('parseCsv trims and drops empty entries', () => {
    expect(parseCsv(' console, , portal ,,docs ')).toEqual(['console', 'portal', 'docs']);
  });

  test('returns both impacted UI projects when URLs are present', () => {
    const result = resolveReviewerGateUiTargets({
      surfaceIds: 'db,console,portal',
      consoleUrl: 'https://console-preview.vercel.app',
      portalUrl: 'https://portal-preview.vercel.app',
    });

    expect(formatOutputs(result)).toEqual({
      e2e_projects: 'console,portal',
      missing_surfaces: '',
      missing_urls: '0',
    });
  });

  test('fails closed when an impacted UI surface is missing its preview URL', () => {
    const result = resolveReviewerGateUiTargets({
      surfaceIds: 'portal,docs',
      consoleUrl: '',
      portalUrl: '',
    });

    expect(result).toEqual({
      e2eProjects: ['portal'],
      missingSurfaces: ['portal'],
      missingUrls: true,
    });
  });
});
