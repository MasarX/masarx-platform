const {
  resolveReleaseVerifyPreviewSurfaces,
} = require('../../../scripts/ops/ci/release-verify-preview-surfaces');

describe('release-verify-preview-surfaces', () => {
  test('keeps explicit non-UI preview surfaces while skipping UI projects when the UI gate is already proven by same-SHA evidence', () => {
    const result = resolveReleaseVerifyPreviewSurfaces({
      requiredPreviewSurfaceIds: 'db,api_ingress',
      uiProjects: 'console,portal',
      runUiGateEffective: '0',
    });

    expect(result).toEqual({
      csv: 'db,api_ingress',
      surface_ids: ['db', 'api_ingress'],
    });
  });

  test('adds db runtime plus effective UI surfaces without duplicates when UI preview validation is still required', () => {
    const result = resolveReleaseVerifyPreviewSurfaces({
      requiredPreviewSurfaceIds: 'db,api_ingress',
      uiProjects: 'portal,console,portal',
      runUiGateEffective: '1',
    });

    expect(result).toEqual({
      csv: 'db,api_ingress,portal,console',
      surface_ids: ['db', 'api_ingress', 'portal', 'console'],
    });
  });
});
