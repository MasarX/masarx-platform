const { resolveEdgeGuardSettings } = require('../../../scripts/ops/workspace/ensure-edge-role-api-keys');

describe('workspace/ensure-edge-role-api-keys', () => {
  test('uses strict guard toggles when least-privilege keys are valid', () => {
    expect(resolveEdgeGuardSettings(true)).toEqual({
      modeLabel: 'least-privilege (edge roles)',
      previewMode: '0',
      edgeRequireDbJwt: '1',
    });
  });

  test('uses preview-compatible guard toggles in fallback mode', () => {
    expect(resolveEdgeGuardSettings(false)).toEqual({
      modeLabel: 'fallback (service_role)',
      previewMode: '1',
      edgeRequireDbJwt: '0',
    });
  });
});

