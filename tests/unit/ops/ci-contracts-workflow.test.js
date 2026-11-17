const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('CI contract workflows', () => {
  test('reviewer gate workflow keeps dynamic test-selection contracts but drops duplicated governance naming checks', () => {
    const body = readWorkflow('reviewer-gate-pr.yml');
    expect(body).not.toContain('CI policy contracts (naming + dynamic gating)');
    expect(body).not.toContain('Lint plans (primary only) (fail-fast)');
    expect(body).not.toContain('Lint plans (automation) (fail-fast)');
    expect(body).toContain('suite_test_unit');
    expect(body).toContain('suite_test_ui');
    expect(body).toContain('dynamic-gating-report.json');
  });

  test('release verify uses classifier suite flags and fallback-aware logging', () => {
    const body = readWorkflow('release-verify-main.yml');
    expect(body).toContain('suite_verify_cloud_core');
    expect(body).toContain('selection_confidence');
    expect(body).toContain('fallback_to_full');
    expect(body).toContain('changed-surfaces.js');
    expect(body).toContain('preview-backed comprehensive mode');
    expect(body).toContain('validate-test-selection-contract.js');
    expect(body).toContain('release_verify_required_context');
    expect(body).toContain('needs: [release_verify]');
    expect(body).toContain('name: release_verify / run');
    expect(body).toContain('FIELDOPS_STORE_PREFLIGHT_PROFILE: ci');
    expect(body).toContain('FIELDOPS_VERIFY_SKIP_STORE_PREFLIGHT: "1"');
  });

  test('pr governance gate enforces CI naming/test-selection contracts', () => {
    const body = readWorkflow('pr-governance-gate.yml');
    expect(body).toContain('validate-deploy-env-vars.js');
    expect(body).toContain('validate-env-name-standard.js');
    expect(body).toContain('validate-test-selection-contract.js');
  });
});
