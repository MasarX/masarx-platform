const {
  buildPreviewAuthDiagnostics,
  detectKeyKind,
  resolveEnvSource,
} = require('../../../scripts/ops/ci/preview-auth-diagnostics');

describe('preview-auth-diagnostics', () => {
  test('detectKeyKind distinguishes jwt, secret, opaque, and missing keys', () => {
    expect(detectKeyKind('a.b.c')).toBe('jwt');
    expect(detectKeyKind('sb_secret_abc')).toBe('secret');
    expect(detectKeyKind('opaque-value')).toBe('opaque');
    expect(detectKeyKind('')).toBe('missing');
  });

  test('resolveEnvSource returns the first populated candidate', () => {
    expect(resolveEnvSource([
      { name: 'FIRST', source: 'first' },
      { name: 'SECOND', source: 'second' },
    ], {
      SECOND: 'value-2',
    })).toEqual({
      source: 'second',
      value: 'value-2',
    });
  });

  test('buildPreviewAuthDiagnostics records key sources, project ref, and readiness failure class', () => {
    const diagnostics = buildPreviewAuthDiagnostics({
      ENV_FILE: '.tmp/preview.env',
      PREVIEW_MANIFEST_PATH: '.tmp/reviewer-gate-preview-bundle/manifest.json',
      PREVIEW_PROJECT_REF: '46b364a4-da77-4f71-9e7b-f34b567e3dbe-123',
      PREVIEW_SUPABASE_URL: 'https://46b364a4-da77-4f71-9e7b-f34b567e3dbe-123.supabase.co',
      PREVIEW_RUNTIME_READY_FAILURE_CLASS: 'invalid-admin-key',
      PREVIEW_RUNTIME_READY: '0',
      PREVIEW_SUPABASE_SERVICE_ROLE_KEY: 'a.b.c',
      PREVIEW_SUPABASE_ANON_KEY: 'anon-key',
      PREVIEW_SUPABASE_JWT_SECRET: 'jwt-secret',
    });

    expect(diagnostics).toEqual(expect.objectContaining({
      env_file: '.tmp/preview.env',
      manifest_path: '.tmp/reviewer-gate-preview-bundle/manifest.json',
      project_ref: '46b364a4-da77-4f71-9e7b-f34b567e3dbe-123',
      supabase_url: 'https://46b364a4-da77-4f71-9e7b-f34b567e3dbe-123.supabase.co',
      readiness_failure_class: 'invalid-admin-key',
      runtime_ready: '0',
      service_key_source: 'preview_service_role_secret',
      service_key_kind: 'jwt',
      service_key_present: '1',
      anon_key_source: 'preview_anon_secret',
      anon_key_present: '1',
      jwt_secret_source: 'preview_jwt_secret',
      jwt_secret_present: '1',
    }));
  });
});
