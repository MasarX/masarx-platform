const {
  formatOutputs,
  parseCsv,
  resolveReleaseVerifyScope,
} = require('../../../scripts/ops/ci/release-verify-scope');

describe('release-verify-scope', () => {
  test('parseCsv trims and drops empty entries', () => {
    expect(parseCsv(' console, , portal ,,docs ')).toEqual(['console', 'portal', 'docs']);
  });

  test('requires preview validation for verify-cloud-core changes', () => {
    const result = resolveReleaseVerifyScope({
      eventName: 'merge_group',
      suiteVerifyCloudCore: '1',
      surfaceIds: 'docs,landing',
      allowMergeGroupPreview: '1',
    });

    expect(formatOutputs(result)).toEqual({
      run_preview_validation: '1',
      preview_requested: '1',
      reason: 'verify_cloud_core',
      run_ui_gate: '0',
      run_mobile_gate: '0',
      run_landing_gate: '1',
      run_docs_gate: '1',
      ui_projects: '',
    });
  });

  test('pull_request stays on the fast lane even when impacted UI surfaces would otherwise require preview', () => {
    const result = resolveReleaseVerifyScope({
      eventName: 'pull_request',
      surfaceIds: 'db,console,portal',
    });

    expect(result).toEqual({
      runPreviewValidation: true,
      previewRequested: false,
      reason: 'pr_quick_only',
      runUiGate: true,
      runMobileGate: false,
      runLandingGate: false,
      runDocsGate: false,
      uiProjects: ['console', 'portal'],
    });
  });

  test('workflow_dispatch keeps targeted UI changes on preview-backed verification', () => {
    const result = resolveReleaseVerifyScope({
      eventName: 'workflow_dispatch',
      surfaceIds: 'db,console,portal',
    });

    expect(result).toEqual({
      runPreviewValidation: true,
      previewRequested: true,
      reason: 'ui_surface',
      runUiGate: true,
      runMobileGate: false,
      runLandingGate: false,
      runDocsGate: false,
      uiProjects: ['console', 'portal'],
    });
  });

  test('keeps landing-only changes on the fast lane when full preview is skipped', () => {
    const result = resolveReleaseVerifyScope({
      skipFullPreview: '1',
      hasLanding: '1',
      surfaceIds: 'landing',
    });

    expect(formatOutputs(result)).toEqual({
      run_preview_validation: '0',
      preview_requested: '0',
      reason: 'landing_fast_only',
      run_ui_gate: '0',
      run_mobile_gate: '0',
      run_landing_gate: '1',
      run_docs_gate: '0',
      ui_projects: '',
    });
  });

  test('keeps docs-only changes on the fast lane even when preview is generally allowed', () => {
    const result = resolveReleaseVerifyScope({
      surfaceIds: 'docs',
    });

    expect(formatOutputs(result)).toEqual({
      run_preview_validation: '0',
      preview_requested: '0',
      reason: 'preview_not_required',
      run_ui_gate: '0',
      run_mobile_gate: '0',
      run_landing_gate: '0',
      run_docs_gate: '1',
      ui_projects: '',
    });
  });

  test('keeps fully skipped docs and ci lanes on the fast path', () => {
    const result = resolveReleaseVerifyScope({
      skipPreview: '1',
      surfaceIds: '',
    });

    expect(formatOutputs(result)).toEqual({
      run_preview_validation: '0',
      preview_requested: '0',
      reason: 'skip_preview_fast_only',
      run_ui_gate: '0',
      run_mobile_gate: '0',
      run_landing_gate: '0',
      run_docs_gate: '0',
      ui_projects: '',
    });
  });

  test('requires preview validation for mobile changes but still keeps docs gate metadata', () => {
    const result = resolveReleaseVerifyScope({
      eventName: 'merge_group',
      surfaceIds: 'mobile_fieldops,docs',
      allowMergeGroupPreview: '1',
    });

    expect(result).toEqual({
      runPreviewValidation: true,
      previewRequested: true,
      reason: 'mobile_surface',
      runUiGate: false,
      runMobileGate: true,
      runLandingGate: false,
      runDocsGate: true,
      uiProjects: [],
    });
  });

  test('merge_group can fail closed to the fast lane when preview is explicitly disabled', () => {
    const result = resolveReleaseVerifyScope({
      eventName: 'merge_group',
      suiteVerifyCloudCore: '1',
      surfaceIds: 'console',
      allowMergeGroupPreview: '0',
    });

    expect(formatOutputs(result)).toEqual({
      run_preview_validation: '1',
      preview_requested: '0',
      reason: 'merge_group_fast_only',
      run_ui_gate: '1',
      run_mobile_gate: '0',
      run_landing_gate: '0',
      run_docs_gate: '0',
      ui_projects: 'console',
    });
  });
});
