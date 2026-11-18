const {
  buildPreviewManifestOutputs,
  resolveBooleanOutput,
} = require('../../../scripts/ops/ci/preview-manifest-outputs');
const { buildMaterializedOwnership } = require('../../../scripts/ops/workspace/preview-ownership');

describe('preview-manifest-outputs', () => {
  test('resolveBooleanOutput treats explicit false as 0 and everything else as 1', () => {
    expect(resolveBooleanOutput(false)).toBe('0');
    expect(resolveBooleanOutput('false')).toBe('0');
    expect(resolveBooleanOutput('0')).toBe('1');
    expect(resolveBooleanOutput(true)).toBe('1');
    expect(resolveBooleanOutput('')).toBe('1');
  });

  test('buildPreviewManifestOutputs resolves DB contract and hosted URLs', () => {
    const ownership = buildMaterializedOwnership({
      workspace_mode: 'branch',
      project_ref: 'abcdefghijklmnopqrst',
      project_name: 'wk-preview',
      branch_id: 'branch-one',
      branch_parent_ref: 'tsruxlpethmpzoxdkvto',
      run_id: 'run-one',
      run_attempt: '1',
    });
    const outputs = buildPreviewManifestOutputs({
      env_file: '.tmp/fallback.env',
      workspace_ownership: ownership,
      surfaces: {
        db: {
          project_ref: 'abcdefghijklmnopqrst',
          project_name: 'wk-preview',
          workspace_mode: 'branch',
          branch_id: 'branch-one',
          branch_parent_ref: 'tsruxlpethmpzoxdkvto',
          supabase_url: 'https://proj-ref.supabase.co',
          env_file: '.tmp/preview.env',
          runtime_ready: true,
          runtime_ready_at: '2026-03-20T00:00:00.000Z',
          jwt_ready: true,
          db_ready: true,
          rest_ready: false,
          readiness_failure_class: 'preview-runtime-unready',
        },
        console: {
          deployment_url: 'https://console-preview.vercel.app',
        },
        portal: {
          deployment_url: 'https://portal-preview.vercel.app',
        },
        landing: {
          url: 'https://landing-preview.pages.dev',
        },
        docs: {
          url: 'https://docs-preview.pages.dev',
        },
      },
    });

    expect(outputs).toEqual({
      materialized_ownership: '1',
      project_ref: 'abcdefghijklmnopqrst',
      project_name: 'wk-preview',
      workspace_mode: 'branch',
      branch_id: 'branch-one',
      branch_parent_ref: 'tsruxlpethmpzoxdkvto',
      ownership_generation_token: ownership.generation_token,
      supabase_url: 'https://proj-ref.supabase.co',
      env_file: '.tmp/preview.env',
      runtime_ready: '1',
      runtime_ready_at: '2026-03-20T00:00:00.000Z',
      jwt_ready: '1',
      db_ready: '1',
      rest_ready: '0',
      readiness_failure_class: 'preview-runtime-unready',
      console_url: 'https://console-preview.vercel.app',
      portal_url: 'https://portal-preview.vercel.app',
      landing_url: 'https://landing-preview.pages.dev',
      docs_url: 'https://docs-preview.pages.dev',
    });
  });

  test('exposes materialized ownership independently of runtime readiness', () => {
    const ownership = buildMaterializedOwnership({
      workspace_mode: 'project',
      project_ref: 'abcdefghijklmnopqrst',
      project_name: 'wk-preview-failed',
      run_id: 'run-one',
      run_attempt: '1',
    });
    const outputs = buildPreviewManifestOutputs({
      workspace_ownership: ownership,
      surfaces: {
        db: {
          ...ownership,
          status: 'failed',
          runtime_ready: false,
          readiness_failure_class: 'db-push-failed',
        },
      },
    });
    expect(outputs.materialized_ownership).toBe('1');
    expect(outputs.runtime_ready).toBe('0');
    expect(outputs.project_ref).toBe('abcdefghijklmnopqrst');
  });
});
