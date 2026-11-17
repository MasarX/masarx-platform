const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('reviewer-gate-chatops workflow', () => {
  test('dispatch ref is derived from PR base branch policy source', () => {
    const body = readWorkflow('reviewer-gate-chatops.yml');
    expect(body).toContain("const policyRef = String(pr?.base?.ref || '').trim();");
    expect(body).toContain('const dispatchRef = policyRef;');
    expect(body).toContain('ref: dispatchRef');
    expect(body).not.toContain("ref: 'main'");
  });

  test('dispatch checkout stays sparse for local-runner reliability', () => {
    const body = readWorkflow('reviewer-gate-chatops.yml');
    const checkoutBlock = body.match(
      /- name: Checkout \(for shared workflow scripts\)[\s\S]*?- name: Dispatch PR Gate \(Preview \+ Verify\)/,
    );

    expect(checkoutBlock).toBeTruthy();
    expect(checkoutBlock[0]).toContain('filter: blob:none');
    expect(checkoutBlock[0]).toContain('sparse-checkout: |');
    expect(checkoutBlock[0]).toContain('.github/scripts/gh-helpers.js');
    expect(checkoutBlock[0]).toContain('sparse-checkout-cone-mode: false');
    expect(checkoutBlock[0]).not.toContain('docs/ops/evidence');
  });
});
